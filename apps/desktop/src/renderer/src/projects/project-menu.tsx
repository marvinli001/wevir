import { cn } from 'cn';
import { Folder, FolderPlus, X } from 'lucide-react';
import type { ComponentProps } from 'react';
import {
  COMPACT_DETAIL,
  COMPACT_ICON,
  COMPACT_ITEM,
  COMPACT_RADIO_ITEM,
} from '@/components/compact-menu';
import { ScrollFade } from '@/components/scroll-fade';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { abbreviateHome, parentDirectory } from '@/layout/rail-model';
import { openCreateProject } from './create-project';

/**
 * 选项目的下拉菜单内容（紧凑菜单，`components/compact-menu.ts`）：每个项目一行，文件夹图标、名称与截掉开头的上一级目录
 * （`~` 开头），当前的打勾；下面是“创建项目…”，Host 能建对话时（0.39.0，照 Codex 桌面端）最下面还有“不在目录中工作”，
 * 没选项目时它打勾。项目多时列表最高 320 px，带滚动边缘渐隐。首页标题里的项目名与输入框上方的环境栏（U12）共用。
 * `workspaces` 只放项目（`projectsOf`），`onSelect(null)` 是不在项目里。
 */
export function ProjectMenuContent({
  currentId,
  workspaces,
  onSelect,
  chats = false,
  ...props
}: {
  currentId: string | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string | null) => void;
  /** 列出“不在目录中工作”（`useChatsSupported`）。 */
  chats?: boolean;
} & Pick<ComponentProps<typeof DropdownMenuContent>, 'align' | 'side' | 'sideOffset'>) {
  return (
    <DropdownMenuContent className="w-auto max-w-80 min-w-56" {...props}>
      <ScrollFade className="max-h-80 overflow-y-auto [--scroll-fade-size:16px]">
        <DropdownMenuRadioGroup
          value={currentId ?? ''}
          onValueChange={(id: string) => onSelect(id)}
        >
          {workspaces.map(({ workspace }) => (
            <DropdownMenuRadioItem
              key={workspace.id}
              value={workspace.id}
              title={workspace.rootPath}
              closeOnClick
              className={COMPACT_RADIO_ITEM}
            >
              <Folder aria-hidden className={COMPACT_ICON} />
              <span className="max-w-48 shrink-0 truncate">{workspace.displayName}</span>
              <span dir="rtl" className={cn(COMPACT_DETAIL, 'text-left')}>
                <bdi dir="ltr">{abbreviateHome(parentDirectory(workspace.rootPath))}</bdi>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </ScrollFade>
      {workspaces.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={() => openCreateProject()} className={COMPACT_ITEM}>
        <FolderPlus aria-hidden className={COMPACT_ICON} />
        {t('home.createProject')}
      </DropdownMenuItem>
      {chats && (
        <DropdownMenuRadioGroup value={currentId ?? ''} onValueChange={() => onSelect(null)}>
          <DropdownMenuRadioItem
            value=""
            closeOnClick
            className={COMPACT_RADIO_ITEM}
            data-testid="project-none"
          >
            <X aria-hidden className={COMPACT_ICON} />
            {t('home.workWithoutProject')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      )}
    </DropdownMenuContent>
  );
}

/**
 * 截掉开头、留住最后一段的路径（等宽、12 px）：容器从右往左排，省略号就落在左边；路径本身用 bdi 保持从左往右。
 */
export function StartTruncated({ text, className }: { text: string; className?: string }) {
  return (
    <span dir="rtl" className={cn('block truncate text-left font-mono text-xs', className)}>
      <bdi dir="ltr">{text}</bdi>
    </span>
  );
}
