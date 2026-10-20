import { ChartColumn } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usageAvailability } from '@/usage/usage-model';
import { UsagePage } from '@/usage/usage-page';
import { CenterPage } from './center-page';
import { PendingPage } from './route-states';

/** `/usage`（0.62.0）：Host 没有 `usage_stats` 功能时是空状态；没连上过先等。 */
export function UsageRoute() {
  const { client } = useHostConnection();
  // 断线重连期间 client 还在，沿用上次 hello 的功能表，页面不跳回加载状态。
  const features = client?.hello.features;
  const availability = usageAvailability(features);
  if (client === undefined || availability === 'pending') return <PendingPage />;
  if (availability === 'unsupported') {
    return (
      <CenterPage>
        <EmptyState icon={<ChartColumn />} title={t('usage.unsupported')} />
      </CenterPage>
    );
  }
  return <UsagePage client={client} />;
}
