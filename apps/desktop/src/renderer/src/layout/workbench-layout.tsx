import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useWorkbenchData } from '@/data/workbench-data';
import { resolveRoute, type WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { formatShortcut, matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { useRememberLocation } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import {
  type AuxPlan,
  arrangePanes,
  auxRatioAfterDrag,
  focusOrder,
  type LayoutNode,
  PANE_LAYOUT,
} from './arrange';
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
import './rail-cards';
import { RAIL_DOCKED_WIDTH, type RailRoom, railRoom } from './rail-model';
import { RailToggle, SessionRail } from './session-rail';
import { WindowControls } from './window-controls';

/** 浮层顶上一行（标题与关闭按钮）的高，与顶栏一样是 44。 */
const OVERLAY_HEADER = 44;
const NO_PANES = emptyScope();

/**
 * 工作台（R12，docs/architecture/desktop-layout.md）：侧栏（项目 → 会话）、顶栏、主窗格（路由内容）与窗格区。
 * 侧栏停靠还是浮层由 layout-rules.ts 按视口宽度决定；窗格区停靠、浮层还是最大化，以及里面的排布，由 arrange.ts
 * 按内容区的尺寸与当前会话的窗格状态算出来。
 *
 * U5 起照 Codex 桌面端：红绿灯后面固定是后退、前进与侧栏开关（window-controls.tsx），侧栏开合时它们不动；停靠的
 * 侧栏与窗格区开合都有宽度过渡（index.css 的 .layout-transition），侧栏露出的宽是根节点上的 `--sidebar-shown`，
 * 顶栏按它让出窗口按钮的位置。
 */
export function WorkbenchLayout() {
  const viewportWidth = useViewportWidth();
  const viewportHeight = useViewportHeight();
  const prefs = layoutPrefs.use();
  const transient = transientLayout.use();
  // 拖动侧栏分隔条时的草稿：宽度，以及是否拖过了最小宽度、要折叠（松开才写进偏好）。
  const [sidebarDrag, setSidebarDrag] = useState<{ width: number; collapsed: boolean }>();
  // 拖动中吸附折叠或展开的那一下要过渡（平时拖动跟手、不过渡）。
  const [sidebarSnapping, pulseSidebarSnap] = useSnapPulse();
  const [auxSnapping, pulseAuxSnap] = useSnapPulse();
  // 拖动窗格区分隔条拖过了最小宽度：窗格区先收起，松开才真的隐藏。
  const [auxCollapsing, setAuxCollapsing] = useState(false);
  const sidebarDragStart = useRef(0);
  // 浮层关闭后焦点回到打开它的按钮。
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const auxToggleRef = useRef<HTMLButtonElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarPlan = planSidebar({
    viewportWidth,
    sidebarWidth: sidebarDrag?.width ?? prefs.sidebarWidth,
    sidebarCollapsed: prefs.sidebarCollapsed,
    sidebarOverlayOpen: transient.sidebarOverlayOpen,
  });

  const { workspaceId, sessionId, childId } = useParams();
  const header = useHeader(workspaceId, sessionId);
  const location = useLocation();
  useRememberLocation(workspaceId);
  usePrunePanes();
  useWindowResizing();

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
  const arrange = (width: number) =>
    arrangePanes({
      width,
      height: content.height,
      overlayHeight: viewportHeight - OVERLAY_HEADER,
      panes: scope ?? NO_PANES,
      maximized,
    });
  // 会话侧栏（U18，desktop-layout.md §12）：只有会话页有；停靠后主窗格与窗格区还排得下才停靠，否则让位改浮层。
  // 地方够时按偏好显示，地方紧时默认收起（rail-model.ts 的 railRoom）。
  const rail = header.session && sessionId !== undefined ? header.session : undefined;
  const room: RailRoom =
    rail !== undefined && maximized === undefined ? railRoom(content.width, arrange) : 'none';
  const railCanDock = room !== 'none';
  const railDocked =
    room === 'roomy' ? prefs.railShown : room === 'tight' && transient.railTightOpen;
  const railOverlay = rail !== undefined && !railCanDock && transient.railOverlayOpen;
  const plan = arrange(content.width - (railDocked ? RAIL_DOCKED_WIDTH : 0));
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
      state.auxOverlayOpen || state.railOverlayOpen
        ? { ...state, auxOverlayOpen: false, railOverlayOpen: false }
        : state,
    );
  }, [scopeKey]);
  useSubagentRoute(panes, workspaceId, sessionId, childId);

  // 浮层的开关只对浮层模式有意义；停靠后清掉，窗口再变窄时不会自己弹出来。
  useEffect(() => {
    if (plan.mode !== 'overlay' && transient.auxOverlayOpen) {
      transientLayout.set((state) => ({ ...state, auxOverlayOpen: false }));
    }
  }, [plan.mode, transient.auxOverlayOpen]);
  useEffect(() => {
    if (railCanDock && transient.railOverlayOpen) {
      transientLayout.set((state) => ({ ...state, railOverlayOpen: false }));
    }
  }, [railCanDock, transient.railOverlayOpen]);
  // 地方紧时临时停靠出来的会话侧栏：窗口变宽（改按偏好）或放不下（改浮层）后清掉，再回到地方紧时又是默认收起。
  useEffect(() => {
    if (rail !== undefined && room !== 'tight' && transient.railTightOpen) {
      transientLayout.set((state) => ({ ...state, railTightOpen: false }));
    }
  }, [rail, room, transient.railTightOpen]);
  // 窗格区与会话侧栏的浮层一次只开一个：窗格区的浮层打开时收起侧栏的。
  useEffect(() => {
    if (transient.auxOverlayOpen) {
      transientLayout.set((state) =>
        state.railOverlayOpen ? { ...state, railOverlayOpen: false } : state,
      );
    }
  }, [transient.auxOverlayOpen]);

  useShortcuts(sidebarPlan, panes, setOpenTabsOpen);

  const setSidebarOverlayOpen = (open: boolean) =>
    transientLayout.set((state) => ({ ...state, sidebarOverlayOpen: open }));
  const setAuxOverlayOpen = (open: boolean) =>
    transientLayout.set((state) => ({ ...state, auxOverlayOpen: open }));
  const setRailOverlayOpen = (open: boolean) =>
    transientLayout.set((state) => ({
      ...state,
      railOverlayOpen: open,
      ...(open && { auxOverlayOpen: false }),
    }));
  // 地方够时切换偏好（记住），地方紧时临时停靠或收起，放不下时开关浮层（后两种不记住）。
  const toggleRail = () =>
    room === 'roomy'
      ? layoutPrefs.set((current) => ({ ...current, railShown: !current.railShown }))
      : room === 'tight'
        ? transientLayout.set((state) => ({ ...state, railTightOpen: !state.railTightOpen }))
        : setRailOverlayOpen(!transient.railOverlayOpen);
  const commitSidebarWidth = (width: number) => {
    setSidebarDrag(undefined);
    layoutPrefs.set((current) => ({ ...current, sidebarWidth: clampSidebarWidth(width) }));
  };
  // 拖过最小宽度松开：收起侧栏，宽度偏好不变，再打开还是原来的宽。
  const collapseSidebarByDrag = () => {
    setSidebarDrag(undefined);
    layoutPrefs.set((current) => ({ ...current, sidebarCollapsed: true }));
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
    onCancel: () => setDraftSizes(undefined),
    onReset: (key) => commitScope((current) => resetSplitRatios(current, key)),
  };
  const paneContext: PaneContext = { entry: header.entry, sessionId, childId };
  const tree = (node: NonNullable<AuxPlan['tree']>) => (
    <PaneTree node={node} context={paneContext} resize={splitResize} />
  );

  const docked = sidebarPlan.sidebar === 'docked';
  const sidebarShown = docked && !sidebarDrag?.collapsed;
  const auxDocked = plan.mode === 'docked' && plan.tree !== undefined;
  const auxShownWidth = auxDocked && !auxCollapsing;
  // 窗格区不再停靠（收起、改浮层、最大化）时丢掉拖动中的折叠草稿。
  useEffect(() => {
    if (!auxDocked) setAuxCollapsing(false);
  }, [auxDocked]);
  const retainedAux = useRetainedAux(
    auxDocked ? plan : undefined,
    scopeKey,
    plan.mode === 'maximized',
  );

  return (
    <PaneControllerProvider value={panes}>
      <div
        className="layout-transition relative flex h-full overflow-hidden"
        data-layout-sidebar={sidebarPlan.sidebar}
        data-resizing={sidebarDrag !== undefined || undefined}
        data-snapping={sidebarSnapping || undefined}
        style={
          { '--sidebar-shown': `${sidebarShown ? sidebarPlan.sidebarWidth : 0}px` } as CSSProperties
        }
      >
        {/* 收起时侧栏不卸载，宽度过渡到 0；里面一列始终是侧栏的宽，开合时不重新排版。 */}
        <aside
          aria-hidden={!docked}
          inert={!docked}
          aria-label={t('sidebar.label')}
          className="relative shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground"
          style={{ width: 'var(--sidebar-shown)' }}
        >
          <div
            className="flex h-full flex-col border-r border-sidebar-border"
            style={{ width: sidebarPlan.sidebarWidth }}
          >
            <Sidebar />
          </div>
        </aside>
        {docked && (
          <Splitter
            orientation="vertical"
            label={t('layout.resizeSidebar')}
            valueNow={sidebarPlan.sidebarWidth}
            valueMin={LAYOUT.sidebarMin}
            valueMax={LAYOUT.sidebarMax}
            collapsible="before"
            onResizeStart={() => {
              sidebarDragStart.current = sidebarPlan.sidebarWidth;
            }}
            onResize={(delta) =>
              setSidebarDrag((current) => ({
                width: clampSidebarWidth(sidebarDragStart.current + delta),
                collapsed: current?.collapsed ?? false,
              }))
            }
            onCollapseChange={(collapsed) => {
              pulseSidebarSnap();
              setSidebarDrag((current) => ({
                width: current?.width ?? sidebarDragStart.current,
                collapsed,
              }));
            }}
            onResizeEnd={(delta, collapsed) =>
              collapsed
                ? collapseSidebarByDrag()
                : commitSidebarWidth(sidebarDragStart.current + delta)
            }
            onResizeCancel={() => setSidebarDrag(undefined)}
            onReset={() => commitSidebarWidth(LAYOUT.sidebarDefault)}
            className="absolute inset-y-0 z-20 -ml-1"
            // 跟着露出的宽走：吸附折叠时分隔条随侧栏的边一起滑走。
            style={{ left: 'var(--sidebar-shown)' }}
          />
        )}
        <Sheet open={sidebarPlan.sidebar === 'overlay'} onOpenChange={setSidebarOverlayOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            finalFocus={sidebarToggleRef}
            className="gap-0 bg-sidebar text-sidebar-foreground data-[side=left]:w-(--overlay-width)"
            style={{ '--overlay-width': `${sidebarPlan.sidebarWidth}px` } as CSSProperties}
          >
            <SheetTitle className="sr-only">{t('sidebar.label')}</SheetTitle>
            <Sidebar
              controls={
                <WindowControls
                  sidebar={{ open: true, onToggle: () => setSidebarOverlayOpen(false) }}
                />
              }
            />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={cn(
              'app-drag flex h-11 shrink-0 items-center gap-2 pr-3',
              // 首页（U4，方向稿 A）没有标题，顶栏只是拖动区，不画分隔线。
              location.pathname !== paths.home() && 'border-b border-border',
            )}
            // 窗口按钮在窗口左上角不动：侧栏露出得越少，顶栏越要让出它们的位置。
            style={{
              paddingLeft:
                'max(0.75rem, calc(max(0.5rem, var(--traffic-lights-inset)) + var(--window-controls-width) + 0.5rem - var(--sidebar-shown)))',
            }}
          >
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h1 className="truncate text-sm font-medium" data-testid="header-title">
                {header.title}
              </h1>
              {header.subtitle && (
                <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                  {header.subtitle}
                </span>
              )}
            </div>
            {panes && (
              <div className="flex shrink-0 items-center gap-0.5">
                {rail && (
                  <>
                    <RailToggle
                      ref={railToggleRef}
                      shown={railDocked || railOverlay}
                      onToggle={toggleRail}
                    />
                    <span aria-hidden className="mx-1 h-4 w-px bg-border" />
                  </>
                )}
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
                'relative min-h-0 min-w-0 flex-1 outline-none',
                // 最大化时主窗格留在原处、只是看不见，消息流的滚动位置与输入框里的草稿都还在。
                plan.mode === 'maximized' && 'invisible absolute inset-0',
              )}
            >
              <Outlet />
            </main>
            {/* 停靠的窗格区：外层过渡宽度，里面一列始终是窗格区的宽；收起时留着最后的内容滑出去。与主窗格同是画布色
                （U17，desktop-tokens.md §21），窗格只靠细边框与圆角分开。 */}
            {plan.mode !== 'maximized' && (
              <div
                className="layout-transition flex shrink-0 overflow-hidden"
                data-resizing={draftSizes !== undefined || auxCollapsing || undefined}
                data-snapping={auxSnapping || undefined}
                inert={!auxDocked}
                style={{
                  width: auxShownWidth ? SPLITTER_WIDTH + plan.auxWidth + PANE_LAYOUT.gap : 0,
                }}
                onTransitionEnd={(event) => {
                  if (event.target === event.currentTarget && !auxDocked) retainedAux.clear();
                }}
              >
                {retainedAux.plan && (
                  <>
                    <Splitter
                      orientation="vertical"
                      label={t('layout.resizeAux')}
                      valueNow={retainedAux.plan.auxWidth}
                      valueMin={retainedAux.plan.auxMinWidth}
                      valueMax={retainedAux.plan.auxMaxWidth}
                      collapsible="after"
                      onResizeStart={() => {
                        auxDragStart.current = plan.auxWidth;
                      }}
                      onResize={(delta) =>
                        storedScope &&
                        setDraftSizes(setAuxRatio(storedScope, plan.columns, auxRatio(delta)).sizes)
                      }
                      onCollapseChange={(collapsed) => {
                        pulseAuxSnap();
                        setAuxCollapsing(collapsed);
                      }}
                      onResizeEnd={(delta, collapsed) => {
                        setAuxCollapsing(false);
                        if (collapsed) {
                          // 拖过最小宽度松开：隐藏窗格区，宽度比例不变，再打开还是原来的宽。
                          setDraftSizes(undefined);
                          panes?.toggleAux();
                          retainedAux.clear();
                          return;
                        }
                        const ratio = auxRatio(delta);
                        commitScope((current) => setAuxRatio(current, plan.columns, ratio));
                      }}
                      onResizeCancel={() => {
                        setAuxCollapsing(false);
                        setDraftSizes(undefined);
                      }}
                      onReset={() => commitScope((current) => resetAuxRatio(current, plan.columns))}
                    />
                    <div
                      className="flex shrink-0 py-2 pr-2"
                      style={{ width: retainedAux.plan.auxWidth + PANE_LAYOUT.gap }}
                    >
                      {tree(retainedAux.plan.tree)}
                    </div>
                  </>
                )}
              </div>
            )}
            {plan.mode === 'maximized' && plan.tree && (
              <div className="flex min-w-0 flex-1 p-2">{tree(plan.tree)}</div>
            )}
            {/* 停靠的会话侧栏：在窗格区右边，开合同样过渡外层宽度，收起时不卸载。 */}
            {rail && header.entry && sessionId !== undefined && plan.mode !== 'maximized' && (
              <div
                className="layout-transition flex shrink-0 overflow-hidden"
                // 宽只有开与关两种，拖窗口时也过渡：跨过默认显示的宽度时滑进滑出，不是一下跳开（index.css）。
                data-resize-transition
                inert={!railDocked}
                style={{ width: railDocked ? RAIL_DOCKED_WIDTH : 0 }}
              >
                <div className="flex shrink-0 flex-col" style={{ width: RAIL_DOCKED_WIDTH }}>
                  <SessionRail
                    sessionId={sessionId as Session['id']}
                    session={rail}
                    entry={header.entry}
                    visible={railDocked}
                  />
                </div>
              </div>
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
            className="gap-0 bg-background text-foreground data-[side=right]:w-(--overlay-width) data-[side=right]:sm:max-w-none"
            style={{ '--overlay-width': `${plan.auxWidth}px` } as CSSProperties}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
              <SheetTitle className="shrink-0 text-sm">{t('layout.auxOverlay')}</SheetTitle>
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

        {rail && header.entry && sessionId !== undefined && (
          <Sheet open={railOverlay} onOpenChange={setRailOverlayOpen}>
            <SheetContent
              side="right"
              showCloseButton={false}
              finalFocus={railToggleRef}
              className="gap-0 bg-background text-foreground data-[side=right]:w-(--overlay-width) data-[side=right]:sm:max-w-none"
              style={
                { '--overlay-width': `${RAIL_DOCKED_WIDTH + PANE_LAYOUT.gap}px` } as CSSProperties
              }
            >
              <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
                <SheetTitle className="shrink-0 text-sm">{t('rail.label')}</SheetTitle>
                <span className="flex-1" />
                <RailToggle shown onToggle={() => setRailOverlayOpen(false)} />
              </div>
              <div className="flex min-h-0 flex-1 pl-2">
                <SessionRail
                  sessionId={sessionId as Session['id']}
                  session={rail}
                  entry={header.entry}
                  visible={railOverlay}
                />
              </div>
            </SheetContent>
          </Sheet>
        )}

        {/* 放在最后：盖在侧栏与顶栏的拖动区上面，按钮才点得到（拖动区按文档顺序计算）。 */}
        <WindowControls
          className="app-drag absolute top-0 left-0 z-30 h-11 pl-[max(0.5rem,var(--traffic-lights-inset))]"
          sidebar={{
            open: sidebarPlan.sidebar !== 'hidden',
            onToggle: () => toggleSidebar(sidebarPlan),
            ref: sidebarToggleRef,
          }}
        />
      </div>
    </PaneControllerProvider>
  );
}

/** 停靠窗格区里分隔条的宽（splitter.tsx 的 w-2）。 */
const SPLITTER_WIDTH = 8;

/**
 * 停靠的窗格区收起时还要画一会儿（宽度过渡到 0 的那段）：记住最后一次停靠的排布，过渡结束再清掉。换会话时不用
 * 它，不把上一个会话的窗格滑出去。
 */
function useRetainedAux(
  current: AuxPlan | undefined,
  scopeKey: string | undefined,
  /** 最大化时窗格区不在原处，不用滑出去。 */
  reset: boolean,
) {
  const retained = useRef<{ plan: DockedAux; scope?: string }>(undefined);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  if (reset) retained.current = undefined;
  if (current?.tree) retained.current = { plan: current as DockedAux, scope: scopeKey };
  const plan = current?.tree
    ? (current as DockedAux)
    : retained.current?.scope === scopeKey
      ? retained.current?.plan
      : undefined;
  return {
    plan,
    clear: () => {
      retained.current = undefined;
      rerender();
    },
  };
}

type DockedAux = AuxPlan & { tree: LayoutNode };

/**
 * 拖动分隔条时吸附折叠或展开的那一下（交互手感一轮）：在 snap 弹簧的时长里返回 true，布局容器据此带上 data-snapping，
 * 这段时间宽度按 snap 弹簧过渡（index.css），之后回到拖动时的不过渡。
 */
function useSnapPulse(): [boolean, () => void] {
  const [snapping, setSnapping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pulse = () => {
    // 构建后的 CSS 把 300ms 压成 .3s，两种单位都要认。
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--spring-snap-duration')
      .trim();
    const amount = Number.parseFloat(value);
    const duration = value.endsWith('ms') ? amount : amount * 1000;
    setSnapping(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setSnapping(false),
      Number.isFinite(duration) ? duration : 300,
    );
  };
  return [snapping, pulse];
}

/** 拖窗口改尺寸时给 <html> 加 data-window-resizing，布局的宽度过渡暂时关掉（index.css）。 */
function useWindowResizing() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const root = document.documentElement;
    const onResize = () => {
      root.setAttribute('data-window-resizing', '');
      clearTimeout(timer);
      timer = setTimeout(() => root.removeAttribute('data-window-resizing'), 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
      root.removeAttribute('data-window-resizing');
    };
  }, []);
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
  /** 会话页的会话（会话侧栏用）；草稿页没有。 */
  session?: Session;
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
        session: target.session,
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
