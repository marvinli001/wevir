import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import {
  createHashRouter,
  Navigate,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
  useRouteError,
} from 'react-router';
import { AssistantDialog } from '@/assistants/assistant-dialog';
import { GroupDialog } from '@/assistants/group-dialog';
import { AutomationDialog } from '@/automations/automation-dialog';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { EnvironmentDialog } from '@/environments/environment-dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { WorkbenchLayout } from '@/layout/workbench-layout';
import { useHistoryNav, useTrackHistory } from '@/lib/history-nav';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { platformApi } from '@/platform/platform';
import { ArchiveProjectDialog } from '@/projects/archive-project-dialog';
import { CreateProjectDialog } from '@/projects/create-project';
import { EditProjectDialog } from '@/projects/edit-project-dialog';
import { RemoveProjectDialog } from '@/projects/remove-project-dialog';
import { SearchDialog } from '@/search/search-dialog';
import { searchOpen } from '@/search/search-model';
import { DeleteSessionDialog } from '@/session/delete-session-dialog';
import { RenameDialog } from '@/session/rename-dialog';
import { SideSessionCloser } from '@/session/side-session';
import { HomeRoute } from './home-route';
import { NotFoundRoute } from './not-found';
import { AGENT_SEGMENT, DEFAULT_SETTINGS_TAB, paths, ROUTE_PATTERNS } from './paths';
import { SessionRoute } from './session-route';

/**
 * 动效样张（U3，fx/fx-gallery.tsx）：开发模式下有；正式构建只有 `VITE_WEVIR_FX_GALLERY=1` 时才带（在生产 CSP 下核对
 * 效果用），否则连同它的 chunk 一起被摇掉。
 */
const FX_GALLERY = import.meta.env.DEV || import.meta.env.VITE_WEVIR_FX_GALLERY === '1';

/**
 * 不常开的整页（插件、使用统计、自动化、助理、调优、设置、首次引导）按需载入：它们带着 diff、图表与市场等较重的依赖，
 * 不放进启动时的主包。同一页的几条路由共用一次载入。
 */
const pluginsPage = async () => ({ Component: (await import('./plugins-route')).PluginsRoute });
const usagePage = async () => ({ Component: (await import('./usage-route')).UsageRoute });
const automationsPage = async () => ({
  Component: (await import('./automations-route')).AutomationsRoute,
});
const assistantsPage = async () => ({
  Component: (await import('./assistants-route')).AssistantsRoute,
});
const tuningPage = async () => ({ Component: (await import('./tuning-route')).TuningRoute });
const settingsPage = async () => ({ Component: (await import('./settings-route')).SettingsRoute });
const welcomePage = async () => ({
  Component: (await import('@/onboarding/welcome-route')).WelcomeRoute,
});

