// 分支到新会话与撤回（0.38.0，codex-event-mapping.md §6.15）：真实 codex-app-server + 网关 + mock 模型。`fork` 的 branch 分出
// 持久化的 thread，只带到去掉最后几个回合之前；`rewind` 用 `thread/revert` 撤回最后一个回合。看模型收到的请求里有哪些回合。
// 二进制不在时跳过。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  finishTurn,
  newAdapter,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 分支与撤回');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

/** `[slow]` 慢慢回答（回合进行中分支用），其余一句话。 */
const script: MockScript = (view) =>
  view.lastUserText.includes('[slow]')
    ? { text: ['慢', '慢', '地', '答'], delayMs: 400 }
    : { text: [`收到：${view.lastUserText}`] };

async function open(home?: string) {
  const made = dirs.make('branch');
  const adapter = newAdapter({
    home: home ?? made.home,
    providers: [mockProvider(mock)],
    logger: collectingLogger(),
  });
  adapters.push(adapter);
  const config = { cwd: made.workspace, providerId: 'mock', modelId: MOCK_MODEL };
  const { engineSessionId } = await adapter.createSession(config);
  return {
    adapter,
    id: engineSessionId,
    config,
    home: home ?? made.home,
    events: collectEvents(adapter, engineSessionId),
  };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  const turn = await finishTurn(events, from);
  expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  return turn;
}

/** 模型收到的、带着这段文字的最近一次请求的输入。 */
function inputWith(text: string): string {
  const request = mock.requests.findLast((r) => JSON.stringify(r.body.input).includes(text));
  return JSON.stringify(request?.body.input);
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 分支与撤回（真实 codex-app-server）',
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('从中间的回合分支：新 thread 只带到那个回合，没有边界说明；主线不受影响；换进程后能恢复', async () => {
      const { adapter, id, config, events, home } = await open();
      for (const word of ['ALPHA', 'BRAVO', 'CHARLIE'])
        await run(adapter, id, events, `暗号 ${word}`);
      const branch = await adapter.fork(id, config, { kind: 'branch', dropTurns: 1 });
      expect(branch.engineSessionId).not.toBe(id);
      const branchEvents = collectEvents(adapter, branch.engineSessionId);
      await run(adapter, branch.engineSessionId, branchEvents, '分支 DELTA');
      const input = inputWith('分支 DELTA');
      expect(input).toContain('ALPHA');
      expect(input).toContain('BRAVO');
      expect(input).not.toContain('CHARLIE');
      expect(input).not.toContain(SIDE_BOUNDARY_NOTE.split('\n')[0]);

      await run(adapter, id, events, '主线 ECHO');
      const main = inputWith('主线 ECHO');
      expect(main).toContain('CHARLIE');
      expect(main).not.toContain('DELTA');

      // 分支落盘：换一个进程照常恢复、接着聊。
      await adapter.dispose();
      const next = newAdapter({
        home,
        providers: [mockProvider(mock)],
        logger: collectingLogger(),
      });
      adapters.push(next);
      await next.resumeSession(branch.engineSessionId, config);
      const resumed = collectEvents(next, branch.engineSessionId);
      await run(next, branch.engineSessionId, resumed, '恢复后 FOXTROT');
      const after = inputWith('恢复后 FOXTROT');
      expect(after).toContain('DELTA');
      expect(after).not.toContain('CHARLIE');
    });

    it('不去掉回合时分到最后；回合进行中只分到最近一个结束的回合', async () => {
      const { adapter, id, config, events } = await open();
      await run(adapter, id, events, '第一 GOLF');
      const whole = await adapter.fork(id, config, { kind: 'branch', dropTurns: 0 });
      const wholeEvents = collectEvents(adapter, whole.engineSessionId);
      await run(adapter, whole.engineSessionId, wholeEvents, '整段 HOTEL');
      expect(inputWith('整段 HOTEL')).toContain('GOLF');

      const from = events.length;
      await adapter.send(id, { content: [{ type: 'text', text: '[slow] 第二 INDIA' }] });
      for (
        let i = 0;
        i < 100 && !events.slice(from).some((e) => e.type === 'assistant.delta');
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const running = await adapter.fork(id, config, { kind: 'branch', dropTurns: 0 });
      const runningEvents = collectEvents(adapter, running.engineSessionId);
      await run(adapter, running.engineSessionId, runningEvents, '进行中 JULIET');
      const input = inputWith('进行中 JULIET');
      expect(input).toContain('GOLF');
      expect(input).not.toContain('INDIA');
      await finishTurn(events, from);
    });

    it('撤回最后一个回合：下一个回合的请求里没有它；可以连着撤回；换进程恢复之后也能撤回', async () => {
      const { adapter, id, config, events, home } = await open();
      await run(adapter, id, events, '保留 KILO');
      await run(adapter, id, events, '撤掉 LIMA');
      await adapter.rewind(id);
      await run(adapter, id, events, '改过 MIKE');
      const input = inputWith('改过 MIKE');
      expect(input).toContain('KILO');
      expect(input).not.toContain('LIMA');

      await adapter.rewind(id);
      await run(adapter, id, events, '再改 NOVEMBER');
      const again = inputWith('再改 NOVEMBER');
      expect(again).toContain('KILO');
      expect(again).not.toContain('MIKE');

      await adapter.dispose();
      const next = newAdapter({
        home,
        providers: [mockProvider(mock)],
        logger: collectingLogger(),
      });
      adapters.push(next);
      await next.resumeSession(id, config);
      const resumed = collectEvents(next, id);
      await next.rewind(id);
      await run(next, id, resumed, '恢复后 OSCAR');
      const after = inputWith('恢复后 OSCAR');
      expect(after).toContain('KILO');
      expect(after).not.toContain('NOVEMBER');
    });

    it('拒绝：回合进行中撤回；没有回合时撤回；去掉的回合比有的多', async () => {
      const { adapter, id, config, events } = await open();
      await expect(adapter.rewind(id)).rejects.toMatchObject({ code: 'invalid_input' });
      await run(adapter, id, events, '唯一 PAPA');
      await expect(
        adapter.fork(id, config, { kind: 'branch', dropTurns: 1 }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      const from = events.length;
      await adapter.send(id, { content: [{ type: 'text', text: '[slow] 进行中 QUEBEC' }] });
      await expect(adapter.rewind(id)).rejects.toMatchObject({ code: 'session_busy' });
      await finishTurn(events, from);
    });
  },
);
