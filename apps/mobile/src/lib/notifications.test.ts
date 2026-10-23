import type { NotificationIntent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { CHANNEL_A, SESSION } from './bot-test-utils';
import { alreadyShowing, notificationTarget } from './notifications';

function intent(patch: Partial<NotificationIntent>): NotificationIntent {
  return {
    id: 'channel:1',
    kind: 'channel',
    title: '小管家',
    body: '',
    createdAt: '2026-10-24T08:00:00.000Z',
    collapseKey: `channel:${CHANNEL_A}`,
    ...patch,
  };
}

describe('notificationTarget', () => {
  it('助理的提醒（含它会话里的审批）打开那个助理', () => {
    expect(notificationTarget('mac', intent({ channelId: CHANNEL_A }))).toEqual({
      pathname: '/bot/[key]',
      params: { key: `mac/${CHANNEL_A}` },
    });
    expect(
      notificationTarget(
        'mac',
        intent({ kind: 'approval', channelId: CHANNEL_A, sessionId: SESSION }),
      ),
    ).toMatchObject({ pathname: '/bot/[key]' });
  });

  it('别的会话打开会话页，没有会话时打开那台电脑', () => {
    expect(notificationTarget('mac', intent({ kind: 'completed', sessionId: SESSION }))).toEqual({
      pathname: '/session/[key]',
      params: { key: `mac/${SESSION}` },
    });
    expect(notificationTarget('mac', intent({ kind: 'automation' }))).toEqual({
      pathname: '/computer/[name]',
      params: { name: 'mac' },
    });
  });

  it('正看着那个助理或会话时不弹', () => {
    const bot = notificationTarget('mac', intent({ channelId: CHANNEL_A }));
    expect(alreadyShowing(bot, `/bot/mac%2F${CHANNEL_A}`)).toBe(true);
    expect(alreadyShowing(bot, `/bot/mac/${CHANNEL_A}`)).toBe(true);
    expect(alreadyShowing(bot, '/')).toBe(false);
    const computer = notificationTarget('mac', intent({ kind: 'automation' }));
    expect(alreadyShowing(computer, '/computer/mac')).toBe(false);
  });
});
