import type { SessionId, SessionState, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { KeepAwake } from './keep-awake.js';
import { SES, SES2, T0 } from './test-utils.js';

let seq = 0;
function event(sessionId: SessionId, type: string, payload: unknown): WevirEvent {
  seq += 1;
  return { seq, sessionId, ts: T0, type, source: 'host', payload } as WevirEvent;
}
const state = (sessionId: SessionId, from: SessionState, to: SessionState) =>
  event(sessionId, 'session.state_changed', { from, to, reason: 'turn_started' });
const asked = (sessionId: SessionId, id: string) =>
  event(sessionId, 'question.requested', { question: { id } });
const answered = (sessionId: SessionId, questionId: string) =>
  event(sessionId, 'question.resolved', { questionId, status: 'answered' });

function setup(preventSleep = true) {
  const keepAwake = new KeepAwake({ preventSleep });
  const changes: boolean[] = [];
  keepAwake.watch((value) => changes.push(value));
  return { keepAwake, changes };
}

describe('KeepAwake', () => {
  it('开着时：回合在跑或取消中算，等审批、等回答不算；回合结束后放开', () => {
    const { keepAwake, changes } = setup();
    expect(keepAwake.keepAwake).toBe(false);
    keepAwake.onEvent(state(SES, 'idle', 'running'));
    expect(keepAwake.keepAwake).toBe(true);
    keepAwake.onEvent(state(SES, 'running', 'awaiting_approval'));
    expect(keepAwake.keepAwake).toBe(false);
    keepAwake.onEvent(state(SES, 'awaiting_approval', 'running'));
    keepAwake.onEvent(asked(SES, 'q1'));
    expect(keepAwake.keepAwake).toBe(false);
    keepAwake.onEvent(answered(SES, 'q1'));
    expect(keepAwake.keepAwake).toBe(true);
    keepAwake.onEvent(asked(SES, 'q2'));
    keepAwake.onEvent(state(SES, 'running', 'cancelling'));
    expect(keepAwake.keepAwake).toBe(true);
    keepAwake.onEvent(state(SES, 'cancelling', 'idle'));
    expect(keepAwake.keepAwake).toBe(false);
    expect(changes).toEqual([true, false, true, false, true, false, true, false]);
  });

  it('多个会话：最后一个回合结束才放开；没回答的问题随回合作废', () => {
    const { keepAwake, changes } = setup();
    keepAwake.onEvent(state(SES, 'idle', 'running'));
    keepAwake.onEvent(state(SES2, 'idle', 'running'));
    keepAwake.onEvent(asked(SES, 'q1'));
    keepAwake.onEvent(state(SES2, 'running', 'idle'));
    expect(keepAwake.keepAwake).toBe(false);
    keepAwake.onEvent(state(SES, 'running', 'error'));
    keepAwake.onEvent(state(SES, 'error', 'idle'));
    keepAwake.onEvent(state(SES, 'idle', 'running'));
    expect(keepAwake.keepAwake).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  it('设置关着时不挡；打开、关上时按当时的回合通知一次', () => {
    const { keepAwake, changes } = setup(false);
    keepAwake.onEvent(state(SES, 'idle', 'running'));
    expect(keepAwake.keepAwake).toBe(false);
    keepAwake.settingsChanged({ preventSleep: true });
    expect(keepAwake.keepAwake).toBe(true);
    keepAwake.settingsChanged({ preventSleep: true });
    keepAwake.settingsChanged({});
    expect(changes).toEqual([true, false]);
  });

  it('hold：设置开着时保持，释放后放开，释放可重复调用', () => {
    const { keepAwake, changes } = setup();
    const release = keepAwake.hold('remote device');
    const other = keepAwake.hold('remote device');
    expect(keepAwake.keepAwake).toBe(true);
    release();
    release();
    expect(keepAwake.keepAwake).toBe(true);
    other();
    expect(keepAwake.keepAwake).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('别的事件不影响，没见过开始的会话的问题忽略', () => {
    const { keepAwake, changes } = setup();
    keepAwake.onEvent(event(SES, 'turn.started', { turnId: 'trn_1' }));
    keepAwake.onEvent(asked(SES, 'q1'));
    keepAwake.onEvent(answered(SES, 'q1'));
    expect(keepAwake.keepAwake).toBe(false);
    expect(changes).toEqual([]);
  });
});
