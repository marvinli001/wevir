import { TriangleAlert } from 'lucide-react';
import { createHashRouter, Navigate, useRouteError } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { WorkbenchLayout } from '@/layout/workbench-layout';
import { HomeRoute } from './home-route';
import { NotFoundRoute } from './not-found';
import { DEFAULT_SETTINGS_TAB, ROUTE_PATTERNS } from './paths';
import { SessionRoute } from './session-route';
import { SettingsRoute } from './settings-route';

/** 路由表（见 paths.ts）。工作台页面共用三栏布局；设置是整窗页面。 */
export const router = createHashRouter([
  {
    ErrorBoundary: RouteError,
    children: [
      {
        Component: WorkbenchLayout,
        children: [
          { path: ROUTE_PATTERNS.home, Component: HomeRoute },
          { path: ROUTE_PATTERNS.draft, Component: SessionRoute },
          { path: ROUTE_PATTERNS.session, Component: SessionRoute },
          { path: '*', Component: NotFoundRoute },
        ],
      },
      {
        path: ROUTE_PATTERNS.settings,
        element: <Navigate to={DEFAULT_SETTINGS_TAB} replace />,
      },
      { path: ROUTE_PATTERNS.settingsTab, Component: SettingsRoute },
    ],
  },
]);

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
