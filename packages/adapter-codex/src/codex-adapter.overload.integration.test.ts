// 模型满载时自动续跑：上游以 `server_is_overloaded` 结束响应，Codex 以 `serverOverloaded` 结束回合、不再重试；适配器报
// `turn.retrying`，等一会儿以空输入 `turn/start` 接着做。真实 codex-app-server + 网关 + mock 模型。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockReply,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 模型满载时续跑');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['?'] });
const adapters: CodexAdapter[] = [];

const OVERLOADED: MockReply = {
  failed: {
    code: 'server_is_overloaded',
    message: 'Selected model is at capacity. Please try a different model.',
  },
};

async function open(delayMs = 10) {
  const { home, workspace } = dirs.make('overload');
  const adapter = newAdapter({
    home,
    providers: [mockProvider(mock)],
    overloadRetry: { maxAttempts: 2, baseDelayMs: delayMs, maxDelayMs: delayMs },
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId) };
}

/** 请求里用户消息出现的次数（续跑不重发用户的消息）。 */
function userMessages(index: number, text: string): number {
  return (mock.requests[index]?.body.input ?? []).filter(
    (item) => item.role === 'user' && JSON.stringify(item.content).includes(text),
  ).length;
}

const types = (events: AgentEvent[]) => events.map((event) => event.type);

describe.skipIf(binary === undefined)(
  'CodexAdapter 模型满载时续跑（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => script(view));
    });
    afterEach(async () => {
      script = () => ({ text: ['?'] });
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('满载两次后成功：报 turn.retrying 1/2、2/2，空输入续跑，用户消息只发一次，回合正常完成', async () => {
      const { adapter, id, events } = await open();
      const first = mock.requests.length;
      script = (view) => (view.index - first < 2 ? OVERLOADED : { text: ['做完了'] });
      const turn = await runTurn(adapter, id, '整理一下目录', events);
      expect(turn.filter(ofType('turn.retrying'))).toEqual([
        {
          type: 'turn.retrying',
          engineSessionId: id,
          attempt: 1,
          maxAttempts: 2,
          reason: 'Selected model is at capacity. Please try a different model.',
        },
        expect.objectContaining({ attempt: 2, maxAttempts: 2 }),
      ]);
      expect(types(turn)).not.toContain('turn.failed');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.find(ofType('assistant.message'))).toMatchObject({ text: '做完了' });
      expect(mock.requests.length - first).toBe(3);
      for (let index = first; index < mock.requests.length; index += 1) {
        expect(userMessages(index, '整理一下目录')).toBe(1);
      }
      // 之后的回合照常。
      script = () => ({ text: ['好'] });
      const next = await runTurn(adapter, id, '再来', events);
      expect(next.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('次数用完：最后一次照常以 turn.failed 结束', async () => {
      const { adapter, id, events } = await open();
      const first = mock.requests.length;
      script = () => OVERLOADED;
      const turn = await runTurn(adapter, id, 'hi', events);
      expect(turn.filter(ofType('turn.retrying'))).toHaveLength(2);
      expect(turn.at(-1)).toMatchObject({
        type: 'turn.failed',
        category: 'provider',
        message: 'Selected model is at capacity. Please try a different model.',
      });
      expect(mock.requests.length - first).toBe(3);
    });

    it('等着续跑时取消：回合以 cancelled 结束，不再发请求', async () => {
      const { adapter, id, events } = await open(10_000);
      const first = mock.requests.length;
      script = () => OVERLOADED;
      const from = events.length;
      await adapter.send(id, { content: [{ type: 'text', text: 'hi' }] });
      await waitForEvent(events, ofType('turn.retrying'), 'turn.retrying', from);
      await adapter.cancel(id);
      const turn = await finishTurn(events, from);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
      expect(mock.requests.length - first).toBe(1);
    });
  },
);
