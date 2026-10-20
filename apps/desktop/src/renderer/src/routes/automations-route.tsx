import type { AutomationId } from '@wevir/protocol';
import { CalendarClock } from 'lucide-react';
import { useParams } from 'react-router';
import { AutomationDetail } from '@/automations/automation-detail';
import { automationsAvailability } from '@/automations/automations-model';
import { AutomationsPage } from '@/automations/automations-page';
import { EmptyState } from '@/components/empty-state';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { CenterPage } from './center-page';
import { PendingPage } from './route-states';

/** `/automations` 与 `/automations/:automationId`（0.66.0）：Host 没有 `automations` 功能时是空状态；没连上过先等。 */
export function AutomationsRoute() {
  const { client } = useHostConnection();
  const { automationId } = useParams();
  // 断线重连期间 client 还在，沿用上次 hello 的功能表，页面不跳回加载状态。
  const availability = automationsAvailability(client?.hello.features);
  if (client === undefined || availability === 'pending') return <PendingPage />;
  if (availability === 'unsupported') {
    return (
      <CenterPage>
        <EmptyState icon={<CalendarClock />} title={t('automations.unsupported')} />
      </CenterPage>
    );
  }
  if (automationId !== undefined) {
    return (
      <AutomationDetail
        key={automationId}
        client={client}
        automationId={automationId as AutomationId}
      />
    );
  }
  return <AutomationsPage client={client} />;
}
