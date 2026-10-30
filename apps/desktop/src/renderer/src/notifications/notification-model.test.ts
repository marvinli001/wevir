import type { NotificationIntent, Session, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  channelIdFromTag,
  deliveryFor,
  displayDelivery,
  intentDisplayKind,
  isFresh,
  NOTIFICATION_MAX_AGE_MS,
  notificationKind,
  notificationTag,
  sessionIdFromTag,
} from './notification-model';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  migrateNotificationKinds,
  NOTIFICATION_SETTINGS_STORAGE_KEY,
  parseNotificationSettings,
} from './notification-settings';

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

describe('host intents (0.106.0)', () => {
  const intent = (overrides: Partial<NotificationIntent>): NotificationIntent => ({
    id: 'approval:apr_1',
    kind: 'approval',
    sessionId: 'ses_1',
    title: 'Fix login',
    body: '',
    createdAt: new Date().toISOString(),
    collapseKey: 'session:ses_1',
    ...overrides,
  });

  it('shows session intents under their own kind and automation runs by status', () => {
    for (const kind of ['approval', 'question', 'completed', 'failed'] as const) {
      expect(intentDisplayKind(intent({ kind }))).toBe(kind);
    }
    const run = (automationStatus: NotificationIntent['automationStatus']) =>
      intentDisplayKind(intent({ kind: 'automation', automationStatus }));
    expect(run('waiting')).toBe('approval');
    expect(run('failed')).toBe('failed');
    expect(run('completed')).toBe('completed');
    // agent 的提醒（0.142.0）只来自 Host：本机判定从不产生它。
    expect(intentDisplayKind(intent({ kind: 'agent' }))).toBe('agent');
    expect(
      deliveryFor('agent', { focused: false, viewing: false }, DEFAULT_NOTIFICATION_SETTINGS),
    ).toEqual({ toast: false, system: false });
  });

  it('presents a host intent exactly like the local decision did when the kind is on', () => {
    const contexts = [
      { focused: true, viewing: true },
      { focused: true, viewing: false },
      { focused: false, viewing: true },
      { focused: false, viewing: false },
    ];
    for (const context of contexts) {
      for (const channels of [
        DEFAULT_NOTIFICATION_SETTINGS,
        { ...DEFAULT_NOTIFICATION_SETTINGS, inApp: false, system: false },
      ]) {
        expect(displayDelivery(context, channels)).toEqual(
          deliveryFor('approval', context, channels),
        );
      }
    }
  });

  it('ignores the local kind switches: the host already applied its own', () => {
    const off = { ...DEFAULT_NOTIFICATION_SETTINGS, completed: false };
    expect(displayDelivery({ focused: false, viewing: false }, off)).toEqual({
      toast: false,
      system: true,
    });
  });
});

describe('migrateNotificationKinds', () => {
  function memoryStorage(value?: unknown) {
    return {
      getItem: (key: string) =>
        key === NOTIFICATION_SETTINGS_STORAGE_KEY && value !== undefined
          ? JSON.stringify(value)
          : null,
    };
  }

  function fakeClient(notifications?: object) {
    const calls: Array<[string, unknown]> = [];
    const request = async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'settings.get') {
        return {
          settings: {
            sendWhileBusy: 'steer',
            ...(notifications !== undefined && { notifications }),
          },
        };
      }
      return { settings: { sendWhileBusy: 'steer' } };
    };
    // biome-ignore lint/suspicious/noExplicitAny: the fake only implements request.
    return { calls, client: { request } as any };
  }

  it('copies switched-off kinds into the host settings once, automations on', async () => {
    const { calls, client } = fakeClient();
    const local = { ...DEFAULT_NOTIFICATION_SETTINGS, completed: false, sound: false };
    await migrateNotificationKinds(memoryStorage(local), client);
    expect(calls).toEqual([
      ['settings.get', {}],
      [
        'settings.update',
        {
          settings: {
            notifications: {
              completed: false,
              approval: true,
              question: true,
              failed: true,
              automation: true,
            },
          },
        },
      ],
    ]);
  });

  it('leaves the host alone when it already has kinds, or nothing local was changed', async () => {
    const has = fakeClient({ approval: false });
    await migrateNotificationKinds(
      memoryStorage({ ...DEFAULT_NOTIFICATION_SETTINGS, failed: false }),
      has.client,
    );
    expect(has.calls).toEqual([['settings.get', {}]]);

    const untouched = fakeClient();
    await migrateNotificationKinds(memoryStorage(DEFAULT_NOTIFICATION_SETTINGS), untouched.client);
    await migrateNotificationKinds(memoryStorage(), untouched.client);
    await migrateNotificationKinds({ getItem: () => '{not json' }, untouched.client);
    expect(untouched.calls).toEqual([]);
  });
});

describe('tags', () => {
  it('round-trips the session id', () => {
    expect(sessionIdFromTag(notificationTag('abc'))).toBe('abc');
    expect(sessionIdFromTag('other')).toBeUndefined();
    expect(sessionIdFromTag('session:')).toBeUndefined();
    // 助理（0.121.0）：按助理收起，点开去助理页。
    expect(notificationTag('chn_1')).toBe('channel:chn_1');
    expect(channelIdFromTag(notificationTag('chn_1'))).toBe('chn_1');
    expect(sessionIdFromTag(notificationTag('chn_1'))).toBeUndefined();
    expect(channelIdFromTag(notificationTag('abc'))).toBeUndefined();
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
