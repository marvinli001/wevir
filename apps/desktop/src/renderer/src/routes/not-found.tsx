import { SearchX } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { CenterPage } from './center-page';
import { paths } from './paths';

/** “未找到”：URL 指向的工作区、会话或页面不存在。不替用户跳到别的工作区。 */
export function NotFound({ message }: { message: string }) {
  return (
    <CenterPage>
      <EmptyState
        icon={<SearchX />}
        title={t('notFound.title')}
        action={
          <Button variant="outline" nativeButton={false} render={<Link to={paths.home()} />}>
            {t('notFound.goHome')}
          </Button>
        }
      >
        <p data-testid="not-found-message">{message}</p>
      </EmptyState>
    </CenterPage>
  );
}

/** 路由表里没有的路径。 */
export function NotFoundRoute() {
  const { pathname } = useLocation();
  return <NotFound message={t('notFound.page', { path: pathname })} />;
}
