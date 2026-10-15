// 通知（U31）的判断，照 T3 Code 的 ThreadNotificationCoordinator（MIT，ec1313c）：会话需要处理（审批、提问、出错）或
// 回合完成时提醒；窗口在前台且看的正是这个会话时不提醒；在前台看别的会话时在应用里提醒；窗口在后台时发系统通知，角标
// 记下后台时收到的条数，窗口回到前台时清零。

import type { Session, WevirEvent } from '@wevir/protocol';
import type { NotificationSettings } from './notification-settings';

export type NotificationKind = 'approval' | 'question' | 'completed' | 'failed';

/** 太旧的事件不提醒（断线重连后补到的事件）。 */
export const NOTIFICATION_MAX_AGE_MS = 2 * 60_000;

/** 这条事件要不要提醒、是哪一类；不提醒时 undefined。子会话与支线不单独提醒。 */
export function notificationKind(
  event: WevirEvent,
  session: Session,
): NotificationKind | undefined {
  if (session.parentSessionId !== undefined || session.side) return undefined;
  switch (event.type) {
    case 'approval.requested':
      return 'approval';
    case 'question.requested':
      return 'question';
    case 'turn.finished':
      if (event.payload.outcome === 'completed') return 'completed';
      if (event.payload.outcome === 'failed') return 'failed';
      return undefined;
    default:
      return undefined;
  }
}

export function isFresh(event: WevirEvent, now: number): boolean {
  const ts = Date.parse(event.ts);
  return Number.isFinite(ts) && now - ts <= NOTIFICATION_MAX_AGE_MS;
}

export interface NotificationContext {
  /** 窗口在前台（可见且有焦点）。 */
  focused: boolean;
  /** 主窗格正在显示这个会话。 */
  viewing: boolean;
}

export interface Delivery {
  toast: boolean;
  system: boolean;
}

const NONE: Delivery = { toast: false, system: false };

/** 怎样提醒：这一类关掉了、或正看着这个会话时都不提醒。 */
export function deliveryFor(
  kind: NotificationKind,
  context: NotificationContext,
  settings: NotificationSettings,
): Delivery {
  if (!settings[kind]) return NONE;
  if (context.focused) {
    return context.viewing ? NONE : { toast: settings.inApp, system: false };
  }
  return { toast: false, system: settings.system };
}

/** 系统通知的 tag：同一个会话只留最新的一条，打开会话时收回。 */
export function notificationTag(sessionId: string): string {
  return `session:${sessionId}`;
}

export function sessionIdFromTag(tag: string): string | undefined {
  return tag.startsWith('session:') ? tag.slice('session:'.length) || undefined : undefined;
}
