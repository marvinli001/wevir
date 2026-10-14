import { cn } from 'cn';
import { FolderPlus } from 'lucide-react';
import type { ComponentProps } from 'react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { openCreateProject } from './create-project';

/**
 * 选项目的下拉菜单内容：每个项目一行（名称与截掉开头的路径），最下面是“创建项目…”。首页标题里的项目名与输入框上方的
 * 环境栏（U12）共用。
 */
export function ProjectMenuContent({
  currentId,
  workspaces,
  onSelect,
  ...props
}: {
  currentId: string | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string) => void;
} & Pick<ComponentProps<typeof DropdownMenuContent>, 'align' | 'side' | 'sideOffset'>) {
  return (
    <DropdownMenuContent className="w-auto max-w-80 min-w-56" {...props}>
      <DropdownMenuRadioGroup value={currentId ?? ''} onValueChange={(id: string) => onSelect(id)}>
        {workspaces.map(({ workspace }) => (
          <DropdownMenuRadioItem
            key={workspace.id}
            value={workspace.id}
            title={workspace.rootPath}
            closeOnClick
          >
            <span className="min-w-0">
              <span className="block truncate">{workspace.displayName}</span>
              <StartTruncated text={workspace.rootPath} className="text-muted-foreground" />
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {workspaces.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={() => openCreateProject()}>
        <FolderPlus className="text-muted-foreground" />
        {t('home.createProject')}
      </DropdownMenuItem>
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
