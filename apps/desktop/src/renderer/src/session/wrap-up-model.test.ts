import type { ChatMessage } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import { lastTurnShowsWrapUp, turnWrapUp, wrapUpCardOf } from './wrap-up-model';

const actions = [
  { label: '提交', message: '提交这次改动。' },
  { label: '先不', message: '先不提交。' },
];

function user(turnId: `trn_${string}`): ChatMessage {
  return {
    id: `${turnId}:user`,
    role: 'user',
    turnId,
    parts: [],
    seqRange: [1, 1],
    ts: '2026-10-27T00:00:00.000Z',
  };
}

function assistant(
  turnId: `trn_${string}`,
  wrapUp?: Extract<ChatMessage, { role: 'assistant' }>['wrapUp'],
): ChatMessage {
  return {
    id: `${turnId}:assistant`,
    role: 'assistant',
    turnId,
    parts: [],
    seqRange: [2, 3],
    ...(wrapUp !== undefined && { wrapUp }),
  };
}

describe('wrapUpCardOf', () => {
  it('有问题、有按钮才画；只有回顾的不画', () => {
    expect(wrapUpCardOf(undefined)).toBeUndefined();
    expect(wrapUpCardOf({ seq: 5, recap: '做完了。' })).toBeUndefined();
    expect(wrapUpCardOf({ seq: 5, recap: '做完了。', ask: '要提交吗？' })).toBeUndefined();
    expect(
      wrapUpCardOf({ seq: 5, recap: '做完了。', ask: '要提交吗？', actions, blocked: true }),
    ).toEqual({ recap: '做完了。', ask: '要提交吗？', actions });
  });
});

describe('turnWrapUp 与 lastTurnShowsWrapUp', () => {
  const card = { seq: 5, recap: '做完了。', ask: '要提交吗？', actions };

  it('取回合里带收尾的那条助手消息；最后一个回合画着卡片时回顾卡片让位', () => {
    const messages = [user('trn_1'), assistant('trn_1', card)];
    expect(turnWrapUp(messages)).toBe(card);
    expect(lastTurnShowsWrapUp({ messages })).toBe(true);
    expect(
      lastTurnShowsWrapUp({ messages: [...messages, user('trn_2'), assistant('trn_2')] }),
    ).toBe(false);
    expect(
      lastTurnShowsWrapUp({
        messages: [user('trn_1'), assistant('trn_1', { seq: 5, recap: '好了。' })],
      }),
    ).toBe(false);
    expect(lastTurnShowsWrapUp({ messages: [] })).toBe(false);
  });
});
