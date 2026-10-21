// 工作区的运行配置（0.84.0，ADR-0013 决策 1）：每个工作区一份 `<数据目录>/previews/<工作区 ID>.json`（0600，写临时文件再 rename），
// 不写回仓库，同检查配置（verification/checks-store.ts）。读坏了的文件按空配置处理并告警。同一工作区的读写排队执行。

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreviewConfig, PreviewInput, WorkspaceId } from '@wevir/protocol';
import { PREVIEWS_MAX_PER_WORKSPACE, PreviewConfigSchema } from '@wevir/protocol';
import { HostError } from '../errors.js';
import { normalizeRelative } from '../verification/checks-store.js';

function invalid(path: Array<string | number>, message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

export class PreviewStore {
  readonly #dir: string | undefined;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #cache = new Map<WorkspaceId, PreviewConfig[]>();
  readonly #tails = new Map<WorkspaceId, Promise<unknown>>();

  /** `dir` 省略时只在内存里（测试）。 */
  constructor(options: {
    dir?: string;
    onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  }) {
    this.#dir = options.dir;
    this.#onWarning = options.onWarning ?? (() => {});
  }

  list(workspaceId: WorkspaceId): Promise<PreviewConfig[]> {
    return this.#serial(workspaceId, async () => structuredClone(await this.#load(workspaceId)));
  }

  /**
   * 按 `name` 新建或替换一项；`previous` 是改名前的名字（那一项换成这一项，位置不变）。新名字与另一项重名时拒绝。返回全部配置。
   */
  save(
    workspaceId: WorkspaceId,
    input: PreviewInput,
    options: { previous?: string; addedBy: PreviewConfig['addedBy'] },
  ): Promise<PreviewConfig[]> {
    return this.#serial(workspaceId, async () => {
      const current = await this.#load(workspaceId);
      const cwd = normalizeRelative(input.cwd ?? '');
      if (cwd === undefined) {
        throw invalid(['config', 'cwd'], 'cwd must be a relative path inside the session folder');
      }
      const name = input.name.trim();
      const replaced = options.previous ?? name;
      const index = current.findIndex((config) => config.name === replaced);
      if (options.previous !== undefined && index === -1) {
        throw invalid(['previous'], `no run configuration named ${options.previous}`);
      }
      if (name !== replaced && current.some((config) => config.name === name)) {
        throw invalid(['config', 'name'], `a run configuration named ${name} already exists`);
      }
      if (index === -1 && current.length >= PREVIEWS_MAX_PER_WORKSPACE) {
        throw invalid(
          ['config'],
          `a project can have at most ${PREVIEWS_MAX_PER_WORKSPACE} run configurations`,
        );
      }
      const before = index === -1 ? undefined : current[index];
      const now = new Date().toISOString();
      const config = PreviewConfigSchema.parse({
        name,
        command: input.command.trim(),
        cwd,
        ...(input.port !== undefined && { port: input.port }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.env !== undefined && Object.keys(input.env).length > 0 && { env: input.env }),
        addedBy: options.addedBy,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      });
      const next = [...current];
      if (index === -1) next.push(config);
      else next[index] = config;
      await this.#store(workspaceId, next);
      return structuredClone(next);
    });
  }

  /** 删掉一项；没有这一项时原样返回。 */
  remove(workspaceId: WorkspaceId, name: string): Promise<PreviewConfig[]> {
    return this.#serial(workspaceId, async () => {
      const current = await this.#load(workspaceId);
      const next = current.filter((config) => config.name !== name);
      if (next.length !== current.length) await this.#store(workspaceId, next);
      return structuredClone(next);
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

  async #load(workspaceId: WorkspaceId): Promise<PreviewConfig[]> {
    const cached = this.#cache.get(workspaceId);
    if (cached) return cached;
    let loaded: PreviewConfig[] = [];
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

  #parse(workspaceId: WorkspaceId, text: string): PreviewConfig[] {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#onWarning('运行配置读不出来，按空配置处理', { workspaceId });
      return [];
    }
    const file = raw as { version?: unknown; configs?: unknown } | null;
    if (
      file === null ||
      typeof file !== 'object' ||
      file.version !== 1 ||
      !Array.isArray(file.configs)
    ) {
      this.#onWarning('运行配置的格式不对，按空配置处理', { workspaceId });
      return [];
    }
    const configs: PreviewConfig[] = [];
    for (const item of file.configs as unknown[]) {
      const parsed = PreviewConfigSchema.safeParse(item);
      if (parsed.success && !configs.some((config) => config.name === parsed.data.name)) {
        configs.push(parsed.data);
      } else this.#onWarning('丢掉一项格式不对的运行配置', { workspaceId });
    }
    return configs;
  }

  async #store(workspaceId: WorkspaceId, next: PreviewConfig[]): Promise<void> {
    if (this.#dir !== undefined) {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      const path = this.#file(workspaceId);
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify({ version: 1, configs: next }, null, 2)}\n`);
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
