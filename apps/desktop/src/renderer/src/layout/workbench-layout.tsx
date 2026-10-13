import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useParams } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useWorkbenchData } from '@/data/workbench-data';
import { resolveRoute, type WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { useRememberLocation } from '@/routes/last-location';
import { clampSidebarWidth, LAYOUT, type LayoutPlan, planLayout } from './layout-rules';
import { layoutPrefs, transientLayout, useViewportWidth } from './layout-state';
import { RightPanel } from './right-panel';
import { rightPanelKey } from './right-panel-tabs';
import { Sidebar } from './sidebar';
import { SidebarResizer } from './sidebar-resizer';

/**
 * 三栏布局：左栏（工作区 → 会话）、中栏（路由内容，限宽居中）、右栏（默认收起）。每栏停靠还是浮层由
 * layout-rules.ts 按视口宽度决定。
 */
export function WorkbenchLayout() {
  const viewportWidth = useViewportWidth();
  const prefs = layoutPrefs.use();
  const transient = transientLayout.use();
  const [dragWidth, setDragWidth] = useState<number>();
  // 浮层关闭后焦点回到打开它的按钮。
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const rightPanelToggleRef = useRef<HTMLButtonElement>(null);
  const plan = planLayout({
    viewportWidth,
    sidebarWidth: dragWidth ?? prefs.sidebarWidth,
    sidebarCollapsed: prefs.sidebarCollapsed,
    sidebarOverlayOpen: transient.sidebarOverlayOpen,
    rightPanelOpen: transient.rightPanelOpen,
  });

  const { workspaceId, sessionId } = useParams();
  const header = useHeader(workspaceId, sessionId);
  const location = useLocation();
  useRememberLocation(workspaceId, sessionId);

  // 在浮层左栏里选了会话就收起浮层。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在路由变化时触发。
  useEffect(() => {
    transientLayout.set((state) => ({ ...state, sidebarOverlayOpen: false }));
  }, [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar(plan);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [plan]);

  const setRightPanelOpen = (open: boolean) =>
    transientLayout.set((state) => ({ ...state, rightPanelOpen: open }));
  const setSidebarOverlayOpen = (open: boolean) =>
    transientLayout.set((state) => ({ ...state, sidebarOverlayOpen: open }));
  const commitSidebarWidth = (width: number) => {
    setDragWidth(undefined);
    layoutPrefs.set((current) => ({ ...current, sidebarWidth: clampSidebarWidth(width) }));
  };

  const panelKey = rightPanelKey(workspaceId, sessionId);

  return (
    <div className="flex h-full overflow-hidden" data-layout-sidebar={plan.sidebar}>
      {plan.sidebar === 'docked' && (
        <aside
          className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
          style={{ width: plan.sidebarWidth }}
        >
          <Sidebar onCollapse={() => toggleSidebar(plan)} />
          <SidebarResizer
            width={plan.sidebarWidth}
            onDrag={(width) => setDragWidth(clampSidebarWidth(width))}
            onCommit={commitSidebarWidth}
          />
        </aside>
      )}
      <Sheet open={plan.sidebar === 'overlay'} onOpenChange={setSidebarOverlayOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          finalFocus={sidebarToggleRef}
          className="gap-0 bg-sidebar text-sidebar-foreground data-[side=left]:w-(--overlay-width)"
          style={{ '--overlay-width': `${plan.sidebarWidth}px` } as CSSProperties}
        >
          <SheetTitle className="sr-only">{t('sidebar.workspaces')}</SheetTitle>
          <Sidebar onCollapse={() => setSidebarOverlayOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {plan.sidebar !== 'docked' && (
            <IconButton
              ref={sidebarToggleRef}
              label={t('layout.expandSidebar')}
              onClick={() => toggleSidebar(plan)}
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
          <IconButton
            ref={rightPanelToggleRef}
            label={t(transient.rightPanelOpen ? 'layout.closeRightPanel' : 'layout.openRightPanel')}
            aria-expanded={transient.rightPanelOpen}
            onClick={() => setRightPanelOpen(!transient.rightPanelOpen)}
            tooltipSide="bottom"
          >
            {transient.rightPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </IconButton>
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>

      {plan.rightPanel === 'docked' && (
        <aside
          className="flex shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground"
          style={{ width: LAYOUT.rightPanelWidth }}
        >
          <RightPanel panelKey={panelKey} entry={header.entry} />
        </aside>
      )}
      <Sheet open={plan.rightPanel === 'overlay'} onOpenChange={setRightPanelOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          finalFocus={rightPanelToggleRef}
          className="gap-0 bg-sidebar text-sidebar-foreground data-[side=right]:w-(--overlay-width)"
          style={{ '--overlay-width': `${LAYOUT.rightPanelWidth}px` } as CSSProperties}
        >
          <SheetTitle className="sr-only">{t('rightPanel.tab.overview')}</SheetTitle>
          <RightPanel
            panelKey={panelKey}
            entry={header.entry}
            onClose={() => setRightPanelOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** 左栏能停靠时切换“收起”偏好（记住）；放不下时切换浮层（不记住）。 */
function toggleSidebar(plan: LayoutPlan): void {
  if (plan.sidebarCanDock) {
    layoutPrefs.set((prefs) => ({ ...prefs, sidebarCollapsed: !prefs.sidebarCollapsed }));
  } else {
    transientLayout.set((state) => ({ ...state, sidebarOverlayOpen: !state.sidebarOverlayOpen }));
  }
}

interface Header {
  title: string;
  subtitle?: string;
  entry?: WorkspaceEntry;
}

/** 顶栏标题：会话标题 · 工作区名；草稿页是“新会话”；首页、设置、未找到等页面不显示标题。 */
function useHeader(workspaceId: string | undefined, sessionId: string | undefined): Header {
  const data = useWorkbenchData();
  if (workspaceId === undefined) return { title: '' };
  const target = resolveRoute(data, workspaceId, sessionId);
  switch (target.kind) {
    case 'session':
      return {
        title: target.session.title || t('session.untitled'),
        subtitle: target.entry.workspace.displayName,
        entry: target.entry,
      };
    case 'draft':
      return {
        title: t('session.draftTitle'),
        subtitle: target.entry.workspace.displayName,
        entry: target.entry,
      };
    case 'session-not-found':
      return { title: t('notFound.title'), entry: target.entry };
    case 'workspace-not-found':
      return { title: t('notFound.title') };
    case 'loading':
    case 'unavailable':
      return { title: '' };
  }
}
