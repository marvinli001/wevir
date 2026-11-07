// 生命周期钩子的文件来源（0.137.0，ADR-0023 决策 3、4）：仓库里的 `.wevir/hooks.json`、`.claude/settings.json`、
// `.claude/settings.local.json`，Claude 用户层的 `settings.json`，已装插件的 hooks 文件。写法都是 Claude Code / Codex 的
// `{ hooks: { 事件: [ { matcher, hooks: [处理器] } ] } }`。`.codex/` 的仍由 guardrails/repo-hooks.ts 管（Codex 自己会读，要逐个停用）。
//
// 仓库来源的内容散列除了 hook 条目本身，还含命令里引用的仓库内文件（两家都只散列条目，脚本改了照样执行）：取前
// `REFERENCED_FILES_MAX` 个、各 `REFERENCED_FILE_MAX_BYTES` 以内的；超出的照样启用，但标 `unhashedFiles`。

import { createHash, webcrypto } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookSource } from '@wevir/protocol';
import { HOOK_EVENTS } from '@wevir/protocol';

/** 散列里最多纳入几个被引用的文件、每个多大。 */
export const REFERENCED_FILES_MAX = 8;
export const REFERENCED_FILE_MAX_BYTES = 1024 * 1024;

/** 找到的一个处理器。 */
export interface FoundHook {
  id: string;
  source: HookSource;
  /** 显示用的路径（仓库来源相对项目根，`/` 分隔）。 */
  file?: string;
  pluginId?: string;
  event: string;
  matcher?: string;
  handler: string;
  command?: string;
  timeoutSec?: number;
  onFailure?: string;
  engines: string[];
  hash: string;
  unhashedFiles?: true;
  /** 插件目录：执行时设 `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT`。 */
  pluginDir?: string;
}

export interface HookScan {
  hooks: FoundHook[];
  warnings: string[];
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function contentHash(identity: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeys(identity)))
    .digest('hex')}`;
}

/**
 * 命令里引用的、`root` 下存在的文件（相对路径、`./…`、`$CLAUDE_PROJECT_DIR/…` 一类）：按出现先后，去重。只认带 `/` 或以 `.` 开头的词，
 * 免得把 `pnpm`、`test` 当成文件。
 */
export async function referencedFiles(command: string, root: string): Promise<string[]> {
  const words = command.match(/"[^"]*"|'[^']*'|[^\s;&|<>()]+/g) ?? [];
  const found: string[] = [];
  for (const raw of words) {
    let word = raw.replace(/^["']|["']$/g, '');
    word = word.replace(/^\$\{?(?:CLAUDE_PROJECT_DIR|PWD)\}?(?=\/)/, root);
    if (word.includes('$') || word.includes('*')) continue;
    if (!word.includes('/') && !word.startsWith('.')) continue;
    const path = isAbsolute(word) ? word : resolve(root, word);
    const rel = relative(root, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    if (!found.includes(path)) found.push(path);
  }
  return found;
}

/** 条目加上引用文件的内容一起散列。 */
const fileHashes = new Map<string, { stamp: string; hash: string }>();

async function hashWithFiles(
  identity: unknown,
  command: string | undefined,
  root: string | undefined,
): Promise<{ hash: string; unhashedFiles?: true }> {
  if (command === undefined || root === undefined) return { hash: contentHash(identity) };
  const files = await referencedFiles(command, root);
  const contents: Record<string, string> = {};
  let skipped = files.length > REFERENCED_FILES_MAX;
  for (const file of files.slice(0, REFERENCED_FILES_MAX)) {
    try {
      const info = await stat(file, { bigint: true });
      if (info.size > BigInt(REFERENCED_FILE_MAX_BYTES)) {
        skipped = true;
        continue;
      }
      const stamp = `${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
      const cached = fileHashes.get(file);
      const hash =
        cached?.stamp === stamp
          ? cached.hash
          : Buffer.from(await webcrypto.subtle.digest('SHA-256', await readFile(file))).toString(
              'hex',
            );
      fileHashes.delete(file);
      fileHashes.set(file, { stamp, hash });
      if (fileHashes.size > 256) fileHashes.delete(fileHashes.keys().next().value as string);
      contents[relative(root, file).split(sep).join('/')] = hash;
    } catch {
      skipped = true;
    }
  }
  const hash = contentHash(
    Object.keys(contents).length === 0 ? identity : { entry: identity, files: contents },
  );
  return { hash, ...(skipped && { unhashedFiles: true as const }) };
}

