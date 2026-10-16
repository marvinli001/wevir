import type { Workspace } from '@wevir/protocol';
import { Folder, FolderPlus, SquarePen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { projectsOf, type WorkspaceEntry } from '@/data/workbench-model';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { openCreateProject } from '@/projects/create-project';
import { paths } from '@/routes/paths';
import { openSessions, removeClosingSessions } from './remove';
import {
  EmptyList,
  LIST_CARD,
  NoticeBanner,
  SettingsLoading,
  SettingsSection,
} from './settings-ui';

/**
 * 设置 → 项目（T5.4 的工作区，U5 改叫项目）：“创建项目”打开与侧栏相同的对话框（projects/create-project.tsx），
 * 列出路径，移除只注销、不删文件。
 */
export function WorkspaceSettings() {
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const { client } = useHostConnection();
  const [removing, setRemoving] = useState<WorkspaceEntry>();

  if (data.status !== 'ready') return <SettingsLoading data={data} />;
  // “对话”工作区（0.39.0）不是项目，不列、也不能移除。
  const projects = projectsOf(data.workspaces);

  const remove = async (workspace: Workspace) => {
    if (!client) return;
    await removeClosingSessions(client, () =>
      client.request('workspace.remove', { workspaceId: workspace.id }),
    );
    await store?.refresh();
  };

  return (
    <SettingsSection
      title={t('settings.section.projects')}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => openCreateProject({ onCreated: () => {} })}
          disabled={!client}
          data-action="add-workspace"
        >
          <FolderPlus data-icon="inline-start" />
          {t('project.create.title')}
        </Button>
      }
    >
      <div className="space-y-3">
        {!client && <NoticeBanner notice={{ tone: 'info', text: t('settings.noHost') }} />}
        {projects.length === 0 ? (
          <EmptyList>{t('project.empty')}</EmptyList>
        ) : (
          <ul className={LIST_CARD}>
            {projects.map((entry) => (
              <WorkspaceRow
                key={entry.workspace.id}
                entry={entry}
                disabled={!client}
                onRemove={() => setRemoving(entry)}
              />
            ))}
          </ul>
        )}
      </div>
      {removing && (
        <RemoveWorkspaceDialog
          entry={removing}
          onClose={() => setRemoving(undefined)}
          onConfirm={() => remove(removing.workspace)}
        />
      )}
    </SettingsSection>
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
    <li className="flex items-center gap-3.5 px-4 py-3" data-workspace-id={workspace.id}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <Folder className="size-4 text-muted-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{workspace.displayName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('workspace.sessions', { count: sessions.length })}
          </span>
        </p>
        <p
          dir="rtl"
          title={workspace.rootPath}
          className="mt-0.5 truncate text-left font-mono text-xs text-muted-foreground"
        >
          <bdi dir="ltr">{workspace.rootPath}</bdi>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
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
      </div>
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
