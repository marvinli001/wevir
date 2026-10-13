import { FolderPlus, MessagesSquare } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useWorkbenchData } from '@/data/workbench-data';
import { t } from '@/i18n';
import { CenterPage } from './center-page';
import { paths } from './paths';
import { PendingPage } from './route-states';

/** `/`：没有选中会话。不自动跳到第一个工作区或最近的会话（启动时恢复上次会话归 T5.5）。 */
export function HomeRoute() {
  const data = useWorkbenchData();
  const location = useLocation();
  if (data.status === 'loading') return <PendingPage />;
  if (data.status === 'error') return <PendingPage error={data.error} />;
  if (data.workspaces.length === 0) {
    return (
      <CenterPage>
        <EmptyState
          icon={<FolderPlus />}
          title={t('home.noWorkspacesTitle')}
          action={
            <Button
              nativeButton={false}
              render={<Link to={paths.settings('workspaces')} state={{ from: location }} />}
            >
              {t('home.goAddWorkspace')}
            </Button>
          }
        >
          <p>{t('home.noWorkspacesBody')}</p>
        </EmptyState>
      </CenterPage>
    );
  }
  return (
    <CenterPage>
      <EmptyState icon={<MessagesSquare />} title={t('home.title')}>
        <p>{t('home.body')}</p>
      </EmptyState>
    </CenterPage>
  );
}
