import { ConfirmDialog } from '@/components/confirm-dialog';
import { useWorkbenchStore } from '@/data/workbench-data';
import { removalImpact, removeRequest, removeWorkspace } from '@/data/workspace-actions';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';

/**
 * 移除项目的确认框：侧栏项目的右键菜单与设置 → 项目共用（`requestRemoveProject`）。写明只是让 Wevir 不再列出它、磁盘上的文件
 * 不动，并写出会隐藏几个会话、其中几个未关闭的会先被关闭（RESOURCE_IN_USE 的处理在 `removeWorkspace`）。挂在路由根上。
 */
export function RemoveProjectDialog() {
  const entry = removeRequest.use();
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  if (!entry) return null;
  const { workspace } = entry;
  const { sessions, open } = removalImpact(entry);
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && removeRequest.set(undefined)}
      title={t('workspace.remove.title', { name: workspace.displayName })}
      confirmLabel={t('workspace.remove.confirm')}
      onConfirm={async () => {
        if (client) await removeWorkspace(client, store, workspace);
      }}
      failure={(error) => t('workspace.remove.failed', { error })}
    >
      <p>{t('workspace.remove.body')}</p>
      <p className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-sm break-all text-foreground">
        {workspace.rootPath}
      </p>
      {sessions > 0 && <p>{t('workspace.remove.sessions', { count: sessions })}</p>}
      {open > 0 && <p>{t('workspace.remove.openSessions', { count: open })}</p>}
    </ConfirmDialog>
  );
}
