// 通知设置（U31，设置 → 通知）：只存在本机（localStorage），不同步到 Host 或别的设备。

import { createPersistedStore } from '@/lib/store';

export interface NotificationSettings {
  /** 窗口不在前台时发系统通知。 */
  system: boolean;
  /** 窗口在前台、但看的不是这个会话时，在右下角提醒。 */
  inApp: boolean;
  /** 系统通知带提示音。 */
  sound: boolean;
  /** 程序坞图标上的角标：窗口回到前台前收到的系统通知数。 */
  badge: boolean;
  /** 各类事件。 */
  completed: boolean;
  approval: boolean;
  question: boolean;
  failed: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  system: true,
  inApp: true,
  sound: true,
  badge: true,
  completed: true,
  approval: true,
  question: true,
  failed: true,
};

const KEYS = Object.keys(DEFAULT_NOTIFICATION_SETTINGS) as (keyof NotificationSettings)[];

/** 读存下来的值：缺的、类型不对的项用默认值。 */
export function parseNotificationSettings(raw: unknown): NotificationSettings | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value === 'boolean') settings[key] = value;
  }
  return settings;
}

const store = createPersistedStore<NotificationSettings>(
  'wevir.notifications.v1',
  DEFAULT_NOTIFICATION_SETTINGS,
  parseNotificationSettings,
);

export const useNotificationSettings = store.use;
export const getNotificationSettings = store.get;

export function updateNotificationSettings(patch: Partial<NotificationSettings>): void {
  store.set((current) => ({ ...current, ...patch }));
}
