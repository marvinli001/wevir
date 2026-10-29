// 生命周期钩子的配置与信任（0.137.0，ADR-0023 决策 3、4、7）：Wevir 自己的 hooks 存在 `<数据目录>/hooks/<global|工作区 ID>.json`
// （0600，写临时文件再 rename，同 guardrails/），同一文件另记仓库来源的启用（启用时的内容散列）与插件、Claude 用户层的停用。仓库、
// 插件与 Claude 用户层的 hooks 不复制，每次用时从文件读（短时缓存）。`.codex/` 的由护栏管（guardrails/repo-hooks.ts），这里只列出来、
// 启停转给它。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Hook,
  HookCommandHandler,
  HookSupport,
  MethodParams,
  RepoHook,
  WorkspaceId,
} from '@wevir/protocol';
import {
  HOOK_TIMEOUT_DEFAULT_SEC,
  HOOKS_MAX_PER_SCOPE,
  HookCommandHandlerSchema,
  HookEventSchema,
  WorkspaceIdSchema,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import type { RunnableHook } from './run.js';
import { matcherMatches } from './run.js';
import {
  type FoundHook,
  type InstalledPluginHooks,
  scanClaudeUserHooks,
  scanPluginHooks,
  scanProjectHooks,
} from './sources.js';

type Scope = WorkspaceId | 'global';

interface StoredHook {
  id: string;
  name?: string;
  event: string;
  matcher?: string;
  handler: HookCommandHandler;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScopeFile {
  hooks: StoredHook[];
  /** 仓库来源：启用了的 ID → 启用时的内容散列。 */
  trusted: Record<string, { hash: string; at: string }>;
  /** 插件与 Claude 用户层：停用了的 ID → 停用时间（只在全局文件里）。 */
  disabled: Record<string, string>;
}

const emptyFile = (): ScopeFile => ({ hooks: [], trusted: {}, disabled: {} });

/** 会话的信息：判断哪些 hooks 对它有效。 */
export interface HookScope {
  workspaceId?: WorkspaceId | undefined;
  cwd: string;
  /** 承载会话的引擎（`codex`、`claude` 或 Provider 种类）。 */
  engine: string;
}

export interface HookServiceOptions {
  dir: string;
  workspaceRoot: (workspaceId: WorkspaceId) => string | undefined;
  /** 已装的插件。 */
  plugins?: () => readonly InstalledPluginHooks[];
  /** Claude 用户层的设置文件：路径与显示用的标签。没有 Claude 引擎时不给。 */
  claudeUserSettings?: () => { path: string; label: string } | undefined;
  /** `.codex/` 的仓库 hooks（护栏）。 */
  codexRepoHooks?: {
    list(workspaceId: WorkspaceId): { hooks: RepoHook[]; warnings: string[] };
    setEnabled(workspaceId: WorkspaceId, hookId: string, enabled: boolean): Promise<RepoHook>;
  };
  /** 各引擎有接点的事件。 */
  support?: () => HookSupport[];
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  platform?: NodeJS.Platform;
  /** 文件来源的扫描缓存多久（毫秒，默认 2000；测试给 0）。 */
  scanTtlMs?: number;
}

type ChangeListener = (change: { workspaceId?: WorkspaceId }) => void;

function invalid(path: Array<string | number>, message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function checkMatcher(matcher: string | undefined): void {
  if (matcher === undefined || matcher === '' || matcher === '*') return;
  try {
    new RegExp(`^(?:${matcher})$`);
  } catch (error) {
    throw invalid(['matcher'], `invalid regular expression: ${(error as Error).message}`);
  }
}

/** 文件来源的扫描结果缓存多久（毫秒）：一个回合里每次工具调用都要看一遍。 */
const SCAN_TTL_MS = 2000;

export class HookService {
  readonly #options: HookServiceOptions;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform;
  readonly #files = new Map<Scope, ScopeFile>();
  readonly #listeners = new Set<ChangeListener>();
  readonly #scans = new Map<string, { at: number; hooks: FoundHook[]; warnings: string[] }>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: HookServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#loadAll();
  }

  // ── 列出 ─────────────────────────────────────────────────────────────

  list(workspaceId?: WorkspaceId): { hooks: Hook[]; warnings: string[]; support: HookSupport[] } {
    const hooks: Hook[] = [];
    const warnings: string[] = [];
    const scopes: Scope[] = workspaceId === undefined ? ['global'] : ['global', workspaceId];
    for (const scope of scopes) {
      for (const stored of this.#files.get(scope)?.hooks ?? []) hooks.push(toHook(scope, stored));
    }
    if (workspaceId !== undefined) {
      const root = this.#options.workspaceRoot(workspaceId);
      if (root !== undefined) {
        const scan = this.#scan(`project:${root}`, () => scanProjectHooks(root, this.#platform));
        const trusted = this.#files.get(workspaceId)?.trusted ?? {};
        for (const found of scan.hooks) {
          hooks.push(foundHook(found, trustStatus(found, trusted), trusted[found.id]?.at));
        }
        warnings.push(...scan.warnings);
        if (this.#options.codexRepoHooks !== undefined) {
          try {
            const codex = this.#options.codexRepoHooks.list(workspaceId);
            for (const repo of codex.hooks) hooks.push(codexHook(repo));
            warnings.push(...codex.warnings);
          } catch (error) {
            warnings.push(`.codex: ${(error as Error).message}`);
          }
        }
      }
    }
    const disabled = this.#files.get('global')?.disabled ?? {};
    for (const found of this.#globalFound(warnings)) {
      hooks.push(foundHook(found, toggleStatus(found, disabled)));
    }
    return { hooks, warnings, support: this.#options.support?.() ?? [] };
  }

  // ── Wevir 自己的 ───────────────────────────────────────────────────────

  async add(params: MethodParams<'hook.add'>): Promise<Hook> {
    const scope: Scope = params.workspaceId ?? 'global';
    checkMatcher(params.matcher);
    return this.#mutate(scope, (file) => {
      if (file.hooks.length >= HOOKS_MAX_PER_SCOPE) {
        throw invalid(['event'], `a scope can have at most ${HOOKS_MAX_PER_SCOPE} hooks`);
      }
      const now = this.#now().toISOString();
      const name = params.name?.trim();
      const matcher = params.matcher?.trim();
      const stored: StoredHook = {
        id: newId('hok'),
        ...(name !== undefined && name !== '' && { name }),
        event: params.event,
        ...(matcher !== undefined && matcher !== '' && { matcher }),
        handler: params.handler,
        enabled: params.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      file.hooks.push(stored);
      return toHook(scope, stored);
    });
  }

  async update(params: MethodParams<'hook.update'>): Promise<Hook> {
    if (params.matcher !== null) checkMatcher(params.matcher);
    return this.#changeOwn(params.hookId, (stored) => {
      const name = params.name === null ? undefined : (params.name?.trim() ?? stored.name);
      const matcher =
        params.matcher === null ? undefined : (params.matcher?.trim() ?? stored.matcher);
      const { name: _name, matcher: _matcher, ...rest } = stored;
      return {
        ...rest,
        ...(name !== undefined && name !== '' && { name }),
        ...(matcher !== undefined && matcher !== '' && { matcher }),
        event: params.event ?? stored.event,
        handler: params.handler ?? stored.handler,
      };
    });
  }

  delete(hookId: string): Promise<void> {
    const scope = this.#scopeOf(hookId);
    if (scope === undefined) return Promise.reject(notFound(hookId));
    return this.#mutate(scope, (file) => {
      const index = file.hooks.findIndex((hook) => hook.id === hookId);
      if (index === -1) throw notFound(hookId);
      file.hooks.splice(index, 1);
    });
  }

  /** 任何来源的启停：Wevir 自己的是开关，仓库来源是信任当前内容，插件与 Claude 用户层是停用记录，`.codex/` 转给护栏。 */
  async setEnabled(params: MethodParams<'hook.setEnabled'>): Promise<Hook> {
    const { hookId, enabled } = params;
    if (this.#scopeOf(hookId) !== undefined) {
      return this.#changeOwn(hookId, (stored) => ({ ...stored, enabled }));
    }
    const workspaceId = params.workspaceId;
    if (workspaceId !== undefined) {
      const root = this.#options.workspaceRoot(workspaceId);
      if (root === undefined) {
        throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
      }
      this.#scans.delete(`project:${root}`);
      const found = scanProjectHooks(root, this.#platform).hooks.find((h) => h.id === hookId);
      if (found !== undefined) {
        if (enabled && found.command === undefined) {
          throw invalid(['hookId'], 'only command hooks can be enabled');
        }
        return this.#mutate(workspaceId, (file) => {
          if (enabled) file.trusted[hookId] = { hash: found.hash, at: this.#now().toISOString() };
          else delete file.trusted[hookId];
          return foundHook(found, trustStatus(found, file.trusted), file.trusted[hookId]?.at);
        });
      }
      const codex = this.#options.codexRepoHooks;
      if (codex?.list(workspaceId).hooks.some((hook) => hook.id === hookId)) {
        const repo = await codex.setEnabled(workspaceId, hookId, enabled);
        this.#emit(workspaceId);
        return codexHook(repo);
      }
    }
    const found = this.#globalFound([]).find((h) => h.id === hookId);
    if (found === undefined) throw notFound(hookId);
    if (enabled && found.command === undefined) {
      throw invalid(['hookId'], 'only command hooks can be enabled');
    }
    return this.#mutate('global', (file) => {
      if (enabled) delete file.disabled[hookId];
      else file.disabled[hookId] = this.#now().toISOString();
      return foundHook(found, toggleStatus(found, file.disabled));
    });
  }

  /** 收变化（`guardrail.changed`）；返回退订函数。 */
  watch(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ── 执行时 ─────────────────────────────────────────────────────────────

  /** 对这个会话有效、事件对得上的处理器（不看 matcher）。只有能执行的命令处理器。 */
  #effective(scope: HookScope, event: string): Array<RunnableHook & { matcher?: string }> {
    const out: Array<RunnableHook & { matcher?: string }> = [];
    const scopes: Scope[] =
      scope.workspaceId === undefined ? ['global'] : ['global', scope.workspaceId];
    for (const name of scopes) {
      for (const stored of this.#files.get(name)?.hooks ?? []) {
        if (!stored.enabled || stored.event !== event) continue;
        out.push({
          id: stored.id,
          source: 'wevir',
          command: stored.handler.command,
          timeoutSec: stored.handler.timeout ?? HOOK_TIMEOUT_DEFAULT_SEC,
          ...(stored.handler.onFailure !== undefined && { onFailure: stored.handler.onFailure }),
          ...(stored.matcher !== undefined && { matcher: stored.matcher }),
        });
      }
    }
    const runs = (found: FoundHook) =>
      found.event === event &&
      found.command !== undefined &&
      found.handler === 'command' &&
      (found.engines.includes('*') || found.engines.includes(scope.engine));
    const runnable = (found: FoundHook): RunnableHook & { matcher?: string } => ({
      id: found.id,
      source: found.source,
      command: found.command as string,
      timeoutSec: found.timeoutSec ?? HOOK_TIMEOUT_DEFAULT_SEC,
      ...(found.onFailure !== undefined && { onFailure: found.onFailure }),
      ...(found.matcher !== undefined && { matcher: found.matcher }),
      ...(found.pluginDir !== undefined && {
        env: { CLAUDE_PLUGIN_ROOT: found.pluginDir, PLUGIN_ROOT: found.pluginDir },
      }),
    });
    if (scope.workspaceId !== undefined) {
      const trusted = this.#files.get(scope.workspaceId)?.trusted ?? {};
      const scan = this.#scan(`project:${scope.cwd}`, () =>
        scanProjectHooks(scope.cwd, this.#platform),
      );
      for (const found of scan.hooks) {
        if (runs(found) && trustStatus(found, trusted) === 'enabled') out.push(runnable(found));
      }
    }
    const disabled = this.#files.get('global')?.disabled ?? {};
    for (const found of this.#globalFound([])) {
      if (runs(found) && toggleStatus(found, disabled) === 'enabled') out.push(runnable(found));
    }
    return out;
  }

  /** 这个事件有没有可能要跑的处理器（挂接点用，不看 matcher）。返回它们的时限之和（秒），没有时 0。 */
  pending(scope: HookScope, event: string): number {
    return this.#effective(scope, event).reduce(
      (sum, hook) => sum + (hook.timeoutSec ?? HOOK_TIMEOUT_DEFAULT_SEC),
      0,
    );
  }

  /** 这次调用要跑的处理器。 */
  handlers(scope: HookScope, event: string, input: Record<string, unknown>): RunnableHook[] {
    return this.#effective(scope, event)
      .filter((hook) => matcherMatches(hook.matcher, event, input))
      .map(({ matcher: _matcher, ...hook }) => hook);
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  #globalFound(warnings: string[]): FoundHook[] {
    const found: FoundHook[] = [];
    const user = this.#options.claudeUserSettings?.();
    if (user !== undefined) {
      const scan = this.#scan(`claude:${user.path}`, () =>
        scanClaudeUserHooks(user.path, user.label, this.#platform),
      );
      found.push(...scan.hooks);
      warnings.push(...scan.warnings);
    }
    for (const plugin of this.#options.plugins?.() ?? []) {
      if (!plugin.enabled) continue;
      const scan = this.#scan(`plugin:${plugin.id}:${plugin.path}`, () =>
        scanPluginHooks(plugin, this.#platform),
      );
      found.push(...scan.hooks);
      warnings.push(...scan.warnings);
    }
    return found;
  }

  #scan(
    key: string,
    read: () => { hooks: FoundHook[]; warnings: string[] },
  ): { hooks: FoundHook[]; warnings: string[] } {
    const now = Date.now();
    const cached = this.#scans.get(key);
    if (cached !== undefined && now - cached.at < (this.#options.scanTtlMs ?? SCAN_TTL_MS)) {
      return cached;
    }
    let result: { hooks: FoundHook[]; warnings: string[] };
    try {
      result = read();
    } catch (error) {
      result = { hooks: [], warnings: [`${key}: ${(error as Error).message}`] };
    }
    const entry = { at: now, ...result };
    this.#scans.set(key, entry);
    if (this.#scans.size > 200) this.#scans.delete(this.#scans.keys().next().value as string);
    return entry;
  }

  #scopeOf(hookId: string): Scope | undefined {
    for (const [scope, file] of this.#files) {
      if (file.hooks.some((hook) => hook.id === hookId)) return scope;
    }
    return undefined;
  }

  #changeOwn(hookId: string, edit: (stored: StoredHook) => StoredHook): Promise<Hook> {
    const scope = this.#scopeOf(hookId);
    if (scope === undefined) return Promise.reject(notFound(hookId));
    return this.#mutate(scope, (file) => {
      const index = file.hooks.findIndex((hook) => hook.id === hookId);
      const current = file.hooks[index];
      if (current === undefined) throw notFound(hookId);
      const next = { ...edit(current), updatedAt: this.#now().toISOString() };
      file.hooks[index] = next;
      return toHook(scope, next);
    });
  }

  #mutate<T>(scope: Scope, edit: (file: ScopeFile) => T): Promise<T> {
    const task = async (): Promise<T> => {
      const next = structuredClone(this.#files.get(scope) ?? emptyFile());
      const result = edit(next);
      await this.#write(scope, next);
      this.#files.set(scope, next);
      this.#emit(scope === 'global' ? undefined : scope);
      return result;
    };
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #emit(workspaceId: WorkspaceId | undefined): void {
    for (const listener of this.#listeners) {
      try {
        listener(workspaceId === undefined ? {} : { workspaceId });
      } catch (error) {
        this.#options.onWarning?.('hook listener failed', { error: (error as Error).message });
      }
    }
  }

  async #write(scope: Scope, file: ScopeFile): Promise<void> {
    const dir = this.#options.dir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${scope}.json`);
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, ...file }, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  #loadAll(): void {
    let names: string[];
    try {
      mkdirSync(this.#options.dir, { recursive: true, mode: 0o700 });
      names = readdirSync(this.#options.dir);
    } catch (error) {
      this.#options.onWarning?.('failed to read the hooks folder', {
        error: (error as Error).message,
      });
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const scope = name.slice(0, -'.json'.length);
      if (scope !== 'global' && !WorkspaceIdSchema.safeParse(scope).success) continue;
      this.#files.set(scope as Scope, this.#parse(scope, join(this.#options.dir, name)));
    }
  }

  #parse(scope: string, path: string): ScopeFile {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.#options.onWarning?.('hooks file is unreadable, treating it as empty', { scope });
      return emptyFile();
    }
    const file = raw as Record<string, unknown> | null;
    if (file === null || typeof file !== 'object' || file.version !== 1) {
      this.#options.onWarning?.('hooks file has an unknown format, treating it as empty', {
        scope,
      });
      return emptyFile();
    }
    const hooks: StoredHook[] = [];
    for (const item of Array.isArray(file.hooks) ? file.hooks : []) {
      const hook = item as Partial<StoredHook> | null;
      if (
        hook === null ||
        typeof hook !== 'object' ||
        typeof hook.id !== 'string' ||
        !HookEventSchema.safeParse(hook.event).success ||
        !HookCommandHandlerSchema.safeParse(hook.handler).success ||
        typeof hook.enabled !== 'boolean' ||
        typeof hook.createdAt !== 'string' ||
        typeof hook.updatedAt !== 'string'
      ) {
        this.#options.onWarning?.('dropped a malformed hook', { scope });
        continue;
      }
      hooks.push(hook as StoredHook);
    }
    const trusted: ScopeFile['trusted'] = {};
    if (file.trusted !== null && typeof file.trusted === 'object') {
      for (const [id, value] of Object.entries(file.trusted as Record<string, unknown>)) {
        const entry = value as { hash?: unknown; at?: unknown } | null;
        if (typeof entry?.hash === 'string' && typeof entry.at === 'string') {
          trusted[id] = { hash: entry.hash, at: entry.at };
        }
      }
    }
    const disabled: ScopeFile['disabled'] = {};
    if (file.disabled !== null && typeof file.disabled === 'object') {
      for (const [id, at] of Object.entries(file.disabled as Record<string, unknown>)) {
        if (typeof at === 'string') disabled[id] = at;
      }
    }
    return { hooks, trusted, disabled };
  }
}

