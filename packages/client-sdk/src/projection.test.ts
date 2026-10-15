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
import {
  type ChatPart,
  projectTranscript,
  TranscriptProjection,
  userContentText,
} from './projection.js';
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
      {
        type: 'reasoning',
        key: streaming[0]?.key,
        text: '想一想',
        state: 'done',
        // 起止沿用增量：从回合开始（seq 3）到最后一段思考增量（seq 5）。
        startedAt: '2026-10-13T08:00:00.003Z',
        endedAt: '2026-10-13T08:00:00.005Z',
      },
      { type: 'text', key: streaming[1]?.key, text: '你好！', state: 'done' },
    ]);
  });

  it('思考的起止：从回合上一次有输出算起，等审批的时间不算；没有增量时结束于已提交思考', () => {
    const { list, add, turn } = events();
    turn();
    add('tool.started', {
      turnId: TURN,
      toolCallId: 'call_1',
      toolName: 'shell',
      display: { kind: 'shell' },
      input: {},
    });
    add('approval.requested', { approval: approval('call_1') });
    add('approval.resolved', {
      approvalId: APPROVAL,
      status: 'approved',
      resolution: { optionId: 'allow', decidedBy: identity, reason: 'user' },
    });
    add('tool.finished', { turnId: TURN, toolCallId: 'call_1', status: 'completed' });
    add('usage.updated', { contextUsed: 1, contextSize: 2 });
    add('assistant.thought', { turnId: TURN, messageId: 'm1', text: '再想想', replaces: [] });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'reasoning',
      text: '还',
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'reasoning',
      text: '有',
    });
    const [, committed, streaming] = assistantParts(list);
    // 已提交的思考（seq 10）从工具收尾（seq 8）算起，usage 不算输出。
    expect(committed).toMatchObject({
      type: 'reasoning',
      startedAt: '2026-10-13T08:00:00.008Z',
      endedAt: '2026-10-13T08:00:00.010Z',
    });
    // 增量里的思考从上一段思考（seq 10）算到最后一段增量（seq 12）。
    expect(streaming).toMatchObject({
      type: 'reasoning',
      state: 'streaming',
      startedAt: '2026-10-13T08:00:00.010Z',
      endedAt: '2026-10-13T08:00:00.012Z',
    });
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

  it('接力（0.25.0）在切换处成为一条系统消息，带新旧两头；摘要不进消息', () => {
    const { list, add, turn } = events();
    turn();
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 3 });
    add('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
    add('session.handoff', {
      from: { providerId: 'deepseek-official', modelId: 'deepseek-chat', engineSessionId: 'e1' },
      to: { providerId: 'claude', modelId: 'claude-opus-5-5', engineSessionId: 'e2' },
      permissionMode: 'on_request',
      resumed: false,
      strategy: 'full_thread_summary',
      covered: { fromSeq: 1, toSeq: 6 },
      items: 2,
      omittedItems: 0,
      context: 'Context handoff (full_thread_summary):\n…',
    });
    const transcript = projectTranscript(list);
    expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
    expect(transcript.messages[2]?.parts).toEqual([
      {
        type: 'notice',
        key: `n:${list.length}`,
        notice: {
          kind: 'handoff',
          providerId: 'claude',
          modelId: 'claude-opus-5-5',
          fromProviderId: 'deepseek-official',
          fromModelId: 'deepseek-chat',
          resumed: false,
        },
      },
    ]);
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

describe('计划模式（0.36.0）', () => {
  it('计划是回合里的 plan 部件，同一 planId 原位替换；latestPlan 与 collaborationMode 跟着最近一条消息', () => {
    const { list, add } = events();
    add('user.message', {
      turnId: TURN,
      content: [{ type: 'text', text: '先出计划' }],
      sentBy: identity,
      collaborationMode: 'plan',
    });
    add('turn.started', { turnId: TURN });
    add('plan.proposed', { turnId: TURN, planId: 'p1', text: '# A' });
    add('plan.proposed', { turnId: TURN, planId: 'p1', text: '# B' });
    let transcript = projectTranscript(list);
    expect(transcript.collaborationMode).toBe('plan');
    expect(transcript.messages[0]).toMatchObject({ role: 'user', collaborationMode: 'plan' });
    expect(transcript.messages[1]?.parts).toEqual([
      { type: 'plan', key: 'p:p1', planId: 'p1', text: '# B', state: 'done' },
    ]);
    expect(transcript.latestPlan).toMatchObject({ turnId: TURN, planId: 'p1', text: '# B' });

    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    add('user.message', {
      turnId: TURN2,
      content: [{ type: 'text', text: '实施' }],
      sentBy: identity,
    });
    transcript = projectTranscript(list);
    expect(transcript.collaborationMode).toBe('default');
    expect(transcript.latestPlan).toBeUndefined();
    expect(transcript.messages.at(-1)).not.toHaveProperty('collaborationMode');
    // 计划部件留在给出它的回合里。
    expect(transcript.messages[1]?.parts[0]).toMatchObject({ type: 'plan', text: '# B' });
  });

  it('计划的增量（0.37.0）：写的时候就是 streaming 的 plan 部件，plan.proposed 以全文替换；预览不算 latestPlan', () => {
    const { list, add } = events();
    add('user.message', {
      turnId: TURN,
      content: [{ type: 'text', text: '先出计划' }],
      sentBy: identity,
      collaborationMode: 'plan',
    });
    add('turn.started', { turnId: TURN });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'text',
      text: '看过了。',
    });
    add('plan.delta', { turnId: TURN, planId: 'p1', text: '\n# 导' });
    add('plan.delta', { turnId: TURN, planId: 'p1', text: '出\n\n- 一' });
    let transcript = projectTranscript(list);
    expect(transcript.messages[1]?.parts.at(-1)).toEqual({
      type: 'plan',
      key: 'p:p1',
      planId: 'p1',
      text: '\n# 导出\n\n- 一',
      state: 'streaming',
    });
    expect(transcript.latestPlan).toBeUndefined();

    add('plan.proposed', { turnId: TURN, planId: 'p1', text: '# 导出\n\n- 一\n- 二' });
    // 给出之后迟到的增量（没有 restart）不再追加。
    add('plan.delta', { turnId: TURN, planId: 'p1', text: '迟到' });
    transcript = projectTranscript(list);
    const parts = transcript.messages[1]?.parts ?? [];
    expect(parts.filter((part) => part.type === 'plan')).toEqual([
      { type: 'plan', key: 'p:p1', planId: 'p1', text: '# 导出\n\n- 一\n- 二', state: 'done' },
    ]);
    expect(parts.findIndex((part) => part.type === 'plan')).toBe(1);
    expect(transcript.latestPlan).toMatchObject({ planId: 'p1', text: '# 导出\n\n- 一\n- 二' });

    // 从头重写：给出过的计划也作废，latestPlan 清空，等新的全文。
    add('plan.delta', { turnId: TURN, planId: 'p1', text: '# 第二版', restart: true });
    transcript = projectTranscript(list);
    expect(transcript.messages[1]?.parts[1]).toMatchObject({
      text: '# 第二版',
      state: 'streaming',
    });
    expect(transcript.latestPlan).toBeUndefined();
    add('plan.proposed', { turnId: TURN, planId: 'p1', text: '# 第二版' });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    transcript = projectTranscript(list);
    // 没被替换的文本增量在回合结束时去掉（§6.3），计划留下。
    expect(transcript.messages[1]?.parts).toMatchObject([{ text: '# 第二版', state: 'done' }]);
    expect(transcript.latestPlan).toMatchObject({ text: '# 第二版' });
  });

  it('回合结束时没写完的计划（0.37.0）：留下已写出的部分（incomplete），只有空白的去掉；都不是 latestPlan', () => {
    for (const outcome of ['cancelled', 'failed', 'interrupted', 'completed'] as const) {
      const { list, add } = events();
      add('user.message', {
        turnId: TURN,
        content: [{ type: 'text', text: '先出计划' }],
        sentBy: identity,
        collaborationMode: 'plan',
      });
      add('turn.started', { turnId: TURN });
      add('plan.delta', { turnId: TURN, planId: 'p1', text: '# 写到一半' });
      add('plan.delta', { turnId: TURN, planId: 'p2', text: ' \n' });
      add('turn.finished', { turnId: TURN, outcome, durationMs: 5 });
      const transcript = projectTranscript(list);
      expect(transcript.messages[1]?.parts, outcome).toEqual([
        { type: 'plan', key: 'p:p1', planId: 'p1', text: '# 写到一半', state: 'incomplete' },
      ]);
      expect(transcript.latestPlan).toBeUndefined();
    }
  });

  it('applySessionEvent：会话的 collaborationMode 跟着 user.message', () => {
    const { add } = events();
    const base = { id: SES, lastSeq: 1 } as Session;
    const planned = applySessionEvent(
      base,
      add('user.message', {
        turnId: TURN,
        content: [{ type: 'text', text: 'x' }],
        sentBy: identity,
        collaborationMode: 'plan',
      }),
    );
    expect(planned.collaborationMode).toBe('plan');
    const back = applySessionEvent(
      planned,
      add('user.message', {
        turnId: TURN2,
        content: [{ type: 'text', text: 'y' }],
        sentBy: identity,
      }),
    );
    expect(back).not.toHaveProperty('collaborationMode');
  });
});

