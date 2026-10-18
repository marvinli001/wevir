import { useEffect } from 'react';
import { createPersistedStore } from '@/lib/store';
import { useWorkbenchData } from './workbench-data';

/** 设置 → 常规的“运行时防止系统休眠”（照 Codex 桌面端），只存在本机，默认关。 */
export const preventSleepPref = createPersistedStore<boolean>(
  'wevir.prevent-sleep.v1',
  false,
  (raw) => (typeof raw === 'boolean' ? raw : undefined),
);

/**
 * 打开了“运行时防止系统休眠”且列表里有会话的回合在跑（含取消中）时，让主进程挡住系统的空闲睡眠（powerSaveBlocker）。
 * 等审批、等回答不算在跑。挂在 App 里，不画东西。
 */
export function PreventSleepCoordinator() {
  const enabled = preventSleepPref.use();
  const data = useWorkbenchData();
  const running =
    data.status === 'ready' &&
    data.workspaces.some((entry) =>
      entry.sessions.some(
        (session) =>
          (session.state === 'running' && !session.awaitingInput) || session.state === 'cancelling',
      ),
    );
  const active = enabled && running;
  useEffect(() => {
    window.wevir?.setPreventSleep(active).catch(() => undefined);
  }, [active]);
  return null;
}
