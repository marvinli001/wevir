import type { WevirClient } from '@wevir/client-sdk';
import type { SyncStatus } from '@wevir/protocol';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export function ZuvOutbox({
  client,
  status,
  disabled,
  onRecovered,
}: {
  client: WevirClient;
  status: SyncStatus;
  disabled: boolean;
  onRecovered: (status: SyncStatus) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const outbox = status.outbox ?? [];
  const binding = status.binding;
  const deviceChanged =
    status.currentDeviceId !== undefined && status.currentDeviceId !== status.binding?.deviceId;
  if (
    !client.supports('sync_outbox_recovery') ||
    !binding ||
    !outbox.length ||
    (!deviceChanged && !outbox.some((value) => value.outcome !== 'ready'))
  )
    return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
      <span className="text-sm text-muted-foreground">
        {t(
          deviceChanged
            ? 'sync.deviceChanged'
            : outbox.some((value) => value.outcome === 'uncertain')
              ? 'sync.outboxUncertain'
              : 'sync.outboxRejected',
        )}
      </span>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirm(true)}>
        {t('sync.recoverOutbox')}
      </Button>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={setConfirm}
          title={t('sync.recoverOutbox')}
          confirmLabel={t('sync.recoverOutbox')}
          failure={(value) => value}
          onConfirm={async () =>
            onRecovered(
              await client.request('sync.recoverOutbox', {
                expectedDeviceId: binding.deviceId,
                commitIds: outbox.map((value) => value.commitId),
              }),
            )
          }
        >
          <p>{t('sync.recoverOutboxConsequences')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