export interface TableContext {
  source: HookSource;
  /** ID 前缀（`<来源>:<文件>` 或 `plugin:<ID>`）。 */
  idPrefix: string;
  file?: string;
  pluginId?: string;
  pluginDir?: string;
  engines: string[];
  /** 仓库来源：引用文件的基准目录（项目根）；给了才把引用的文件算进散列。 */
  root?: string;
  platform: NodeJS.Platform;
}

/** 一份 hooks 表里的处理器。认不出的事件不收；处理器种类照收（非 `command` 的列为不支持）。 */
export async function parseHookTable(
  table: Record<string, unknown>,
  context: TableContext,
): Promise<FoundHook[]> {
  const found: FoundHook[] = [];
  for (const [event, groups] of Object.entries(table)) {
    if (!KNOWN_EVENTS.has(event) || !Array.isArray(groups)) continue;
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const matcher =
        typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : undefined;
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        if (!isRecord(handler)) continue;
        const type = typeof handler.type === 'string' ? handler.type : 'unknown';
        const command =
          type !== 'command'
            ? undefined
            : context.platform === 'win32' && typeof handler.commandWindows === 'string'
              ? handler.commandWindows
              : typeof handler.command === 'string' && handler.command.trim() !== ''
                ? handler.command
                : undefined;
        const timeout = handler.timeout;
        const timeoutSec =
          typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1
            ? timeout
            : undefined;
        const onFailure = typeof handler.onFailure === 'string' ? handler.onFailure : undefined;
        // 后台跑的命令（`async`）不能拦截，本批不执行。
        const kind = type === 'command' && handler.async === true ? 'command_async' : type;
        const identity = { event, matcher: matcher ?? null, handler };
        found.push({
          id: `${context.idPrefix}:${event}:${groupIndex}:${handlerIndex}`,
          source: context.source,
          ...(context.file !== undefined && { file: context.file }),
          ...(context.pluginId !== undefined && { pluginId: context.pluginId }),
          ...(context.pluginDir !== undefined && { pluginDir: context.pluginDir }),
          event,
          ...(matcher !== undefined && { matcher }),
          handler: kind,
          ...(command !== undefined && { command }),
          ...(timeoutSec !== undefined && { timeoutSec }),
          ...(onFailure !== undefined && { onFailure }),
          engines: context.engines,
          ...(await hashWithFiles(identity, command, context.root)),
        });
      }
    }
  }
  return found;
}

/** 读一个 JSON 文件的 `hooks` 表；文件不存在时 undefined，读坏了进 `warnings`。 */
async function readTable(
  absolute: string,
  label: string,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`${label}: ${(error as Error).message}`);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push(`${label}: ${(error as Error).message}`);
    return undefined;
  }
  const table = isRecord(parsed) ? parsed.hooks : undefined;
  if (table === undefined) return undefined;
  if (!isRecord(table)) {
    warnings.push(`${label}: hooks is not an object`);
    return undefined;
  }
  return table;
}

/** `cwd` 所在仓库的根（向上找 `.git`，文件或目录都算）到 `cwd` 的每一层；不在仓库里时只有 `cwd`。 */
export async function projectDirs(cwd: string): Promise<{ root: string; dirs: string[] }> {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const found = await stat(join(dir, '.git')).then(
      () => true,
      () => false,
    );
    if (found) {
      const dirs = [dir];
      const rest = relative(dir, start);
      if (rest !== '') {
        let at = dir;
        for (const part of rest.split(sep)) {
          at = join(at, part);
          dirs.push(at);
        }
      }
      return { root: dir, dirs };
    }
    if (dirname(dir) === dir) return { root: start, dirs: [start] };
  }
}

