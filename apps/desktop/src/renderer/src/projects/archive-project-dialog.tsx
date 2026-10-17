import type { SessionId } from '@wevir/protocol';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { archiveSessions } from '@/data/session-actions';
import { useWorkbenchStore } from '@/data/workbench-data';
import { archiveProjectRequest } from '@/data/workspace-actions';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { openSessions } from '@/settings/remove';

/**
 * 归档项目里的全部会话（项目菜单的“归档会话”）：归档会关闭会话、取消运行中的回合，所以先确认；写出个数与其中未关闭的个数，
 * 已归档的会话在设置 → 已归档里恢复。一个失败不影响其余的，失败时框里显示第一个原因。挂在路由根上。
 */
export function ArchiveProjectDialog() {
  const entry = archiveProjectRequest.use();
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  if (!entry) return null;
  const { workspace, sessions } = entry;
  const open = openSessions(sessions).length;
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && archiveProjectRequest.set(undefined)}
      title={t('project.archiveSessions.title', { name: workspace.displayName })}
      confirmLabel={t('session.archive')}
      onConfirm={async () => {
        if (!client) return;
        const { failed, firstError } = await archiveSessions(
          client,
          store,
          sessions.map((session) => session.id as SessionId),
        );
        if (failed > 0) throw new Error(describe(firstError));
      }}
      failure={(error) => t('session.archiveFailed', { error })}
    >
      <p>{t('project.archiveSessions.body', { count: sessions.length })}</p>
      {open > 0 && <p>{t('workspace.remove.openSessions', { count: open })}</p>}
    </ConfirmDialog>
  );
}
