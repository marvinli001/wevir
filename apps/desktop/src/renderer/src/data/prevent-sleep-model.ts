import type { WevirClient } from '@wevir/client-sdk';
import type { Session } from '@wevir/protocol';

/** 旧版只存在本机的“运行时防止系统休眠”（U36）。连旧 Host 时仍用它。 */
export const PREVENT_SLEEP_STORAGE_KEY = 'wevir.prevent-sleep.v1';

/**
 * 本机判定（连旧 Host 时，0.102.0 起由 Host 判定）：有会话的回合在跑（含取消中），等审批、等回答不算。
 */
export function hasRunningTurn(
  sessions: Iterable<Pick<Session, 'state' | 'awaitingInput'>>,
): boolean {
  for (const session of sessions) {
    if (session.state === 'running' && session.awaitingInput !== true) return true;
    if (session.state === 'cancelling') return true;
  }
  return false;
}

/**
 * 把本机旧的开关迁进 Host 设置（0.102.0，Host 功能 `prevent_sleep`）：本机为 true 且 Host 还没有这一项时写过去，之后删掉本机的值。
 * 写失败时留着，下次连上再试。
 */
export async function migratePreventSleep(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  client: Pick<WevirClient, 'request'>,
): Promise<void> {
  const raw = storage.getItem(PREVENT_SLEEP_STORAGE_KEY);
  if (raw === null) return;
  let enabled = false;
  try {
    enabled = JSON.parse(raw) === true;
  } catch {
    // 格式不对当作关。
  }
  if (enabled) {
    const { settings } = await client.request('settings.get', {});
    if (settings.preventSleep === undefined) {
      await client.request('settings.update', { settings: { preventSleep: true } });
    }
  }
  storage.removeItem(PREVENT_SLEEP_STORAGE_KEY);
}
