// 不在项目里的会话（0.39.0）与交给用户的文件（0.40.0）：只带 Codex 引擎的 Host（startHost + 真实 codex-app-server + mock
// 模型）。会话不带 workspaceId，建在“对话”工作区里自己的文件夹；mock 模型用 apply_patch 在那里写一份报告，再调
// wevir_share_file 交出它：请求批准时不问（工具标成只读），事件流里有 file.shared。没有 codex-app-server 时跳过。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { SessionId } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function binaryAvailable(): boolean {
  try {
    resolveCodexBinary();
    return true;
  } catch (error) {
    console.warn(`[交文件 + codex] 跳过：${(error as Error).message}`);
    return false;
  }
}

/** Wevir 的工具：命名空间 `mcp__wevir` 里的，或顶层名字里带它的。 */
function wevirTool(tools: MockRequestBody['tools'], name: string) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = ((tool.tools ?? []) as Array<{ name?: string }>).find((t) => t.name === name);
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.endsWith(name)) {
      return { name: tool.name };
    }
  }
  throw new Error(`请求里没有 ${name}`);
}

const REPORT = [
  '*** Begin Patch',
  '*** Add File: 周报.md',
  '+# 周报',
  '+本周完成三项。',
  '*** End Patch',
].join('\n');

/** 写报告 → 交出报告 → 说一句话。 */
const script: MockScript = (view) => {
  if (!view.lastUserText.includes('[report]')) return { text: ['好的。'] };
  if (view.toolOutputs.length === 0) {
    return { toolCalls: [{ kind: 'custom', name: 'apply_patch', input: REPORT }] };
  }
  if (view.toolOutputs.length === 1) {
    const tool = wevirTool(view.body.tools, 'wevir_share_file');
    return {
      toolCalls: [
        {
          kind: 'function',
          name: tool.name,
          ...(tool.namespace !== undefined && { namespace: tool.namespace }),
          args: { paths: ['周报.md'] },
        },
      ],
    };
  }
  return { text: [`已交付：${view.toolOutputs.at(-1) ?? ''}`] };
};

describe.skipIf(!binaryAvailable())(
  '对话里交文件（startHost + 真实 codex-app-server + mock 模型）',
  { timeout: 120_000 },
  () => {
    it('不带 workspaceId 的会话在自己的文件夹里写报告并交出，请求批准时不问', async () => {
      const model = await startMockModel(script);
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
      // 只有 Codex 引擎：不挂订阅来源的引擎，不碰本机的 claude 等登录。
      const host = await startHost({
        home,
        adapter: new CodexRuntime({
          home,
          binary: resolveCodexBinary(),
          clientInfo: { name: 'wevir', version: '0.0.0' },
        }),
        engine: 'codex',
        logger: createLogger({ level: 'error', mirror: () => {} }),
      });
      cleanups.push(() => host.shutdown());
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(host.url);
      cleanups.push(() => client.ws.close());
      const hello = await client.hello(info.token as string);
      expect(hello.result.features).toMatchObject({ chat_sessions: true, shared_files: true });
      await client.request('provider.upsert', {
        id: 'wevir-mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'wevir-mock-key-not-a-secret',
      });

      const { session } = await client.request('session.create', { providerId: 'wevir-mock' });
      expect(session.cwd).toMatch(/[/\\]chats[/\\]ses_/);
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId: session.id as SessionId,
        sinceSeq: 0,
      });
      const sent = await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: '[report] 写一份周报给我' }],
      });
      await client.until(
        () =>
          client
            .events(subscriptionId)
            .find((e) => e.type === 'turn.finished' && e.payload.turnId === sent.turnId),
        'turn.finished',
        90_000,
      );
      const events = client.events(subscriptionId);
      expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(existsSync(join(session.cwd, '周报.md'))).toBe(true);
      const shared = events.find((e) => e.type === 'file.shared');
      expect(shared?.payload).toEqual({
        turnId: sent.turnId,
        files: [
          {
            path: '周报.md',
            name: '周报.md',
            size: Buffer.byteLength('# 周报\n本周完成三项。\n'),
            mimeType: 'text/markdown',
          },
        ],
      });
      const answer = events.filter((e) => e.type === 'assistant.message').at(-1);
      expect((answer?.payload as { text: string } | undefined)?.text).toContain('周报.md');
    });
  },
);
