// 会话目标（0.35.0，codex-event-mapping.md §6.13）：真实 codex-app-server + 网关 + mock 模型。第一个回合由 startGoal 开，之后
// Codex 在 thread 空闲时自己开回合接着做；mock 模型在续跑的回合里调 update_goal 把目标标为完成。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  type MockView,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 会话目标');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['?'] });
const adapters: CodexAdapter[] = [];

/** Codex 续跑回合的提示词开头（ext/goal/templates/goals/continuation.md）。 */
const CONTINUATION = 'Continue working toward the active thread goal.';

function lastInputText(view: MockView): string {
  return JSON.stringify(view.body.input.at(-1) ?? '');
}

function toolNames(view: MockView): string[] {
  const tools = (view.body as { tools?: Array<{ name?: string }> }).tools ?? [];
  return tools.flatMap((tool) => (typeof tool.name === 'string' ? [tool.name] : []));
}

/** 续跑的回合调 update_goal 标为完成，工具结果回来后收尾；其余回合回一句话。 */
const completeOnContinuation: MockScript = (view) => {
  if (view.toolOutputs.length > 0) return { text: ['目标已完成。'] };
  if (lastInputText(view).includes(CONTINUATION)) {
    return { toolCalls: [{ kind: 'function', name: 'update_goal', args: { status: 'complete' } }] };
  }
  return { text: ['先看看现状。'] };
};

const OBJECTIVE = '把 a.txt 的内容改成 b';

async function open() {
  const { home, workspace } = dirs.make('goal');
  const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return {
    adapter,
    id: engineSessionId,
    events: collectEvents(adapter, engineSessionId),
    home,
    workspace,
  };
}

async function startGoal(adapter: CodexAdapter, id: string, objective = OBJECTIVE): Promise<void> {
  await adapter.startGoal(id, {
    objective,
    input: { content: [{ type: 'text', text: objective }] },
  });
}

function goalStatuses(events: readonly AgentEvent[]): Array<string | null> {
  return events.filter(ofType('goal.updated')).map((event) => event.goal?.status ?? null);
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 会话目标（真实 codex-app-server）',
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

    it('startGoal：第一个回合之后 Codex 自己开续跑回合（turn.started 带 trigger），模型标完成后不再续跑', async () => {
      const { adapter, id, events } = await open();
      script = completeOnContinuation;
      await startGoal(adapter, id);
      const first = await finishTurn(events, 0);
      expect(first.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      // 第一个请求就带着三个目标工具，输入是目标本身。
      const firstRequest = mock.requests.at(0)?.body;
      expect(JSON.stringify(firstRequest?.input)).toContain(OBJECTIVE);
      const names = toolNames({
        index: 0,
        lastUserText: '',
        toolOutputs: [],
        body: firstRequest as never,
      });
      expect(names).toEqual(expect.arrayContaining(['get_goal', 'create_goal', 'update_goal']));

      const started = await waitForEvent(events, ofType('turn.started'), '续跑回合', first.length);
      expect(started).toEqual({ type: 'turn.started', engineSessionId: id, trigger: 'goal' });
      const continuation = await finishTurn(events, events.indexOf(started));
      expect(continuation.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      // 目标工具的调用不产生 item（不报 tool.*），只有目标的变化。
      expect(continuation.some((event) => event.type === 'tool.started')).toBe(false);
      expect(goalStatuses(continuation)).toContain('complete');
      await waitForEvent(
        events,
        (event): event is AgentEvent =>
          event.type === 'goal.updated' && event.goal?.status === 'complete',
        '目标完成',
      );
      const statuses = goalStatuses(events);
      expect(statuses.slice(0, 2)).toEqual(['paused', 'active']);
      expect(statuses.at(-1)).toBe('complete');
      const complete = events.filter(ofType('goal.updated')).at(-1)?.goal;
      expect(complete).toMatchObject({ objective: OBJECTIVE, status: 'complete' });
      expect(complete?.tokensUsed).toBeGreaterThan(0);
      // 完成之后没有新的回合。
      const count = events.filter(ofType('turn.started')).length;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(events.filter(ofType('turn.started'))).toHaveLength(count);
    });

    it('停止续跑回合时先暂停目标，之后不再续跑；clearGoal 清掉它', async () => {
      const { adapter, id, events } = await open();
      script = (view) =>
        lastInputText(view).includes(CONTINUATION)
          ? { text: ['慢', '慢', '地', '做'], delayMs: 400 }
          : { text: ['先看看现状。'] };
      await startGoal(adapter, id);
      const first = await finishTurn(events, 0);
      const started = await waitForEvent(events, ofType('turn.started'), '续跑回合', first.length);
      await waitForEvent(
        events,
        ofType('assistant.delta'),
        '续跑回合开始输出',
        events.indexOf(started),
      );
      await adapter.cancel(id);
      expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
      expect(goalStatuses(events).at(-1)).toBe('paused');
      const count = events.filter(ofType('turn.started')).length;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(events.filter(ofType('turn.started'))).toHaveLength(count);

      expect(await adapter.clearGoal(id)).toBe(true);
      await waitForEvent(
        events,
        (event): event is AgentEvent => event.type === 'goal.updated' && event.goal === null,
        '目标清除',
      );
      expect(await adapter.clearGoal(id)).toBe(false);
    });

    it('重启后恢复会话：目标还在；继续时适配器先用当前设置开一个回合，之后 Codex 续跑到完成', async () => {
      const { adapter, id, events, home, workspace } = await open();
      script = (view) => ({
        text: [lastInputText(view).includes(CONTINUATION) ? '续' : '先看看现状。'],
      });
      await startGoal(adapter, id);
      await finishTurn(events, 0);
      const paused = await adapter.updateGoal(id, 'paused');
      expect(paused).toMatchObject({ objective: OBJECTIVE, status: 'paused' });
      // 暂停之后可能还有一个已经开始的续跑回合，等它结束。
      await new Promise((resolve) => setTimeout(resolve, 500));
      await adapter.dispose();

      const restarted = newAdapter({ home, providers: [mockProvider(mock)] });
      adapters.push(restarted);
      await restarted.resumeSession(id, {
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const after = collectEvents(restarted, id);
      script = completeOnContinuation;
      const resumed = await restarted.updateGoal(id, 'active');
      expect(resumed).toMatchObject({ objective: OBJECTIVE, status: 'active' });
      // 适配器开的回合：先报 turn.started（trigger: goal），空输入。
      expect(after[0]).toEqual({ type: 'turn.started', engineSessionId: id, trigger: 'goal' });
      await waitForEvent(
        after,
        (event): event is AgentEvent =>
          event.type === 'goal.updated' && event.goal?.status === 'complete',
        '目标完成',
      );
      expect(after.filter(ofType('turn.started')).length).toBeGreaterThanOrEqual(2);
    });
  },
);
