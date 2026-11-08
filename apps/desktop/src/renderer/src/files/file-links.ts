// 助手消息里的文件链接（U32）：会话视图在 Host 有 `workspace_files` 时提供打开方式，markdown-view.tsx 点到 `data-file-link`
// 时交给它。没有提供时（旧的 Host、子智能体详情）点了不做什么。

import type { Session, Workspace } from '@wevir/protocol';
import { createContext, useCallback } from 'react';
import { changeFolders } from '@/changes/change-folders';
import { useWorkbenchSelector } from '@/data/workbench-data';
import type { WorkbenchData } from '@/data/workbench-model';
import type { PaneController } from '@/layout/pane-controller';
import { capabilities, platformApi } from '@/platform/platform';
import { folderFile, parseFileHref, toAbsolutePath, toRelativePath } from './file-path';
import { openFile, openFiles } from './files-store';

export const OpenFileLink = createContext<((href: string) => void) | undefined>(undefined);

/**
 * 在文件窗格里打开会话文件夹里的一个文件（`path` 相对会话目录，0.40.0 的文件卡片用）。会话视图在 Host 有 `workspace_files` 时
 * 提供；没有时卡片改用系统的默认应用。
 */
export const OpenSessionFile = createContext<((path: string) => void) | undefined>(undefined);

/**
 * 会话的附加文件夹（不含会话目录本身），规则同“变更”与 Host 的校验：会话自己的 `extraRoots`；旧会话没有时用项目的附加文件夹，
 * worktree 会话不退回项目的。
 */
export function extraFolders(
  workspace: Pick<Workspace, 'extraFolders'>,
  session: Pick<Session, 'cwd' | 'extraRoots' | 'worktrees'>,
): string[] {
  return changeFolders(workspace, session).filter((folder) => folder !== session.cwd);
}

const NO_FOLDERS: readonly string[] = [];

function sameFolders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((folder, index) => folder === b[index]);
}

/** 同上，项目从工作台的列表里找。 */
export function useExtraFolders(
  session: Pick<Session, 'workspaceId' | 'cwd' | 'extraRoots' | 'worktrees'>,
): readonly string[] {
  const { workspaceId, cwd, extraRoots, worktrees } = session;
  const select = useCallback(
    (data: WorkbenchData) => {
      const workspace =
        data.status === 'ready'
          ? data.workspaces.find((entry) => entry.workspace.id === workspaceId)?.workspace
          : undefined;
      const folders = extraFolders(workspace ?? {}, { cwd, extraRoots, worktrees });
      return folders.length === 0 ? NO_FOLDERS : folders;
    },
    [workspaceId, cwd, extraRoots, worktrees],
  );
  return useWorkbenchSelector(select, sameFolders);
}

/**
 * 附加文件夹里的文件在文件窗格里用的路径（0.168.0）：规范化的绝对路径，文件窗格按它找回文件夹。不在附加文件夹里时 undefined。
 */
export function folderFilePath(path: string, folders: readonly string[]): string | undefined {
  const found = folderFile(path, folders);
  return found && toAbsolutePath(found.path, found.folder);
}

/**
 * 打开一个文件链接：在会话目录里的进文件窗格（目录打开文件树）；在会话附加文件夹里的文件（`folders`，Host 有
 * `multi_folder_files` 时才给）也进文件窗格；其余的绝对路径在访达里显示。
 */
export function openFileLink(
  panes: PaneController | undefined,
  cwd: string,
  href: string,
  folders: readonly string[] = [],
): void {
  const target = parseFileHref(href);
  if (!target) return;
  const relative = toRelativePath(target.path, cwd);
  if (relative === undefined) {
    const inFolder = target.path.endsWith('/') ? undefined : folderFilePath(target.path, folders);
    if (inFolder !== undefined) {
      openFile(panes, inFolder, target.line);
      return;
    }
    if (
      capabilities().localFiles &&
      (target.path.startsWith('/') || /^[a-z]:[\\/]/i.test(target.path))
    ) {
      void platformApi()
        .revealPath(target.path)
        .catch(() => undefined);
    }
    return;
  }
  if (relative === '' || target.path.endsWith('/')) openFiles(panes);
  else openFile(panes, relative, target.line);
}
