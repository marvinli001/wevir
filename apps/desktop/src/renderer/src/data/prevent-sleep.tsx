import { hostSupports } from '@wevir/client-sdk';
import { useEffect, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { createPersistedStore } from '@/lib/store';
import {
  hasRunningTurn,
  migratePreventSleep,
  PREVENT_SLEEP_STORAGE_KEY,
} from './prevent-sleep-model';
import { useWorkbenchData } from './workbench-data';

/**
 * 设置 → 常规的“运行时防止系统休眠”（照 Codex 桌面端），默认关。0.102.0 起存在 Host 设置 `preventSleep`；这里只给没有
 * `prevent_sleep` 的旧 Host 用，连上新 Host 时迁过去（`migratePreventSleep`）。
 */
export const preventSleepPref = createPersistedStore<boolean>(
  PREVENT_SLEEP_STORAGE_KEY,
  false,
  (raw) => (typeof raw === 'boolean' ? raw : undefined),
);

/**
 * 让主进程按需挡住系统的空闲睡眠（powerSaveBlocker）。Host 有 `prevent_sleep` 时照 Host 的判定（`power.get` / `power.changed`）；
 * 旧 Host 上照旧在这里判定：打开了开关且列表里有会话的回合在跑（含取消中），等审批、等回答不算。挂在 App 里，不画东西。
 */
export function PreventSleepCoordinator() {
  const { client, view } = useHostConnection();
  const hostOwned =
    view.status === 'connected' && hostSupports(view.hello.features, 'prevent_sleep');
  const [hostKeepAwake, setHostKeepAwake] = useState(false);
  const enabled = preventSleepPref.use();
  const data = useWorkbenchData();

  useEffect(() => {
    if (!client || !hostOwned) return;
    let disposed = false;
    const read = () =>
      client
        .request('power.get', {})
        .then(({ keepAwake }) => {
          if (!disposed) setHostKeepAwake(keepAwake);
        })
        .catch(() => undefined);
    const stop = client.onPowerChanged((change) => {
      if (change === undefined) void read();
      else setHostKeepAwake(change.keepAwake);
    });
    void migratePreventSleep(window.localStorage, client)
      .catch(() => undefined)
      .finally(() => void read());
    return () => {
      disposed = true;
      stop();
      setHostKeepAwake(false);
    };
  }, [client, hostOwned]);

  const active = hostOwned
    ? hostKeepAwake
    : enabled &&
      data.status === 'ready' &&
      hasRunningTurn(data.workspaces.flatMap((entry) => entry.sessions));
  useEffect(() => {
    window.wevir?.setPreventSleep(active).catch(() => undefined);
  }, [active]);
  return null;
}
