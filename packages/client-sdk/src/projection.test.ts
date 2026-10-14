import type {
  ApprovalRequest,
  Session,
  TurnId,
  WevirEvent,
  WevirEventOf,
  WevirEventPayload,
  WevirEventType,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { type ChatPart, projectTranscript, TranscriptProjection } from './projection.js';
import { applySessionEvent, applySubagentEvent } from './session-state.js';
import { identity, SES } from './test-utils.js';

const TURN: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN2: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQS';
const STREAM = 'stm_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
const STREAM2 = 'stm_01JA2B3C4D5E6F7G8H9JKMNPQS' as const;
const APPROVAL = 'apr_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;

/** 按调用顺序分配 seq 的事件构造器。 */
function events() {
  let seq = 0;
  const list: WevirEvent[] = [];
  const add = <T extends WevirEventType>(
    type: T,
    payload: WevirEventPayload<T>,
  ): WevirEventOf<T> => {
    seq += 1;
    const event = {
      seq,
      sessionId: SES,
      ts: new Date(Date.UTC(2026, 9, 13, 8, 0, 0, seq)).toISOString(),
      type,
      source: 'host',
      payload,
    } as WevirEventOf<T>;
    list.push(event);
    return event;
  };
  const turn = (turnId = TURN, text = '你好') => {
    add('user.message', { turnId, content: [{ type: 'text', text }], sentBy: identity });
    add('turn.started', { turnId });
    add('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
  };
  add('session.created', {
    workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
    cwd: '/tmp/w',
    providerId: 'deepseek-official',
    modelId: 'deepseek-chat',
  });
  return { list, add, turn };
}

function assistantParts(events: WevirEvent[], options = {}): ChatPart[] {
  const message = projectTranscript(events, options).messages.find((m) => m.role === 'assistant');
  return [...(message?.parts ?? [])];
}

function approval(toolCallId: string): ApprovalRequest {
  return {
    id: APPROVAL,
    sessionId: SES,
    turnId: TURN,
    toolCallId,
    options: [
      { optionId: 'allow', label: 'Allow once', kind: 'allow_once', category: 'allow' },
      { optionId: 'reject', label: 'Reject', kind: 'reject_once', category: 'reject' },
    ],
    detail: null,
    status: 'pending',
    createdAt: '2026-10-13T08:00:00.100Z',
  };
}

describe('TranscriptProjection：增量与已提交消息（domain-model §6.3）', () => {
  it('增量就地累加，已提交消息在原位置替换并沿用 key', () => {
    const { list, add, turn } = events();
    turn();
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'reasoning',
      text: '想',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 1,
      kind: 'text',
      text: '你',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 1,
      kind: 'text',
      text: '好',
    });
    const streaming = assistantParts(list);
    expect(streaming).toMatchObject([
      { type: 'reasoning', text: '想', state: 'streaming' },
      { type: 'text', text: '你好', state: 'streaming' },
    ]);

    add('assistant.thought', {
      turnId: TURN,
      messageId: 'm1',
      text: '想一想',
      replaces: [{ streamId: STREAM, blockIndex: 0 }],
    });
    add('assistant.message', {
      turnId: TURN,
      messageId: 'm1',
      text: '你好！',
      replaces: [{ streamId: STREAM, blockIndex: 1 }],
    });
    const done = assistantParts(list);
    expect(done).toEqual([
      { type: 'reasoning', key: streaming[0]?.key, text: '想一想', state: 'done' },
      { type: 'text', key: streaming[1]?.key, text: '你好！', state: 'done' },
    ]);
  });

  it('没有可替换的增量时追加在末尾；只含空白的已提交块不显示', () => {
    const { list, add, turn } = events();
    turn();
    add('assistant.message', { turnId: TURN, messageId: 'm1', text: '  \n', replaces: [] });
    add('assistant.message', { turnId: TURN, messageId: 'm2', text: '整条', replaces: [] });
    expect(assistantParts(list)).toMatchObject([{ type: 'text', text: '整条', state: 'done' }]);
  });

  it('替换多个块时只留第一个的位置；被替换为空白时整段移除', () => {
    const { list, add, turn } = events();
    turn();
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'text',
      text: 'a',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 1,
      kind: 'text',
      text: 'b',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM2,
      blockIndex: 0,
      kind: 'text',
      text: ' ',
    });
    add('assistant.message', {
      turnId: TURN,
      messageId: 'm1',
      text: 'ab',
      replaces: [
        { streamId: STREAM, blockIndex: 0 },
        { streamId: STREAM, blockIndex: 1 },
      ],
    });
    add('assistant.message', {
      turnId: TURN,
      messageId: 'm2',
      text: ' ',
      replaces: [{ streamId: STREAM2, blockIndex: 0 }],
    });
    expect(assistantParts(list)).toMatchObject([{ type: 'text', text: 'ab', state: 'done' }]);
  });

  it('abandoned 的 attempt 在 stream_ended 时丢弃；回合结束时丢弃仍未替换的增量', () => {
    const { list, add, turn } = events();
    turn();
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'text',
      text: '放弃',
    });
    add('assistant.stream_ended', { turnId: TURN, streamId: STREAM, outcome: 'abandoned' });
    expect(assistantParts(list)).toEqual([]);
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM2,
      blockIndex: 0,
      kind: 'text',
      text: '孤儿',
    });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 10 });
    const transcript = projectTranscript(list);
    const assistant = transcript.messages.find((m) => m.role === 'assistant');
    expect(assistant?.parts).toEqual([]);
    expect(assistant).toMatchObject({ finished: { outcome: 'completed', durationMs: 10 } });
    expect(transcript.activeTurnId).toBeUndefined();
  });

  it('回合被中断（Host 或引擎退出）时保留中断前已生成的增量，只含空白的块不留', () => {
    const { list, add, turn } = events();
    turn();
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'reasoning',
      text: '先看数据',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 1,
      kind: 'text',
      text: '第 1 段：华东',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 2,
      kind: 'text',
      text: ' ',
    });
    add('turn.finished', { turnId: TURN, outcome: 'interrupted', durationMs: 5 });
    expect(assistantParts(list)).toMatchObject([
      { type: 'reasoning', text: '先看数据', state: 'done' },
      { type: 'text', text: '第 1 段：华东', state: 'done' },
    ]);
  });
});

