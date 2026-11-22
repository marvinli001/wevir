// 删整个目录（worktree 等用户内容）。Host 在 Electron 里跑时 `node:fs` 被换成认 asar 的版本：目录里的 `.asar` 文件（如
// node_modules 里 electron 包自带的 default_app.asar）被当成目录，递归删除跳过它，最后 rmdir 报 ENOTEMPTY。Electron 里改用
// 不认 asar 的 `original-fs`；普通 Node 里就是 `node:fs`。
import * as fs from 'node:fs';
import { createRequire } from 'node:module';

let cached: typeof fs | undefined;

function plainFs(): typeof fs {
  if (cached !== undefined) return cached;
  cached = fs;
  if (process.versions.electron !== undefined) {
    try {
      cached = createRequire(import.meta.url)('original-fs') as typeof fs;
    } catch {
      // 拿不到时退回 node:fs。
    }
  }
  return cached;
}

const OPTIONS = { recursive: true, force: true } as const;

/** `rm -rf`：目录不在也不报错。 */
export function removeTree(path: string): Promise<void> {
  return plainFs().promises.rm(path, OPTIONS);
}

/** {@link removeTree} 的同步版。 */
export function removeTreeSync(path: string): void {
  plainFs().rmSync(path, OPTIONS);
}
