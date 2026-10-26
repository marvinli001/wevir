import { ArrowDown, ArrowUp, FolderOpen, Pencil, X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { ArchiveIcon, PinIcon } from '@/components/session-icons';
import { ContextMenuSeparator } from '@/components/ui/context-menu';
import { useSessionManagement } from '@/data/session-actions';
import type { WorkspaceEntry } from '@/data/workbench-model';
import {
  reorderProjects,
  requestArchiveProject,
  requestEditProject,
  requestRemoveProject,
  togglePinnedWorkspace,
  usePinnedWorkspaces,
  useWorkspaceManagement,
} from '@/data/workspace-actions';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { capabilities, platformApi } from '@/platform/platform';
import { type ProjectMenuItem, projectMenuGroups } from './context-menu-model';
import { moveProject } from './project-drag-model';
import { MenuItem } from './session-context-menu';

/**
 * 项目标题右键菜单的内容（分组与取舍在 context-menu-model.ts）：置顶、编辑 | 上移、下移 | 在访达中显示 | 归档会话 | 移除项目。
 * 置顶与上移、下移（同拖动排序，project-drag-model.ts）只记在本机，
 * 编辑改名称（`workspace.update`），归档会话与移除项目先经确认框；移除只让 Wevir 不再列出项目，磁盘上的文件不动，设置 → 项目
 * 的移除按钮是同一个确认框。
 */
export function ProjectContextMenuItems({
  entry,
  pinned,
  listed,
}: {
  entry: WorkspaceEntry;
  pinned: boolean;
  /** 左栏现在的项目顺序（置顶的在前）。 */
  listed: readonly string[];
}) {
  const { workspace, sessions } = entry;
  const manage = useWorkspaceManagement();
  const sessionManage = useSessionManagement();
  const pinnedProjects = usePinnedWorkspaces();
  const from = listed.indexOf(workspace.id);
  const moved = (by: number) => moveProject(listed, pinnedProjects, workspace.id, from + by);
  const up = moved(-1);
  const down = moved(1);
  const groups = projectMenuGroups({
    edit: manage.update,
    archiveSessions: sessionManage.archive && sessions.length > 0,
    reveal: capabilities().localFiles,
    remove: manage.remove,
    moveUp: up !== listed,
    moveDown: down !== listed,
  });
  const items: Record<ProjectMenuItem, () => ReactNode> = {
    pin: () => (
      <MenuItem
        id="pin-project"
        icon={<PinIcon filled={pinned} />}
        onClick={() => togglePinnedWorkspace(workspace.id)}
      >
        {t(pinned ? 'session.unpin' : 'session.pin')}
      </MenuItem>
    ),
    edit: () => (
      <MenuItem id="edit-project" icon={<Pencil />} onClick={() => requestEditProject(workspace)}>
        {t('project.edit')}
      </MenuItem>
    ),
    moveUp: () => (
      <MenuItem id="move-project-up" icon={<ArrowUp />} onClick={() => reorderProjects(up)}>
        {t('project.moveUp')}
      </MenuItem>
    ),
    moveDown: () => (
      <MenuItem id="move-project-down" icon={<ArrowDown />} onClick={() => reorderProjects(down)}>
        {t('project.moveDown')}
      </MenuItem>
    ),
    reveal: () => (
      <MenuItem
        id="reveal-project"
        icon={<FolderOpen />}
        onClick={() =>
          void platformApi()
            .revealPath(workspace.rootPath)
            .catch(() => undefined)
        }
      >
        {t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
      </MenuItem>
    ),
    archiveSessions: () => (
      <MenuItem
        id="archive-project"
        icon={<ArchiveIcon />}
        onClick={() => requestArchiveProject(entry)}
      >
        {t('project.archiveSessions')}
      </MenuItem>
    ),
    remove: () => (
      <MenuItem id="remove-project" icon={<X />} onClick={() => requestRemoveProject(entry)}>
        {t('project.remove')}
      </MenuItem>
    ),
  };
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group.join()}>
          {index > 0 && <ContextMenuSeparator />}
          {group.map((item) => (
            <Fragment key={item}>{items[item]()}</Fragment>
          ))}
        </Fragment>
      ))}
    </>
  );
}
