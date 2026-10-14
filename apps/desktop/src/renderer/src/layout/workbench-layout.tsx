import { cn } from 'cn';
import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useWorkbenchData } from '@/data/workbench-data';
import { resolveRoute, type WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { formatShortcut, matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { useRememberLocation } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import { type AuxPlan, arrangePanes, auxRatioAfterDrag, focusOrder, PANE_LAYOUT } from './arrange';
import { clampSidebarWidth, LAYOUT, planSidebar, type SidebarPlan } from './layout-rules';
import { layoutPrefs, transientLayout, useViewportHeight, useViewportWidth } from './layout-state';
import { OpenTabsMenu } from './open-tabs-menu';
import { PaneTree, type SplitResizeHandlers } from './pane-area';
import { type PaneController, PaneControllerProvider, usePaneController } from './pane-controller';
import type { PaneContext } from './pane-registry';
import {
  emptyScope,
  focusedGroup,
  type PaneSizes,
  PRIMARY,
  paneScopeKey,
  resetAuxRatio,
  resetSplitRatios,
  setAuxRatio,
  setSplitRatios,
} from './pane-state';
import { prunePaneScopes, updateScope, useScopePanes } from './pane-store';
import { Sidebar } from './sidebar';
import { Splitter } from './splitter';
import { SummaryCard, SummaryToggle } from './summary-card';

/** 浮层顶上一行（标题与关闭按钮）的高，与顶栏一样是 44。 */
const OVERLAY_HEADER = 44;
const NO_PANES = emptyScope();

/**
 * 工作台（R12，docs/architecture/desktop-layout.md）：侧栏（工作区 → 会话）、顶栏、主窗格（路由内容）与窗格区。
 * 侧栏停靠还是浮层由 layout-rules.ts 按视口宽度决定；窗格区停靠、浮层还是最大化，以及里面的排布，由 arrange.ts
 * 按内容区的尺寸与当前会话的窗格状态算出来。
 */
export function WorkbenchLayout() {
  const viewportWidth = useViewportWidth();
  const viewportHeight = useViewportHeight();
  const prefs = layoutPrefs.use();
  const transient = transientLayout.use();
  const [dragWidth, setDragWidth] = useState<number>();
  const sidebarDragStart = useRef(0);
  // 浮层关闭后焦点回到打开它的按钮。
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const auxToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarPlan = planSidebar({
    viewportWidth,
    sidebarWidth: dragWidth ?? prefs.sidebarWidth,
    sidebarCollapsed: prefs.sidebarCollapsed,
    sidebarOverlayOpen: transient.sidebarOverlayOpen,
  });

  const { workspaceId, sessionId, childId } = useParams();
  const header = useHeader(workspaceId, sessionId);
  const location = useLocation();
  useRememberLocation(workspaceId, sessionId);
  usePrunePanes();

  // 当前会话的窗格：拖动分隔条时尺寸先用草稿，松开再写回本机。
  const scopeKey = header.panes ? paneScopeKey(workspaceId, sessionId) : undefined;
  const storedScope = useScopePanes(scopeKey, workspaceId);
  const [draftSizes, setDraftSizes] = useState<PaneSizes>();
  const scope = storedScope && draftSizes ? { ...storedScope, sizes: draftSizes } : storedScope;
  const [contentRef, content] = useElementSize();
  const maximized =
    transient.maximized && transient.maximized.scope === scopeKey
      ? transient.maximized.groupId
      : undefined;
  const plan = arrangePanes({
    width: content.width,
    height: content.height,
    overlayHeight: viewportHeight - OVERLAY_HEADER,
    panes: scope ?? NO_PANES,
    maximized,
  });
  const panes = usePaneController(
    scopeKey,
    workspaceId,
    scope,
    plan,
    maximized,
    transient.auxOverlayOpen,
  );
  const [openTabsOpen, setOpenTabsOpen] = useState(false);

  // 换页面时收起侧栏的浮层；换会话时收起窗格区的浮层（进出子智能体详情不算：详情就画在窗格区里）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在路由变化时触发。
  useEffect(() => {
    transientLayout.set((state) =>
      state.sidebarOverlayOpen ? { ...state, sidebarOverlayOpen: false } : state,
    );
  }, [location.pathname]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换会话时触发。
  useEffect(() => {
    transientLayout.set((state) =>
      state.auxOverlayOpen ? { ...state, auxOverlayOpen: false } : state,
    );
  }, [scopeKey]);
  useSubagentRoute(panes, workspaceId, sessionId, childId);

  // 浮层的开关只对浮层模式有意义；停靠后清掉，窗口再变窄时不会自己弹出来。
  useEffect(() => {
    if (plan.mode !== 'overlay' && transient.auxOverlayOpen) {
      transientLayout.set((state) => ({ ...state, auxOverlayOpen: false }));
    }
  }, [plan.mode, transient.auxOverlayOpen]);

  useShortcuts(sidebarPlan, panes, setOpenTabsOpen);

  const setSidebarOverlayOpen = (open: boolean) =>
    transientLayout.set((state) => ({ ...state, sidebarOverlayOpen: open }));
  const setAuxOverlayOpen = (open: boolean) =>
    transientLayout.set((state) => ({ ...state, auxOverlayOpen: open }));
  const commitSidebarWidth = (width: number) => {
    setDragWidth(undefined);
    layoutPrefs.set((current) => ({ ...current, sidebarWidth: clampSidebarWidth(width) }));
  };

  const commitScope = (update: Parameters<typeof updateScope>[2]) => {
    setDraftSizes(undefined);
    if (scopeKey !== undefined && workspaceId !== undefined)
      updateScope(scopeKey, workspaceId, update);
  };
  const auxDragStart = useRef(0);
  const auxRatio = (delta: number) =>
    auxRatioAfterDrag(plan, content.width, auxDragStart.current, delta);
  const splitResize: SplitResizeHandlers = {
    onDraft: (key, fractions) =>
      storedScope && setDraftSizes(setSplitRatios(storedScope, key, fractions).sizes),
    onCommit: (key, fractions) => commitScope((current) => setSplitRatios(current, key, fractions)),
    onReset: (key) => commitScope((current) => resetSplitRatios(current, key)),
  };
  const paneContext: PaneContext = { entry: header.entry, sessionId, childId };
  const tree = (node: NonNullable<AuxPlan['tree']>) => (
    <PaneTree node={node} context={paneContext} resize={splitResize} />
  );

  return (
    <PaneControllerProvider value={panes}>
      <div className="flex h-full overflow-hidden" data-layout-sidebar={sidebarPlan.sidebar}>
        {sidebarPlan.sidebar === 'docked' && (
          <aside
            className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
            style={{ width: sidebarPlan.sidebarWidth }}
          >
            <Sidebar onCollapse={() => toggleSidebar(sidebarPlan)} />
            <Splitter
              orientation="vertical"
              label={t('layout.resizeSidebar')}
              valueNow={sidebarPlan.sidebarWidth}
              valueMin={LAYOUT.sidebarMin}
              valueMax={LAYOUT.sidebarMax}
              onResizeStart={() => {
                sidebarDragStart.current = sidebarPlan.sidebarWidth;
              }}
              onResize={(delta) =>
                setDragWidth(clampSidebarWidth(sidebarDragStart.current + delta))
              }
              onResizeEnd={(delta) => commitSidebarWidth(sidebarDragStart.current + delta)}
              onReset={() => commitSidebarWidth(LAYOUT.sidebarDefault)}
              className="absolute inset-y-0 -right-1"
            />
          </aside>
        )}
        <Sheet open={sidebarPlan.sidebar === 'overlay'} onOpenChange={setSidebarOverlayOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            finalFocus={sidebarToggleRef}
            className="gap-0 bg-sidebar text-sidebar-foreground data-[side=left]:w-(--overlay-width)"
            style={{ '--overlay-width': `${sidebarPlan.sidebarWidth}px` } as CSSProperties}
          >
            <SheetTitle className="sr-only">{t('sidebar.workspaces')}</SheetTitle>
            <Sidebar onCollapse={() => setSidebarOverlayOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={cn(
              'app-drag flex h-11 shrink-0 items-center gap-2 border-b border-border px-3',
              // 侧栏没有停靠时，这条顶栏在窗口最左边，要给红绿灯让位。
              sidebarPlan.sidebar !== 'docked' && 'pl-[max(0.75rem,var(--traffic-lights-inset))]',
            )}
          >
            {sidebarPlan.sidebar !== 'docked' && (
              <IconButton
                ref={sidebarToggleRef}
                label={t('layout.expandSidebar')}
                shortcut={formatShortcut(SHORTCUTS.toggleSidebar)}
                onClick={() => toggleSidebar(sidebarPlan)}
                tooltipSide="bottom"
              >
                <PanelLeftOpen />
              </IconButton>
            )}
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h1 className="truncate text-sm font-medium" data-testid="header-title">
                {header.title}
              </h1>
              {header.subtitle && (
                <span className="max-w-[40%] shrink-0 truncate text-xs text-faint-foreground">
                  {header.subtitle}
                </span>
              )}
            </div>
            {panes && (
              <div className="flex shrink-0 items-center gap-0.5">
                <SummaryToggle
                  sessionId={sessionId}
                  workspaceName={header.subtitle ?? ''}
                  primaryWidth={plan.primaryWidth}
                />
                <span aria-hidden className="mx-1 h-4 w-px bg-border" />
                <OpenTabsMenu open={openTabsOpen} onOpenChange={setOpenTabsOpen} />
                <IconButton
                  ref={auxToggleRef}
                  label={t(panes.auxShown ? 'layout.hideAux' : 'layout.showAux')}
                  shortcut={formatShortcut(SHORTCUTS.toggleAux)}
                  aria-pressed={panes.auxShown}
                  className={cn(panes.auxShown && 'bg-accent')}
                  onClick={panes.toggleAux}
                  tooltipSide="bottom"
                >
                  {panes.auxShown ? <PanelRightClose /> : <PanelRightOpen />}
                </IconButton>
              </div>
            )}
          </header>

          <div ref={contentRef} className="relative flex min-h-0 flex-1">
            <main
              data-pane-id={PRIMARY}
              tabIndex={-1}
              inert={plan.mode === 'maximized'}
              onPointerDownCapture={() => panes?.focus(PRIMARY)}
              className={cn(
                'relative min-h-0 min-w-0 outline-none',
                plan.mode === 'docked' ? 'shrink-0' : 'flex-1',
                // 最大化时主窗格留在原处、只是看不见，消息流的滚动位置与输入框里的草稿都还在。
                plan.mode === 'maximized' && 'invisible absolute inset-0',
              )}
              style={plan.mode === 'docked' ? { width: plan.primaryWidth } : undefined}
            >
              <Outlet />
              {panes && header.entry && (
                <SummaryCard
                  sessionId={sessionId}
                  workspaceName={header.entry.workspace.displayName}
                  primaryWidth={plan.primaryWidth}
                />
              )}
            </main>
            {plan.mode === 'docked' && plan.tree && (
              <div className="flex shrink-0 bg-sidebar">
                <Splitter
                  orientation="vertical"
                  label={t('layout.resizeAux')}
                  valueNow={plan.auxWidth}
                  valueMin={plan.auxMinWidth}
                  valueMax={plan.auxMaxWidth}
                  onResizeStart={() => {
                    auxDragStart.current = plan.auxWidth;
                  }}
                  onResize={(delta) =>
                    storedScope &&
                    setDraftSizes(setAuxRatio(storedScope, plan.columns, auxRatio(delta)).sizes)
                  }
                  onResizeEnd={(delta) => {
                    const ratio = auxRatio(delta);
                    commitScope((current) => setAuxRatio(current, plan.columns, ratio));
                  }}
                  onReset={() => commitScope((current) => resetAuxRatio(current, plan.columns))}
                />
                <div className="flex py-2 pr-2" style={{ width: plan.auxWidth + PANE_LAYOUT.gap }}>
                  {tree(plan.tree)}
                </div>
              </div>
            )}
            {plan.mode === 'maximized' && plan.tree && (
              <div className="flex min-w-0 flex-1 bg-sidebar p-2">{tree(plan.tree)}</div>
            )}
          </div>
        </div>

        <Sheet
          open={plan.mode === 'overlay' && transient.auxOverlayOpen}
          onOpenChange={setAuxOverlayOpen}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            finalFocus={auxToggleRef}
            className="gap-0 bg-sidebar text-sidebar-foreground data-[side=right]:w-(--overlay-width) data-[side=right]:sm:max-w-none"
            style={{ '--overlay-width': `${plan.auxWidth}px` } as CSSProperties}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
              <SheetTitle className="shrink-0 text-sm">{t('layout.auxOverlay')}</SheetTitle>
              {sidebarPlan.sidebar === 'docked' && (
                <span className="min-w-0 truncate text-xs text-faint-foreground">
                  {t('layout.auxOverlayHint')}
                </span>
              )}
              <IconButton
                label={t('layout.hideAux')}
                className="ml-auto"
                onClick={() => setAuxOverlayOpen(false)}
                tooltipSide="bottom"
              >
                <PanelRightClose />
              </IconButton>
            </div>
            <div className="flex min-h-0 flex-1 p-2">{plan.tree && tree(plan.tree)}</div>
          </SheetContent>
        </Sheet>
      </div>
    </PaneControllerProvider>
  );
}

/** 侧栏能停靠时切换“收起”偏好（记住）；放不下时切换浮层（不记住）。 */
function toggleSidebar(plan: SidebarPlan): void {
  if (plan.sidebarCanDock) {
    layoutPrefs.set((prefs) => ({ ...prefs, sidebarCollapsed: !prefs.sidebarCollapsed }));
  } else {
    transientLayout.set((state) => ({ ...state, sidebarOverlayOpen: !state.sidebarOverlayOpen }));
  }
}

/**
 * 子智能体详情的路由（R5，desktop-layout.md §5.2）：URL 带 `agent/:childId` 时保证“子智能体”标签打开（窗格区收起、
 * 在浮层里或被别的窗格最大化盖住时也显示出来）；还在这个地址时它被关掉，就回到父会话的地址。
 */
function useSubagentRoute(
  panes: PaneController | undefined,
  workspaceId: string | undefined,
  sessionId: string | undefined,
  childId: string | undefined,
) {
  const navigate = useNavigate();
  const latest = useRef(panes);
  latest.current = panes;
  const ready = panes !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在进入详情（换子会话或会话）时打开一次。
  useEffect(() => {
    if (childId !== undefined && ready) latest.current?.open({ kind: 'subagents' });
  }, [childId, sessionId, ready]);

  const scopeKey = panes?.scopeKey;
  const hasTab =
    panes?.scope.groups.some((group) => group.tabs.some((tab) => tab.kind === 'subagents')) ??
    false;
  const previous = useRef<{ scopeKey?: string; hasTab: boolean }>({ hasTab: false });
  useEffect(() => {
    const before = previous.current;
    previous.current = { scopeKey, hasTab };
    // 只看同一个会话里“有 → 没有”：换会话时新会话可能还没打开这个标签，那不是用户关掉的。
    if (before.scopeKey !== scopeKey || !before.hasTab || hasTab) return;
    if (childId !== undefined && workspaceId !== undefined && sessionId !== undefined) {
      navigate(paths.session(workspaceId, sessionId));
    }
  }, [scopeKey, hasTab, childId, workspaceId, sessionId, navigate]);
}

/** 内容区的尺寸：首帧前量一次，之后跟着 ResizeObserver。 */
function useElementSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** 会话列表读成功后清掉不在了的会话与工作区的窗格状态（§5.1）。 */
function usePrunePanes() {
  const data = useWorkbenchData();
  useEffect(() => {
    if (data.status !== 'ready') return;
    prunePaneScopes(
      new Set(data.workspaces.flatMap((entry) => entry.sessions.map((session) => session.id))),
      new Set(data.workspaces.map((entry) => entry.workspace.id)),
    );
  }, [data]);
}

/** 全局快捷键（§3.10）。输入法合成期间、已经被别处处理过的按键不响应。 */
function useShortcuts(
  sidebarPlan: SidebarPlan,
  panes: PaneController | undefined,
  setOpenTabsOpen: (open: boolean) => void,
) {
  const latest = useRef({ sidebarPlan, panes });
  latest.current = { sidebarPlan, panes };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const { sidebarPlan, panes } = latest.current;
      const run = (action: () => void) => {
        event.preventDefault();
        action();
      };
      if (matchesShortcut(event, SHORTCUTS.toggleSidebar))
        return run(() => toggleSidebar(sidebarPlan));
      if (!panes) return;
      const current = focusedPaneId(panes);
      const group = panes.scope.groups.find((candidate) => candidate.id === current);
      if (matchesShortcut(event, SHORTCUTS.toggleAux)) return run(panes.toggleAux);
      if (matchesShortcut(event, SHORTCUTS.openTabs)) {
        if (panes.scope.groups.length > 0) run(() => setOpenTabsOpen(true));
        return;
      }
      if (matchesShortcut(event, SHORTCUTS.maximize)) {
        const target = panes.maximized ?? group?.id;
        if (target !== undefined) run(() => panes.toggleMaximize(target));
        return;
      }
      if (matchesShortcut(event, SHORTCUTS.splitRight)) {
        if (group && group.tabs.length > 1) run(() => panes.split(group.activeTabId, 'right'));
        return;
      }
      for (const [shortcut, delta] of [
        [SHORTCUTS.nextTab, 1],
        [SHORTCUTS.previousTab, -1],
      ] as const) {
        if (matchesShortcut(event, shortcut)) {
          if (group) run(() => panes.cycle(group.id, delta));
          return;
        }
      }
      for (const [shortcut, delta] of [
        [SHORTCUTS.nextPane, 1],
        [SHORTCUTS.previousPane, -1],
      ] as const) {
        if (matchesShortcut(event, shortcut)) {
          run(() => movePaneFocus(panes, current, delta));
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpenTabsOpen]);
}

/** 快捷键作用的“当前窗格”：最近聚焦的窗格组；最近聚焦的是主窗格时就是主窗格。 */
function focusedPaneId(panes: PaneController): string | undefined {
  if (panes.maximized !== undefined) return panes.maximized;
  const first = panes.scope.focus[0];
  if (first === PRIMARY) return PRIMARY;
  return focusedGroup(panes.scope)?.id;
}

/** 在主窗格与显示出来的窗格之间移动焦点（从左到右、从上到下）。 */
function movePaneFocus(panes: PaneController, current: string | undefined, delta: number) {
  const order = focusOrder(panes.plan);
  if (order.length === 0) return;
  const index = current === undefined ? -1 : order.indexOf(current);
  const next = order[(index + delta + order.length) % order.length];
  if (next === undefined) return;
  panes.focus(next);
  document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(next)}"]`)?.focus();
}

interface Header {
  title: string;
  subtitle?: string;
  entry?: WorkspaceEntry;
  /** 会话与新会话草稿有窗格区；首页、未找到没有。 */
  panes: boolean;
}

/** 顶栏标题：会话标题 · 工作区名；草稿页是“新会话”；首页、设置、未找到等页面不显示标题。 */
function useHeader(workspaceId: string | undefined, sessionId: string | undefined): Header {
  const data = useWorkbenchData();
  if (workspaceId === undefined) return { title: '', panes: false };
  const target = resolveRoute(data, workspaceId, sessionId);
  switch (target.kind) {
    case 'session':
      return {
        title: target.session.title || t('session.untitled'),
        subtitle: target.entry.workspace.displayName,
        entry: target.entry,
        panes: true,
      };
    case 'draft':
      return {
        title: t('session.draftTitle'),
        subtitle: target.entry.workspace.displayName,
        entry: target.entry,
        panes: true,
      };
    case 'session-not-found':
      return { title: t('notFound.title'), entry: target.entry, panes: false };
    case 'workspace-not-found':
      return { title: t('notFound.title'), panes: false };
    case 'loading':
    case 'unavailable':
      return { title: '', panes: false };
  }
}
