import type { StatusTone } from '@/components/status-dot';
import { t } from '@/i18n';
import type { HostConnectionView } from './host-connection';

/** Host 连接状态的圆点样式：左栏底部、设置的“关于”共用。 */
export const HOST_STATUS_TONE: Record<
  HostConnectionView['status'],
  { tone: StatusTone; pulse?: boolean }
> = {
  connecting: { tone: 'warning', pulse: true },
  connected: { tone: 'success' },
  reconnecting: { tone: 'warning', pulse: true },
  closed: { tone: 'neutral' },
  failed: { tone: 'danger' },
};

export function hostStatusText(view: HostConnectionView): string {
  switch (view.status) {
    case 'connecting':
      return t('host.connecting');
    case 'connected':
      return t('host.connected');
    case 'reconnecting':
      return t('host.reconnecting', { attempt: view.attempt });
    case 'closed':
      return t('host.closed');
    case 'failed':
      return t('host.failed');
  }
}
