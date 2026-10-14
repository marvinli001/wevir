// 每个会话的窗格状态存在本机（R12，desktop-layout.md §5）：localStorage `wevir.panes.v1`，只有 ID、种类、参数与
// 比例。操作本身是 pane-state.ts 的纯函数，这里只负责读写与清理。

import { useMemo } from 'react';
import { createPersistedStore } from '@/lib/store';
import {
  EMPTY_STORED,
  moveScope,
  parseStoredPanes,
  pruneStored,
  type ScopePanes,
  scopeOf,
  storeScope,
} from './pane-state';

const panesStore = createPersistedStore('wevir.panes.v1', EMPTY_STORED, parseStoredPanes);

/** 标签与窗格组的 ID，只在本机的窗格状态里用，不需要全局唯一。 */
export function newPaneId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 一个会话（或草稿）的窗格状态；首页这类没有窗格区的页面是 undefined。 */
export function useScopePanes(
  scopeKey: string | undefined,
  workspaceId: string | undefined,
): ScopePanes | undefined {
  const stored = panesStore.use();
  return useMemo(
    () =>
      scopeKey === undefined || workspaceId === undefined
        ? undefined
        : scopeOf(stored, scopeKey, workspaceId),
    [stored, scopeKey, workspaceId],
  );
}

/** 改一个会话的窗格状态；update 原样返回时不写。 */
export function updateScope(
  scopeKey: string,
  workspaceId: string,
  update: (scope: ScopePanes) => ScopePanes,
): void {
  panesStore.set((stored) => {
    const current = scopeOf(stored, scopeKey, workspaceId);
    const next = update(current);
    return next === current ? stored : storeScope(stored, scopeKey, workspaceId, next, Date.now());
  });
}

/** 草稿变成会话时把窗格集搬过去（§2.2）。 */
export function movePaneScope(from: string, to: string): void {
  panesStore.set((stored) => moveScope(stored, from, to, Date.now()));
}

/** 会话列表读成功后清掉不在了的会话与工作区（§5.1）。 */
export function prunePaneScopes(
  sessionIds: ReadonlySet<string>,
  workspaceIds: ReadonlySet<string>,
): void {
  panesStore.set((stored) => pruneStored(stored, sessionIds, workspaceIds));
}
