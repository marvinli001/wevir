// 助手消息里的文件链接（U32）：会话视图在 Host 有 `workspace_files` 时提供打开方式，markdown-view.tsx 点到 `data-file-link`
// 时交给它。没有提供时（旧的 Host、子智能体详情）点了不做什么。

import { createContext } from 'react';
import type { PaneController } from '@/layout/pane-controller';
import { capabilities, platformApi } from '@/platform/platform';
import { parseFileHref, toRelativePath } from './file-path';
import { openFile, openFiles } from './files-store';

export const OpenFileLink = createContext<((href: string) => void) | undefined>(undefined);

/**
 * 在文件窗格里打开会话文件夹里的一个文件（`path` 相对会话目录，0.40.0 的文件卡片用）。会话视图在 Host 有 `workspace_files` 时
 * 提供；没有时卡片改用系统的默认应用。
 */
export const OpenSessionFile = createContext<((path: string) => void) | undefined>(undefined);

/**
 * 打开一个文件链接：在会话目录里的进文件窗格（目录打开文件树），在目录外的绝对路径在访达里显示。
 */
export function openFileLink(panes: PaneController | undefined, cwd: string, href: string): void {
  const target = parseFileHref(href);
  if (!target) return;
  const relative = toRelativePath(target.path, cwd);
  if (relative === undefined) {
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
