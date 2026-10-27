// 回合收尾（0.128.0）：只带 Codex 引擎的 Host（startHost + 真实 codex-app-server + mock 模型）。模型在最终回答前调
// wevir_wrap_up：请求批准时不问（工具标成只读），事件流里有 turn.wrap_up，回合结束后 Session.wrapUp 带着它，会话的通知正文是问题。
// 没有 codex-app-server 时跳过。

import { readFileSync } from 'node:fs';
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
    console.warn(`[回合收尾 + codex] 跳过：${(error as Error).message}`);
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

const ACTIONS = [
  { label: '提交', message: '提交这次改动。' },
  { label: '先不', message: '先不提交，我自己看一遍。' },
];

/** 收尾 → 写最终回答。 */
const script: MockScript = (view) => {
  if (!view.lastUserText.includes('[wrap]')) return { text: ['好的。'] };
  if (view.toolOutputs.length === 0) {
    const tool = wevirTool(view.body.tools, 'wevir_wrap_up');
    return {
      toolCalls: [
        {
          kind: 'function',
          name: tool.name,
          ...(tool.namespace !== undefined && { namespace: tool.namespace }),
          args: {
            recap: '换算函数支持开尔文，测试全部通过。还没提交。',
            ask: '要提交吗？',
            actions: ACTIONS,
            blocked: true,
          },
        },
      ],
    };
  }
  return {
    text: [
      `改好了，测试通过。${view.toolOutputs.at(-1)?.includes('"card":true') ? '' : '（没有卡片）'}`,
    ],
  };
};

describe.skipIf(!binaryAvailable())(
  '回合收尾（startHost + 真实 codex-app-server + mock 模型）',
  { timeout: 120_000 },
  () => {
    it('模型调 wevir_wrap_up：不问批准，写 turn.wrap_up，回合结束后会话等决定', async () => {
      const model = await startMockModel(script);
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
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
      expect(hello.result.features).toMatchObject({ turn_wrap_up: true });
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
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId: session.id as SessionId,
        sinceSeq: 0,
      });
      const sent = await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: '[wrap] 给换算函数加开尔文' }],
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
      expect(events.find((e) => e.type === 'turn.wrap_up')?.payload).toEqual({
        turnId: sent.turnId,
        recap: '换算函数支持开尔文，测试全部通过。还没提交。',
        ask: '要提交吗？',
        actions: ACTIONS,
        blocked: true,
      });
      const answer = events.filter((e) => e.type === 'assistant.message').at(-1);
      expect((answer?.payload as { text: string } | undefined)?.text).toBe('改好了，测试通过。');
      const { session: after } = await client.request('session.get', {
        sessionId: session.id as SessionId,
      });
      expect(after.state).toBe('idle');
      expect(after.wrapUp).toEqual({
        turnId: sent.turnId,
        recap: '换算函数支持开尔文，测试全部通过。还没提交。',
        ask: '要提交吗？',
        blocked: true,
      });
    });
  },
);
