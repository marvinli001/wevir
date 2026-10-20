// 工作区的检查配置（0.65.0，ADR-0008 决策 2）：每个工作区一份 `<数据目录>/checks/<工作区 ID>.json`（0600，写临时文件再 rename），
// 不写回仓库。读坏了的文件按空配置处理并告警，不让一份坏文件挡住会话。同一工作区的读写排队执行。

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import type {
  CheckDefinition,
  CheckId,
  CheckInput,
  CheckSource,
  RepairSettings,
  WorkspaceId,
} from '@wevir/protocol';
import {
  CHECK_TIMEOUT_DEFAULT_MS,
  CHECKS_MAX_PER_WORKSPACE,
  CheckDefinitionSchema,
  DEFAULT_REPAIR_SETTINGS,
  RepairSettingsSchema,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';

export interface WorkspaceChecks {
  checks: CheckDefinition[];
  repair: RepairSettings;
}

/** 相对路径规整成 `/` 分隔、没有 `./` 与结尾的 `/`；绝对路径、出界（`..`）返回 undefined。空字符串是目录本身。 */
export function normalizeRelative(path: string): string | undefined {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (trimmed === '' || trimmed === '.' || trimmed === './') return '';
  if (isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) return undefined;
  const normalized = posix.normalize(trimmed).replace(/\/+$/, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function invalid(path: Array<string | number>, message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

export class ChecksStore {
  readonly #dir: string | undefined;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #cache = new Map<WorkspaceId, WorkspaceChecks>();
  readonly #tails = new Map<WorkspaceId, Promise<unknown>>();

  /** `dir` 省略时只在内存里（测试）。 */
  constructor(options: {
    dir?: string;
    onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  }) {
    this.#dir = options.dir;
    this.#onWarning = options.onWarning ?? (() => {});
  }

  list(workspaceId: WorkspaceId): Promise<WorkspaceChecks> {
    return this.#serial(workspaceId, async () => structuredClone(await this.#load(workspaceId)));
  }

  /**
   * 保存一项检查（即用户认可这条命令）：带 `id` 时改那一项、版本加一，否则新建。`scriptHash` 是来源为脚本时调用方读出的正文散列。
   */
  save(
    workspaceId: WorkspaceId,
    input: CheckInput,
    resolved: { scriptHash?: string } = {},
  ): Promise<CheckDefinition> {
    return this.#serial(workspaceId, async () => {
      const current = await this.#load(workspaceId);
      const cwd = normalizeRelative(input.cwd ?? '');
      if (cwd === undefined) {
        throw invalid(['check', 'cwd'], 'cwd must be a relative path inside the session folder');
      }
      const paths = input.paths?.map((path, index) => {
        const glob = /[*?[]/.test(path);
        const normalized = glob
          ? path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
          : normalizeRelative(path);
        if (
          normalized === undefined ||
          normalized === '' ||
          normalized.startsWith('/') ||
          normalized.includes('../')
        ) {
          throw invalid(['check', 'paths', index], 'paths must be relative to the session folder');
        }
        return glob ? normalized : `${normalized}${path.trim().endsWith('/') ? '/' : ''}`;
      });
      const source = sourceOf(input, resolved);
      const now = new Date().toISOString();
      const index =
        input.id === undefined ? -1 : current.checks.findIndex((c) => c.id === input.id);
      if (input.id !== undefined && index === -1) {
        throw new HostError('INVALID_PARAMS', `check ${input.id} not found`, {
          issues: [{ path: ['check', 'id'], message: 'not found' }],
        });
      }
      if (index === -1 && current.checks.length >= CHECKS_MAX_PER_WORKSPACE) {
        throw invalid(['check'], `a project can have at most ${CHECKS_MAX_PER_WORKSPACE} checks`);
      }
      const previous = index === -1 ? undefined : current.checks[index];
      const check: CheckDefinition = CheckDefinitionSchema.parse({
        id: previous?.id ?? newId('chk'),
        name: input.name.trim(),
        command: input.command.trim(),
        cwd,
        timeoutMs: input.timeoutMs ?? CHECK_TIMEOUT_DEFAULT_MS,
        kind: input.kind,
        trigger: input.trigger,
        ...(paths !== undefined && paths.length > 0 && { paths }),
        ...(input.expectOutput !== undefined && { expectOutput: input.expectOutput }),
        source,
        revision: (previous?.revision ?? 0) + 1,
        approvedAt: now,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      const checks = [...current.checks];
      if (index === -1) checks.push(check);
      else checks[index] = check;
      await this.#store(workspaceId, { ...current, checks });
      return structuredClone(check);
    });
  }

  remove(workspaceId: WorkspaceId, checkId: CheckId): Promise<boolean> {
    return this.#serial(workspaceId, async () => {
      const current = await this.#load(workspaceId);
      const checks = current.checks.filter((check) => check.id !== checkId);
      if (checks.length === current.checks.length) return false;
      await this.#store(workspaceId, { ...current, checks });
      return true;
    });
  }

  setRepair(workspaceId: WorkspaceId, patch: Partial<RepairSettings>): Promise<RepairSettings> {
    return this.#serial(workspaceId, async () => {
      const current = await this.#load(workspaceId);
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      const repair = RepairSettingsSchema.parse({ ...current.repair, ...defined });
      await this.#store(workspaceId, { ...current, repair });
      return { ...repair };
    });
  }

  /** 工作区移除时：删掉它的配置。 */
  removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    return this.#serial(workspaceId, async () => {
      this.#cache.delete(workspaceId);
      if (this.#dir !== undefined) await rm(this.#file(workspaceId), { force: true });
    });
  }

  #file(workspaceId: WorkspaceId): string {
    return join(this.#dir ?? '', `${workspaceId}.json`);
  }

  async #load(workspaceId: WorkspaceId): Promise<WorkspaceChecks> {
    const cached = this.#cache.get(workspaceId);
    if (cached) return cached;
    let loaded: WorkspaceChecks = { checks: [], repair: { ...DEFAULT_REPAIR_SETTINGS } };
    if (this.#dir !== undefined) {
      const text = await readFile(this.#file(workspaceId), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (text !== undefined) loaded = this.#parse(workspaceId, text);
    }
    this.#cache.set(workspaceId, loaded);
    return loaded;
  }

  #parse(workspaceId: WorkspaceId, text: string): WorkspaceChecks {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#onWarning('检查配置读不出来，按空配置处理', { workspaceId });
      return { checks: [], repair: { ...DEFAULT_REPAIR_SETTINGS } };
    }
    const file = raw as { version?: unknown; checks?: unknown; repair?: unknown } | null;
    if (
      file === null ||
      typeof file !== 'object' ||
      file.version !== 1 ||
      !Array.isArray(file.checks)
    ) {
      this.#onWarning('检查配置的格式不对，按空配置处理', { workspaceId });
      return { checks: [], repair: { ...DEFAULT_REPAIR_SETTINGS } };
    }
    const checks: CheckDefinition[] = [];
    for (const item of file.checks as unknown[]) {
      const parsed = CheckDefinitionSchema.safeParse(item);
      if (parsed.success) checks.push(parsed.data);
      else this.#onWarning('丢掉一项格式不对的检查', { workspaceId });
    }
    const repair = RepairSettingsSchema.safeParse({
      ...DEFAULT_REPAIR_SETTINGS,
      ...(typeof file.repair === 'object' ? file.repair : {}),
    });
    return { checks, repair: repair.success ? repair.data : { ...DEFAULT_REPAIR_SETTINGS } };
  }

  async #store(workspaceId: WorkspaceId, next: WorkspaceChecks): Promise<void> {
    if (this.#dir !== undefined) {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      const path = this.#file(workspaceId);
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    }
    this.#cache.set(workspaceId, next);
  }

  #serial<T>(workspaceId: WorkspaceId, task: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(workspaceId) ?? Promise.resolve()).then(task);
    this.#tails.set(
      workspaceId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

function sourceOf(input: CheckInput, resolved: { scriptHash?: string }): CheckSource {
  const source = input.source ?? { kind: 'user' };
  if (source.kind !== 'package_script') return source;
  if (resolved.scriptHash === undefined) {
    throw invalid(['check', 'source'], `script ${source.script} not found in ${source.file}`);
  }
  const file = normalizeRelative(source.file);
  if (file === undefined || file === '') {
    throw invalid(['check', 'source', 'file'], 'file must be relative to the project folder');
  }
  return { kind: 'package_script', file, script: source.script, scriptHash: resolved.scriptHash };
}
