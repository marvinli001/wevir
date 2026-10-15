// 助手消息里的文件链接（U32）：会话视图在 Host 有 `workspace_files` 时提供打开方式，markdown-view.tsx 点到 `data-file-link`
// 时交给它。没有提供时（旧的 Host、子智能体详情）点了不做什么。

import { createContext } from 'react';
import type { PaneController } from '@/layout/pane-controller';
import { parseFileHref, toRelativePath } from './file-path';
import { openFile, openFiles } from './files-store';

export const OpenFileLink = createContext<((href: string) => void) | undefined>(undefined);

/**
 * 打开一个文件链接：在会话目录里的进文件窗格（目录打开文件树），在目录外的绝对路径在访达里显示。
 */
export function openFileLink(panes: PaneController | undefined, cwd: string, href: string): void {
  const target = parseFileHref(href);
  if (!target) return;
  const relative = toRelativePath(target.path, cwd);
  if (relative === undefined) {
    if (target.path.startsWith('/') || /^[a-z]:[\\/]/i.test(target.path)) {
      void window.wevir.revealPath(target.path).catch(() => undefined);
    }
    return;
  }
  if (relative === '' || target.path.endsWith('/')) openFiles(panes);
  else openFile(panes, relative, target.line);
}
