// 侧栏右键菜单的分组（照 Codex 桌面端：组之间一道分隔线）：哪些项出现、怎么分组。只列 Wevir 有对应能力的项；Host 不支持的项
// （旧版本的 Host 没有改名、归档、删除、分支）直接不出现，空的组连分隔线一起省掉。纯函数，组件按它渲染。

export type SessionMenuItem =
  | 'rename'
  | 'pin'
  | 'unread'
  | 'branch'
  | 'move'
  | 'automate'
  | 'copy'
  | 'openWith'
  | 'archive'
  | 'delete';

export interface SessionMenuAvailability {
  rename: boolean;
  branch: boolean;
  /** 在本地与工作树之间移动（0.81.0）。 */
  move?: boolean;
  /** 新建发进这个会话的自动化（0.73.0）。 */
  automate?: boolean;
  /** 打开方式（外部编辑器、在访达中显示）：路径在这台电脑上时才有（platform/platform.ts 的 `localFiles`）。默认有。 */
  openWith?: boolean;
  archive: boolean;
  delete: boolean;
}

function present<T>(groups: readonly (readonly (T | false)[])[]): T[][] {
  return groups
    .map((group) => group.filter((item): item is T => item !== false))
    .filter((group) => group.length > 0);
}

/** 会话行的菜单：重命名、置顶、标记为未读 | 分支、移到工作树或本地、新建自动化 | 复制 ▸ | 打开方式 ▸ | 归档、永久删除。 */
export function sessionMenuGroups(available: SessionMenuAvailability): SessionMenuItem[][] {
  return present<SessionMenuItem>([
    [available.rename && 'rename', 'pin', 'unread'],
    [
      available.branch && 'branch',
      available.move === true && 'move',
      available.automate === true && 'automate',
    ],
    ['copy'],
    [available.openWith !== false && 'openWith'],
    [available.archive && 'archive', available.delete && 'delete'],
  ]);
}

export type ProjectMenuItem =
  | 'pin'
  | 'edit'
  | 'moveUp'
  | 'moveDown'
  | 'reveal'
  | 'archiveSessions'
  | 'remove';

export interface ProjectMenuAvailability {
  edit: boolean;
  /** Host 能归档，且项目里有会话。 */
  archiveSessions: boolean;
  /** 在访达中显示：路径在这台电脑上时才有。默认有。 */
  reveal?: boolean;
  /** 移除项目（`workspace.write`）。默认有。 */
  remove?: boolean;
  /** 上移、下移：在它那一段（置顶的或没置顶的）里不是第一个、最后一个时才有。默认没有。 */
  moveUp?: boolean;
  moveDown?: boolean;
}

/** 项目标题的菜单：置顶、编辑 | 上移、下移 | 在访达中显示 | 归档会话 | 移除项目。 */
export function projectMenuGroups(available: ProjectMenuAvailability): ProjectMenuItem[][] {
  return present<ProjectMenuItem>([
    ['pin', available.edit && 'edit'],
    [available.moveUp === true && 'moveUp', available.moveDown === true && 'moveDown'],
    [available.reveal !== false && 'reveal'],
    [available.archiveSessions && 'archiveSessions'],
    [available.remove !== false && 'remove'],
  ]);
}
