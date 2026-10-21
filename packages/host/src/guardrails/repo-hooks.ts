// 仓库自带的 Codex hooks（0.85.0，domain-model §3.40）：找出 Codex 会从项目层读的 hooks，给“仓库 hooks”列表与会话的停用清单用。
// Codex（rust-v0.162.1，config 的项目层发现）从仓库根（向上找到的 `.git`）到会话目录一路上，每个目录的 `.codex/` 是一层，读其中的
// `hooks.json` 与 `config.toml` 的 `[hooks]`；linked worktree 读主 checkout 的。这些 hooks 不受信任时 Codex 不执行（实测），Wevir
// 再把它们的键逐个写成 `enabled = false`，用户启用的经检查程序转一手、挂在会话层（见 service.ts）。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { codexHookKey, isCodexHookEvent } from '@wevir/adapter-codex';
import { parse as parseToml } from 'smol-toml';

/** 检测到的一个仓库 hook 处理器。 */
export interface FoundRepoHook {
  /** `<相对仓库根的文件>:<事件>:<组序号>:<处理器序号>`。 */
  id: string;
  /** 相对仓库根，`/` 分隔。 */
  file: string;
  event: string;
  matcher?: string;
  handler: string;
  command?: string;
  timeoutSec?: number;
  statusMessage?: string;
  /** 内容散列（事件、matcher 与处理器的全部字段）：内容一改就变。 */
  hash: string;
  /** Codex 的持久化键（绝对路径），会话里写 `enabled = false` 用。 */
  codexKey: string;
}

export interface RepoHookScan {
  hooks: FoundRepoHook[];
  /** 读不出的文件：`<相对路径>: <说明>`。 */
  warnings: string[];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** linked worktree 的 `.git` 文件 → 主 checkout 的根；读不出时 undefined。 */
function mainCheckoutOf(root: string): string | undefined {
  try {
    const text = readFileSync(join(root, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match?.[1]) return undefined;
    const gitDir = resolve(root, match[1].trim());
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return dirname(resolve(gitDir, common));
  } catch {
    return undefined;
  }
}

/**
 * Codex 会读 `.codex/` 的目录，从仓库根到 `cwd`。`cwd` 不在任何仓库里时只有它自己。linked worktree 换成主 checkout 里对应的目录。
 * 返回 `{ root, dirs }`，`root` 是相对路径的基准。
 */
export function codexProjectDirs(cwd: string): { root: string; dirs: string[] } {
  const start = resolve(cwd);
  let root: string | undefined;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (root === undefined) return { root: start, dirs: [start] };
  const rest = relative(root, start);
  const base = isDir(join(root, '.git')) ? root : (mainCheckoutOf(root) ?? root);
  const dirs = [base];
  if (rest !== '') {
    let dir = base;
    for (const part of rest.split(sep)) {
      dir = join(dir, part);
      dirs.push(dir);
    }
  }
  return { root: base, dirs };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function contentHash(identity: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeys(identity)))
    .digest('hex')}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 一份 hooks 表（`hooks.json` 的 `hooks`，或 `config.toml` 的 `[hooks]`）里的处理器。 */
function handlersOf(
  table: Record<string, unknown>,
  file: { absolute: string; relative: string },
  platform: NodeJS.Platform,
): FoundRepoHook[] {
  const found: FoundRepoHook[] = [];
  for (const [event, groups] of Object.entries(table)) {
    if (!isCodexHookEvent(event) || !Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return;
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
      group.hooks.forEach((handler, handlerIndex) => {
        if (!isRecord(handler)) return;
        const type = typeof handler.type === 'string' ? handler.type : 'unknown';
        const command =
          type !== 'command'
            ? undefined
            : platform === 'win32' && typeof handler.commandWindows === 'string'
              ? handler.commandWindows
              : typeof handler.command === 'string'
                ? handler.command
                : undefined;
        const timeout = handler.timeout;
        const timeoutSec =
          typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1
            ? timeout
            : undefined;
        const statusMessage =
          typeof handler.statusMessage === 'string' ? handler.statusMessage : undefined;
        found.push({
          id: `${file.relative}:${event}:${groupIndex}:${handlerIndex}`,
          file: file.relative,
          event,
          ...(matcher !== undefined && { matcher }),
          // 异步的命令 hook 不能拦截，Wevir 也不转。
          handler: type === 'command' && handler.async === true ? 'command_async' : type,
          ...(command !== undefined && { command }),
          ...(timeoutSec !== undefined && { timeoutSec }),
          ...(statusMessage !== undefined && { statusMessage }),
          hash: contentHash({ event, matcher: matcher ?? null, handler }),
          codexKey: codexHookKey(file.absolute, event, groupIndex, handlerIndex),
        });
      });
    });
  }
  return found;
}

/** 找出 Codex 在 `cwd` 会读的仓库 hooks。 */
export function scanRepoHooks(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): RepoHookScan {
  const { root, dirs } = codexProjectDirs(cwd);
  const hooks: FoundRepoHook[] = [];
  const warnings: string[] = [];
  for (const dir of dirs) {
    const codexDir = join(dir, '.codex');
    if (!isDir(codexDir)) continue;
    for (const name of ['hooks.json', 'config.toml']) {
      const absolute = join(codexDir, name);
      const rel = relative(root, absolute).split(sep).join('/');
      let text: string;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          warnings.push(`${rel}: ${(error as Error).message}`);
        }
        continue;
      }
      let table: unknown;
      try {
        table =
          name === 'hooks.json'
            ? (JSON.parse(text) as { hooks?: unknown }).hooks
            : parseToml(text).hooks;
      } catch (error) {
        warnings.push(`${rel}: ${(error as Error).message}`);
        continue;
      }
      if (table === undefined) continue;
      if (!isRecord(table)) {
        warnings.push(`${rel}: hooks is not a table`);
        continue;
      }
      hooks.push(...handlersOf(table, { absolute, relative: rel }, platform));
    }
  }
  return { hooks, warnings };
}
