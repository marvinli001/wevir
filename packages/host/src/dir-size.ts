// 文件与文件夹占了多少（0.43.0，`session.usage`）：文件大小之和（同访达），不跟随符号链接，读不了的算 0。worktree 里的
// node_modules 动辄几十万个文件，同时进行的文件系统调用有上限。

import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 同时进行的文件系统调用上限。 */
const CONCURRENCY = 32;

export type FsLimit = <T>(task: () => Promise<T>) => Promise<T>;

export function fsLimit(max = CONCURRENCY): FsLimit {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** `path`（文件或整个文件夹）的字节数；不在时为 0。 */
export async function sizeOf(path: string, limit: FsLimit = fsLimit()): Promise<number> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await limit(() => lstat(path));
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return Number(info.size);
  let entries: Dirent[];
  try {
    entries = await limit(() => readdir(path, { withFileTypes: true }));
  } catch {
    return 0;
  }
  const sizes = await Promise.all(entries.map((entry) => sizeOf(join(path, entry.name), limit)));
  return sizes.reduce((sum, size) => sum + size, 0);
}
