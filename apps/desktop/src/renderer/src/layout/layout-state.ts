// 布局的界面状态（T5.2）。左栏宽度、是否收起、收起的工作区记在本机；右栏开关与浮层只在本次运行内。

import { useSyncExternalStore } from 'react';
import { createPersistedStore, createStore } from '@/lib/store';
import { clampSidebarWidth, LAYOUT } from './layout-rules';

export interface LayoutPrefs {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** 左栏树里收起的工作区。默认全部展开。 */
  collapsedWorkspaces: readonly string[];
}

const DEFAULT_PREFS: LayoutPrefs = {
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  collapsedWorkspaces: [],
};

export const layoutPrefs = createPersistedStore<LayoutPrefs>(
  'wevir.layout.v1',
  DEFAULT_PREFS,
  (raw) => {
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
    };
  },
);

export interface TransientLayout {
  sidebarOverlayOpen: boolean;
  rightPanelOpen: boolean;
}

export const transientLayout = createStore<TransientLayout>({
  sidebarOverlayOpen: false,
  rightPanelOpen: false,
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
