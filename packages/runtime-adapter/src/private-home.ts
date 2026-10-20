// 添加的订阅账号（0.63.0）的私有配置目录：引擎的凭据、会话与设置都在 Wevir 数据目录的 `accounts/<id>/` 里，与用户自己的
// `~/.claude`、`~/.grok` 互不相通；用户自己写的说明与扩展（CLAUDE.md、skills、agents、commands）照常要用，链回用户的目录。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface LinkUserEntriesOptions {
  /** 私有目录（如 `<root>/claude`），链接放在这里。 */
  privateDir: string;
  /** 用户自己的目录（如 `~/.claude`），链接指向这里。 */
  userDir: string;
  /** 要链的条目名（文件或目录）。 */
  entries: readonly string[];
  platform?: NodeJS.Platform;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * 把用户目录里的这些条目链进私有目录。尽力而为：链不上只少了这一项；私有目录里已有真文件或真目录时那是这个账号自己的内容，
 * 不动；用户那边没有这一项时不链，以前链过的删掉（悬空的链接会被引擎当成真实路径）。Windows 上目录用 junction（不需要管理员
 * 权限），文件链不上就跳过。从不抛错。
 */
export async function linkUserEntries(options: LinkUserEntriesOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  try {
    await fsp.mkdir(options.privateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    options.warn?.('the account directory could not be created', {
      dir: options.privateDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (const entry of options.entries) {
    const link = path.join(options.privateDir, entry);
    const target = path.join(options.userDir, entry);
    try {
      const own = await fsp.lstat(link).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (own !== undefined && !own.isSymbolicLink()) continue;
      const existing =
        own === undefined ? undefined : path.resolve(path.dirname(link), await fsp.readlink(link));
      const stats = await fsp.stat(target).catch(() => undefined);
      if (stats === undefined) {
        if (existing !== undefined) await fsp.rm(link, { force: true });
        continue;
      }
      if (existing === target) continue;
      if (existing !== undefined) await fsp.rm(link, { force: true });
      const type = stats.isDirectory() ? (platform === 'win32' ? 'junction' : 'dir') : 'file';
      await fsp.symlink(target, link, type);
    } catch (error) {
      options.warn?.('a user config entry was not linked into the account directory', {
        link,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
