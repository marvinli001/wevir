import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { createHashRouter, Navigate, Outlet, useRouteError } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { EnvironmentDialog } from '@/environments/environment-dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { WorkbenchLayout } from '@/layout/workbench-layout';
import { useHistoryNav, useTrackHistory } from '@/lib/history-nav';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { WelcomeRoute } from '@/onboarding/welcome-route';
import { CreateProjectDialog } from '@/projects/create-project';
import { HomeRoute } from './home-route';
import { NotFoundRoute } from './not-found';
import { AGENT_SEGMENT, DEFAULT_SETTINGS_TAB, ROUTE_PATTERNS } from './paths';
import { SessionRoute } from './session-route';
import { SettingsRoute } from './settings-route';

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

/** 路由根：记历史序号（窗口左上角的后退 / 前进）、全局的后退 / 前进快捷键、全局对话框。 */
function AppRoot() {
  useTrackHistory();
  const history = useHistoryNav();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (matchesShortcut(event, SHORTCUTS.back) && history.canBack) {
        event.preventDefault();
        history.back();
      } else if (matchesShortcut(event, SHORTCUTS.forward) && history.canForward) {
        event.preventDefault();
        history.forward();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [history]);
  return (
    <>
      <Outlet />
      <CreateProjectDialog />
      <EnvironmentDialog />
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