/** 路由表（见 paths.ts）。工作台页面共用三栏布局；设置与首次引导是整窗页面。 */
export const router = createHashRouter([
  {
    Component: AppRoot,
    ErrorBoundary: RouteError,
    children: [
      {
        Component: WorkbenchLayout,
        children: [
          { path: ROUTE_PATTERNS.home, Component: HomeRoute },
          { path: ROUTE_PATTERNS.draft, Component: SessionRoute },
          // 插件页（0.42.0）：在工作台里，左栏照常。
          { path: ROUTE_PATTERNS.plugins, lazy: pluginsPage },
          { path: ROUTE_PATTERNS.pluginsTab, lazy: pluginsPage },
          { path: ROUTE_PATTERNS.marketGroup, lazy: pluginsPage },
          { path: ROUTE_PATTERNS.marketEntry, lazy: pluginsPage },
          // 使用统计（0.62.0）：同插件页，在工作台里。
          { path: ROUTE_PATTERNS.usage, lazy: usagePage },
          // 自动化（0.66.0）：同插件页，在工作台里。
          { path: ROUTE_PATTERNS.automations, lazy: automationsPage },
          { path: ROUTE_PATTERNS.automation, lazy: automationsPage },
          // 助理（0.120.0）：同插件页，在工作台里。
          { path: ROUTE_PATTERNS.assistants, lazy: assistantsPage },
          { path: ROUTE_PATTERNS.assistant, lazy: assistantsPage },
          { path: ROUTE_PATTERNS.assistantThread, lazy: assistantsPage },
          // 调优（0.85.0）：同插件页，在工作台里。
          { path: ROUTE_PATTERNS.tuning, lazy: tuningPage },
          { path: ROUTE_PATTERNS.tuningTab, lazy: tuningPage },
          {
            path: ROUTE_PATTERNS.session,
            Component: SessionRoute,
            // 子智能体详情（R5）：主窗格不变，详情画在“子智能体”窗格里（workbench-layout.tsx），这里不渲染东西。
            children: [{ path: AGENT_SEGMENT, element: null }],
          },
          ...(FX_GALLERY
            ? [
                {
                  path: 'dev/fx',
                  lazy: async () => ({ Component: (await import('@/fx/fx-gallery')).FxGallery }),
                },
              ]
            : []),
          { path: '*', Component: NotFoundRoute },
        ],
      },
      {
        path: ROUTE_PATTERNS.settings,
        element: <Navigate to={DEFAULT_SETTINGS_TAB} replace />,
      },
      { path: ROUTE_PATTERNS.settingsTab, lazy: settingsPage },
      { path: ROUTE_PATTERNS.welcome, lazy: welcomePage },
    ],
  },
]);

/** 路由根：记历史序号（窗口左上角的后退 / 前进）、全局快捷键（后退 / 前进，U35 起新建会话与设置，0.77.0 起搜索）、全局对话框。 */
function AppRoot() {
  useTrackHistory();
  const history = useHistoryNav();
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const workspaceId = matches.map((match) => match.params.workspaceId).find(Boolean);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (matchesShortcut(event, SHORTCUTS.back) && history.canBack) {
        event.preventDefault();
        history.back();
      } else if (matchesShortcut(event, SHORTCUTS.forward) && history.canForward) {
        event.preventDefault();
        history.forward();
      } else if (matchesShortcut(event, SHORTCUTS.newSession)) {
        // U35：在项目里时开这个项目的草稿页，否则回首页。
        event.preventDefault();
        navigate(workspaceId ? paths.draft(workspaceId) : paths.home());
      } else if (matchesShortcut(event, SHORTCUTS.search)) {
        // 0.77.0：会话全文搜索；再按一次关上。
        event.preventDefault();
        searchOpen.set((open) => !open);
      } else if (matchesShortcut(event, SHORTCUTS.settings)) {
        event.preventDefault();
        if (!location.pathname.startsWith(ROUTE_PATTERNS.settings)) {
          navigate(paths.settings(), { state: { from: location } });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    // macOS 应用菜单的设置…与检查更新…（main/app-menu.ts）：已在设置里时只换分页，保留返回的去处。
    const offOpenSettings = platformApi()?.onOpenSettings((tab) => {
      if (location.pathname.startsWith(ROUTE_PATTERNS.settings)) {
        navigate(paths.settings(tab), { replace: true, state: location.state });
      } else {
        navigate(paths.settings(tab), { state: { from: location } });
      }
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      offOpenSettings?.();
    };
  }, [history, navigate, location, workspaceId]);
  return (
    <>
      <Outlet />
      <CreateProjectDialog />
      <EnvironmentDialog />
      <RenameDialog />
      <DeleteSessionDialog />
      <AutomationDialog />
      <AssistantDialog />
      <GroupDialog />
      <EditProjectDialog />
      <RemoveProjectDialog />
      <ArchiveProjectDialog />
      <SideSessionCloser />
      <SearchDialog />
    </>
  );
}

function RouteError() {
  const error = useRouteError();
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title={t('error.title')}
      action={<Button onClick={() => window.location.reload()}>{t('error.reload')}</Button>}
    >
      <p className="font-mono text-sm">{describe(error)}</p>
    </EmptyState>
  );
}