describe('提问（0.10.0）', () => {
  it('提问是回合里的一个部件，等回答时在 pendingQuestions；结束后原位换成带结局的', () => {
    const { list, add, turn } = events();
    turn();
    const question = {
      id: 'qst_01JA2B3C4D5E6F7G8H9JKMNPQR' as const,
      sessionId: SES,
      turnId: TURN,
      questions: [{ id: 'scope', question: '做到哪一步？', options: [{ label: '全链路' }] }],
      status: 'pending' as const,
      createdAt: '2026-10-13T08:00:00.000Z',
    };
    add('question.requested', { question });
    const projection = new TranscriptProjection();
    for (const event of list) projection.apply(event);
    let snapshot = projection.snapshot();
    expect(snapshot.pendingQuestions.map((q) => q.id)).toEqual([question.id]);
    expect(snapshot.messages.at(-1)?.parts.at(-1)).toMatchObject({
      type: 'question',
      question: { id: question.id, status: 'pending' },
    });
    const resolved = add('question.resolved', {
      questionId: question.id,
      status: 'answered',
      resolution: {
        reason: 'user',
        answers: { scope: { answers: ['全链路'] } },
        answeredBy: identity,
      },
    });
    projection.apply(resolved);
    snapshot = projection.snapshot();
    expect(snapshot.pendingQuestions).toEqual([]);
    expect(snapshot.messages.at(-1)?.parts.at(-1)).toMatchObject({
      type: 'question',
      question: { status: 'answered', resolution: { answers: { scope: { answers: ['全链路'] } } } },
    });
    const base: Session = {
      id: SES,
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
      cwd: '/tmp/w',
      engine: { kind: 'echo', sessionId: 'e1' },
      providerId: 'p',
      modelId: 'm',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      createdAt: '2026-10-13T08:00:00.000Z',
      updatedAt: '2026-10-13T08:00:00.000Z',
      lastSeq: 1,
    };
    expect(list.slice(0, -1).reduce(applySessionEvent, base).awaitingInput).toBe(true);
    expect(list.reduce(applySessionEvent, base).awaitingInput).toBeUndefined();
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

  it('换模型与推理档位（0.9.0）：没给档位时清掉', () => {
    const { list, add } = events();
    add('session.configured', { modelId: 'deepseek-v4-pro', reasoningEffort: 'high' });
    const configured = list.reduce(applySessionEvent, base);
    expect(configured).toMatchObject({ modelId: 'deepseek-v4-pro', reasoningEffort: 'high' });
    add('session.configured', { modelId: 'deepseek-chat' });
    const cleared = list.reduce(applySessionEvent, base);
    expect(cleared.modelId).toBe('deepseek-chat');
    expect(cleared.reasoningEffort).toBeUndefined();

    // 权限模式（0.11.0）：带了就跟着变；不带（旧 Host）即 on_request。
    add('session.configured', { modelId: 'deepseek-chat', permissionMode: 'full_access' });
    expect(list.reduce(applySessionEvent, base).permissionMode).toBe('full_access');
    add('session.configured', { modelId: 'deepseek-chat' });
    expect(list.reduce(applySessionEvent, base).permissionMode).toBeUndefined();
  });

  it('接力（0.25.0）：Provider、模型、引擎会话与权限模式换成新的，档位没给时清掉，只读解除', () => {
    const { list, add } = events();
    add('session.configured', { modelId: 'deepseek-v4-pro', reasoningEffort: 'high' });
    add('session.handoff', {
      from: { providerId: 'deepseek-official', modelId: 'deepseek-chat', engineSessionId: 'e1' },
      to: { providerId: 'claude', modelId: 'claude-opus-5-5', engineSessionId: 'e2' },
      permissionMode: 'on_request',
      resumed: false,
      strategy: 'full_thread_summary',
      covered: { fromSeq: 1, toSeq: 6 },
      items: 2,
      omittedItems: 0,
      context: 'Context handoff (full_thread_summary):\n…',
    });
    const session = list.reduce(applySessionEvent, {
      ...base,
      readOnly: { reason: 'engine_session_not_found', message: 'gone', since: base.createdAt },
    });
    expect(session).toMatchObject({
      providerId: 'claude',
      modelId: 'claude-opus-5-5',
      engine: { kind: base.engine.kind, sessionId: 'e2' },
      permissionMode: 'on_request',
    });
    expect(session.reasoningEffort).toBeUndefined();
    expect(session.readOnly).toBeUndefined();
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

  it('父会话：subagents 摘要按 sessionId 更新，派出它的回合里有原位更新的 subagent 部件', () => {
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
    const ended = add('subagent.updated', { subagent: done });
    projection.apply(ended);
    const after = projection.snapshot();
    expect(after.subagents).toEqual([done]);
    const parts = after.messages.find((m) => m.role === 'assistant')?.parts;
    // 父回合还没结束：“结束”部件跟在同一个回合里（R5）。
    expect(parts).toEqual([
      { type: 'subagent', key: `a:${CHILD}`, subagent: done },
      { type: 'subagent', key: `a:${CHILD}:end:${ended.seq}`, subagent: done, ended: 'completed' },
    ]);
    expect(after.parent).toBeUndefined();
  });

  it('子会话结束时，“结束”部件加在父会话当时的回合里；之后的摘要更新两个部件都跟着换', () => {
    const { list, add, turn } = events();
    turn();
    add('subagent.started', { subagent: summary });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    add('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
    turn(TURN2, '继续');
    add('assistant.message', { turnId: TURN2, messageId: 'm2', text: '还在等', replaces: [] });
    const done = { ...summary, status: 'completed' as const, endedAt: '2026-10-13T08:00:01.000Z' };
    add('subagent.updated', { subagent: done });
    // 关闭不再加结束部件：只在离开 running 时加。
    const closed = { ...done, status: 'closed' as const, title: '生成的标题' };
    const last = add('subagent.updated', { subagent: closed });
    const transcript = projectTranscript(list);
    const [first, second] = transcript.messages.filter((m) => m.role === 'assistant');
    expect(first?.parts).toEqual([{ type: 'subagent', key: `a:${CHILD}`, subagent: closed }]);
    expect(second?.parts).toEqual([
      { type: 'text', key: expect.any(String), text: '还在等', state: 'done' },
      {
        type: 'subagent',
        key: `a:${CHILD}:end:${last.seq - 1}`,
        subagent: closed,
        ended: 'completed',
      },
    ]);
  });

  it('父会话空闲时子会话才结束：“结束”部件是一条系统消息', () => {
    const { list, add, turn } = events();
    turn();
    add('subagent.started', { subagent: summary });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    add('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
    const failed = { ...summary, status: 'failed' as const, endedAt: '2026-10-13T08:00:01.000Z' };
    const ended = add('subagent.updated', { subagent: failed });
    const messages = projectTranscript(list).messages;
    expect(messages.at(-1)).toMatchObject({
      role: 'system',
      parts: [{ type: 'subagent', key: `a:${CHILD}:end:${ended.seq}`, ended: 'failed' }],
    });
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

describe('待发消息与插话（R11）', () => {
  const PENDING = 'pnd_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
  const PENDING2 = 'pnd_01JA2B3C4D5E6F7G8H9JKMNPQS' as const;
  const base = {
    content: [{ type: 'text' as const, text: '顺便跑一下测试' }],
    sentBy: identity,
    createdAt: '2026-10-13T08:00:00.000Z',
    updatedAt: '2026-10-13T08:00:00.000Z',
  };

  it('pendingMessages 按加入的先后，到了终态就去掉', () => {
    const { list, add, turn } = events();
    turn();
    add('pending.added', {
      pending: { ...base, id: PENDING, delivery: 'steer', status: 'waiting' },
    });
    add('pending.added', {
      pending: { ...base, id: PENDING2, delivery: 'queue', status: 'waiting' },
    });
    let transcript = projectTranscript(list);
    expect(transcript.pendingMessages.map((p) => [p.id, p.delivery])).toEqual([
      [PENDING, 'steer'],
      [PENDING2, 'queue'],
    ]);
    add('pending.updated', {
      pending: { ...base, id: PENDING2, delivery: 'queue', status: 'held' },
    });
    add('pending.updated', {
      pending: { ...base, id: PENDING, delivery: 'steer', status: 'inserted', turnId: TURN },
    });
    transcript = projectTranscript(list);
    expect(transcript.pendingMessages.map((p) => [p.id, p.status])).toEqual([[PENDING2, 'held']]);
  });

  it('插话：回合中间一条用户消息，之后的输出另起一条助手消息；finished 在最后一条，增量与工具在各自的消息里收尾', () => {
    const { list, add, turn } = events();
    turn();
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'text',
      text: '先',
    });
    add('tool.started', {
      turnId: TURN,
      toolCallId: 'call_1',
      toolName: 'shell',
      display: { kind: 'shell' },
      input: {},
    });
    add('user.steered', {
      turnId: TURN,
      pendingId: PENDING,
      clientMessageId: 'msg-3',
      content: [{ type: 'text', text: '顺便跑一下测试' }],
      sentBy: identity,
    });
    // 插话之前的增量，已提交消息晚到：仍在它所在的那条助手消息里原位替换。
    add('assistant.message', {
      turnId: TURN,
      messageId: 'm1',
      text: '先回答第一部分',
      replaces: [{ streamId: STREAM, blockIndex: 0 }],
    });
    add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM2,
      blockIndex: 0,
      kind: 'text',
      text: '好',
    });
    add('assistant.message', {
      turnId: TURN,
      messageId: 'm2',
      text: '好的，测试也跑了',
      replaces: [{ streamId: STREAM2, blockIndex: 0 }],
    });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 10 });
    const { messages } = projectTranscript(list);
    expect(
      messages.map((m) => [
        m.role,
        m.id,
        m.parts.map((p) => (p.type === 'text' ? p.text : p.type)),
      ]),
    ).toEqual([
      ['user', TURN, ['你好']],
      ['assistant', `${TURN}:assistant`, ['先回答第一部分', 'tool']],
      ['user', `${TURN}:steer:${PENDING}`, ['顺便跑一下测试']],
      ['assistant', `${TURN}:assistant:7`, ['好的，测试也跑了']],
    ]);
    const [, first, steer, second] = messages;
    expect(steer).toMatchObject({ steered: true, pendingId: PENDING, clientMessageId: 'msg-3' });
    expect(first?.role === 'assistant' && first.finished).toBeFalsy();
    expect(second?.role === 'assistant' && second.finished).toEqual({
      outcome: 'completed',
      durationMs: 10,
    });
    // 两条助手消息都带回合开始的时刻（U2：进行中的计时与“已处理”的用时）。
    for (const message of [first, second]) {
      expect(message?.role === 'assistant' && message.startedAt).toBe('2026-10-13T08:00:00.003Z');
    }
    // 回合结束时第一条助手消息里没收尾的工具也显示为 unknown。
    expect(first?.parts.find((p) => p.type === 'tool')).toMatchObject({ status: 'unknown' });
  });

  it('排队发出的回合：用户消息带 pendingId', () => {
    const { list, add } = events();
    add('user.message', {
      turnId: TURN2,
      content: [{ type: 'text', text: '然后提交' }],
      sentBy: identity,
      pendingId: PENDING2,
    });
    const [message] = projectTranscript(list).messages;
    expect(message).toMatchObject({ role: 'user', pendingId: PENDING2 });
    expect(message).not.toHaveProperty('steered');
  });
});

describe('建议的后续任务（0.16.0）', () => {
  const CHILD = 'ses_01JA2B3C4D5E6F7G8H9JKMNPZZ' as const;
  const task = (id: `tsk_${string}`, title: string) => ({
    id,
    title,
    prompt: `do ${title}`,
    toolCallId: 'call_suggest_1',
    turnId: TURN,
    status: 'suggested' as const,
  });
  const A = task('tsk_01JA2B3C4D5E6F7G8H9JKMNPQA', 'tests');
  const B = task('tsk_01JA2B3C4D5E6F7G8H9JKMNPQB', 'readme');

  it('提出建议的回合里一个 tasks 部件，随开始与回报原位更新；回报时在当时的位置加一个 task_report 部件', () => {
    const { list, add, turn } = events();
    turn();
    add('tasks.suggested', { toolCallId: 'call_suggest_1', turnId: TURN, tasks: [A, B] });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    add('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
    const projection = new TranscriptProjection();
    for (const event of list) projection.apply(event);
    const before = projection.snapshot();
    const card = before.messages[1];
    expect(card?.parts.find((p) => p.type === 'tasks')).toEqual({
      type: 'tasks',
      key: 'k:call_suggest_1',
      toolCallId: 'call_suggest_1',
      tasks: [A, B],
    });
    expect(before.suggestedTasks).toEqual([A, B]);

    projection.apply(add('task.started', { taskId: A.id, sessionId: CHILD }));
    projection.apply(
      add('task.reported', {
        taskId: A.id,
        sessionId: CHILD,
        outcome: 'failed',
        summary: '没跑通',
      }),
    );
    const after = projection.snapshot();
    const reported = { ...A, status: 'reported', sessionId: CHILD, outcome: 'failed' };
    expect(after.messages[1]?.parts.find((p) => p.type === 'tasks')).toMatchObject({
      tasks: [reported, B],
    });
    expect(after.suggestedTasks).toEqual([reported, B]);
    // 回报时会话空闲：一条系统消息。
    expect(after.messages.at(-1)).toMatchObject({
      role: 'system',
      parts: [{ type: 'task_report', key: `kr:${A.id}`, task: reported, summary: '没跑通' }],
    });
    // 不认识的任务忽略。
    projection.apply(
      add('task.started', { taskId: 'tsk_01JA2B3C4D5E6F7G8H9JKMNPQZ', sessionId: CHILD }),
    );
    expect(projection.snapshot().suggestedTasks).toHaveLength(2);
    projection.reset();
    expect(projection.snapshot().suggestedTasks).toEqual([]);
  });
});

describe('命令回合与上下文压缩（0.24.0）', () => {
  it('命令开的回合：一条带 command、没有文字的用户消息；压缩部件原位从 running 换成 completed', () => {
    const { list, add } = events();
    add('turn.started', { turnId: TURN, command: { kind: 'compact' } });
    add('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
    add('context.compacting', { turnId: TURN, compactionId: 'c1', trigger: 'manual' });
    const running = projectTranscript(list).messages;
    expect(running[0]).toMatchObject({ role: 'user', command: { kind: 'compact' }, parts: [] });
    expect(running[1]?.parts).toEqual([
      { type: 'compaction', key: 'c:c1', compactionId: 'c1', trigger: 'manual', status: 'running' },
    ]);
    add('context.compacted', { turnId: TURN, compactionId: 'c1', trigger: 'manual' });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    const done = projectTranscript(list).messages;
    expect(done).toHaveLength(2);
    expect(done[1]?.parts).toMatchObject([{ type: 'compaction', status: 'completed' }]);
  });

  it('普通回合里的自动压缩；没压缩成的在回合结束时去掉', () => {
    const { list, add, turn } = events();
    turn();
    add('context.compacted', { turnId: TURN, compactionId: 'c1', trigger: 'auto' });
    add('context.compacting', { turnId: TURN, compactionId: 'c2', trigger: 'auto' });
    expect(assistantParts(list).map((part) => part.key)).toEqual(['c:c1', 'c:c2']);
    add('turn.finished', { turnId: TURN, outcome: 'failed', durationMs: 5 });
    expect(assistantParts(list)).toEqual([
      { type: 'compaction', key: 'c:c1', compactionId: 'c1', trigger: 'auto', status: 'completed' },
    ]);
    const user = projectTranscript(list).messages[0];
    expect(user).toMatchObject({ role: 'user' });
    expect(user && 'command' in user).toBe(false);
  });
});

describe('会话目标（0.35.0）', () => {
  const goal = {
    objective: '补齐测试',
    status: 'active' as const,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    updatedAt: '2026-10-15T08:00:00.000Z',
  };

  it('设目标的回合：用户消息带 trigger；引擎自己开的回合补一条带 trigger、没有文字的用户消息', () => {
    const { list, add } = events();
    add('user.message', {
      turnId: TURN,
      content: [{ type: 'text', text: '补齐测试' }],
      sentBy: identity,
    });
    add('turn.started', { turnId: TURN, trigger: 'goal' });
    add('session.goal_changed', { goal });
    add('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 5 });
    add('turn.started', { turnId: TURN2, trigger: 'goal' });
    const { messages, goal: current } = projectTranscript(list);
    expect(messages[0]).toMatchObject({
      role: 'user',
      trigger: 'goal',
      parts: [{ type: 'text', text: '补齐测试' }],
    });
    const continuation = messages.find(
      (message) => 'turnId' in message && message.turnId === TURN2,
    );
    expect(continuation).toMatchObject({ role: 'user', trigger: 'goal', parts: [] });
    expect(current).toEqual(goal);
  });

  it('普通回合没有 trigger；清除目标后 goal 是 undefined', () => {
    const { list, add, turn } = events();
    turn();
    add('session.goal_changed', { goal: { ...goal, status: 'paused' } });
    expect(projectTranscript(list).goal?.status).toBe('paused');
    add('session.goal_changed', { goal: null });
    const { messages, goal: current } = projectTranscript(list);
    expect(messages[0] && 'trigger' in messages[0]).toBe(false);
    expect(current).toBeUndefined();
  });
});

describe('消息里的图片（0.28.0）', () => {
  const image = {
    type: 'image' as const,
    imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR' as const,
    mimeType: 'image/png' as const,
    size: 42,
    width: 4,
    height: 2,
  };

  it('用户消息：先是文本部件，之后每张图片一个；只有图片时没有文本部件', () => {
    const { list, add } = events();
    add('user.message', {
      turnId: TURN,
      content: [{ type: 'text', text: '看' }, image, { type: 'text', text: '这张' }],
      sentBy: identity,
    });
    add('user.message', { turnId: TURN2, content: [image], sentBy: identity });
    const users = projectTranscript(list).messages.filter((message) => message.role === 'user');
    expect(users[0]?.parts).toEqual([
      { type: 'text', key: 'text', text: '看\n这张', state: 'done' },
      { type: 'image', key: 'image:1', image },
    ]);
    expect(users[1]?.parts).toEqual([{ type: 'image', key: 'image:0', image }]);
  });

  it('userContentText 只取文本', () => {
    expect(userContentText([{ type: 'text', text: 'a' }, image, { type: 'text', text: 'b' }])).toBe(
      'a\nb',
    );
    expect(userContentText([image])).toBe('');
  });
});

describe('应用级工具（0.30.0）', () => {
  it('用户消息带 from；ui.show 记成最近一次', () => {
    const { list, add } = events();
    const from = { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS' as const, kind: 'report' as const };
    add('user.message', {
      turnId: TURN,
      content: [{ type: 'text', text: 'r' }],
      sentBy: identity,
      from,
    });
    add('turn.started', { turnId: TURN });
    const first = add('ui.show', { target: { kind: 'files' }, turnId: TURN });
    const last = add('ui.show', { target: { kind: 'file', path: 'a.md', line: 2 } });
    const projection = new TranscriptProjection();
    for (const event of list) projection.apply(event);
    const transcript = projection.snapshot();
    expect(transcript.messages[0]).toMatchObject({ role: 'user', from });
    expect(transcript.uiShow).toEqual({ seq: last.seq, ts: last.ts, target: last.payload.target });
    expect(first.seq).toBeLessThan(last.seq);
  });
});
