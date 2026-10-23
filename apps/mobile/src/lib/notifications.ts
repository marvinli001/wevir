// App 开着、连着电脑时的提醒：电脑上 Host 判定的通知意图（`notification.intent`）在顶部弹一条，点开去对应的地方。助理的（带
// `channelId`：它开口了，或它的会话里要批准、回答）打开那个助理；别的会话打开会话页；没有会话的自动化打开那台电脑。纯逻辑。

import type { NotificationIntent } from '@wevir/protocol';
import { botKey } from './bots';

export type NotificationTarget =
  | { pathname: '/bot/[key]'; params: { key: string } }
  | { pathname: '/session/[key]'; params: { key: string } }
  | { pathname: '/computer/[name]'; params: { name: string } };

export function notificationTarget(
  computer: string,
  intent: NotificationIntent,
): NotificationTarget {
  if (intent.channelId !== undefined)
    return { pathname: '/bot/[key]', params: { key: botKey(computer, intent.channelId) } };
  if (intent.sessionId !== undefined)
    return { pathname: '/session/[key]', params: { key: botKey(computer, intent.sessionId) } };
  return { pathname: '/computer/[name]', params: { name: computer } };
}

/** 现在这一页就是提醒要去的地方（看着那个助理或会话）时不弹。`path` 是 expo-router 的 `usePathname()`。 */
export function alreadyShowing(target: NotificationTarget, path: string): boolean {
  switch (target.pathname) {
    case '/bot/[key]':
      return (
        path === `/bot/${encodeURIComponent(target.params.key)}` ||
        path === `/bot/${target.params.key}`
      );
    case '/session/[key]':
      return (
        path === `/session/${encodeURIComponent(target.params.key)}` ||
        path === `/session/${target.params.key}`
      );
    case '/computer/[name]':
      return false;
  }
}

export interface Banner {
  /** 电脑与 `collapseKey`。 */
  key: string;
  computerName: string;
  intent: NotificationIntent;
  target: NotificationTarget;
}
