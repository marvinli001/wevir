import { createContext, useContext, useMemo } from 'react';
import type { AuxPlan } from './arrange';
import { transientLayout } from './layout-state';
import { emitPanesClosed } from './pane-events';
import type { PaneParams } from './pane-kinds';
import {
  activateTab,
  closeGroup,
  closeTab,
  cycleTab,
  findTab,
  focusPane,
  moveTab,
  type OpenRequest,
  openPane,
  type ScopePanes,
  type SplitDirection,
  setTabParams,
  splitTab,
  toggleAux,
} from './pane-state';
import { newPaneId, updateScope } from './pane-store';

/**
 * 当前会话的窗格操作（R12）。工作台布局提供，窗格、已打开的标签页、置顶摘要，以及以后的功能（R5 的子智能体
 * 等）经 usePanes() 打开或关闭窗格。首页这类没有窗格区的页面拿到 undefined。
 */
export interface PaneController {
  scopeKey: string;
  scope: ScopePanes;
  plan: AuxPlan;
  /** 最大化的窗格组。 */
  maximized: string | undefined;
  /** 窗格区现在看得见：停靠、最大化，或浮层开着。 */
  auxShown: boolean;
  open(request: OpenRequest): void;
  activate(tabId: string): void;
  closeTab(tabId: string): void;
  /** 换掉标签的参数（不打开、不聚焦）。 */
  setParams(tabId: string, params: PaneParams): void;
  closeGroups(groupIds: readonly string[]): void;
  focus(id: string): void;
  split(tabId: string, direction: SplitDirection): void;
  move(tabId: string, groupId: string): void;
  cycle(groupId: string, delta: number): void;
  toggleAux(): void;
  toggleMaximize(groupId: string): void;
}

const PaneControllerContext = createContext<PaneController | undefined>(undefined);

export const PaneControllerProvider = PaneControllerContext.Provider;

export function usePanes(): PaneController | undefined {
  return useContext(PaneControllerContext);
}

/** 打开或激活标签会让窗格区显示；停靠不下时打开浮层（停靠时工作台布局会把这个标记清掉）。 */
function showOverlay(): void {
  transientLayout.set((state) =>
    state.auxOverlayOpen ? state : { ...state, auxOverlayOpen: true },
  );
}

function setMaximized(scopeKey: string, groupId: string | undefined): void {
  transientLayout.set((state) => ({
    ...state,
    maximized: groupId === undefined ? undefined : { scope: scopeKey, groupId },
  }));
}

export function usePaneController(
  scopeKey: string | undefined,
  workspaceId: string | undefined,
  scope: ScopePanes | undefined,
  plan: AuxPlan,
  maximized: string | undefined,
  auxOverlayOpen: boolean,
): PaneController | undefined {
  return useMemo(() => {
    if (scopeKey === undefined || workspaceId === undefined || scope === undefined)
      return undefined;
    const update = (fn: (current: ScopePanes) => ScopePanes) =>
      updateScope(scopeKey, workspaceId, fn);
    const restoreIfHidden = (groupId: string | undefined) => {
      if (maximized !== undefined && maximized !== groupId) setMaximized(scopeKey, undefined);
    };
    return {
      scopeKey,
      scope,
      plan,
      maximized,
      auxShown:
        plan.mode === 'docked' ||
        plan.mode === 'maximized' ||
        (plan.mode === 'overlay' && auxOverlayOpen),
      open(request) {
        restoreIfHidden(undefined);
        update((current) => openPane(current, request, newPaneId));
        showOverlay();
      },
      activate(tabId) {
        restoreIfHidden(findTab(scope, tabId)?.group.id);
        update((current) => activateTab(current, tabId));
        showOverlay();
      },
      closeTab(tabId) {
        const found = findTab(scope, tabId);
        update((current) => closeTab(current, tabId));
        if (found) emitPanesClosed([found.tab]);
      },
      setParams(tabId, params) {
        update((current) => setTabParams(current, tabId, params));
      },
      closeGroups(groupIds) {
        if (maximized !== undefined && groupIds.includes(maximized))
          setMaximized(scopeKey, undefined);
        const tabs = scope.groups
          .filter((group) => groupIds.includes(group.id))
          .flatMap((group) => group.tabs);
        update((current) => groupIds.reduce(closeGroup, current));
        emitPanesClosed(tabs);
      },
      focus(id) {
        update((current) => focusPane(current, id));
      },
      split(tabId, direction) {
        restoreIfHidden(undefined);
        update((current) => splitTab(current, tabId, direction, newPaneId));
      },
      move(tabId, groupId) {
        restoreIfHidden(undefined);
        update((current) => moveTab(current, tabId, groupId));
      },
      cycle(groupId, delta) {
        update((current) => cycleTab(current, groupId, delta));
      },
      toggleAux() {
        if (plan.mode === 'overlay') {
          transientLayout.set((state) => ({ ...state, auxOverlayOpen: !auxOverlayOpen }));
          return;
        }
        if (plan.mode === 'maximized') setMaximized(scopeKey, undefined);
        update((current) => toggleAux(current, newPaneId));
        showOverlay();
      },
      toggleMaximize(groupId) {
        setMaximized(scopeKey, maximized === groupId ? undefined : groupId);
        update((current) => focusPane(current, groupId));
      },
    };
  }, [scopeKey, workspaceId, scope, plan, maximized, auxOverlayOpen]);
}
