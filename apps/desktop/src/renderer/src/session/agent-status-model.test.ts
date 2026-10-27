import type { Session, TurnId, WevirEvent } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SessionActivityTracker } from '@/data/session-activity';
import { formatClock } from './agent-status-model';

const T1 = 'trn_1' as TurnId;
const TS = '2026-10-15T08:00:00.000Z';

describe('formatClock', () => {
  it('分:秒，超过一小时带小时', () => {
    expect(formatClock(7_400)).toBe('0:07');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('SessionActivityTracker', () => {
  const session = { id: 'ses_1', cwd: '/w' } as Pick<Session, 'id' | 'cwd'>;
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>) =>
    ({ type, payload, sessionId: session.id, seq: ++seq, ts: TS }) as unknown as WevirEvent;

  it('跟着事件换当前动作，只在变了时通知，回合结束时清掉', () => {
    const tracker = new SessionActivityTracker();
    const listener = vi.fn();
    tracker.subscribe(session.id as Session['id'], listener);
    tracker.apply(
      event('tool.started', {
        turnId: T1,
        toolCallId: 'a',
        toolName: 'read',
        display: { kind: 'read', paths: ['/w/a.ts'] },
      }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toBeUndefined();

    tracker.apply(event('turn.started', { turnId: T1 }), session);
    const thinking = tracker.get(session.id as Session['id']);
    expect(thinking).toMatchObject({ tone: 'running', steps: 0 });
    tracker.apply(
      event('tool.started', {
        turnId: T1,
        toolCallId: 'a',
        toolName: 'read',
        display: { kind: 'read', paths: ['/w/a.ts'] },
      }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toMatchObject({ target: 'a.ts', steps: 0 });
    const calls = listener.mock.calls.length;
    tracker.apply(
      event('assistant.delta', {
        turnId: T1,
        streamId: 's',
        blockIndex: 0,
        kind: 'text',
        text: 'x',
      }),
      session,
    );
    expect(listener.mock.calls.length).toBe(calls);

    tracker.apply(
      event('tool.finished', { turnId: T1, toolCallId: 'a', status: 'completed' }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toMatchObject({
      label: thinking?.label,
      steps: 1,
    });
    tracker.apply(
      event('turn.finished', { turnId: T1, outcome: 'completed', durationMs: 10 }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toBeUndefined();
  });
});
