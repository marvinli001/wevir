import type { SessionUsage } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { deleteRequest, deleteSessionPermanently } from '@/data/session-actions';
import { useWorkbenchStore } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { usageBytes } from '@/settings/storage-model';
import { describeDeleteError } from '@/settings/storage-sessions';
import { formatFileSize } from './shared-files-model';

/**
 * 永久删除一个会话（右键菜单的“永久删除”，`session.delete` 只收已归档的，没归档的先归档再删）。打开时读 `session.usage`
 * 写出占用与有没提交的改动的工作树（设置 → 存储的确认框同一套说法）；读不到时只是少这两行。有改动的工作树确认后带 `force` 删，
 * 量过之后才改出来的由 Host 拒绝（`RESOURCE_IN_USE` 带 `worktrees`）。挂在路由根上。
 */
export function DeleteSessionDialog() {
  const session = deleteRequest.use();
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const [usage, setUsage] = useState<SessionUsage>();

  useEffect(() => {
    setUsage(undefined);
    if (!session || !client) return;
    let cancelled = false;
    client
      .request('session.usage', session.archivedAt === undefined ? {} : { archived: true })
      .then(({ sessions }) => {
        if (!cancelled) setUsage(sessions.find((entry) => entry.sessionId === session.id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, client]);

  if (!session) return null;
  const dirty = usage?.worktrees.filter((worktree) => worktree.dirty).length ?? 0;
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && deleteRequest.set(undefined)}
      title={t('session.delete.title', { title: session.title || t('session.untitled') })}
      confirmLabel={t('session.delete')}
      onConfirm={async () => {
        if (!client) return;
        try {
          await deleteSessionPermanently(client, store, session, dirty > 0);
        } catch (reason) {
          throw new Error(describeDeleteError(reason));
        }
      }}
      failure={(error) => t('settings.storage.deleteError', { error })}
    >
      {usage && (
        <p>
          {t('settings.storage.deleteSize', {
            size: formatFileSize(usageBytes(usage), currentLocale()),
          })}
        </p>
      )}
      {dirty > 0 && (
        <p className="text-warning">{t('settings.storage.deleteDirty', { count: dirty })}</p>
      )}
      <p>{t('settings.storage.deleteIrreversible')}</p>
    </ConfirmDialog>
  );
}