describe('TranscriptProjection：工具与审批', () => {
  it('工具从运行到审批再到被拒绝；未决审批按创建时间列出', () => {
    const { list, add, turn } = events();
    turn();
    add('tool.started', {
      turnId: TURN,
      toolCallId: 'call-1',
      toolName: 'write',
      display: { kind: 'write', paths: ['/x'], summary: '/x' },
      input: { file_path: '/x' },
    });
    add('approval.requested', { approval: approval('call-1') });
    let transcript = projectTranscript(list);
    expect(transcript.pendingApprovals.map((a) => a.id)).toEqual([APPROVAL]);
    expect(assistantParts(list)[0]).toMatchObject({
      type: 'tool',
      status: 'awaiting_approval',
      approval: { approvalId: APPROVAL, status: 'pending' },
    });

    add('approval.resolved', {
      approvalId: APPROVAL,
      status: 'denied',
      resolution: { reason: 'user', optionId: 'reject', decidedBy: identity },
    });
    add('tool.finished', {
      turnId: TURN,
      toolCallId: 'call-1',
      status: 'failed',
      output: { text: 'rejected', truncated: false },
    });
    transcript = projectTranscript(list);
    expect(transcript.pendingApprovals).toEqual([]);
    expect(transcript.approvals.get(APPROVAL)).toMatchObject({
      status: 'denied',
      resolution: { decidedBy: identity },
    });
    expect(assistantParts(list)[0]).toMatchObject({
      status: 'failed',
      output: { text: 'rejected' },
      approval: { status: 'denied' },
    });
  });

  it('回合结束时仍未收尾的工具显示为 unknown', () => {
    const { list, add, turn } = events();
    turn();
    add('tool.started', {
      turnId: TURN,
      toolCallId: 'call-1',
      toolName: 'bash',
      display: { kind: 'shell', command: 'sleep 9' },
    });
    expect(assistantParts(list)[0]).toMatchObject({ status: 'running' });
    add('turn.finished', { turnId: TURN, outcome: 'interrupted', durationMs: 5 });
    expect(assistantParts(list)[0]).toMatchObject({ status: 'unknown' });
  });

  it('工具更新合并输出；待办每个回合只保留一份最新的', () => {
    const { list, add, turn } = events();
    turn();
    add('tool.started', {
      turnId: TURN,
      toolCallId: 'todo-1',
      toolName: 'todo_write',
      display: { kind: 'plan' },
    });
    add('todo.updated', {
      turnId: TURN,
      toolCallId: 'todo-1',
      items: [{ content: 'a', status: 'pending' }],
    });
    add('tool.updated', {
      turnId: TURN,
      toolCallId: 'todo-1',
      output: { text: 'ok', truncated: false },
    });
    add('todo.updated', {
      turnId: TURN,
      toolCallId: 'todo-2',
      items: [{ content: 'a', status: 'completed' }],
    });
    expect(assistantParts(list)).toMatchObject([
      { type: 'tool', output: { text: 'ok' } },
      { type: 'todo', items: [{ content: 'a', status: 'completed' }] },
    ]);
  });
});

