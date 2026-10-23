// 通知（U31）的判断，照 T3 Code 的 ThreadNotificationCoordinator（MIT，ec1313c）：会话需要处理（审批、提问、出错）或
// 回合完成时提醒；窗口在前台且看的正是这个会话时不提醒；在前台看别的会话时在应用里提醒；窗口在后台时发系统通知，角标
// 记下后台时收到的条数，窗口回到前台时清零。0.106.0 起 Host 有 `notification_intents` 时“要不要提醒”由 Host 判定（通知意图），
// 这里的 `notificationKind` 与 `isFresh` 只给旧 Host 用；怎样提醒（`displayDelivery`）两边一样。

import type { NotificationIntent, Session, WevirEvent } from '@wevir/protocol';
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

/** 怎样提醒（旧 Host，本机判定种类）：这一类关掉了、或正看着这个会话时都不提醒。 */
export function deliveryFor(
  kind: NotificationKind,
  context: NotificationContext,
  settings: NotificationSettings,
): Delivery {
  if (!settings[kind]) return NONE;
  return displayDelivery(context, settings);
}

/** 怎样提醒（种类已由 Host 或 `deliveryFor` 判过）：正看着这个会话不提醒，前台看别的会话在应用里提醒，后台发系统通知。 */
export function displayDelivery(
  context: NotificationContext,
  settings: Pick<NotificationSettings, 'inApp' | 'system'>,
): Delivery {
  if (context.focused) {
    return context.viewing ? NONE : { toast: settings.inApp, system: false };
  }
  return { toast: false, system: settings.system };
}

/** Host 的意图在本机显示成哪一类（决定标题与语气）：自动化按运行的状态，等待处理当作需要批准；助理的帖子当作完成。 */
export function intentDisplayKind(intent: NotificationIntent): NotificationKind {
  // 助理开口（0.121.0）当作完成。
  if (intent.kind === 'channel') return 'completed';
  if (intent.kind !== 'automation') return intent.kind;
  if (intent.automationStatus === 'failed') return 'failed';
  if (intent.automationStatus === 'completed') return 'completed';
  return 'approval';
}

/** 系统通知的 tag：同一个会话（或助理，0.121.0）只留最新的一条，打开它时收回。 */
export function notificationTag(id: string): string {
  return id.startsWith('chn_') ? `channel:${id}` : `session:${id}`;
}

export function sessionIdFromTag(tag: string): string | undefined {
  return tag.startsWith('session:') ? tag.slice('session:'.length) || undefined : undefined;
}

export function channelIdFromTag(tag: string): string | undefined {
  return tag.startsWith('channel:') ? tag.slice('channel:'.length) || undefined : undefined;
}
