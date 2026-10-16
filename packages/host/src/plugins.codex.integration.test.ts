// P1 端到端：真实锁定的 app-server + 仓库的假模型 + 本机 stdio MCP，分别覆盖两种 Codex 实现。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter, CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import { MOCK_MODEL, type MockRequestBody, startMockModel } from '@wevir/adapter-codex/testing';
import type { ApprovalOption, PluginsList } from '@wevir/protocol';
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
  console.warn('[plugins + codex] 跳过：运行 bash scripts/fetch-codex.sh 下载锁定的 app-server');
}

function findTool(tools: MockRequestBody['tools'], suffix = 'plugin_ping') {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const nested = (tool.tools as Array<{ name?: string }>).find((item) =>
        item.name?.endsWith(suffix),
      );
      if (nested?.name) return { name: nested.name, namespace: tool.name };
    } else if (tool.name?.endsWith(suffix)) return { name: tool.name };
  }
  return undefined;
}
function makeSkill(root: string, name: string): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill description\n---\nBODY-${name}-9dc4\n`,
  );
  return folder;
}

describe.skipIf(!binary || process.platform === 'win32')(
  'Host plugins + real Codex',
  { timeout: 120_000 },
  () => {
    it.each(['adapter', 'runtime'] as const)(
      '%s：调用 MCP、按权限审批、skills 隔离与热更新、移除后不再提供工具',
      async (mode) => {
        const home = join(temp(), 'home'),
          userHome = join(temp(), 'user'),
          cwd = join(temp(), 'project');
        const externalPath = makeSkill(join(userHome, '.agents', 'skills'), 'external-canary');
        makeSkill(join(cwd, '.agents', 'skills'), 'project-canary');
        makeSkill(join(cwd, '.codex', 'skills'), 'codex-project-canary');
        const model = await startMockModel((view) => {
          if (view.lastUserText.includes('[call-plugin]') && view.toolOutputs.length === 0) {
            const tool = findTool(view.body.tools);
            if (!tool) return { text: ['MISSING-PLUGIN-TOOL'] };
            return { toolCalls: [{ kind: 'function', ...tool, args: {} }] };
          }
          return { text: [view.toolOutputs.at(-1) ?? 'ok'] };
        });
        cleanups.push(() => model.close());
        const options = {
          home,
          binary,
          parentEnv: { ...process.env, HOME: userHome },
          logger: { warn: () => {}, info: () => {} },
        };
        const adapter = mode === 'runtime' ? new CodexRuntime(options) : new CodexAdapter(options);
        const engine = adapter instanceof CodexRuntime ? adapter.gateway : adapter;
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
        const hello = await client.hello(info.token);
        expect(hello.result.features.plugins).toBe(true);
        expect(hello.result.engineFeatures?.['openai-compatible']).toMatchObject({
          mcpServers: true,
          skills: true,
        });
        await client.request('provider.upsert', {
          id: 'mock',
          kind: 'openai-compatible',
          displayName: 'Mock',
          api: 'openai-responses',
          baseURL: model.baseURL,
          models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
          defaultModelId: MOCK_MODEL,
          apiKey: 'mock-key-not-a-secret',
        });
        const { connector } = await client.request('connector.add', {
          name: 'plugin_test',
          config: {
            transport: 'stdio',
            command: process.execPath,
            args: [fileURLToPath(new URL('./test-fixtures/plugin-mcp.mjs', import.meta.url))],
            env: { PLUGIN_TEST_SECRET: 'plugin-env-not-a-real-secret', ELECTRON_RUN_AS_NODE: '1' },
          },
        });
        await client.request('skill.install', {
          path: makeSkill(join(temp(), 'source'), 'managed-canary'),
        });
        const { workspace } = await client.request('workspace.add', { rootPath: cwd });
        const { session } = await client.request('session.create', {
          workspaceId: workspace.id,
          providerId: 'mock',
          permissionMode: 'on_request',
        });
        const { subscriptionId } = await client.request('events.subscribe', {
          sessionId: session.id,
          sinceSeq: 0,
        });
        const events = () => client.events(subscriptionId);
        const send = async (text: string) => {
          const { turnId } = await client.request('session.send', {
            sessionId: session.id,
            content: [{ type: 'text', text }],
          });
          return turnId;
        };
        const finish = (turnId: string) =>
          client.until(
            () =>
              events().find(
                (item) => item.type === 'turn.finished' && item.payload.turnId === turnId,
              ),
            'turn.finished',
            90_000,
          );
        let turn = await send('[call-plugin] Call the plugin');
        const approval = await client
          .until(
            () => events().find((item) => item.type === 'approval.requested'),
            'approval.requested',
            30_000,
          )
          .catch((error: unknown) => {
            throw new Error(
              `${String(error)}; events=${JSON.stringify(events())}; tools=${JSON.stringify(model.requests.at(-1)?.body.tools)}; stderr=${engine.process.stderrTail}`,
            );
          });
        expect(approval.type).toBe('approval.requested');
        if (approval.type !== 'approval.requested') throw new Error('missing approval');
        const decision = approval.payload.approval.options.find(
          (item: ApprovalOption) => item.kind === 'allow_accept',
        );
        expect(decision).toBeDefined();
        await client.request('approval.respond', {
          approvalId: approval.payload.approval.id,
          optionId: decision?.optionId as string,
        });
        await finish(turn);
        expect(
          events().some(
            (item) =>
              item.type === 'assistant.message' && item.payload.text.includes('PLUGIN-TOOL-CALLED'),
          ),
        ).toBe(true);
        const context = () => JSON.stringify(model.requests.at(-1)?.body.input ?? []);
        expect(context()).toContain('managed-canary');
        expect(context()).not.toContain('external-canary');
        expect(context()).not.toContain('project-canary');
        const codexSkills = await engine.process.request<{
          data: Array<{ skills: Array<{ name: string; enabled: boolean }> }>;
        }>('skills/list', { cwds: [cwd], forceReload: true });
        expect(codexSkills.data.flatMap((item) => item.skills)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'managed-canary', enabled: true }),
            expect.objectContaining({ name: 'external-canary', enabled: false }),
            expect.objectContaining({ name: 'project-canary', enabled: false }),
          ]),
        );
        const list: PluginsList = await client.request('plugins.list', {});
        expect(list.connectors[0]).toMatchObject({
          status: 'connected',
          tools: [expect.objectContaining({ name: 'plugin_ping' })],
        });
        expect(JSON.stringify(list)).not.toContain('plugin-env-not-a-real-secret');
        const external = list.skills.find((item) => item.name === 'external-canary');
        const projectSkill = list.skills.find((item) => item.name === 'codex-project-canary');
        expect(projectSkill).toMatchObject({ source: 'project', enabled: false });
        expect(external?.path).toBe(join(externalPath, 'SKILL.md'));
        turn = await send('Use $external-canary');
        await finish(turn);
        expect(context()).not.toContain('BODY-external-canary-9dc4');
        await client.request('skill.setEnabled', { id: external?.id as string, enabled: true });
        turn = await send('Use $external-canary');
        await finish(turn);
        expect(context()).toContain('BODY-external-canary-9dc4');
        await client.request('skill.setEnabled', { id: projectSkill?.id as string, enabled: true });
        turn = await send('Use $codex-project-canary');
        await finish(turn);
        expect(context()).toContain('BODY-codex-project-canary-9dc4');
        makeSkill(join(userHome, '.agents', 'skills'), 'later-external-canary');
        turn = await send('Continue without extra skills');
        await finish(turn);
        expect(context()).not.toContain('later-external-canary');
        await client.request('skill.install', {
          path: makeSkill(join(temp(), 'source'), 'later-managed-canary'),
        });
        turn = await send('Use $later-managed-canary');
        await finish(turn);
        expect(context()).toContain('BODY-later-managed-canary-9dc4');
        // 打开的会话运行中安装 / 禁用连接器；后续回合更新实际工具目录。
        await client.request('connector.setEnabled', { id: connector.id, enabled: false });
        turn = await send('Check tools');
        await finish(turn);
        expect(findTool(model.requests.at(-1)?.body.tools)).toBeUndefined();
        await client.request('connector.setEnabled', { id: connector.id, enabled: true });
        await client.request('session.configure', {
          sessionId: session.id,
          permissionMode: 'full_access',
        });
        const approvalsBefore = events().filter(
          (item) => item.type === 'approval.requested',
        ).length;
        turn = await send('[call-plugin] full access');
        await finish(turn);
        expect(events().filter((item) => item.type === 'approval.requested')).toHaveLength(
          approvalsBefore,
        );
        expect(
          events()
            .filter((item) => item.type === 'assistant.message')
            .at(-1)?.payload,
        ).toMatchObject({ text: expect.stringContaining('PLUGIN-TOOL-CALLED') });
        await client.request('connector.remove', { id: connector.id });
        turn = await send('Check removed tool');
        await finish(turn);
        expect(findTool(model.requests.at(-1)?.body.tools)).toBeUndefined();
        const config = readFileSync(join(home, 'engines', 'codex', 'config.toml'), 'utf8');
        expect(config).toContain('plugins = false');
        expect(config).toContain('apps = false');
        expect(config).not.toContain('plugin-env-not-a-real-secret');
      },
    );

    it.each(['adapter', 'runtime'] as const)(
      '%s：Wevir 插件包（pluginDir 里的 stdio 脚本 + skill）可用，关掉插件后两者都没了',
      async (mode) => {
        const home = join(temp(), 'home'),
          userHome = join(temp(), 'user');
        mkdirSync(userHome, { recursive: true });
        const model = await startMockModel((view) => {
          if (view.lastUserText.includes('[call-package]') && view.toolOutputs.length === 0) {
            const tool = findTool(view.body.tools, 'package_ping');
            if (!tool) return { text: ['MISSING-PACKAGE-TOOL'] };
            return { toolCalls: [{ kind: 'function', ...tool, args: {} }] };
          }
          return { text: [view.toolOutputs.at(-1) ?? 'ok'] };
        });
        cleanups.push(() => model.close());
        const options = {
          home,
          binary,
          parentEnv: { ...process.env, HOME: userHome },
          logger: { warn: () => {}, info: () => {} },
        };
        const adapter = mode === 'runtime' ? new CodexRuntime(options) : new CodexAdapter(options);
        const engine = adapter instanceof CodexRuntime ? adapter.gateway : adapter;
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
        const hello = await client.hello(info.token);
        expect(hello.result.features.plugin_packages).toBe(true);
        await client.request('provider.upsert', {
          id: 'mock',
          kind: 'openai-compatible',
          displayName: 'Mock',
          api: 'openai-responses',
          baseURL: model.baseURL,
          models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
          defaultModelId: MOCK_MODEL,
          apiKey: 'mock-key-not-a-secret',
        });
        const token = 'package-token-not-a-secret';
        const { plugin } = await client.request('plugin.install', {
          path: fileURLToPath(new URL('./test-fixtures/wevir-plugin', import.meta.url)),
          inputs: { TOKEN: token, REGION: 'eu-west' },
        });
        let { session } = await client.request('session.create', {
          providerId: 'mock',
          permissionMode: 'on_request',
        });
        let { subscriptionId } = await client.request('events.subscribe', {
          sessionId: session.id,
          sinceSeq: 0,
        });
        const events = () => client.events(subscriptionId);
        const run = async (text: string) => {
          const { turnId } = await client.request('session.send', {
            sessionId: session.id,
            content: [{ type: 'text', text }],
          });
          return turnId as string;
        };
        const finish = (turnId: string) =>
          client.until(
            () =>
              events().find(
                (item) => item.type === 'turn.finished' && item.payload.turnId === turnId,
              ),
            'turn.finished',
            90_000,
          );
        let turn = await run('[call-package] Call the package');
        const approval = await client
          .until(
            () => events().find((item) => item.type === 'approval.requested'),
            'approval.requested',
            30_000,
          )
          .catch((error: unknown) => {
            throw new Error(
              `${String(error)}; events=${JSON.stringify(events())}; stderr=${engine.process.stderrTail}`,
            );
          });
        if (approval.type !== 'approval.requested') throw new Error('missing approval');
        const decision = approval.payload.approval.options.find(
          (item: ApprovalOption) => item.kind === 'allow_accept',
        );
        await client.request('approval.respond', {
          approvalId: approval.payload.approval.id,
          optionId: decision?.optionId as string,
        });
        await finish(turn);
        expect(
          events()
            .filter((item) => item.type === 'assistant.message')
            .at(-1)?.payload,
        ).toMatchObject({ text: expect.stringContaining('PACKAGE-TOOL-CALLED region=eu-west') });
        const context = () => JSON.stringify(model.requests.at(-1)?.body.input ?? []);
        expect(context()).toContain('package-canary');
        const codexSkills = async () =>
          (
            await engine.process.request<{
              data: Array<{ skills: Array<{ name: string; enabled: boolean }> }>;
            }>('skills/list', { cwds: [], forceReload: true })
          ).data.flatMap((item) => item.skills);
        expect(await codexSkills()).toContainEqual(
          expect.objectContaining({ name: 'package-canary', enabled: true }),
        );
        const list: PluginsList = await client.request('plugins.list', {});
        expect(list.connectors.find((item) => item.pluginId === plugin.id)).toMatchObject({
          name: 'sample-tools_api',
          status: 'connected',
          tools: [expect.objectContaining({ name: 'package_ping' })],
        });
        expect(JSON.stringify(list)).not.toContain(token);
        const config = () => readFileSync(join(home, 'engines', 'codex', 'config.toml'), 'utf8');
        expect(config()).not.toContain(`\${`);
        expect(config()).toContain('sample-tools_api');

        await client.request('plugin.setEnabled', { id: plugin.id, enabled: false });
        // 已打开的会话：下一个回合没有工具；skills 目录只控制之后的注入，所以在新会话里看上下文。
        turn = await run('[call-package] after disabling');
        await finish(turn);
        expect(findTool(model.requests.at(-1)?.body.tools, 'package_ping')).toBeUndefined();
        ({ session } = await client.request('session.create', {
          providerId: 'mock',
          permissionMode: 'on_request',
        }));
        ({ subscriptionId } = await client.request('events.subscribe', {
          sessionId: session.id,
          sinceSeq: 0,
        }));
        turn = await run('[call-package] new session');
        await finish(turn);
        expect(findTool(model.requests.at(-1)?.body.tools, 'package_ping')).toBeUndefined();
        expect(context()).not.toContain('package-canary');
        expect(await codexSkills()).not.toContainEqual(
          expect.objectContaining({ name: 'package-canary', enabled: true }),
        );
        expect(config()).not.toContain('sample-tools_api');
        expect(config()).toContain('plugins = false');
        expect(config()).toContain('apps = false');
      },
    );
  },
);
