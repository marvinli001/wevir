import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECHO_APPROVAL_OPTIONS, ECHO_PLAN, EchoAdapter, type EchoAdapterOptions } from './echo.js';
import { isAdapterError } from './errors.js';
import type { AgentEvent } from './events.js';
import type { SessionConfig } from './types.js';

const config: SessionConfig = { cwd: '/tmp/echo-workspace', providerId: 'echo', modelId: 'echo-1' };

let adapters: EchoAdapter[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(adapters.map((adapter) => adapter.dispose()));
  adapters = [];
});

async function open(options: EchoAdapterOptions = {}) {
  const adapter = new EchoAdapter({ stepDelayMs: 0, ...options });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession(config);
  const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
  /** 读事件直到满足条件（含该事件）。 */
  const readUntil = async (stop: (event: AgentEvent) => boolean) => {
    const read: AgentEvent[] = [];
    for (;;) {
      const next = await events.next();
      if (next.done) return read;
      read.push(next.value);
      if (stop(next.value)) return read;
    }
  };
  const send = (prompt: string) =>
    adapter.send(engineSessionId, { content: [{ type: 'text', text: prompt }] });
  return { adapter, id: engineSessionId, events, readUntil, send };
}

const settled = (event: AgentEvent) =>
  event.type === 'turn.settled' || event.type === 'turn.failed';
const types = (events: AgentEvent[]) => events.map((event) => event.type);

function textOf(events: AgentEvent[], kind: 'text' | 'reasoning'): string {
  return events
    .flatMap((event) =>
      event.type === 'assistant.delta' && event.kind === kind ? [event.text] : [],
    )
    .join('');
}

