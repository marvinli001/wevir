// 审批测试要写的“工作区之外、且不在系统临时目录”的目录。Codex 的 workspace-write 可写根是工作区、`$TMPDIR` 与
// `/tmp`（codex-notes §2.3），写在那里不会触发审批，所以建在本包的 .test-outside/ 下（gitignore），用完删掉。

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../.test-outside/', import.meta.url));

/** 新建一个这样的目录（realpath），返回它和删除它的函数。 */
export function makeOutsideDir(label: string): { dir: string; remove: () => void } {
  mkdirSync(ROOT, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  for (const temp of [tmpdir(), '/tmp']) {
    if (!existsSync(temp)) continue;
    const rel = relative(realpathSync(temp), dir);
    // Windows 上不同盘符时 relative 返回绝对路径。
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      throw new Error(`${dir} 在系统临时目录 ${temp} 下，写入不会触发审批`);
    }
  }
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmdirSync(ROOT);
      } catch {
        // 还有别的测试在用（ENOTEMPTY），由最后一个删。
      }
    },
  };
}
