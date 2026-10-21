import { cn } from 'cn';
import {
  CalendarClock,
  Copy,
  Eye,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Pencil,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { COMPACT_ICON, COMPACT_ITEM } from '@/components/compact-menu';
import { ArchiveIcon, PinIcon } from '@/components/session-icons';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import type { SessionActions } from '@/data/session-actions';
import { openInEditor, useEditors } from '@/files/files-store';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { type SessionMenuItem, sessionMenuGroups } from './context-menu-model';

/** 子菜单里的项比一级菜单窄一点。 */
const SUB_CONTENT = 'min-w-40';

/**
 * 会话行右键菜单的内容（Codex 桌面端的版式：组之间一道分隔线，分组与取舍在 context-menu-model.ts）：重命名、置顶、标记为未读 |
 * 分支 | 复制 ▸（会话 ID、工作目录） | 打开方式 ▸（外部编辑器、在访达中显示） | 归档、永久删除。动作都来自 `useSessionActions`，
 * 与行上悬停的按钮是同一套。只在菜单打开时渲染，所以本机编辑器的查找推迟到第一次打开。
 */
export function SessionContextMenuItems({
  cwd,
  actions,
}: {
  cwd: string;
  actions: SessionActions;
}) {
  const groups = sessionMenuGroups({
    rename: actions.rename !== undefined,
    branch: actions.branch !== undefined,
    move: actions.move !== undefined,
    automate: actions.automate !== undefined,
    archive: actions.archive !== undefined,
    delete: actions.remove !== undefined,
  });
  const items: Record<SessionMenuItem, () => ReactNode> = {
    rename: () => (
      <MenuItem id="rename" icon={<Pencil />} onClick={actions.rename}>
        {t('session.rename')}
      </MenuItem>
    ),
    pin: () => (
      <MenuItem id="pin" icon={<PinIcon filled={actions.pinned} />} onClick={actions.togglePin}>
        {t(actions.pinned ? 'session.unpin' : 'session.pin')}
      </MenuItem>
    ),
    unread: () => (
      <MenuItem id="unread" icon={<Eye />} onClick={actions.toggleUnread}>
        {t(actions.unread ? 'session.markRead' : 'session.markUnread')}
      </MenuItem>
    ),
    branch: () => (
      <MenuItem id="branch" icon={<GitBranch />} onClick={actions.branch}>
        {t('message.branch')}
      </MenuItem>
    ),
    move: () => (
      <MenuItem id="move" icon={<FolderGit2 />} onClick={actions.move?.run}>
        {t(actions.move?.to === 'local' ? 'session.moveToLocal' : 'session.moveToWorktree')}
      </MenuItem>
    ),
    automate: () => (
      <MenuItem id="automate" icon={<CalendarClock />} onClick={actions.automate}>
        {t('session.automate')}
      </MenuItem>
    ),
    copy: () => (
      <ContextMenuSub>
        <ContextMenuSubTrigger className={COMPACT_ITEM} data-menu-item="copy">
          <Copy className={COMPACT_ICON} />
          {t('session.copy')}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className={SUB_CONTENT}>
          <ContextMenuItem
            className={COMPACT_ITEM}
            onClick={actions.copyId}
            data-menu-item="copy-id"
          >
            {t('session.copy.id')}
          </ContextMenuItem>
          <ContextMenuItem
            className={COMPACT_ITEM}
            onClick={actions.copyCwd}
            data-menu-item="copy-cwd"
          >
            {t('session.copy.cwd')}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    ),
    openWith: () => <OpenWithSub cwd={cwd} reveal={actions.reveal} />,
    archive: () => (
      <MenuItem id="archive" icon={<ArchiveIcon />} onClick={actions.archive}>
        {t('session.archive')}
      </MenuItem>
    ),
    delete: () => (
      <MenuItem id="delete" icon={<Trash2 />} onClick={actions.remove}>
        {t('session.delete')}
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

/** 一个紧凑的菜单项：左边是说明文字色的图标。 */
export function MenuItem({
  id,
  icon,
  onClick,
  children,
  className,
}: {
  id: string;
  icon: ReactNode;
  onClick?: (() => void) | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ContextMenuItem className={cn(COMPACT_ITEM, className)} onClick={onClick} data-menu-item={id}>
      <span className={cn('flex size-3.5 shrink-0 items-center justify-center', COMPACT_ICON)}>
        {icon}
      </span>
      {children}
    </ContextMenuItem>
  );
}

/** 打开方式：本机装了的外部编辑器（用上次选的记作首选），最后是在访达（资源管理器、文件管理器）中显示。 */
function OpenWithSub({ cwd, reveal }: { cwd: string; reveal: () => void }) {
  const editors = useEditors() ?? [];
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={COMPACT_ITEM} data-menu-item="open-with">
        <SquareArrowOutUpRight className={COMPACT_ICON} />
        {t('files.openWith')}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className={SUB_CONTENT}>
        {editors.map((editor) => (
          <ContextMenuItem
            key={editor.id}
            className={COMPACT_ITEM}
            onClick={() => openInEditor(editor.id, cwd)}
            data-menu-item={`editor-${editor.id}`}
          >
            {editor.name}
          </ContextMenuItem>
        ))}
        {editors.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem className={COMPACT_ITEM} onClick={reveal} data-menu-item="reveal">
          <FolderOpen className={COMPACT_ICON} />
          {t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
