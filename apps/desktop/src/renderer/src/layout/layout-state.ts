// 布局的界面状态（T5.2，R12 改）。侧栏宽度、是否收起、收起的工作区、置顶摘要开关记在本机（全局）；
// 每个会话的窗格在 pane-store.ts；侧栏与窗格区的浮层、最大化只在本次运行内。

import { useSyncExternalStore } from 'react';
import { createPersistedStore, createStore } from '@/lib/store';
import { clampSidebarWidth, LAYOUT } from './layout-rules';

export interface LayoutPrefs {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** 侧栏树里收起的工作区。默认全部展开。 */
  collapsedWorkspaces: readonly string[];
  /** 置顶摘要卡片（desktop-layout.md §3.8），默认开。 */
  summaryPinned: boolean;
}

const DEFAULT_PREFS: LayoutPrefs = {
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  collapsedWorkspaces: [],
  summaryPinned: true,
};

/** 读回偏好；v1（T5.2，没有 summaryPinned）的格式也认。 */
export function parseLayoutPrefs(raw: unknown): LayoutPrefs | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Partial<Record<keyof LayoutPrefs, unknown>>;
  return {
    sidebarWidth:
      typeof value.sidebarWidth === 'number'
        ? clampSidebarWidth(value.sidebarWidth)
        : DEFAULT_PREFS.sidebarWidth,
    sidebarCollapsed: value.sidebarCollapsed === true,
    collapsedWorkspaces: Array.isArray(value.collapsedWorkspaces)
      ? value.collapsedWorkspaces.filter((id): id is string => typeof id === 'string')
      : [],
    summaryPinned: value.summaryPinned !== false,
  };
}

export const layoutPrefs = createPersistedStore<LayoutPrefs>(
  'wevir.layout.v2',
  DEFAULT_PREFS,
  parseLayoutPrefs,
  ['wevir.layout.v1'],
);

export interface TransientLayout {
  sidebarOverlayOpen: boolean;
  /** 窗格区停靠不下、以浮层显示时，浮层是否开着。 */
  auxOverlayOpen: boolean;
  /** 最大化的窗格（§3.4），只对那个会话有效。 */
  maximized?: { scope: string; groupId: string };
}

export const transientLayout = createStore<TransientLayout>({
  sidebarOverlayOpen: false,
  auxOverlayOpen: false,
});

export function toggleWorkspace(workspaceId: string): void {
  layoutPrefs.set((prefs) => ({
    ...prefs,
    collapsedWorkspaces: prefs.collapsedWorkspaces.includes(workspaceId)
      ? prefs.collapsedWorkspaces.filter((id) => id !== workspaceId)
      : [...prefs.collapsedWorkspaces, workspaceId],
  }));
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

/** 视口宽度（CSS px）。界面缩放时也会变。 */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth);
}

/** 视口高度（CSS px），浮层的高。 */
export function useViewportHeight(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerHeight);
}
