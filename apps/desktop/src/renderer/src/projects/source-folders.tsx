// 项目的源文件夹列表（0.64.0，照 Codex 桌面端“编辑项目”）：创建项目与编辑项目共用。一张卡片，每行一个文件夹（名字 + 上一级
// 目录，悬停看完整路径，× 移除），最后一行“添加文件夹”。第一个是主文件夹（Host 的 `rootPath`），其余是 `extraFolders`。

import { hostSupports } from '@wevir/client-sdk';
import { WORKSPACE_EXTRA_FOLDERS_MAX } from '@wevir/protocol';
import { Folder, FolderPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { abbreviateHome, parentDirectory } from '@/layout/rail-model';

/** 主文件夹加其他源文件夹最多几个。 */
export const SOURCE_FOLDERS_MAX = WORKSPACE_EXTRA_FOLDERS_MAX + 1;

/** Host 能给项目多个源文件夹（0.64.0）；不能时只有主文件夹。 */
export function useMultipleSourceFolders(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'workspace_folders');
}

/** 用系统的文件夹选择器挑一个；取消时 `null`，打不开选择器时抛出给出原因的错误文案。 */
export async function chooseSourceFolder(): Promise<string | null> {
  try {
    return await window.wevir.selectFolder();
  } catch (reason) {
    throw new Error(t('project.selectFailed', { error: describe(reason) }));
  }
}

export function SourceFolderList({
  folders,
  max,
  locked = 0,
  onAdd,
  onRemove,
}: {
  folders: readonly string[];
  /** 最多几个；到了就不再显示“添加文件夹”。 */
  max: number;
  /** 前几个不能移除（编辑项目时的主文件夹）。 */
  locked?: number;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const row = 'flex min-h-11 items-center gap-2.5 px-3';
  return (
    <ul
      className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
      data-testid="source-folders"
    >
      {folders.map((folder, index) => (
        <li key={folder} className={row} title={folder}>
          <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 truncate text-sm">{basename(folder)}</span>
          <span
            dir="rtl"
            className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground"
          >
            <bdi dir="ltr">{abbreviateHome(parentDirectory(folder))}</bdi>
          </span>
          {index >= locked && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-mr-1.5 text-muted-foreground"
              aria-label={t('project.create.clearFolder')}
              onClick={() => onRemove(index)}
            >
              <X />
            </Button>
          )}
        </li>
      ))}
      {folders.length < max && (
        <li>
          <button
            type="button"
            onClick={onAdd}
            data-action="choose-folder"
            className={`${row} w-full text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:bg-muted`}
          >
            <FolderPlus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {t('project.create.addFolder')}
          </button>
        </li>
      )}
    </ul>
  );
}

export function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}
