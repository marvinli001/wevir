import { TranscriptProjection } from '@wevir/client-sdk';
import type {
  SessionId,
  TurnId,
  WevirEvent,
  WevirEventPayload,
  WevirEventType,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { sameSessionChrome, sessionChrome } from './session-chrome';

const sessionId = 'ses_test' as SessionId;
const turnId = 'trn_test' as TurnId;
function fixture() {
  const projection = new TranscriptProjection();
  let seq = 0;
  const apply = <T extends WevirEventType>(type: T, payload: WevirEventPayload<T>) =>
    projection.apply({
      type,
      payload,
      sessionId,
      seq: ++seq,
      ts: new Date().toISOString(),
      source: 'host',
    } as WevirEvent);
  const chrome = () => sessionChrome({ transcript: projection.snapshot(), caughtUp: true });
  apply('turn.started', { turnId });
  apply('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
  return { apply, chrome };
}

describe('session chrome selection', () => {
  it('正文更新不刷新输入框，回合结束仍更新', () => {
    const f = fixture();
    const before = f.chrome();
    for (let i = 0; i < 100; i++) {
      f.apply('assistant.message', {
        turnId,
        messageId: `m${i}`,
        text: `reply ${i}`,
        replaces: [],
      });
      expect(sameSessionChrome(before, f.chrome())).toBe(true);
    }
    f.apply('turn.finished', { turnId, outcome: 'failed', durationMs: 1000 });
    f.apply('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
    expect(sameSessionChrome(before, f.chrome())).toBe(false);
    expect(f.chrome()).toMatchObject({ finishedTurn: true, lastOutcome: 'failed', turnId });
  });

  it('等待审批与追平状态不能被正文比较吞掉', () => {
    const f = fixture();
    const before = f.chrome();
    if (!before) throw new Error('missing chrome');
    expect(sameSessionChrome(before, { ...before, caughtUp: false })).toBe(false);
    f.apply('session.state_changed', {
      from: 'running',
      to: 'awaiting_approval',
      reason: 'approval_requested',
    });
    expect(sameSessionChrome(before, f.chrome())).toBe(false);
    expect(sameSessionChrome(before, undefined)).toBe(false);
  });
});
