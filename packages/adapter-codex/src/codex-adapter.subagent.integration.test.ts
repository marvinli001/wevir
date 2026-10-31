// 子会话（R4，codex-event-mapping.md §6.5）：真实 codex-app-server + 网关 + mock 模型。派出与等待（spawn → wait，与 Spike
// 的 subagent 场景同一个脚本）、父回合不等子 agent、close_agent、父回合取消时子 agent 不受影响（Codex 不级联，Host 自己
// 级联，domain-model §4.5）、agentsStates 报 notFound 的 receiver 不当作子会话。契约条款（订阅、审批、取消子回合）在
// codex-adapter.contract.integration.test.ts。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  finishTurn,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  defaultMockScript,
  MOCK_MODEL,
  type MockModel,
  type MockReply,
  type MockScript,
  type MockView,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 子会话集成测试');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = defaultMockScript;
let adapters: CodexAdapter[] = [];

function spawn(message: string): MockReply {
  return {
    toolCalls: [
      { kind: 'function', namespace: 'multi_agent_v1', name: 'spawn_agent', args: { message } },
    ],
  };
}

function agentId(view: MockView): string {
  const output = view.toolOutputs[0] ?? '';
  return /"(?:agent_id|id)"\s*:\s*"([^"]+)"/.exec(output)?.[1] ?? output;
}

