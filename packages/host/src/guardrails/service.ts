// 护栏（0.86.0，domain-model §3.40）：规则存在 `<数据目录>/guardrails/<global|工作区 ID>.json`（0600，写临时文件再 rename，照
// `checks/`），不写回仓库；检查程序（`@wevir/runtime-adapter/guardrail`）每次被 hook 调用时直接读这些文件，所以增删改与开关立即生效。
// 文件里另记仓库 hooks 的启用（启用时的内容散列）与每条规则的命中次数。整个目录在启动时读进内存：建会话时要同步给出 hooks。
// 只有方言是 `codex` 的引擎挂得上（`hookDialect`）；别的引擎的会话不受影响。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Guardrail,
  GuardrailId,
  GuardrailRule,
  MethodParams,
  NotificationParams,
  RepoHook,
  WorkspaceId,
} from '@wevir/protocol';
import {
  GUARDRAILS_MAX_PER_SCOPE,
  GuardrailRuleSchema,
  GuardrailSchema,
  WorkspaceIdSchema,
} from '@wevir/protocol';
import type { EngineHook } from '@wevir/runtime-adapter';
import {
  type GuardrailChecker,
  guardrailHooks,
  repoHookCommand,
  writeGuardrailChecker,
} from '@wevir/runtime-adapter/guardrail';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import { type FoundRepoHook, scanRepoHooks } from './repo-hooks.js';

type Scope = WorkspaceId | 'global';

/** 规则在文件里的样子：协议的 `Guardrail` 去掉 `workspaceId`（由文件名定）。 */
type StoredGuardrail = Omit<Guardrail, 'workspaceId'>;

interface ScopeFile {
  /** 规则或仓库 hooks 的启用每变一次加一（命中计数不算）。 */
  revision: number;
  guardrails: StoredGuardrail[];
  /** 启用了的仓库 hooks：ID → 启用时的内容散列。 */
  repoHooks: Record<string, { hash: string; enabledAt: string }>;
}

type ChangeListener = (change: NotificationParams<'guardrail.changed'>) => void;

export interface GuardrailServiceOptions {
  checker: GuardrailChecker;
  /** 工作区的根目录；工作区不存在或已移除时 undefined。 */
  workspaceRoot: (workspaceId: WorkspaceId) => string | undefined;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

/** 会话要挂的 hooks（`SessionConfig.hooks` / `disabledHooks`）。 */
export interface SessionHooks {
  hooks: EngineHook[];
  disabledHooks: string[];
}

function invalid(path: Array<string | number>, message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function notFound(guardrailId: string): HostError {
  return new HostError('GUARDRAIL_NOT_FOUND', `guardrail ${guardrailId} not found`);
}

/** 校验协议的 schema 管不到的：正则写得对不对。 */
function checkRule(rule: GuardrailRule): GuardrailRule {
  if (rule.kind === 'forbidden_command' && rule.match === 'regex') {
    try {
      new RegExp(rule.pattern);
    } catch (error) {
      throw invalid(['rule', 'pattern'], `invalid regular expression: ${(error as Error).message}`);
    }
  }
  return rule;
}

const emptyFile = (): ScopeFile => ({ revision: 0, guardrails: [], repoHooks: {} });

export class GuardrailService {
  readonly #options: GuardrailServiceOptions;
  readonly #now: () => Date;
  readonly #files = new Map<Scope, ScopeFile>();
  readonly #listeners = new Set<ChangeListener>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: GuardrailServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#loadAll();
    // 检查程序每次启动都重写：随 Wevir 升级。写不了时规则照存，会话挂上的 hook 跑不起来时 Codex 放行。
    try {
      writeGuardrailChecker(options.checker);
    } catch (error) {
      this.#warn('failed to write the guardrail checker', { error: (error as Error).message });
    }
  }

  get dir(): string {
    return this.#options.checker.dir;
  }

  /** 给了工作区列全局的与它的，否则只列全局的；全局的在前，各自按创建先后。 */
  list(workspaceId?: WorkspaceId): Guardrail[] {
    const scopes: Scope[] = workspaceId === undefined ? ['global'] : ['global', workspaceId];
    return scopes.flatMap((scope) =>
      (this.#files.get(scope)?.guardrails ?? []).map((g) => this.#toGuardrail(scope, g)),
    );
  }

  async add(params: MethodParams<'guardrail.add'>): Promise<Guardrail> {
    const scope: Scope = params.workspaceId ?? 'global';
    const rule = checkRule(params.rule);
    return this.#mutate(scope, (file) => {
      if (file.guardrails.length >= GUARDRAILS_MAX_PER_SCOPE) {
        throw invalid(['rule'], `a scope can have at most ${GUARDRAILS_MAX_PER_SCOPE} guardrails`);
      }
      const now = this.#now().toISOString();
      const name = params.name?.trim();
      const guardrail: StoredGuardrail = {
        id: newId('grd') as GuardrailId,
        ...(name !== undefined && name !== '' && { name }),
        rule,
        enabled: params.enabled ?? true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        hits: 0,
      };
      file.guardrails.push(guardrail);
      return this.#toGuardrail(scope, guardrail);
    });
  }

