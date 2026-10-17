import { Folder, FolderPlus, Pencil, SquarePen, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { useWorkbenchData } from '@/data/workbench-data';
import { projectsOf, type WorkspaceEntry } from '@/data/workbench-model';
import {
  requestEditProject,
  requestRemoveProject,
  useWorkspaceManagement,
} from '@/data/workspace-actions';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { openCreateProject } from '@/projects/create-project';
import { paths } from '@/routes/paths';
import {
  EmptyList,
  LIST_CARD,
  NoticeBanner,
  SettingsLoading,
  SettingsSection,
} from './settings-ui';

/**
 * 设置 → 项目（T5.4 的工作区，U5 改叫项目）：“创建项目”打开与侧栏相同的对话框（projects/create-project.tsx），
 * 列出路径；编辑与移除打开的对话框与侧栏项目的右键菜单是同一个（projects/），移除只注销、不删文件。
 */
export function WorkspaceSettings() {
  const data = useWorkbenchData();
  const { client } = useHostConnection();
  const manage = useWorkspaceManagement();

  if (data.status !== 'ready') return <SettingsLoading data={data} />;
  // “对话”工作区（0.39.0）不是项目，不列、也不能移除。
  const projects = projectsOf(data.workspaces);

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
                canEdit={manage.update}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function WorkspaceRow({
  entry,
  disabled,
  canEdit,
}: {
  entry: WorkspaceEntry;
  disabled: boolean;
  canEdit: boolean;
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
        {canEdit && (
          <IconButton
            label={t('project.edit')}
            disabled={disabled}
            onClick={() => requestEditProject(workspace)}
            data-action="edit-workspace"
          >
            <Pencil />
          </IconButton>
        )}
        <IconButton
          label={t('workspace.remove')}
          disabled={disabled}
          onClick={() => requestRemoveProject(entry)}
          data-action="remove-workspace"
        >
          <Trash2 />
        </IconButton>
      </div>
    </li>
  );
}
