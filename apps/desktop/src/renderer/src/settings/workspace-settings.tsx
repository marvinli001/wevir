import { isRpcError } from '@wevir/client-sdk';
import type { Workspace } from '@wevir/protocol';
import { Folder, FolderPlus, SquarePen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { openSessions, removeClosingSessions } from './remove';
import { type Notice, NoticeBanner, SettingsLoading } from './settings-ui';

/**
 * 设置 → 工作区（T5.4）：经系统文件夹选择器添加（Host 按 realpath 去重，已有的返回原工作区），列出路径，
 * 移除只注销、不删文件。
 */
export function WorkspaceSettings() {
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const { client } = useHostConnection();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [removing, setRemoving] = useState<WorkspaceEntry>();

  if (data.status !== 'ready') return <SettingsLoading data={data} />;

  const add = async () => {
    if (!client) return;
    setNotice(undefined);
    let rootPath: string | null;
    try {
      rootPath = await window.wevir.selectFolder();
    } catch (error) {
      setNotice({ tone: 'error', text: t('workspace.selectFailed', { error: describe(error) }) });
      return;
    }
    if (rootPath === null) return;
    const listed = new Set(data.workspaces.map((entry) => entry.workspace.id));
    setAdding(true);
    try {
      const { workspace, created } = await client.request('workspace.add', { rootPath });
      await store?.refresh();
      setNotice({ tone: 'success', text: addedText(workspace, created, listed) });
    } catch (error) {
      setNotice({ tone: 'error', text: addError(error) });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (workspace: Workspace) => {
    if (!client) return;
    await removeClosingSessions(client, () =>
      client.request('workspace.remove', { workspaceId: workspace.id }),
    );
    await store?.refresh();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground">{t('workspace.intro')}</p>
        <Button onClick={add} disabled={!client || adding} data-action="add-workspace">
          <FolderPlus />
          {adding ? t('workspace.adding') : t('workspace.add')}
        </Button>
      </div>
      {!client && <NoticeBanner notice={{ tone: 'info', text: t('settings.noHost') }} />}
      {notice && <NoticeBanner notice={notice} />}
      {data.workspaces.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-muted-foreground">
          {t('workspace.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {data.workspaces.map((entry) => (
            <WorkspaceRow
              key={entry.workspace.id}
              entry={entry}
              disabled={!client}
              onRemove={() => setRemoving(entry)}
            />
          ))}
        </ul>
      )}
      {removing && (
        <RemoveWorkspaceDialog
          entry={removing}
          onClose={() => setRemoving(undefined)}
          onConfirm={() => remove(removing.workspace)}
        />
      )}
    </div>
  );
}

function WorkspaceRow({
  entry,
  disabled,
  onRemove,
}: {
  entry: WorkspaceEntry;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { workspace, sessions } = entry;
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-workspace-id={workspace.id}>
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{workspace.displayName}</p>
        <p className="font-mono text-sm break-all text-muted-foreground">{workspace.rootPath}</p>
      </div>
      <span className="shrink-0 text-sm text-muted-foreground">
        {t('workspace.sessions', { count: sessions.length })}
      </span>
      <IconButton
        label={t('workspace.newSession')}
        nativeButton={false}
        render={<Link to={paths.draft(workspace.id)} />}
      >
        <SquarePen />
      </IconButton>
      <IconButton label={t('workspace.remove')} disabled={disabled} onClick={onRemove}>
        <Trash2 />
      </IconButton>
    </li>
  );
}

function RemoveWorkspaceDialog({
  entry,
  onClose,
  onConfirm,
}: {
  entry: WorkspaceEntry;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { workspace, sessions } = entry;
  const open = openSessions(sessions).length;
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('workspace.remove.title', { name: workspace.displayName })}
      confirmLabel={t('workspace.remove.confirm')}
      onConfirm={onConfirm}
      failure={(error) => t('workspace.remove.failed', { error })}
    >
      <p>{t('workspace.remove.body')}</p>
      <p className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-sm break-all text-foreground">
        {workspace.rootPath}
      </p>
      {sessions.length > 0 && <p>{t('workspace.remove.sessions', { count: sessions.length })}</p>}
      {open > 0 && <p>{t('workspace.remove.openSessions', { count: open })}</p>}
    </ConfirmDialog>
  );
}

function addedText(workspace: Workspace, created: boolean, listed: Set<string>): string {
  const name = workspace.displayName;
  if (created) return t('workspace.added', { name });
  // created: false 时可能是列表里已有的，也可能是曾被移除、Host 恢复了的（host-api.md §3.1）。
  return listed.has(workspace.id)
    ? t('workspace.exists', { name })
    : t('workspace.restored', { name });
}

function addError(error: unknown): string {
  if (isRpcError(error, 'WORKSPACE_PATH_INVALID') && error.data) {
    const { reason, path } = error.data;
    return t(`workspace.pathInvalid.${reason}`, { path });
  }
  return t('workspace.addFailed', { error: describe(error) });
}
