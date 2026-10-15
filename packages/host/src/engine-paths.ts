import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { type AccountKind, AccountKindSchema } from '@wevir/protocol';

/**
 * 用户给订阅来源的引擎指定的可执行文件（0.19.0，`account.setPath`），存在数据目录的 `engines.json`：
 * `{ "paths": { "claude": "/opt/homebrew/bin/claude" } }`。文件有问题时当作没有指定（只告警）。写法同 `settings.json`：
 * 0600 的临时文件再 rename。不给路径时只在内存里（测试）。
 */
export class EnginePathStore {
  readonly #path: string | undefined;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  #paths = new Map<AccountKind, string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    options: {
      path?: string;
      onWarning?: (message: string, fields?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.#path = options.path;
    this.#onWarning = options.onWarning ?? (() => {});
  }

  async load(): Promise<ReadonlyMap<AccountKind, string>> {
    const path = this.#path;
    if (path === undefined) return this.all();
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onWarning('engines.json is unreadable; ignoring it', { path, error });
      }
      return this.all();
    }
    const paths =
      raw !== null && typeof raw === 'object' ? (raw as { paths?: unknown }).paths : undefined;
    if (paths !== null && typeof paths === 'object') {
      for (const [kind, value] of Object.entries(paths)) {
        const parsed = AccountKindSchema.safeParse(kind);
        if (parsed.success && typeof value === 'string' && value !== '') {
          this.#paths.set(parsed.data, value);
        } else {
          this.#onWarning('ignoring an invalid entry in engines.json', { path, kind });
        }
      }
    }
    return this.all();
  }

  all(): ReadonlyMap<AccountKind, string> {
    return new Map(this.#paths);
  }

  /** 记下或清掉（`null`）一类的路径。 */
  set(kind: AccountKind, path: string | null): Promise<void> {
    const result = this.#queue.then(async () => {
      const next = new Map(this.#paths);
      if (path === null) next.delete(kind);
      else next.set(kind, path);
      await this.#save(next);
      this.#paths = next;
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  async #save(paths: ReadonlyMap<AccountKind, string>): Promise<void> {
    const path = this.#path;
    if (path === undefined) return;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ paths: Object.fromEntries(paths) }, null, 2)}\n`);
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
}
