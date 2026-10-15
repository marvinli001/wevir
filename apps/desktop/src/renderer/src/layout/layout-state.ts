// 布局的界面状态（T5.2，R12 改）。侧栏宽度、是否收起、收起的项目与整个“项目”一节、会话侧栏开着与否与展开了哪些
// 卡片（U18）记在本机（全局）；每个会话的窗格在 pane-store.ts；侧栏、窗格区与会话侧栏的浮层、最大化只在本次运行内。

import { useSyncExternalStore } from 'react';
import { createPersistedStore, createStore } from '@/lib/store';
import { clampSidebarWidth, LAYOUT } from './layout-rules';

export interface LayoutPrefs {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** 侧栏树里收起的项目（工作区）。默认全部展开。 */
  collapsedWorkspaces: readonly string[];
  /** 侧栏的整个“项目”一节收起了（U5）。 */
  projectsCollapsed: boolean;
  /** 左栏的会话按状态还是按项目分组（U19，desktop-layout.md §13），默认按状态。 */
  sidebarView: 'status' | 'project';
  /** 会话侧栏开着（U18，desktop-layout.md §12），默认开。 */
  railShown: boolean;
  /** 会话侧栏里展开着的卡片（`registerRailCard` 的 id），默认只有“环境”。 */
  railOpen: readonly string[];
}

const DEFAULT_PREFS: LayoutPrefs = {
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  collapsedWorkspaces: [],
  projectsCollapsed: false,
  sidebarView: 'status',
  railShown: true,
  railOpen: ['environment'],
};

/** 读回偏好；v1（T5.2）的格式也认，旧版本存下的 summaryPinned 忽略。 */
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
    projectsCollapsed: value.projectsCollapsed === true,
    sidebarView: value.sidebarView === 'project' ? 'project' : 'status',
    railShown: value.railShown !== false,
    railOpen: Array.isArray(value.railOpen)
      ? value.railOpen.filter((id): id is string => typeof id === 'string')
      : DEFAULT_PREFS.railOpen,
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
  /** 会话侧栏停靠不下、以浮层显示时，浮层是否开着（U18）。 */
  railOverlayOpen: boolean;
  /** 最大化的窗格（§3.4），只对那个会话有效。 */
  maximized?: { scope: string; groupId: string };
}

export const transientLayout = createStore<TransientLayout>({
  sidebarOverlayOpen: false,
  auxOverlayOpen: false,
  railOverlayOpen: false,
});

/** 展开或收起会话侧栏的一张卡片（U18）。 */
export function toggleRailCard(id: string): void {
  layoutPrefs.set((prefs) => ({
    ...prefs,
    railOpen: prefs.railOpen.includes(id)
      ? prefs.railOpen.filter((open) => open !== id)
      : [...prefs.railOpen, id],
  }));
}

export function toggleWorkspace(workspaceId: string): void {
  layoutPrefs.set((prefs) => ({
    ...prefs,
    collapsedWorkspaces: prefs.collapsedWorkspaces.includes(workspaceId)
      ? prefs.collapsedWorkspaces.filter((id) => id !== workspaceId)
      : [...prefs.collapsedWorkspaces, workspaceId],
  }));
}

/** 展开某个项目（新建项目后在侧栏里展开它）。 */
export function expandWorkspace(workspaceId: string): void {
  layoutPrefs.set((prefs) =>
    prefs.collapsedWorkspaces.includes(workspaceId) || prefs.projectsCollapsed
      ? {
          ...prefs,
          projectsCollapsed: false,
          collapsedWorkspaces: prefs.collapsedWorkspaces.filter((id) => id !== workspaceId),
        }
      : prefs,
  );
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
