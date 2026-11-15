// 关掉过的下一步卡片（按回合 ID，只存本机）：卡片不再画，侧栏也不再因这个回合的 `wrapUp.blocked` 标“等决定”。

import { useSyncExternalStore } from 'react';
import { createPersistedStore } from '@/lib/store';
import { dismissWrapUp, parseDismissedWrapUps } from '@/session/wrap-up-model';

const dismissed = createPersistedStore<readonly string[]>(
  'wevir.wrap-up-dismissed.v1',
  [],
  parseDismissedWrapUps,
);

export function dismissWrapUpCard(turnId: string): void {
  dismissed.set((current) => dismissWrapUp(current, turnId));
}

export function isWrapUpDismissed(turnId: string): boolean {
  return dismissed.get().includes(turnId);
}

/** 整个列表：按它重算侧栏分组的组件订阅它。 */
export const useDismissedWrapUps = dismissed.use;

/** 一个回合的卡片关掉了没有。 */
export function useWrapUpDismissed(turnId: string | undefined): boolean {
  return useSyncExternalStore(dismissed.subscribe, () =>
    turnId === undefined ? false : isWrapUpDismissed(turnId),
  );
}