/** 仓库里的文件与它们的来源、跑在哪些引擎上。 */
const PROJECT_FILES: ReadonlyArray<{ path: string[]; source: HookSource; engines: string[] }> = [
  { path: ['.wevir', 'hooks.json'], source: 'project', engines: ['*'] },
  { path: ['.claude', 'settings.json'], source: 'claude_project', engines: ['claude'] },
  { path: ['.claude', 'settings.local.json'], source: 'claude_project', engines: ['claude'] },
];

/** 找出 `cwd` 一路上的仓库 hooks（`.codex/` 的除外）。 */
export async function scanProjectHooks(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<HookScan> {
  const { root, dirs } = await projectDirs(cwd);
  const hooks: FoundHook[] = [];
  const warnings: string[] = [];
  for (const dir of dirs) {
    for (const file of PROJECT_FILES) {
      const absolute = join(dir, ...file.path);
      const rel = relative(root, absolute).split(sep).join('/');
      const table = await readTable(absolute, rel, warnings);
      if (table === undefined) continue;
      hooks.push(
        ...(await parseHookTable(table, {
          source: file.source,
          idPrefix: `${file.source}:${rel}`,
          file: rel,
          engines: file.engines,
          root,
          platform,
        })),
      );
    }
  }
  return { hooks, warnings };
}

/** Claude 用户层的 `settings.json`（视为用户自己的，不算引用文件）。`label` 是显示用的路径。 */
export async function scanClaudeUserHooks(
  path: string,
  label: string,
  platform: NodeJS.Platform = process.platform,
): Promise<HookScan> {
  const warnings: string[] = [];
  const table = await readTable(path, label, warnings);
  if (table === undefined) return { hooks: [], warnings };
  return {
    hooks: await parseHookTable(table, {
      source: 'claude_user',
      idPrefix: 'claude_user:settings.json',
      file: label,
      engines: ['claude'],
      platform,
    }),
    warnings,
  };
}

/** 已装插件的一份 hooks（插件包的格式决定跑在哪些引擎上）。 */
export interface InstalledPluginHooks {
  id: string;
  /** 安装目录。 */
  path: string;
  source: 'wevir' | 'claude' | 'codex';
  enabled: boolean;
}

/**
 * 插件包里的 hooks：清单的 `hooks`（包内路径或行内对象），没有时 `./hooks/hooks.json`。Wevir 的清单是 `wevir-plugin.json`，导入的
 * 包是 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`。读出的是 `hooks` 表本身。
 */
export async function pluginHookTable(
  dir: string,
  format: 'wevir' | 'claude' | 'codex',
  warnings: string[],
  label: string = format,
): Promise<Record<string, unknown> | undefined> {
  const manifestPath =
    format === 'wevir'
      ? join(dir, 'wevir-plugin.json')
      : join(dir, format === 'claude' ? '.claude-plugin' : '.codex-plugin', 'plugin.json');
  let declared: unknown;
  try {
    declared = (JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>).hooks;
  } catch {}
  if (isRecord(declared)) return isRecord(declared.hooks) ? declared.hooks : declared;
  const relativePath =
    typeof declared === 'string' && declared.startsWith('./') ? declared : './hooks/hooks.json';
  const absolute = resolve(dir, relativePath);
  const rel = relative(dir, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    warnings.push(`${label}: hooks path is outside the plugin`);
    return undefined;
  }
  return readTable(absolute, `${label}: ${relativePath}`, warnings);
}

export async function scanPluginHooks(
  plugin: InstalledPluginHooks,
  platform: NodeJS.Platform = process.platform,
): Promise<HookScan> {
  const warnings: string[] = [];
  const table = await pluginHookTable(plugin.path, plugin.source, warnings, plugin.id);
  if (table === undefined) return { hooks: [], warnings };
  return {
    hooks: await parseHookTable(table, {
      source: 'plugin',
      idPrefix: `plugin:${plugin.id}`,
      pluginId: plugin.id,
      pluginDir: plugin.path,
      engines: plugin.source === 'wevir' ? ['*'] : [plugin.source],
      platform,
    }),
    warnings,
  };
}
