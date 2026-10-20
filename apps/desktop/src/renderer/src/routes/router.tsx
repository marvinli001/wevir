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
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { EnvironmentDialog } from '@/environments/environment-dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { WorkbenchLayout } from '@/layout/workbench-layout';
import { useHistoryNav, useTrackHistory } from '@/lib/history-nav';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { WelcomeRoute } from '@/onboarding/welcome-route';
import { ArchiveProjectDialog } from '@/projects/archive-project-dialog';
import { CreateProjectDialog } from '@/projects/create-project';
import { EditProjectDialog } from '@/projects/edit-project-dialog';
import { RemoveProjectDialog } from '@/projects/remove-project-dialog';
import { DeleteSessionDialog } from '@/session/delete-session-dialog';
import { RenameDialog } from '@/session/rename-dialog';
import { SideSessionCloser } from '@/session/side-session';
import { HomeRoute } from './home-route';
import { NotFoundRoute } from './not-found';
import { AGENT_SEGMENT, DEFAULT_SETTINGS_TAB, paths, ROUTE_PATTERNS } from './paths';
import { PluginsRoute } from './plugins-route';
import { SessionRoute } from './session-route';
import { SettingsRoute } from './settings-route';
import { UsageRoute } from './usage-route';

/**
 * 动效样张（U3，fx/fx-gallery.tsx）：开发模式下有；正式构建只有 `VITE_WEVIR_FX_GALLERY=1` 时才带（在生产 CSP 下核对
 * 效果用），否则连同它的 chunk 一起被摇掉。
 */
const FX_GALLERY = import.meta.env.DEV || import.meta.env.VITE_WEVIR_FX_GALLERY === '1';

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
          { path: ROUTE_PATTERNS.plugins, Component: PluginsRoute },
          { path: ROUTE_PATTERNS.pluginsTab, Component: PluginsRoute },
          // 使用统计（0.62.0）：同插件页，在工作台里。
          { path: ROUTE_PATTERNS.usage, Component: UsageRoute },
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
      { path: ROUTE_PATTERNS.settingsTab, Component: SettingsRoute },
      { path: ROUTE_PATTERNS.welcome, Component: WelcomeRoute },
    ],
  },
]);

/** 路由根：记历史序号（窗口左上角的后退 / 前进）、全局快捷键（后退 / 前进，U35 起新建会话与设置）、全局对话框。 */
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
      } else if (matchesShortcut(event, SHORTCUTS.settings)) {
        event.preventDefault();
        if (!location.pathname.startsWith(ROUTE_PATTERNS.settings)) {
          navigate(paths.settings(), { state: { from: location } });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    // macOS 应用菜单的设置…与检查更新…（main/app-menu.ts）：已在设置里时只换分页，保留返回的去处。
    const offOpenSettings = window.wevir?.onOpenSettings((tab) => {
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
      <EditProjectDialog />
      <RemoveProjectDialog />
      <ArchiveProjectDialog />
      <SideSessionCloser />
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
