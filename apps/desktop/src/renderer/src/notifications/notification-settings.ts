// 通知设置（U31，设置 → 通知）：显示类（系统通知、应用内、提示音、角标）只存在本机（localStorage）。种类开关 0.104.0 起在 Host 有
// `notification_intents` 时存在 Host 设置 `notifications`（第一次连上时由 `migrateNotificationKinds` 迁过去）；本机的种类值只给旧 Host 用。

import type { WevirClient } from '@wevir/client-sdk';
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

export const NOTIFICATION_SETTINGS_STORAGE_KEY = 'wevir.notifications.v1';

/** 本机设置里的种类开关（旧 Host 用；新 Host 上迁进 Host 设置）。 */
export const LOCAL_NOTIFICATION_KINDS = ['completed', 'approval', 'question', 'failed'] as const;

const store = createPersistedStore<NotificationSettings>(
  NOTIFICATION_SETTINGS_STORAGE_KEY,
  DEFAULT_NOTIFICATION_SETTINGS,
  parseNotificationSettings,
);

export const useNotificationSettings = store.use;
export const getNotificationSettings = store.get;

export function updateNotificationSettings(patch: Partial<NotificationSettings>): void {
  store.set((current) => ({ ...current, ...patch }));
}

/**
 * 把本机的种类开关迁进 Host 设置（0.104.0，Host 功能 `notification_intents`）：本机存过设置、有关掉的种类，且 Host 设置里还没有
 * `notifications` 时写过去（`automation` 按开）。本机的值留着（显示类还在用，种类值连旧 Host 时用）。写失败时下次连上再试。
 */
export async function migrateNotificationKinds(
  storage: Pick<Storage, 'getItem'>,
  client: Pick<WevirClient, 'request'>,
): Promise<void> {
  let raw: unknown;
  try {
    const text = storage.getItem(NOTIFICATION_SETTINGS_STORAGE_KEY);
    if (text === null) return;
    raw = JSON.parse(text);
  } catch {
    return;
  }
  const local = parseNotificationSettings(raw);
  if (local === undefined || LOCAL_NOTIFICATION_KINDS.every((kind) => local[kind])) return;
  const { settings } = await client.request('settings.get', {});
  if (settings.notifications !== undefined) return;
  const notifications = Object.fromEntries(
    LOCAL_NOTIFICATION_KINDS.map((kind) => [kind, local[kind]]),
  );
  await client.request('settings.update', {
    settings: { notifications: { ...notifications, automation: true } },
  });
}
