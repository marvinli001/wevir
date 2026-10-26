import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { PageSpinner } from '@/components/spinner';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { CenterPage } from './center-page';

/**
 * 数据还没到时的中栏：Host 第一次就连不上时显示原因，否则显示“正在加载”。不在数据到之前就判“未找到”。
 */
export function PendingPage({ error }: { error?: string }) {
  const { view } = useHostConnection();
  const failure = error ?? (view.status === 'failed' ? view.error : undefined);
  if (failure !== undefined) {
    return (
      <CenterPage>
        <EmptyState icon={<TriangleAlert />} title={t('connection.failedTitle')}>
          <p>{failure}</p>
        </EmptyState>
      </CenterPage>
    );
  }
  return (
    <CenterPage>
      <PageSpinner />
    </CenterPage>
  );
}
