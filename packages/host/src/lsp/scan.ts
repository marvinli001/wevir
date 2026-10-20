// 代码智能（LSP 工具，domain-model §3.15）：项目里出现了哪些语言、各在哪个项目根（0.70.0，`lsp.status`）。扫一遍目录树（有上限，
// 跳过依赖、构建产物与隐藏目录），每个源文件按它的语言找项目根——与 `lsp_*` 工具起服务器时用的是同一个规则，所以 monorepo 里
// 各个 go.mod、pyproject.toml 分别是一个根。

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { type ServerSpec, serverFor } from './servers.js';

/** 最多看多少个目录项、多深。 */
const SCAN_ENTRIES_MAX = 20_000;
const SCAN_DEPTH_MAX = 12;
/** 不进去的目录（还有所有以 `.` 开头的）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'venv',
  'env',
  '__pycache__',
  'site-packages',
  'vendor',
  'Pods',
  'DerivedData',
  'coverage',
]);

export interface DetectedServer {
  spec: ServerSpec;
  root: string;
  /** 一个源文件：装完后拿它验证。 */
  sample: string;
  files: number;
}

export interface ScanResult {
  servers: DetectedServer[];
  /** 文件太多没扫完。 */
  truncated: boolean;
}

export async function scanLanguages(
  dir: string,
  servers: readonly ServerSpec[],
): Promise<ScanResult> {
  const found = new Map<string, DetectedServer>();
  /** `<种类>\0<目录>` → 项目根：同一个目录里的文件根一样。 */
  const roots = new Map<string, Promise<string>>();
  let seen = 0;
  let truncated = false;
  let level = [dir];
  for (let depth = 0; depth <= SCAN_DEPTH_MAX && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of level) {
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        seen += 1;
        if (seen > SCAN_ENTRIES_MAX) {
          truncated = true;
          break;
        }
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) next.push(file);
          continue;
        }
        if (!entry.isFile()) continue;
        const spec = serverFor(servers, file);
        if (spec === undefined) continue;
        const rootKey = `${spec.id}\0${current}`;
        let root = roots.get(rootKey);
        if (root === undefined) {
          root = spec.root(file, dir);
          roots.set(rootKey, root);
        }
        const resolved = await root;
        const key = `${spec.id}\0${resolved}`;
        const existing = found.get(key);
        if (existing === undefined) {
          found.set(key, { spec, root: resolved, sample: file, files: 1 });
        } else {
          existing.files += 1;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
    level = next;
  }
  const order = new Map(servers.map((spec, index) => [spec.id, index]));
  return {
    servers: [...found.values()].sort(
      (a, b) =>
        (order.get(a.spec.id) ?? 0) - (order.get(b.spec.id) ?? 0) || a.root.localeCompare(b.root),
    ),
    truncated,
  };
}
