import type { Session, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  deliveryFor,
  isFresh,
  NOTIFICATION_MAX_AGE_MS,
  notificationKind,
  notificationTag,
  sessionIdFromTag,
} from './notification-model';
import { DEFAULT_NOTIFICATION_SETTINGS, parseNotificationSettings } from './notification-settings';

const session = { id: 'ses_1', workspaceId: 'ws_1', title: 'Fix login' } as unknown as Session;

function event(type: string, payload: unknown, ts = new Date().toISOString()): WevirEvent {
  return { seq: 2, sessionId: 'ses_1', ts, type, source: 'host', payload } as unknown as WevirEvent;
}

describe('notificationKind', () => {
  it('maps approvals, questions and finished turns', () => {
    expect(notificationKind(event('approval.requested', { approval: {} }), session)).toBe(
      'approval',
    );
    expect(notificationKind(event('question.requested', { question: {} }), session)).toBe(
      'question',
    );
    const finished = (outcome: string) =>
      event('turn.finished', { turnId: 't', outcome, durationMs: 1 });
    expect(notificationKind(finished('completed'), session)).toBe('completed');
    expect(notificationKind(finished('failed'), session)).toBe('failed');
    expect(notificationKind(finished('cancelled'), session)).toBeUndefined();
    expect(notificationKind(finished('interrupted'), session)).toBeUndefined();
    expect(notificationKind(event('assistant.message', {}), session)).toBeUndefined();
  });

  it('ignores subagents and side sessions', () => {
    const approval = event('approval.requested', { approval: {} });
    expect(notificationKind(approval, { ...session, parentSessionId: 'ses_p' } as Session)).toBe(
      undefined,
    );
    expect(notificationKind(approval, { ...session, side: true } as Session)).toBeUndefined();
  });
});

describe('isFresh', () => {
  it('drops events caught up after a long disconnect', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    expect(isFresh(event('x', {}, '2026-10-15T09:59:30Z'), now)).toBe(true);
    const stale = new Date(now - NOTIFICATION_MAX_AGE_MS - 1).toISOString();
    expect(isFresh(event('x', {}, stale), now)).toBe(false);
  });
});

describe('deliveryFor', () => {
  const settings = DEFAULT_NOTIFICATION_SETTINGS;

  it('stays quiet while the user is looking at the session', () => {
    expect(deliveryFor('completed', { focused: true, viewing: true }, settings)).toEqual({
      toast: false,
      system: false,
    });
  });

  it('shows an in-app reminder for another session and a system one in the background', () => {
    expect(deliveryFor('approval', { focused: true, viewing: false }, settings)).toEqual({
      toast: true,
      system: false,
    });
    expect(deliveryFor('approval', { focused: false, viewing: true }, settings)).toEqual({
      toast: false,
      system: true,
    });
  });

  it('honours the per-kind and per-channel switches', () => {
    const off = { ...settings, completed: false, system: false, inApp: false };
    expect(deliveryFor('completed', { focused: false, viewing: false }, off).system).toBe(false);
    expect(deliveryFor('approval', { focused: false, viewing: false }, off).system).toBe(false);
    expect(deliveryFor('approval', { focused: true, viewing: false }, off).toast).toBe(false);
  });
});

describe('tags', () => {
  it('round-trips the session id', () => {
    expect(sessionIdFromTag(notificationTag('abc'))).toBe('abc');
    expect(sessionIdFromTag('other')).toBeUndefined();
    expect(sessionIdFromTag('session:')).toBeUndefined();
  });
});

describe('parseNotificationSettings', () => {
  it('fills missing or mistyped values with the defaults', () => {
    expect(parseNotificationSettings({ sound: false, badge: 'no' })).toEqual({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      sound: false,
    });
    expect(parseNotificationSettings([])).toBeUndefined();
    expect(parseNotificationSettings(null)).toBeUndefined();
  });
});