describe('TranscriptProjection：会话级事件', () => {
  it('回合内的错误进助手消息，回合外的错误与恢复、关闭成为系统消息', () => {
    const { list, add, turn } = events();
    turn();
    add('engine.error', { category: 'provider', message: '429', turnId: TURN, fatal: false });
    add('turn.finished', { turnId: TURN, outcome: 'failed', durationMs: 3 });
    add('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
    add('engine.error', { category: 'engine_exited', message: 'exit 1', fatal: true });
    add('session.state_changed', { from: 'idle', to: 'error', reason: 'engine_exited' });
    add('session.resumed', { engineVersion: '0.2.1' });
    add('session.state_changed', { from: 'error', to: 'idle', reason: 'resumed' });
    const transcript = projectTranscript(list);
    expect(transcript.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'system',
      'system',
    ]);
    expect(transcript.messages[1]?.parts).toMatchObject([{ type: 'error', category: 'provider' }]);
    expect(transcript.messages[2]?.parts).toMatchObject([{ type: 'error', fatal: true }]);
    expect(transcript.messages[3]?.parts).toMatchObject([
      { type: 'notice', notice: { kind: 'resumed', engineVersion: '0.2.1' } },
    ]);
    expect(transcript.state).toBe('idle');
    expect(transcript.lastError).toBeUndefined();
  });

  it('engine.raw 只在 includeRaw 时投影，放进进行中的回合', () => {
    const { list, add, turn } = events();
    turn();
    add('engine.raw', {
      protocol: 'acp',
      method: 'session/update',
      kind: 'plan',
      params: { a: 1 },
    });
    expect(assistantParts(list)).toEqual([]);
    expect(assistantParts(list, { includeRaw: true })).toMatchObject([
      { type: 'raw', method: 'session/update', kind: 'plan', params: { a: 1 } },
    ]);
  });
});

describe('TranscriptProjection：快照', () => {
  it('没有新事件时返回同一个快照；只有改动过的消息换新对象', () => {
    const { list, add, turn } = events();
    turn(TURN, '第一轮');
    add('assistant.message', { turnId: TURN, messageId: 'm1', text: '一', replaces: [] });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 1 });
    turn(TURN2, '第二轮');
    const projection = new TranscriptProjection();
    for (const event of list) projection.apply(event);
    const first = projection.snapshot();
    expect(projection.snapshot()).toBe(first);

    const delta = add('assistant.delta', {
      turnId: TURN2,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'text',
      text: '二',
    });
    projection.apply(delta);
    const second = projection.snapshot();
    expect(second).not.toBe(first);
    expect(second.messages.slice(0, 3)).toEqual(first.messages.slice(0, 3));
    for (let i = 0; i < 3; i++) expect(second.messages[i]).toBe(first.messages[i]);
    expect(second.messages[3]).not.toBe(first.messages[3]);
    expect(second.approvals).toBe(first.approvals);
    expect(second.lastSeq).toBe(delta.seq);
  });

  it('reset 之后从空投影重新开始', () => {
    const { list, turn } = events();
    turn();
    const projection = new TranscriptProjection();
    for (const event of list) projection.apply(event);
    projection.reset();
    expect(projection.snapshot()).toMatchObject({ messages: [], lastSeq: 0, state: undefined });
  });
});

