import { describe, expect, it } from 'vitest';
import { checkDeltaReplacement, checkTurnEvents } from './contract.js';
import type { AgentEvent } from './events.js';

// 契约条款靠这两个检查函数判定；这里用坏样本确认它们真的会报错，不是空转。

const S = 'engine-session';
const delta = (
  attemptId: string,
  blockIndex: number,
  kind: 'text' | 'reasoning' = 'text',
): AgentEvent => ({
  type: 'assistant.delta',
  engineSessionId: S,
  attemptId,
  blockIndex,
  kind,
  text: 'x',
});
const message = (...replaces: Array<[string, number]>): AgentEvent => ({
  type: 'assistant.message',
  engineSessionId: S,
  messageId: 'm',
  text: 'x',
  replaces: replaces.map(([attemptId, blockIndex]) => ({ attemptId, blockIndex })),
});
const thought = (...replaces: Array<[string, number]>): AgentEvent => ({
  ...(message(...replaces) as Extract<AgentEvent, { type: 'assistant.message' }>),
  type: 'assistant.thought',
});
const settled: AgentEvent = {
  type: 'turn.settled',
  engineSessionId: S,
  outcome: 'completed',
  stopReason: 'end_turn',
};

describe('checkDeltaReplacement', () => {
  it('增量块都被其后的同类已提交事件替换时通过', () => {
    const events = [
      delta('a', 0, 'reasoning'),
      delta('a', 1),
      delta('a', 1),
      thought(['a', 0]),
      message(['a', 1]),
      settled,
    ];
    expect(checkDeltaReplacement(events)).toEqual([]);
  });

  it('abandoned 的 attempt 不要求替换', () => {
    const events: AgentEvent[] = [
      delta('a', 0),
      { type: 'assistant.stream_ended', engineSessionId: S, attemptId: 'a', outcome: 'abandoned' },
      settled,
    ];
    expect(checkDeltaReplacement(events)).toEqual([]);
  });

  it.each([
    ['没有被替换', [delta('a', 0), message(), settled]],
    ['替换早于该块最后一个增量', [delta('a', 0), message(['a', 0]), delta('a', 0), settled]],
    ['替换在终结事件之后', [delta('a', 0), settled, message(['a', 0])]],
    ['text 块被 assistant.thought 替换', [delta('a', 0), thought(['a', 0]), settled]],
    ['替换了没出现过的块', [message(['ghost', 3]), settled]],
  ])('%s 时报错', (_name, events) => {
    expect(checkDeltaReplacement(events as AgentEvent[]).length).toBeGreaterThan(0);
  });
});

describe('checkTurnEvents', () => {
  it('同一会话、恰好一个终结事件且在最后时通过', () => {
    expect(checkTurnEvents([delta('a', 0), message(['a', 0]), settled], S)).toEqual([]);
  });

  it.each([
    ['事件属于别的会话', [{ ...settled, engineSessionId: 'other' }]],
    ['没有终结事件', [message()]],
    ['两个终结事件', [settled, settled]],
    ['终结事件之后还有事件', [settled, message()]],
  ])('%s 时报错', (_name, events) => {
    expect(checkTurnEvents(events as AgentEvent[], S).length).toBeGreaterThan(0);
  });
});
