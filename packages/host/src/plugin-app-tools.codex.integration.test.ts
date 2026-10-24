// P3：真实 rust-v0.162.1 app-server + 本机假模型。模型先在会话文件夹写 skill，再调用安装工具；
// 两个 Codex 实现都验证用户批准、拒绝与完全访问时 Host 补问。无需供应商 Key，不访问用户的 Codex/skills 配置。
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter, CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { PluginsList } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const temp = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch {
  console.warn(
    '[plugin app tools + codex] 跳过：运行 bash scripts/fetch-codex.sh 下载锁定 app-server',
  );
}

function findTool(tools: MockRequestBody['tools'], name: string) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = (tool.tools as Array<{ name?: string }>).find((tool) => tool.name === name);
      if (inner?.name) return { name: inner.name, namespace: tool.name };
    } else if (tool.name?.endsWith(name)) return { name: tool.name };
  }
  throw new Error(`Missing tool: ${name}`);
}
const PATCH = [
  '*** Begin Patch',
  '*** Add File: conversation-skill/SKILL.md',
  '+---',
  '+name: conversation-skill',
  '+description: A skill created inside this conversation',
  '+---',
  '+Use this skill to follow the user request.',
  '*** End Patch',
].join('\n');
const script: MockScript = (view) => {
  if (!view.lastUserText.includes('[install-skill]')) return { text: ['ok'] };
  if (view.toolOutputs.length === 0)
    return { toolCalls: [{ kind: 'custom', name: 'apply_patch', input: PATCH }] };
  if (view.toolOutputs.length === 1)
    return {
      toolCalls: [
        {
          kind: 'function',
          ...findTool(view.body.tools, 'wevir_skill_install'),
          args: { path: 'conversation-skill' },
        },
      ],
    };
  return { text: [view.toolOutputs.at(-1) ?? 'done'] };
};

describe.skipIf(!binary || process.platform === 'win32')(
  '对话里安装 skill（Host + 真实 Codex + 假模型）',
  { timeout: 120_000 },
  () => {
    for (const implementation of ['adapter', 'runtime'] as const) {
      it.each([
        { permissionMode: 'on_request', allow: true },
        { permissionMode: 'on_request', allow: false },
        { permissionMode: 'full_access', allow: true },
      ] as const)(
        `${implementation}: $permissionMode / allow=$allow`,
        async ({ permissionMode, allow }) => {
          const model = await startMockModel(script);
          cleanups.push(() => model.close());
          const home = join(temp(), 'home');
          const userHome = join(temp(), 'isolated-user');
          mkdirSync(userHome);
          const options = {
            home,
            binary,
            parentEnv: { ...process.env, HOME: userHome },
            logger: { warn: () => {}, info: () => {} },
          };
          const adapter =
            implementation === 'adapter' ? new CodexAdapter(options) : new CodexRuntime(options);
          const host = await startHost({
            home,
            pluginUserHome: userHome,
            adapter,
            engine: 'codex',
            logger: createLogger({ level: 'error', mirror: () => {} }),
          });
          cleanups.push(() => host.shutdown());
          const client = await TestRpcClient.connect(host.url);
          cleanups.push(() => client.ws.terminate());
          const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
          await client.hello(info.token);
          await client.request('provider.upsert', {
            id: 'mock',
            kind: 'openai-compatible',
            displayName: 'Mock',
            api: 'openai-responses',
            baseURL: model.baseURL,
            // 这里不测工具搜索：假模型按名字直接调按需的工具（搜索见 tool-search.codex.integration.test.ts）。
            compat: { toolSearch: 'off' },
            models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
            defaultModelId: MOCK_MODEL,
            apiKey: 'mock-not-a-secret',
          });
          const { session } = await client.request('session.create', {
            providerId: 'mock',
            permissionMode,
          });
          const { subscriptionId } = await client.request('events.subscribe', {
            sessionId: session.id,
            sinceSeq: 0,
          });
          const events = () => client.events(subscriptionId);
          const { turnId } = await client.request('session.send', {
            sessionId: session.id,
            content: [
              {
                type: 'text',
                text: '[install-skill] Create and install a skill in this session folder.',
              },
            ],
          });
          const request = await client.until(
            () => events().find((event) => event.type === 'approval.requested'),
            'skill installation approval',
            40_000,
          );
          if (request.type !== 'approval.requested') throw new Error('Missing approval');
          const approval = request.payload.approval;
          expect(approval.detail?.toolName).toBe('mcp__wevir_more__wevir_skill_install');
          expect(approval.detail?.display.summary).toContain('conversation-skill');
          expect(approval.detail?.display.summary).toContain(
            'A skill created inside this conversation',
          );
          expect(request.source).toBe(permissionMode === 'full_access' ? 'host' : 'engine');
          expect(existsSync(join(session.cwd, 'conversation-skill', 'SKILL.md'))).toBe(true);
          // 内置 skills（prompts/skills/）不算这次安装的。
          const installedSkills = (list: PluginsList) =>
            list.skills.filter((skill) => !skill.builtin).map((skill) => skill.name);
          expect(installedSkills(await client.request('plugins.list', {}))).toEqual([]);
          const option = approval.options.find(
            (option) => option.category === (allow ? 'allow' : 'reject'),
          );
          if (!option) throw new Error('Missing decision option');
          await client.request('approval.respond', {
            approvalId: approval.id,
            optionId: option.optionId,
          });
          await client.until(
            () =>
              events().find(
                (event) => event.type === 'turn.finished' && event.payload.turnId === turnId,
              ),
            'turn.finished',
            50_000,
          );
          const installed: PluginsList = await client.request('plugins.list', {});
          expect(installedSkills(installed)).toEqual(allow ? ['conversation-skill'] : []);
          expect(events().filter((event) => event.type === 'approval.requested')).toHaveLength(1);
          if (allow)
            expect(
              readFileSync(
                installed.skills.find((skill) => skill.name === 'conversation-skill')
                  ?.path as string,
                'utf8',
              ),
            ).toContain('follow the user request');
          expect(
            readdirSync(join(home, 'plugins')).filter((name) => name.startsWith('.install-')),
          ).toEqual([]);
        },
      );
    }
  },
);
