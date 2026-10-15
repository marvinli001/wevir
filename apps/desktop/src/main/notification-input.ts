// 系统通知（U31）的入参校验：IPC 收到的是渲染进程给的任意值，字段与长度都核对过才交给 Electron。不依赖 Electron，
// 单独测试。

import { type DesktopNotification, NOTIFICATION_LIMITS } from '../shared/desktop-api.js';

/** 合法时返回同一形状的新对象（只留已知字段），否则 undefined。 */
export function parseDesktopNotification(value: unknown): DesktopNotification | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { tag, title, body, sound } = value as Record<string, unknown>;
  if (!isText(tag, NOTIFICATION_LIMITS.tag) || tag === '') return undefined;
  if (!isText(title, NOTIFICATION_LIMITS.title) || title === '') return undefined;
  if (!isText(body, NOTIFICATION_LIMITS.body)) return undefined;
  if (typeof sound !== 'boolean') return undefined;
  return { tag, title, body, sound };
}

/** 角标数字：0 到 9999 的整数。 */
export function isBadgeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
