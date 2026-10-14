import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { DEFAULT_HOST_SETTINGS, type HostSettings, HostSettingsSchema } from '@wevir/protocol';

/**
 * Host 设置（R11，domain-model §3.7）：整个 Host 共用、CLI 与桌面一致的偏好，存在数据目录的 `settings.json`。所有字段
 * 都有默认值；文件不存在、缺字段或某个字段不合法时用默认值（只告警，不阻止 Host 启动）。`update` 只改给出的字段，
 * 以 0600 写临时文件再 rename；值变了才通知 `watch` 的监听者（`settings.updated`）。不给路径时只在内存里（测试）。
 */
export class HostSettingsStore {
  readonly #path: string | undefined;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #listeners = new Set<(settings: HostSettings) => void>();
  #settings: HostSettings = { ...DEFAULT_HOST_SETTINGS };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    options: {
      path?: string;
      onWarning?: (message: string, fields?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.#path = options.path;
    this.#onWarning =
      options.onWarning ?? ((message, fields) => console.warn('[wevir-host]', message, fields));
  }

  /** 读 `settings.json`。启动时调用一次；文件有问题时用默认值并告警。 */
  async load(): Promise<HostSettings> {
    const path = this.#path;
    if (path === undefined) return this.get();
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.get();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#onWarning('settings.json is not valid JSON; using defaults', { path });
      return this.get();
    }
    const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const settings: Record<string, unknown> = { ...DEFAULT_HOST_SETTINGS };
    for (const key of Object.keys(HostSettingsSchema.shape) as (keyof HostSettings)[]) {
      if (!(key in record)) continue;
      const field = HostSettingsSchema.shape[key].safeParse(record[key]);
      if (field.success) settings[key] = field.data;
      else this.#onWarning('ignoring an invalid value in settings.json', { path, key });
    }
    this.#settings = HostSettingsSchema.parse(settings);
    return this.get();
  }

  get(): HostSettings {
    return { ...this.#settings };
  }

  /** 改给出的字段，写文件，值变了时通知监听者。返回改后的全部设置。 */
  update(patch: Partial<HostSettings>): Promise<HostSettings> {
    const result = this.#queue.then(async () => {
      const next = HostSettingsSchema.parse({ ...this.#settings, ...definedOnly(patch) });
      const changed = (Object.keys(next) as (keyof HostSettings)[]).some(
        (key) => next[key] !== this.#settings[key],
      );
      if (!changed) return this.get();
      await this.#save(next);
      this.#settings = next;
      for (const listener of this.#listeners) listener(this.get());
      return this.get();
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  /** 设置变了时调用 `listener`（带全部设置）。返回退订函数。 */
  watch(listener: (settings: HostSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #save(settings: HostSettings): Promise<void> {
    const path = this.#path;
    if (path === undefined) return;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
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

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