describe('applySessionEvent', () => {
  const base: Session = {
    id: SES,
    workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
    cwd: '/tmp/w',
    engine: { kind: 'dsh', sessionId: 'e1' },
    providerId: 'deepseek-official',
    modelId: 'deepseek-chat',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    lastError: { category: 'provider', message: '旧错误' },
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
    lastSeq: 1,
  };

  it('跟上状态、标题、活动回合与最近活动时间', () => {
    const { list, add, turn } = events();
    add('session.title_changed', { title: '你好', source: 'first_prompt' });
    turn();
    add('session.state_changed', {
      from: 'running',
      to: 'awaiting_approval',
      reason: 'approval_requested',
    });
    const session = list.reduce(applySessionEvent, base);
    expect(session).toMatchObject({
      title: '你好',
      state: 'awaiting_approval',
      activeTurn: { turnId: TURN },
      lastSeq: list.length,
      updatedAt: list.at(-1)?.ts,
    });
    expect(session.lastError).toBeUndefined();
    expect(base.state).toBe('idle');
  });

  it('已应用的 seq 与别的会话的事件原样返回', () => {
    const { list } = events();
    expect(applySessionEvent(base, list[0] as WevirEvent)).toBe(base);
    const other = { ...list[0], seq: 9, sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS' } as WevirEvent;
    expect(applySessionEvent(base, other)).toBe(base);
  });
});

describe('子会话（R4）', () => {
  const CHILD = 'ses_01JA2B3C4D5E6F7G8H9JKMNPZZ' as const;
  const summary = {
    sessionId: CHILD,
    parentToolCallId: 'call_spawn_1',
    parentTurnId: TURN,
    title: 'Helper task',
    modelId: 'deepseek-chat',
    status: 'running' as const,
    startedAt: '2026-10-13T08:00:00.010Z',
    pendingApprovals: [],
  };

  it('父会话：subagents 摘要按 sessionId 更新，派出它的回合里有一个原位更新的 subagent 部件', () => {
    const { list, add, turn } = events();
    turn();
    add('subagent.started', { subagent: summary });
    const projection = new TranscriptProjection();
    for (const event of list) projection.apply(event);
    const before = projection.snapshot();
    expect(before.subagents).toEqual([summary]);
    expect(assistantParts(list)).toEqual([
      { type: 'subagent', key: `a:${CHILD}`, subagent: summary },
    ]);

    const done = { ...summary, status: 'completed' as const, endedAt: '2026-10-13T08:00:01.000Z' };
    projection.apply(add('subagent.updated', { subagent: done }));
    const after = projection.snapshot();
    expect(after.subagents).toEqual([done]);
    const parts = after.messages.find((m) => m.role === 'assistant')?.parts;
    expect(parts).toEqual([{ type: 'subagent', key: `a:${CHILD}`, subagent: done }]);
    expect(after.parent).toBeUndefined();
  });

  it('子会话：parent 取自 session.created，turn.started 的输入投影成来自父 agent 的用户消息', () => {
    const list: WevirEvent[] = [];
    let seq = 0;
    const add = <T extends WevirEventType>(type: T, payload: WevirEventPayload<T>) => {
      seq += 1;
      list.push({
        seq,
        sessionId: CHILD,
        ts: `2026-10-13T08:00:0${seq}.000Z`,
        type,
        source: 'host',
        payload,
      } as WevirEvent);
    };
    add('session.created', {
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
      cwd: '/tmp/w',
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      parent: { sessionId: SES, toolCallId: 'call_spawn_1', turnId: TURN },
    });
    add('turn.started', {
      turnId: TURN2,
      input: [{ type: 'text', text: 'Helper task\n做完说一声' }],
    });
    add('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
    add('assistant.message', { turnId: TURN2, messageId: 'm1', text: '好了', replaces: [] });
    const transcript = projectTranscript(list);
    expect(transcript.parent).toEqual({ sessionId: SES, toolCallId: 'call_spawn_1', turnId: TURN });
    const [user, assistant] = transcript.messages;
    expect(user).toMatchObject({
      role: 'user',
      turnId: TURN2,
      fromParentAgent: true,
      parts: [{ type: 'text', text: 'Helper task\n做完说一声' }],
    });
    expect(user && 'sentBy' in user).toBe(false);
    expect(assistant).toMatchObject({ role: 'assistant', turnId: TURN2 });
  });

  it('applySessionEvent 推进子会话的状态；applySubagentEvent 推进父会话的子会话列表', () => {
    const child: Session = {
      id: CHILD,
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
      cwd: '/tmp/w',
      engine: { kind: 'codex', sessionId: 'thread-child' },
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      title: 'Helper task',
      titleSource: 'first_prompt',
      state: 'idle',
      parentSessionId: SES,
      subagent: {
        parentToolCallId: 'call_spawn_1',
        status: 'running',
        startedAt: summary.startedAt,
      },
      createdAt: summary.startedAt,
      updatedAt: summary.startedAt,
      lastSeq: 2,
    };
    const event = <T extends WevirEventType>(seq: number, type: T, payload: WevirEventPayload<T>) =>
      ({
        seq,
        sessionId: CHILD,
        ts: `2026-10-13T08:00:0${seq}.000Z`,
        type,
        source: 'host',
        payload,
      }) as WevirEvent;
    let current = applySessionEvent(child, event(3, 'turn.started', { turnId: TURN2 }));
    current = applySessionEvent(
      current,
      event(4, 'turn.finished', { turnId: TURN2, outcome: 'completed', durationMs: 5 }),
    );
    expect(current.subagent).toEqual({
      parentToolCallId: 'call_spawn_1',
      status: 'completed',
      startedAt: summary.startedAt,
      endedAt: '2026-10-13T08:00:04.000Z',
    });
    current = applySessionEvent(
      current,
      event(5, 'session.state_changed', { from: 'idle', to: 'closed', reason: 'closed' }),
    );
    expect(current.subagent).toMatchObject({
      status: 'closed',
      endedAt: '2026-10-13T08:00:04.000Z',
    });

    const { add } = events();
    const started = add('subagent.started', { subagent: summary });
    const list1 = applySubagentEvent([], started);
    const done = { ...summary, status: 'completed' as const };
    const list2 = applySubagentEvent(list1, add('subagent.updated', { subagent: done }));
    expect(list1).toEqual([summary]);
    expect(list2).toEqual([done]);
    expect(
      applySubagentEvent(list2, add('usage.updated', { contextUsed: 1, contextSize: 2 })),
    ).toBe(list2);
  });
});