  async update(params: MethodParams<'guardrail.update'>): Promise<Guardrail> {
    const rule = params.rule === undefined ? undefined : checkRule(params.rule);
    return this.#change(params.guardrailId, (guardrail) => {
      const name = params.name === null ? undefined : (params.name?.trim() ?? guardrail.name);
      const { name: _old, ...rest } = guardrail;
      return {
        ...rest,
        ...(name !== undefined && name !== '' && { name }),
        rule: rule ?? guardrail.rule,
      };
    });
  }

  setEnabled(guardrailId: GuardrailId, enabled: boolean): Promise<Guardrail> {
    return this.#change(guardrailId, (guardrail) => ({ ...guardrail, enabled }));
  }

  delete(guardrailId: GuardrailId): Promise<void> {
    const scope = this.#scopeOf(guardrailId);
    if (scope === undefined) return Promise.reject(notFound(guardrailId));
    return this.#mutate(scope, (file) => {
      const index = file.guardrails.findIndex((g) => g.id === guardrailId);
      if (index === -1) throw notFound(guardrailId);
      file.guardrails.splice(index, 1);
    });
  }

  /** 一次拦截：命中计数加一。规则已删时不记。 */
  recordHit(guardrailId: string, at: Date = this.#now()): Promise<void> {
    const scope = this.#scopeOf(guardrailId);
    if (scope === undefined) return Promise.resolve();
    return this.#mutate(
      scope,
      (file) => {
        const guardrail = file.guardrails.find((g) => g.id === guardrailId);
        if (guardrail === undefined) return;
        guardrail.hits += 1;
        guardrail.lastHitAt = at.toISOString();
      },
      { bump: false },
    ).catch((error: unknown) => {
      this.#warn('failed to record a guardrail hit', { guardrailId, error: errorText(error) });
    });
  }

  /** 工作区里检测到的仓库 hooks 与启用状态。 */
  repoHooks(workspaceId: WorkspaceId): { hooks: RepoHook[]; warnings: string[] } {
    const root = this.#root(workspaceId);
    const scan = scanRepoHooks(root, this.#options.platform);
    const enabled = this.#files.get(workspaceId)?.repoHooks ?? {};
    return { hooks: scan.hooks.map((hook) => toRepoHook(hook, enabled)), warnings: scan.warnings };
  }

  async setRepoHookEnabled(
    workspaceId: WorkspaceId,
    hookId: string,
    enabled: boolean,
  ): Promise<RepoHook> {
    const root = this.#root(workspaceId);
    const found = scanRepoHooks(root, this.#options.platform).hooks.find((h) => h.id === hookId);
    if (found === undefined) throw invalid(['hookId'], `repository hook ${hookId} not found`);
    if (enabled && (found.handler !== 'command' || found.command === undefined)) {
      throw invalid(['hookId'], 'only command hooks can be enabled');
    }
    return this.#mutate(workspaceId, (file) => {
      if (enabled) {
        file.repoHooks[hookId] = { hash: found.hash, enabledAt: this.#now().toISOString() };
      } else {
        delete file.repoHooks[hookId];
      }
      return toRepoHook(found, file.repoHooks);
    });
  }

  /**
   * 会话要挂的 hooks：对它有效的规则用到的检查程序 hook，加上用户启用、内容没变的仓库 hooks（经检查程序转一手）；仓库里其余的 hooks
   * 逐个停用。找仓库 hooks 出错只记告警。
   */
  sessionHooks(workspaceId: WorkspaceId | undefined, cwd: string): SessionHooks {
    const rules = this.list(workspaceId)
      .filter((g) => g.enabled)
      .map((g) => ({
        kind: g.rule.kind,
        ...('timeoutSec' in g.rule &&
          g.rule.timeoutSec !== undefined && {
            timeoutSec: g.rule.timeoutSec,
          }),
      }));
    const { checker, platform } = this.#options;
    const hooks = guardrailHooks(checker, workspaceId, rules, platform);
    const disabledHooks: string[] = [];
    try {
      const enabled =
        workspaceId === undefined ? {} : (this.#files.get(workspaceId)?.repoHooks ?? {});
      for (const found of scanRepoHooks(cwd, platform).hooks) {
        disabledHooks.push(found.codexKey);
        if (enabled[found.id]?.hash !== found.hash || found.handler !== 'command') continue;
        if (found.command === undefined) continue;
        hooks.push({
          event: found.event,
          ...(found.matcher !== undefined && { matcher: found.matcher }),
          command: repoHookCommand(checker, found.command, platform),
          ...(found.timeoutSec !== undefined && { timeoutSec: found.timeoutSec }),
          ...(found.statusMessage !== undefined && { statusMessage: found.statusMessage }),
        });
      }
    } catch (error) {
      this.#warn('failed to read repository hooks', { cwd, error: errorText(error) });
    }
    return { hooks, disabledHooks };
  }

  /** 收 `guardrail.changed`；返回退订函数。 */
  watch(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #root(workspaceId: WorkspaceId): string {
    const root = this.#options.workspaceRoot(workspaceId);
    if (root === undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    return root;
  }

  #scopeOf(guardrailId: string): Scope | undefined {
    for (const [scope, file] of this.#files) {
      if (file.guardrails.some((g) => g.id === guardrailId)) return scope;
    }
    return undefined;
  }

  /** 改一条规则：版本加一、更新时间。 */
  #change(
    guardrailId: GuardrailId,
    edit: (guardrail: StoredGuardrail) => StoredGuardrail,
  ): Promise<Guardrail> {
    const scope = this.#scopeOf(guardrailId);
    if (scope === undefined) return Promise.reject(notFound(guardrailId));
    return this.#mutate(scope, (file) => {
      const index = file.guardrails.findIndex((g) => g.id === guardrailId);
      const current = file.guardrails[index];
      if (current === undefined) throw notFound(guardrailId);
      const next: StoredGuardrail = {
        ...edit(current),
        revision: current.revision + 1,
        updatedAt: this.#now().toISOString(),
      };
      file.guardrails[index] = next;
      return this.#toGuardrail(scope, next);
    });
  }

  #toGuardrail(scope: Scope, guardrail: StoredGuardrail): Guardrail {
    return structuredClone(scope === 'global' ? guardrail : { ...guardrail, workspaceId: scope });
  }

  /** 排队改一个范围的文件：在副本上改，写好再换进内存，然后通知。 */
  #mutate<T>(
    scope: Scope,
    edit: (file: ScopeFile) => T,
    { bump = true }: { bump?: boolean } = {},
  ): Promise<T> {
    const task = async (): Promise<T> => {
      const next = structuredClone(this.#files.get(scope) ?? emptyFile());
      const result = edit(next);
      if (bump) next.revision += 1;
      await this.#write(scope, next);
      this.#files.set(scope, next);
      this.#emit(scope);
      return result;
    };
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #emit(scope: Scope): void {
    const change = scope === 'global' ? {} : { workspaceId: scope };
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#warn('guardrail listener failed', { error: errorText(error) });
      }
    }
  }

  async #write(scope: Scope, file: ScopeFile): Promise<void> {
    const dir = this.dir;
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

  /** 启动时读整个目录；读坏了的文件按空的处理并告警（下次改动时覆盖）。 */
  #loadAll(): void {
    let names: string[];
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      names = readdirSync(this.dir);
    } catch (error) {
      this.#warn('failed to read the guardrails folder', { error: errorText(error) });
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const scope = name.slice(0, -'.json'.length);
      if (scope !== 'global' && !WorkspaceIdSchema.safeParse(scope).success) continue;
      this.#files.set(scope as Scope, this.#parse(scope as Scope, join(this.dir, name)));
    }
  }

  #parse(scope: Scope, path: string): ScopeFile {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.#warn('guardrails file is unreadable, treating it as empty', { scope });
      return emptyFile();
    }
    const file = raw as Partial<Record<keyof ScopeFile | 'version', unknown>> | null;
    if (file === null || typeof file !== 'object' || file.version !== 1) {
      this.#warn('guardrails file has an unknown format, treating it as empty', { scope });
      return emptyFile();
    }
    const guardrails: StoredGuardrail[] = [];
    for (const item of Array.isArray(file.guardrails) ? file.guardrails : []) {
      const parsed = GuardrailSchema.omit({ workspaceId: true }).safeParse(item);
      if (parsed.success && GuardrailRuleSchema.safeParse(parsed.data.rule).success) {
        guardrails.push(parsed.data);
      } else {
        this.#warn('dropped a malformed guardrail', { scope });
      }
    }
    const repoHooks: ScopeFile['repoHooks'] = {};
    if (file.repoHooks !== null && typeof file.repoHooks === 'object') {
      for (const [id, value] of Object.entries(file.repoHooks as Record<string, unknown>)) {
        const entry = value as { hash?: unknown; enabledAt?: unknown } | null;
        if (typeof entry?.hash === 'string' && typeof entry.enabledAt === 'string') {
          repoHooks[id] = { hash: entry.hash, enabledAt: entry.enabledAt };
        }
      }
    }
    const revision =
      typeof file.revision === 'number' && Number.isInteger(file.revision) ? file.revision : 0;
    return { revision, guardrails, repoHooks };
  }

  #warn(message: string, fields?: Record<string, unknown>): void {
    this.#options.onWarning?.(message, fields);
  }
}

function toRepoHook(
  found: FoundRepoHook,
  enabled: Record<string, { hash: string; enabledAt: string }>,
): RepoHook {
  const record = enabled[found.id];
  const status =
    found.handler !== 'command' || found.command === undefined
      ? 'unsupported'
      : record === undefined
        ? 'disabled'
        : record.hash === found.hash
          ? 'enabled'
          : 'changed';
  return {
    id: found.id,
    file: found.file,
    event: found.event,
    ...(found.matcher !== undefined && { matcher: found.matcher }),
    handler: found.handler,
    ...(found.command !== undefined && { command: found.command }),
    ...(found.timeoutSec !== undefined && { timeoutSec: found.timeoutSec }),
    hash: found.hash,
    status,
    ...(record !== undefined && { enabledAt: record.enabledAt }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
