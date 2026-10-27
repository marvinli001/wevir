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
  /** 按项目分组时收起了子会话的线程（session-threads.ts，以最上面那个会话的 ID 记）。默认全部展开。 */
  collapsedThreads: readonly string[];
  /** 左栏的会话按状态还是按项目分组（U19，desktop-layout.md §13），默认按状态。 */
  sidebarView: 'status' | 'project';
  /** 地方够时会话侧栏开着（U18，desktop-layout.md §12），默认开；地方紧时默认收起，见 rail-model.ts 的 railRoom。 */
  railShown: boolean;
  /** 会话侧栏里展开着的卡片（`registerRailCard` 的 id），默认只有“环境”。 */
  railOpen: readonly string[];
  /** 用户在设置里打开的可选卡片（`OPTIONAL_RAIL_CARDS`），默认都不显示。 */
  railCards: readonly string[];
}

/**
 * 会话侧栏里要在设置中打开才显示的卡片（按侧栏里的顺序）：不管有没有内容都会占一张卡片的那几张，以及用户想自己决定要不要看的几张。其余卡片有内容才出现。
 */
export const OPTIONAL_RAIL_CARDS = [
  'instructions',
  'rules',
  'readiness',
  'verification',
  'preview',
  'lsp',
  'task-board',
  'retro',
] as const;

const DEFAULT_PREFS: LayoutPrefs = {
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  collapsedWorkspaces: [],
  projectsCollapsed: false,
  collapsedThreads: [],
  sidebarView: 'status',
  railShown: true,
  railOpen: ['environment'],
  railCards: [],
};

/**
 * 读回偏好；v1（T5.2）的格式也认，旧版本存下的 summaryPinned 忽略。从 v1、v2 迁来时（`legacy`），侧栏宽还是旧默认
 * 260 的当作没拖过，换成新的默认（2026-10-15 起 300）。
 */
export function parseLayoutPrefs(raw: unknown, legacy = false): LayoutPrefs | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Partial<Record<keyof LayoutPrefs, unknown>>;
  return {
    sidebarWidth:
      typeof value.sidebarWidth === 'number' &&
      !(legacy && value.sidebarWidth === LAYOUT.legacySidebarDefault)
        ? clampSidebarWidth(value.sidebarWidth)
        : DEFAULT_PREFS.sidebarWidth,
    sidebarCollapsed: value.sidebarCollapsed === true,
    collapsedWorkspaces: Array.isArray(value.collapsedWorkspaces)
      ? value.collapsedWorkspaces.filter((id): id is string => typeof id === 'string')
      : [],
    projectsCollapsed: value.projectsCollapsed === true,
    collapsedThreads: Array.isArray(value.collapsedThreads)
      ? value.collapsedThreads.filter((id): id is string => typeof id === 'string')
      : [],
    sidebarView: value.sidebarView === 'project' ? 'project' : 'status',
    railShown: value.railShown !== false,
    railOpen: Array.isArray(value.railOpen)
      ? value.railOpen.filter((id): id is string => typeof id === 'string')
      : DEFAULT_PREFS.railOpen,
    railCards: Array.isArray(value.railCards)
      ? value.railCards.filter((id): id is string => typeof id === 'string')
      : DEFAULT_PREFS.railCards,
  };
}

export const layoutPrefs = createPersistedStore<LayoutPrefs>(
  'wevir.layout.v3',
  DEFAULT_PREFS,
  parseLayoutPrefs,
  ['wevir.layout.v2', 'wevir.layout.v1'],
);

export interface TransientLayout {
  sidebarOverlayOpen: boolean;
  /** 窗格区停靠不下、以浮层显示时，浮层是否开着。 */
  auxOverlayOpen: boolean;
  /** 会话侧栏停靠不下、以浮层显示时，浮层是否开着（U18）。 */
  railOverlayOpen: boolean;
  /** 会话侧栏地方紧（rail-model.ts 的 `tight`）、默认收起时，用户把它停靠出来了。窗口变宽或放不下时清掉。 */
  railTightOpen: boolean;
  /** 最大化的窗格（§3.4），只对那个会话有效。 */
  maximized?: { scope: string; groupId: string };
}

export const transientLayout = createStore<TransientLayout>({
  sidebarOverlayOpen: false,
  auxOverlayOpen: false,
  railOverlayOpen: false,
  railTightOpen: false,
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

/** 在设置里打开或关掉会话侧栏的一张可选卡片。 */
export function setRailCardEnabled(id: string, enabled: boolean): void {
  layoutPrefs.set((prefs) => ({
    ...prefs,
    railCards: enabled
      ? prefs.railCards.includes(id)
        ? prefs.railCards
        : [...prefs.railCards, id]
      : prefs.railCards.filter((card) => card !== id),
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

/** 展开或收起侧栏里一个会话的子会话。 */
export function toggleThread(sessionId: string): void {
  layoutPrefs.set((prefs) => ({
    ...prefs,
    collapsedThreads: prefs.collapsedThreads.includes(sessionId)
      ? prefs.collapsedThreads.filter((id) => id !== sessionId)
      : [...prefs.collapsedThreads, sessionId],
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

// 量根元素而不是 window.innerWidth / innerHeight：手机浏览器里有东西横向溢出时页面会缩小去装下它，innerWidth 跟着变大
// （375 宽的屏幕上量到过 900 多），侧栏就停靠下来、把主窗格挤到几十像素；根元素的 clientWidth 仍是屏幕本来的宽，双指缩放
// 也不变。桌面端根元素不滚动，两者相同。

/** 视口宽度（CSS px）。界面缩放时也会变。 */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, () => document.documentElement.clientWidth);
}

/** 视口高度（CSS px），浮层的高。 */
export function useViewportHeight(): number {
  return useSyncExternalStore(subscribeResize, () => document.documentElement.clientHeight);
}
