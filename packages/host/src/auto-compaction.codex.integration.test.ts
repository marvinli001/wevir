// 自动压缩降不下用量时停下回合：只带 Codex 引擎的 Host（startHost + 真实 codex-app-server + mock 模型）。mock 每个带工具的
// 请求都报 12.4 万输入 token、调一个工具（模型窗口登记为 128k，压缩线 115,200），像按 128k 登记 DeepSeek 时那样：Codex 每个
// 请求之后都自动压缩，自己停不下来。Host 在连续两次压缩都降不下用量之后说明原因并取消回合。没有 codex-app-server 时跳过。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { SessionId, WevirEventOf } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { FRUITLESS_AUTO_COMPACTIONS } from './session-manager.js';
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
    console.warn(`[自动压缩 + codex] 跳过：${(error as Error).message}`);
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

/** Host 没停下回合时 mock 最多陪 Codex 压缩这么多个请求，之后不再调工具，回合自己结束（断言随之失败）。 */
const REQUEST_CAP = 20;

describe.skipIf(!binaryAvailable())(
  '自动压缩降不下用量（startHost + 真实 codex-app-server + mock 模型）',
  { timeout: 120_000 },
  () => {
    it('连续两次自动压缩之后用量仍在压缩线以上：说明原因并取消回合', async () => {
      let agentRequests = 0;
      const script: MockScript = (view) => {
        // 压缩（与标题）请求不带工具：回一段摘要，用量小。
        if ((view.body.tools ?? []).length === 0)
          return { text: ['摘要：在列会话。'], inputTokens: 900 };
        agentRequests += 1;
        if (agentRequests > REQUEST_CAP) return { text: ['停了。'] };
        const tool = wevirTool(view.body.tools, 'wevir_session_list');
        return {
          toolCalls: [
            {
              kind: 'function',
              name: tool.name,
              ...(tool.namespace !== undefined && { namespace: tool.namespace }),
              args: {},
            },
          ],
          inputTokens: 124_000,
        };
      };
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
      await client.hello(info.token as string);
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

      const { session } = await client.request('session.create', {
        providerId: 'wevir-mock',
        permissionMode: 'full_access',
      });
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId: session.id as SessionId,
        sinceSeq: 0,
      });
      const sent = await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: '列一下现在的会话' }],
      });
      const finished = await client.until(
        () =>
          client
            .events(subscriptionId)
            .find((e) => e.type === 'turn.finished' && e.payload.turnId === sent.turnId),
        'turn.finished',
        90_000,
      );
      const events = client.events(subscriptionId);
      const compactions = events.filter(
        (e) => e.type === 'context.compacted' && e.payload.trigger === 'auto',
      );
      const error = events.find(
        (e): e is WevirEventOf<'engine.error'> => e.type === 'engine.error',
      );

      expect(finished.payload).toMatchObject({ outcome: 'cancelled' });
      // 取消到达之前 Codex 可能已经开始了下一次压缩。
      expect(compactions.length).toBeGreaterThanOrEqual(FRUITLESS_AUTO_COMPACTIONS);
      expect(compactions.length).toBeLessThanOrEqual(FRUITLESS_AUTO_COMPACTIONS + 1);
      expect(error?.payload).toMatchObject({
        category: 'provider',
        fatal: false,
        turnId: sent.turnId,
      });
      expect(error?.payload.message).toMatch(
        /^Stopped the turn: after 2 automatic context compactions in a row the model service still reported 124020 tokens in use, at or above the compaction threshold of 115200 for a 128000-token context window/,
      );
      // 压缩完成之前 Codex 报的是压缩后估算的用量（不含工具），远低于压缩线；停下回合看的是之后下一个请求报的。
      const firstCompacted = events.indexOf(compactions[0] as (typeof events)[number]);
      const estimate = events.slice(0, firstCompacted).findLast((e) => e.type === 'usage.updated')
        ?.payload as { contextUsed: number };
      expect(estimate.contextUsed).toBeLessThan(115_200);
      expect(
        events.slice(firstCompacted).find((e) => e.type === 'usage.updated')?.payload,
      ).toMatchObject({ contextUsed: 124_020, autoCompactAt: 115_200 });
      expect(agentRequests).toBeLessThanOrEqual(FRUITLESS_AUTO_COMPACTIONS + 2);
    });
  },
);