/** 子 agent 慢慢回答（约 1.5 s），给取消用。 */
const SLOW_CHILD: MockReply = {
  text: Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 段。`),
  delayMs: 100,
};

async function open(): Promise<{ adapter: CodexAdapter; id: string; events: AgentEvent[] }> {
  const { home, workspace } = dirs.make('subagent');
  const adapter = newAdapter({ home, providers: [mockProvider(mock)], logger: collectingLogger() });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId) };
}

describe.skipIf(binary === undefined)('子会话 + 真实 codex-app-server', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    mock = await startMockModel((view) => script(view));
  });
  afterEach(async () => {
    script = defaultMockScript;
    await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
    adapters = [];
  });
  afterAll(async () => {
    await mock?.close();
    dirs.cleanup();
  });

  it('spawn → wait：子会话的事件在它自己的流里，父回合等它结束；昵称随后补上', async () => {
    const { adapter, id, events } = await open();
    const parentTurn = await runTurn(adapter, id, '派一个子智能体去做', events);
    expect(parentTurn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });

    const started = parentTurn.find(ofType('subagent.started'));
    if (started === undefined) throw new Error('父回合里没有 subagent.started');
    const spawnTool = parentTurn.find(
      (event) =>
        event.type === 'tool.started' && event.toolName === 'collabAgentToolCall.spawnAgent',
    );
    expect(started).toMatchObject({
      engineSessionId: id,
      parentToolCallId: spawnTool?.type === 'tool.started' ? spawnTool.toolCallId : undefined,
      title: 'Helper task: 派一个子智能体去做',
      prompt: 'Helper task: 派一个子智能体去做\n做完说一声。',
      modelId: MOCK_MODEL,
    });
    // wait 的工具调用在子回合结束之后才完成。
    const waitTool = parentTurn.find(
      (event) => event.type === 'tool.started' && event.toolName === 'collabAgentToolCall.wait',
    );
    expect(waitTool).toBeDefined();

    const child = collectEvents(adapter, started.childEngineSessionId);
    const childEnd = await waitForEvent(child, ofType('turn.settled'), '子回合结束');
    expect(childEnd.outcome).toBe('completed');
    expect(child[0]).toMatchObject({
      type: 'turn.started',
      input: [{ type: 'text', text: 'Helper task: 派一个子智能体去做\n做完说一声。' }],
    });
    expect(child.find(ofType('assistant.message'))?.text).toBe('子 agent 完成了。');
    expect(child.every((event) => event.engineSessionId === started.childEngineSessionId)).toBe(
      true,
    );

    // thread/read 的昵称：有任务描述时不改标题。
    const updated = await waitForEvent(events, ofType('subagent.updated'), 'subagent.updated');
    expect(updated).toMatchObject({ childEngineSessionId: started.childEngineSessionId });
    expect(updated.nickname).toEqual(expect.any(String));
    expect(updated.title).toBeUndefined();
  });

  it('父回合不等子 agent：父回合先结束，子会话照常跑完', async () => {
    script = (view) => {
      if (view.lastUserText.startsWith('Helper task')) return { text: ['Helper', ' done.'] };
      if (view.toolOutputs.length > 0) return { text: ['Spawned.'] };
      return spawn('Helper task\nSay done.');
    };
    const { adapter, id, events } = await open();
    const parentTurn = await runTurn(adapter, id, 'spawn', events);
    const started = parentTurn.find(ofType('subagent.started'));
    if (started === undefined) throw new Error('父回合里没有 subagent.started');
    expect(started.title).toBe('Helper task');
    const child = collectEvents(adapter, started.childEngineSessionId);
    await waitForEvent(child, ofType('turn.settled'), '子回合结束');
    expect(child.find(ofType('assistant.message'))?.text).toBe('Helper done.');
  });

  it('父回合先结束、子 agent 之后跑完：父会话空闲时开一个引擎回合叫醒它，输入带子 agent 的回答', async () => {
    script = (view) => {
      if (view.lastUserText.startsWith('Helper task')) {
        return { text: ['Helper', ' done.'], delayMs: 200 };
      }
      if (view.lastUserText.includes('after your previous turn ended')) return { text: ['收到。'] };
      if (view.toolOutputs.length > 0) return { text: ['Spawned.'] };
      return spawn('Helper task\nSay done.');
    };
    const { adapter, id, events } = await open();
    const parentTurn = await runTurn(adapter, id, 'spawn', events);
    expect(parentTurn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    const started = parentTurn.find(ofType('subagent.started'));
    if (started === undefined) throw new Error('父回合里没有 subagent.started');
    const from = events.length;
    await waitForEvent(events, ofType('turn.started'), '叫醒父会话的回合', from);
    const wake = await finishTurn(events, from);
    // Nickname updates can arrive before the wake-up turn starts.
    expect(wake.filter(ofType('turn.started'))).toEqual([
      { type: 'turn.started', engineSessionId: id },
    ]);
    expect(wake.find(ofType('assistant.message'))?.text).toBe('收到。');
    expect(wake.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    const request = mock.requests.at(-1);
    const note = JSON.stringify(request?.body.input.at(-1));
    expect(note).toContain(started.childEngineSessionId);
    expect(note).toContain('Helper done.');
  });

  it('派出子 agent 的父回合被取消：子 agent 之后跑完不叫醒父会话', async () => {
    script = (view) => {
      if (view.lastUserText.startsWith('Helper task')) return SLOW_CHILD;
      if (view.toolOutputs.length > 0) return SLOW_CHILD;
      return spawn('Helper task\nSay done.');
    };
    const { adapter, id, events } = await open();
    const from = events.length;
    await adapter.send(id, { content: [{ type: 'text', text: 'spawn' }] });
    const started = await waitForEvent(
      events,
      ofType('subagent.started'),
      'subagent.started',
      from,
    );
    const child = collectEvents(adapter, started.childEngineSessionId);
    await adapter.cancel(id);
    const parentTurn = await finishTurn(events, from);
    expect(parentTurn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    const childEnd = await waitForEvent(child, ofType('turn.settled'), '子回合结束');
    expect(childEnd.outcome).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(events.slice(from + parentTurn.length).filter(ofType('turn.started'))).toEqual([]);
  });

  it('close_agent：父会话的流里报 subagent.updated（closed），子回合被中断', async () => {
    script = (view) => {
      if (view.lastUserText.startsWith('Helper task')) return SLOW_CHILD;
      if (view.toolOutputs.length === 0) return spawn('Helper task\nTake your time.');
      if (view.toolOutputs.length === 1) {
        return {
          toolCalls: [
            {
              kind: 'function',
              namespace: 'multi_agent_v1',
              name: 'close_agent',
              args: { target: agentId(view) },
            },
          ],
        };
      }
      return { text: ['Closed it.'] };
    };
    const { adapter, id, events } = await open();
    const parentTurn = await runTurn(adapter, id, 'spawn and close', events);
    const started = parentTurn.find(ofType('subagent.started'));
    if (started === undefined) throw new Error('父回合里没有 subagent.started');
    const closed = await waitForEvent(
      events,
      (event): event is Extract<AgentEvent, { type: 'subagent.updated' }> =>
        event.type === 'subagent.updated' && event.closed === true,
      'subagent.updated（closed）',
    );
    expect(closed.childEngineSessionId).toBe(started.childEngineSessionId);
    const child = collectEvents(adapter, started.childEngineSessionId);
    const childEnd = await waitForEvent(child, ofType('turn.settled'), '子回合结束');
    expect(childEnd.outcome).toBe('cancelled');
  });

  it('取消父回合：Codex 不动子 agent，子回合照常跑完（Host 自己级联取消）', async () => {
    script = (view) => {
      if (view.lastUserText.startsWith('Helper task')) return SLOW_CHILD;
      if (view.toolOutputs.length === 0) return spawn('Helper task\nTake your time.');
      return {
        toolCalls: [
          {
            kind: 'function',
            namespace: 'multi_agent_v1',
            name: 'wait_agent',
            args: { targets: [agentId(view)], timeout_ms: 30_000 },
          },
        ],
      };
    };
    const { adapter, id, events } = await open();
    await adapter.send(id, { content: [{ type: 'text', text: 'spawn and wait' }] });
    const started = await waitForEvent(events, ofType('subagent.started'), 'subagent.started');
    const child = collectEvents(adapter, started.childEngineSessionId);
    await waitForEvent(child, ofType('assistant.delta'), '子 agent 开始回答');
    // 子 agent 先开始回答时，父 agent 的 wait 可能还没发出；等它开始了再取消，否则下面找不到 wait 的结果。
    await waitForEvent(
      events,
      (event): event is Extract<AgentEvent, { type: 'tool.started' }> =>
        event.type === 'tool.started' && event.toolName === 'collabAgentToolCall.wait',
      '父 agent 开始等待',
    );

    await adapter.cancel(id);
    const parentEnd = await waitForEvent(events, ofType('turn.settled'), '父回合结束');
    expect(parentEnd.outcome).toBe('cancelled');
    // 等待中的 wait 没有 item/completed，按失败收尾。
    const waitTool = events.find(
      (event) => event.type === 'tool.started' && event.toolName === 'collabAgentToolCall.wait',
    );
    expect(
      events.find(
        (event) =>
          event.type === 'tool.finished' &&
          waitTool?.type === 'tool.started' &&
          event.toolCallId === waitTool.toolCallId,
      ),
    ).toMatchObject({ status: 'failed' });

    expect(child.some((event) => event.type === 'turn.settled')).toBe(false);
    const childEnd = await waitForEvent(child, ofType('turn.settled'), '子回合照常结束');
    expect(childEnd.outcome).toBe('completed');
  });

  it('单独停掉子 agent（0.14.0）：子回合 cancelled，父 thread 补上说明，父 agent 下一次请求看得到', async () => {
    const seen: { index: number; inTurn: 'first' | 'next' }[] = [];
    let turn: 'first' | 'next' = 'first';
    script = (view) => {
      if (view.lastUserText.startsWith('Helper task')) return SLOW_CHILD;
      if (JSON.stringify(view.body).includes('The user stopped the sub-agent')) {
        seen.push({ index: view.index, inTurn: turn });
        return { text: ['Noted.'] };
      }
      if (view.lastUserText === 'next') return { text: ['Next.'] };
      if (view.toolOutputs.length === 0) return spawn('Helper task\nTake your time.');
      if (view.toolOutputs.length === 1) {
        return {
          toolCalls: [
            {
              kind: 'function',
              namespace: 'multi_agent_v1',
              name: 'wait_agent',
              args: { targets: [agentId(view)], timeout_ms: 3_000 },
            },
          ],
        };
      }
      return { text: ['Waited.'] };
    };
    const { adapter, id, events } = await open();
    await adapter.send(id, { content: [{ type: 'text', text: 'spawn and wait' }] });
    const started = await waitForEvent(events, ofType('subagent.started'), 'subagent.started');
    const child = collectEvents(adapter, started.childEngineSessionId);
    await waitForEvent(child, ofType('assistant.delta'), '子 agent 开始回答');

    await adapter.cancel(started.childEngineSessionId, { notifyParent: true });
    const childEnd = await waitForEvent(child, ofType('turn.settled'), '子回合结束');
    expect(childEnd.outcome).toBe('cancelled');
    // 父回合不受影响：wait_agent 等到自己的超时，然后照常结束。
    const parentEnd = await waitForEvent(events, ofType('turn.settled'), '父回合结束');
    expect(parentEnd.outcome).toBe('completed');
    turn = 'next';
    await runTurn(adapter, id, 'next', events);
    // 实测：wait_agent 超时之后，同一回合里父 agent 的下一次请求就带着这条说明，之后的回合也在历史里。
    expect(seen.map((item) => item.inTurn)).toEqual(['first', 'next']);
  });

  it('agentsStates 报 notFound 的 receiver 不当作子会话', async () => {
    const missing = '01a13896-0000-7000-8000-000000000001';
    script = (view) => {
      if (view.toolOutputs.length > 0) return { text: ['No such agent.'] };
      return {
        toolCalls: [
          {
            kind: 'function',
            namespace: 'multi_agent_v1',
            name: 'wait_agent',
            args: { targets: [missing], timeout_ms: 1000 },
          },
        ],
      };
    };
    const { adapter, id, events } = await open();
    const parentTurn = await runTurn(adapter, id, 'wait for nobody', events);
    expect(parentTurn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(parentTurn.some((event) => event.type.startsWith('subagent.'))).toBe(false);
  });
});