describe('EchoAdapter', () => {
  it('回显输入：先按分片发增量，再发替换它们的已提交消息', async () => {
    const session = await open({ chunkSize: 4 });
    await session.send('hello');
    const events = await session.readUntil(settled);

    expect(types(events)).toEqual([
      'assistant.delta',
      'assistant.delta',
      'assistant.delta',
      'assistant.stream_ended',
      'assistant.message',
      'usage.updated',
      'turn.settled',
    ]);
    expect(textOf(events, 'text')).toBe('Echo: hello');
    const deltas = events.filter((event) => event.type === 'assistant.delta');
    expect(deltas.map((delta) => delta.text)).toEqual(['Echo', ': he', 'llo']);
    const attemptId = deltas[0]?.attemptId;
    expect(events.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'Echo: hello',
      replaces: [{ attemptId, blockIndex: 0 }],
    });
    expect(events.at(-1)).toMatchObject({ outcome: 'completed', stopReason: 'end_turn' });
  });

  it('think：思考先于回复，assistant.thought 替换 reasoning 块，两者同一 messageId', async () => {
    const session = await open({ chunkSize: 64 });
    await session.send('think first');
    const events = await session.readUntil(settled);

    expect(textOf(events, 'reasoning')).toBe('Thinking about: think first');
    const thought = events.find((event) => event.type === 'assistant.thought');
    const message = events.find((event) => event.type === 'assistant.message');
    expect(thought).toMatchObject({
      text: 'Thinking about: think first',
      replaces: [{ blockIndex: 0 }],
    });
    expect(message).toMatchObject({ text: 'Echo: think first', replaces: [{ blockIndex: 1 }] });
    expect(thought?.messageId).toBe(message?.messageId);
    expect(events.indexOf(thought as AgentEvent)).toBeLessThan(
      events.indexOf(message as AgentEvent),
    );
  });

  it('tool：回复前模拟一次不需要审批的工具调用', async () => {
    const session = await open();
    await session.send('use a tool');
    const events = await session.readUntil(settled);

    expect(types(events).slice(0, 2)).toEqual(['tool.started', 'tool.finished']);
    const [started, finished] = events;
    expect(started).toMatchObject({
      toolName: 'echo',
      display: { kind: 'unknown' },
      input: { text: 'use a tool' },
    });
    expect(finished).toMatchObject({ status: 'completed', output: 'use a tool' });
    expect(finished?.type === 'tool.finished' && finished.toolCallId).toBe(
      started?.type === 'tool.started' && started.toolCallId,
    );
  });

  it.each([
    ['allow-once', 'completed', 'Wrote /outside-workspace/echo.txt'],
    ['reject-once', 'failed', 'Error: the user rejected echo_write'],
  ] as const)('approve：选 %s 后工具 %s，回合照常结束', async (optionId, status, output) => {
    const session = await open();
    await session.send('approve it');
    const before = await session.readUntil((event) => event.type === 'approval.requested');

    expect(types(before)).toEqual(['tool.started', 'approval.requested']);
    const request = before[1];
    if (request?.type !== 'approval.requested') throw new Error('no approval request');
    expect(request.options).toEqual(ECHO_APPROVAL_OPTIONS);
    expect(before[0]).toMatchObject({ toolCallId: request.toolCallId, display: { kind: 'write' } });

    await session.adapter.respondToApproval(session.id, request.requestId, { optionId });
    const after = await session.readUntil(settled);
    expect(after[0]).toMatchObject({
      type: 'tool.finished',
      toolCallId: request.toolCallId,
      status,
      output,
    });
    expect(after.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });

  it('ask：提两个问题，回答后写进回复；取消时提问以 question.cancelled 结束', async () => {
    const session = await open();
    await session.send('ask me');
    const before = await session.readUntil((event) => event.type === 'question.requested');
    const request = before.at(-1);
    if (request?.type !== 'question.requested') throw new Error('no question');
    expect(request.questions.map((q) => [q.id, q.multiSelect ?? false])).toEqual([
      ['scope', false],
      ['targets', true],
    ]);
    await expect(
      session.adapter.respondToQuestion(session.id, 'qst_missing', {}),
    ).rejects.toMatchObject({ code: 'question_not_found' });
    await session.adapter.respondToQuestion(session.id, request.requestId, {
      scope: ['Full stack'],
      targets: ['macOS', 'Linux'],
    });
    const after = await session.readUntil(settled);
    expect(textOf(after, 'text')).toContain('Answers: scope=Full stack; targets=macOS, Linux');

    await session.send('ask again');
    await session.readUntil((event) => event.type === 'question.requested');
    await session.adapter.cancel(session.id);
    const cancelled = await session.readUntil(settled);
    expect(cancelled[0]).toMatchObject({ type: 'question.cancelled', reason: 'turn_cancelled' });
  });

  it('plan：一份三步的清单随回合推进，回复完全部完成', async () => {
    const session = await open();
    await session.send('make a plan');
    const events = await session.readUntil(settled);
    const updates = events.flatMap((event) =>
      event.type === 'todo.updated' ? [event.items.map((item) => item.status)] : [],
    );
    expect(updates).toEqual([
      ['in_progress', 'pending', 'pending'],
      ['completed', 'in_progress', 'pending'],
      ['completed', 'completed', 'in_progress'],
      ['completed', 'completed', 'completed'],
    ]);
    const ids = new Set(events.flatMap((e) => (e.type === 'todo.updated' ? [e.toolCallId] : [])));
    expect(ids.size).toBe(1);
    expect(events.find((e) => e.type === 'todo.updated')).toMatchObject({
      items: ECHO_PLAN.map((content) => ({ content })),
    });
  });

  it('fail：回合以 turn.failed 结束，会话仍可用', async () => {
    const session = await open();
    await session.send('please fail');
    expect(await session.readUntil(settled)).toEqual([
      expect.objectContaining({ type: 'turn.failed', category: 'unknown', code: -32603 }),
    ]);
    await session.send('hello again');
    expect((await session.readUntil(settled)).at(-1)).toMatchObject({ outcome: 'completed' });
  });

  it('流式中途取消：已生成的半段作为已提交消息补发，替换已发的增量', async () => {
    const session = await open({ chunkSize: 1 });
    await session.send('a fairly long reply');
    const first = await session.readUntil((event) => event.type === 'assistant.delta');
    await session.adapter.cancel(session.id);
    const rest = await session.readUntil(settled);
    const events = [...first, ...rest];

    const partial = textOf(events, 'text');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan('Echo: a fairly long reply'.length);
    expect(types(events).slice(-3)).toEqual([
      'assistant.stream_ended',
      'assistant.message',
      'turn.settled',
    ]);
    expect(events.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: partial,
      replaces: [{ blockIndex: 0 }],
    });
    expect(events.at(-1)).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
  });

  it('审批挂起时取消：工具以 dsh 的措辞失败', async () => {
    const session = await open();
    await session.send('approve it');
    await session.readUntil((event) => event.type === 'approval.requested');
    await session.adapter.cancel(session.id);
    const events = await session.readUntil(settled);
    expect(types(events)).toEqual(['approval.cancelled', 'tool.finished', 'turn.settled']);
    expect(events[1]).toMatchObject({
      status: 'failed',
      output: 'Error: approval for echo_write was cancelled',
    });
  });

  it('incrementalStream: false 时只发已提交消息，replaces 为空', async () => {
    const session = await open({ incrementalStream: false });
    await session.send('hello');
    const events = await session.readUntil(settled);
    expect(types(events)).toEqual(['assistant.message', 'usage.updated', 'turn.settled']);
    expect(events[0]).toMatchObject({ text: 'Echo: hello', replaces: [] });
  });

  it('计时器走全局 setTimeout：假时钟下按 stepDelayMs 逐步推进', async () => {
    vi.useFakeTimers();
    const adapter = new EchoAdapter({ stepDelayMs: 10, chunkSize: 2 });
    adapters.push(adapter);
    const { engineSessionId } = await adapter.createSession(config);
    const seen: AgentEvent[] = [];
    void (async () => {
      for await (const event of adapter.subscribe(engineSessionId)) seen.push(event);
    })();

    await adapter.send(engineSessionId, { content: [{ type: 'text', text: 'hi' }] });
    // 第一步（回合开始）10 ms，第一个分片再 10 ms。
    await vi.advanceTimersByTimeAsync(19);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(types(seen)).toEqual(['assistant.delta']);
    await vi.advanceTimersByTimeAsync(10);
    expect(types(seen)).toEqual(['assistant.delta', 'assistant.delta']);
    await vi.runAllTimersAsync();
    expect(seen.at(-1)?.type).toBe('turn.settled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('simulateEngineExit：带上退出信息，不发回合结算，订阅结束', async () => {
    const session = await open();
    await session.send('approve it');
    await session.readUntil((event) => event.type === 'approval.requested');
    await session.adapter.simulateEngineExit({ exitCode: 1, signal: null, stderrTail: 'boom' });
    const events = await session.readUntil(() => false);
    expect(events).toEqual([
      expect.objectContaining({ type: 'approval.cancelled', reason: 'engine_exited' }),
      {
        type: 'engine.exited',
        engineSessionId: session.id,
        exitCode: 1,
        signal: null,
        stderrTail: 'boom',
      },
    ]);
    expect(session.adapter.pendingTimerCount).toBe(0);
  });

  it('resumeSession 拒绝与创建时不同的 cwd', async () => {
    const session = await open();
    await session.adapter.close(session.id);
    const error = await session.adapter
      .resumeSession(session.id, { ...config, cwd: '/elsewhere' })
      .catch((caught: unknown) => caught);
    expect(isAdapterError(error, 'session_unavailable')).toBe(true);
    await expect(session.adapter.resumeSession(session.id, config)).resolves.toMatchObject({
      engineSessionId: session.id,
      modelId: 'echo-1',
    });
  });
});

