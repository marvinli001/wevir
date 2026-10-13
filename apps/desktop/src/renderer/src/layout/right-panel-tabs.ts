// 右栏的标签（T5.2）：每个会话一组 `{type, …}` 标签，切换会话时右栏跟着换到那个会话的那一组。骨架只有
// “概览”一种；Phase 1 加文件、Diff、成果时在 RightPanelTab 里加成员（例如 `{ type: 'file', path }`），
// 布局与存取方式不变。只在本次运行内保存。

import { createStore } from '@/lib/store';

export type RightPanelTab = { type: 'overview' };

export interface RightPanelTabs {
  tabs: readonly RightPanelTab[];
  activeIndex: number;
}

/** 一组标签属于哪个会话：会话 ID，新会话草稿用 `draft:<workspaceId>`，首页等没有会话的页面用 `none`。 */
export type RightPanelKey = string;

export function rightPanelKey(workspaceId?: string, sessionId?: string): RightPanelKey {
  if (sessionId !== undefined) return sessionId;
  if (workspaceId !== undefined) return `draft:${workspaceId}`;
  return 'none';
}

const DEFAULT_TABS: RightPanelTabs = { tabs: [{ type: 'overview' }], activeIndex: 0 };

const tabsByKey = createStore<ReadonlyMap<RightPanelKey, RightPanelTabs>>(new Map());

export function useRightPanelTabs(key: RightPanelKey): RightPanelTabs {
  return tabsByKey.use().get(key) ?? DEFAULT_TABS;
}

export function selectRightPanelTab(key: RightPanelKey, index: number): void {
  tabsByKey.set((current) => {
    const tabs = current.get(key) ?? DEFAULT_TABS;
    if (index < 0 || index >= tabs.tabs.length || index === tabs.activeIndex) return current;
    return new Map(current).set(key, { ...tabs, activeIndex: index });
  });
}
