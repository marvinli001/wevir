import type { SessionId, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { SessionActivityTracker } from './session-activity';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const STREAM = 'stm_01JA2B3C4D5E6F7G8H9JKMNPQR';
const session = { id: SES, cwd: '/w' };

let seq = 0;
function event(type: string, payload: unknown): WevirEvent {
  seq += 1;
  return {
    seq,
    sessionId: SES,
    ts: new Date(Date.UTC(2026, 10, 5, 8, 0, seq)).toISOString(),
    type,
    source: 'host',
    payload,
  } as WevirEvent;
}

describe('SessionActivityTracker', () => {
  it('正文写出时是“正在回复”，这段写完后回到“正在思考”', () => {
    const tracker = new SessionActivityTracker();
    tracker.apply(event('turn.started', { turnId: TURN }), session);
    expect(tracker.get(SES)?.label).toBe('正在思考');
    tracker.apply(
      event('assistant.delta', {
        turnId: TURN,
        streamId: STREAM,
        blockIndex: 0,
        kind: 'text',
        text: '我先运行测试。',
      }),
      session,
    );
    expect(tracker.get(SES)?.label).toBe('正在回复');
    tracker.apply(
      event('assistant.stream_ended', { turnId: TURN, streamId: STREAM, outcome: 'committed' }),
      session,
    );
    expect(tracker.get(SES)?.label).toBe('正在思考');
  });
});