describe('EchoAdapter 子会话（subagent）', () => {
  async function collect(adapter: EchoAdapter, id: string, stop: (event: AgentEvent) => boolean) {
    const read: AgentEvent[] = [];
    for await (const event of adapter.subscribe(id)) {
      read.push(event);
      if (stop(event)) break;
    }
    return read;
  }

  it('父回合派出子会话、等它结束；子会话的回合由引擎开始，输入是任务描述', async () => {
    const session = await open();
    await session.send('subagent close');
    const parent = await session.readUntil(settled);
    expect(types(parent)).toEqual([
      'tool.started',
      'subagent.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'tool.started',
      'subagent.updated',
      'tool.finished',
      'assistant.delta',
      'assistant.delta',
      'assistant.delta',
      'assistant.delta',
      'assistant.delta',
      'assistant.stream_ended',
      'assistant.message',
      'usage.updated',
      'turn.settled',
    ]);
    const started = parent[1];
    if (started?.type !== 'subagent.started') throw new Error('没有 subagent.started');
    expect(started).toMatchObject({
      engineSessionId: session.id,
      parentToolCallId: (parent[0] as { toolCallId: string }).toolCallId,
      title: 'Helper task: helper close',
      prompt: 'Helper task: helper close',
      modelId: 'echo-1',
    });
    expect(parent[6]).toMatchObject({
      childEngineSessionId: started.childEngineSessionId,
      closed: true,
    });

    // 子会话的事件在订阅之前就发完了，订阅仍能拿到（bufferUntilSubscribed）。
    const child = await collect(session.adapter, started.childEngineSessionId, settled);
    expect(child[0]).toEqual({
      type: 'turn.started',
      engineSessionId: started.childEngineSessionId,
      input: [{ type: 'text', text: 'Helper task: helper close' }],
    });
    expect(child.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    await expect(
      session.adapter.send(started.childEngineSessionId, {
        content: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toSatisfy((error) => isAdapterError(error, 'invalid_input'));
  });

  it('取消父回合不动子会话（与 Codex 相同）；取消子会话才结束它的回合', async () => {
    const session = await open();
    await session.send('subagent approve');
    const head = await session.readUntil((event) => event.type === 'subagent.started');
    const started = head.at(-1);
    if (started?.type !== 'subagent.started') throw new Error('没有 subagent.started');
    const childId = started.childEngineSessionId;
    const childEvents = session.adapter.subscribe(childId)[Symbol.asyncIterator]();
    const childUntil = async (stop: (event: AgentEvent) => boolean) => {
      const read: AgentEvent[] = [];
      for (;;) {
        const next = await childEvents.next();
        if (next.done) return read;
        read.push(next.value);
        if (stop(next.value)) return read;
      }
    };
    await childUntil((event) => event.type === 'approval.requested');

    await session.adapter.cancel(session.id);
    expect((await session.readUntil(settled)).at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect(await session.adapter.listPendingApprovals(childId)).toHaveLength(1);

    await session.adapter.cancel(childId);
    const rest = await childUntil(settled);
    expect(rest.find((event) => event.type === 'approval.cancelled')).toMatchObject({
      reason: 'turn_cancelled',
    });
    expect(rest.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
  });
});