function notFound(hookId: string): HostError {
  return invalid(['hookId'], `hook ${hookId} not found`);
}

function toHook(scope: Scope, stored: StoredHook): Hook {
  return {
    id: stored.id,
    source: 'wevir',
    ...(scope !== 'global' && { workspaceId: scope }),
    ...(stored.name !== undefined && { name: stored.name }),
    event: stored.event,
    ...(stored.matcher !== undefined && { matcher: stored.matcher }),
    handler: 'command',
    command: stored.handler.command,
    timeoutSec: stored.handler.timeout ?? HOOK_TIMEOUT_DEFAULT_SEC,
    ...(stored.handler.onFailure !== undefined && { onFailure: stored.handler.onFailure }),
    engines: ['*'],
    status: stored.enabled ? 'enabled' : 'disabled',
  };
}

function trustStatus(
  found: FoundHook,
  trusted: Record<string, { hash: string; at: string }>,
): 'enabled' | 'disabled' | 'changed' | 'unsupported' {
  if (found.handler !== 'command' || found.command === undefined) return 'unsupported';
  const record = trusted[found.id];
  if (record === undefined) return 'disabled';
  return record.hash === found.hash ? 'enabled' : 'changed';
}

function toggleStatus(
  found: FoundHook,
  disabled: Record<string, string>,
): 'enabled' | 'disabled' | 'unsupported' {
  if (found.handler !== 'command' || found.command === undefined) return 'unsupported';
  return disabled[found.id] === undefined ? 'enabled' : 'disabled';
}

function foundHook(found: FoundHook, status: string, enabledAt?: string): Hook {
  return {
    id: found.id,
    source: found.source,
    ...(found.file !== undefined && { file: found.file }),
    ...(found.pluginId !== undefined && { pluginId: found.pluginId }),
    event: found.event,
    ...(found.matcher !== undefined && { matcher: found.matcher }),
    handler: found.handler,
    ...(found.command !== undefined && { command: found.command }),
    ...(found.timeoutSec !== undefined && { timeoutSec: found.timeoutSec }),
    ...(found.onFailure !== undefined && { onFailure: found.onFailure }),
    engines: found.engines,
    status,
    hash: found.hash,
    ...(found.unhashedFiles && { unhashedFiles: true as const }),
    ...(enabledAt !== undefined && { enabledAt }),
  };
}

function codexHook(repo: RepoHook): Hook {
  return {
    id: repo.id,
    source: 'codex',
    file: repo.file,
    event: repo.event,
    ...(repo.matcher !== undefined && { matcher: repo.matcher }),
    handler: repo.handler,
    ...(repo.command !== undefined && { command: repo.command }),
    ...(repo.timeoutSec !== undefined && { timeoutSec: repo.timeoutSec }),
    engines: ['codex'],
    status: repo.status,
    hash: repo.hash,
    ...(repo.enabledAt !== undefined && { enabledAt: repo.enabledAt }),
  };
}
