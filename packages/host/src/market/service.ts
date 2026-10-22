import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MARKET_FILE_MAX_BYTES,
  type MarketInstallProgress,
  type MarketMirror,
  type MarketMirrorPreference,
  MarketMirrorSchema,
  type MarketStatus,
  type MethodResult,
  type WevirMarketIndex,
  WevirMarketIndexLenientSchema,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import { member } from '../plugin-install.js';

/** 文件地址：`ref` 读索引时是 `dist`，读条目文件时是索引里的提交。 */
export type MirrorUrl = (ref: string, path: string) => string;

/** 官方市场仓库 wevir-marketplace 的三个镜像，内容由 GitHub 上的 CI 同步过去。 */
export const OFFICIAL_MIRRORS: Readonly<Record<MarketMirror, MirrorUrl>> = {
  github: (ref, path) =>
    `https://raw.githubusercontent.com/Wevir-Labs/wevir-marketplace/${ref}/${path}`,
  cnb: (ref, path) => `https://cnb.cool/wevir-labs/wevir-marketplace/-/git/raw/${ref}/${path}`,
  gitee: (ref, path) => `https://gitee.com/wevir-labs/wevir-marketplace/raw/${ref}/${path}`,
};

/** 索引签名的公钥（base64 SPKI DER），与仓库 keys/ 里的一致；轮换时先加新的，旧的留到所有镜像都换过。 */
export const OFFICIAL_PUBLIC_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAJDlKPHF7VJeydg+dI+ANGIoHDrESaGcgkwpunDC8ygo=',
];

const MIRRORS = MarketMirrorSchema.options;
/** 测速只取签名文件（不到 100 字节），看谁先完整回来。 */
const PROBE_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 20_000;
const INDEX_MAX_BYTES = 8 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 1024;
/** `market.file` 同时读镜像的个数（列表一次要几十个图标）。 */
const FILE_CONCURRENCY = 6;
/** `market.index` 不带 `refresh` 时，缓存在这么久之内直接用。 */
export const MARKET_INDEX_MAX_AGE_MS = 60 * 60 * 1000;
/** 单个条目的上限（plugin-market.md §4.3），市场仓库的 CI 按同样的数拒绝 PR。 */
const ENTRY_MAX_FILES = 200;
const ENTRY_MAX_BYTES = 8 * 1024 * 1024;
/** 下载中的进度最多这么久发一次。 */
const PROGRESS_INTERVAL_MS = 100;
/** 这些文件在条目根目录时它是插件包；都没有、只有 SKILL.md 的是 `skills/` 下的简便投稿。 */
const PACKAGE_MARKERS = [
  'wevir-plugin.json',
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
];

type IndexEntry = WevirMarketIndex['entries'][number];
type EntryFile = IndexEntry['files'][number];

/** `state.json`：自动模式测出的镜像，与缓存的索引来自哪家、何时取到。 */
interface MarketState {
  mirror?: MarketMirror;
  probedAt?: string;
  indexMirror?: MarketMirror;
  fetchedAt?: string;
}

export interface MarketServiceOptions {
  /** 缓存目录，`<数据目录>/plugins/market/official`。 */
  dir: string;
  /** 设置里的选择（`settings.marketMirror`）。 */
  preference: () => MarketMirrorPreference;
  mirrors?: Readonly<Record<MarketMirror, MirrorUrl>>;
  publicKeys?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * 官方插件市场（0.91.0，Host 功能 `plugin_market`）。不经 CDN，直接读 wevir-marketplace 仓库在 GitHub、CNB、Gitee 上的文件。
 *
 * - **选镜像。** 设置是 `auto` 时，第一次用到市场就并发请求三家的 `index.json.sig`，最先完整返回的那家记进 `state.json`，之后一直用它；
 *   用户在设置里选了某一家就用那一家。从手动改回 `auto` 时清掉记住的结果，下次重新测。
 * - **读索引。** 先读选定的镜像，失败（网络、HTTP 状态、验签、格式、序号比缓存小）时依次换另外两家。自动模式下换成功的那家记为新的选择。
 *   签名与序号在 Host 内校验，镜像只是传输通道。
 */
export class MarketService {
  readonly #options: MarketServiceOptions;
  readonly #mirrors: Readonly<Record<MarketMirror, MirrorUrl>>;
  readonly #keys: ReturnType<typeof createPublicKey>[];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #state: MarketState | undefined;
  #index: WevirMarketIndex | undefined;
  #probing: Promise<MarketMirror | undefined> | undefined;
  #refreshing: Promise<MethodResult<'market.index'>> | undefined;
  #lastPreference: MarketMirrorPreference;
  /** `market.file` 正在读的个数与排队的。 */
  #fileSlots = 0;
  readonly #fileQueue: (() => void)[] = [];
  /** 正在进行的安装，按条目 id。 */
  readonly #installs = new Map<
    string,
    { promise: Promise<unknown>; controller: AbortController }
  >();
  readonly #progressListeners = new Set<(progress: MarketInstallProgress) => void>();

  constructor(options: MarketServiceOptions) {
    this.#options = options;
    this.#mirrors = options.mirrors ?? OFFICIAL_MIRRORS;
    this.#keys = (options.publicKeys ?? OFFICIAL_PUBLIC_KEYS).map((key) =>
      createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }),
    );
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#lastPreference = options.preference();
  }

  /** 设置变了时调用：从手动改回 `auto` 时忘掉之前测出的镜像。 */
  async preferenceChanged(): Promise<void> {
    const preference = this.#options.preference();
    const previous = this.#lastPreference;
    this.#lastPreference = preference;
    if (preference !== 'auto' || previous === 'auto') return;
    const state = await this.#loadState();
    if (state.mirror === undefined) return;
    const { mirror: _, probedAt: __, ...rest } = state;
    await this.#saveState(rest);
  }

  async status(): Promise<MarketStatus> {
    const preference = this.#options.preference();
    if (preference !== 'auto') return { preference, mirror: preference };
    const mirror = (await this.#loadState()).mirror ?? (await this.#probe());
    return { preference, ...(mirror !== undefined && { mirror }) };
  }

  async index(refresh = false): Promise<MethodResult<'market.index'>> {
    const state = await this.#loadState();
    const cached = await this.#loadIndex();
    if (
      !refresh &&
      cached !== undefined &&
      state.indexMirror !== undefined &&
      state.fetchedAt !== undefined &&
      this.#now() - Date.parse(state.fetchedAt) < MARKET_INDEX_MAX_AGE_MS
    ) {
      return { index: cached, mirror: state.indexMirror, fetchedAt: state.fetchedAt };
    }
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /**
   * 条目目录里的一个文件（0.94.0）：只认当前索引里这个条目 `files` 列出的路径，按索引的 `commit` 读，校验大小与 sha256。
   * 缓存在 `files/<commit>/<条目目录>/<path>`，用之前同样校验；从索引来自的镜像读起，失败换另外两家。
   */
  async file(entryId: string, path: string): Promise<MethodResult<'market.file'>> {
    const index = (await this.#loadIndex()) ?? (await this.index()).index;
    const entry = index.entries.find((item) => item.id === entryId);
    if (entry === undefined) {
      throw new HostError('INVALID_PARAMS', `no market entry ${entryId}`, {
        issues: [{ path: ['entry'], message: 'not in the market index' }],
      });
    }
    const file = entry.files.find((item) => item.path === path);
    if (file === undefined || file.size > MARKET_FILE_MAX_BYTES) {
      const message = file === undefined ? 'not a file of this entry' : 'file too large';
      throw new HostError('INVALID_PARAMS', `${entryId}/${path}: ${message}`, {
        issues: [{ path: ['path'], message }],
      });
    }
    const bytes = await this.#entryFile(index, entry, file);
    return { data: bytes.toString('base64') };
  }

  /** 收 `market.installProgress`（0.99.0）。返回取消函数。 */
  watch(listener: (progress: MarketInstallProgress) => void): () => void {
    this.#progressListeners.add(listener);
    return () => this.#progressListeners.delete(listener);
  }

  /**
   * 安装一个条目（0.99.0）：按索引的 `commit` 把 `files` 全部下载到 `installs/` 下的临时目录，逐个校验后交给 `run`（插件安装事务）。
   * `skills/` 下的简便投稿先包成只含这一个 skill 的 Wevir 插件。同一条目已在安装时并入那一次。
   */
  install<T>(entryId: string, run: (root: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const running = this.#installs.get(entryId);
    if (running !== undefined) return running.promise as Promise<T>;
    const controller = new AbortController();
    const promise = this.#install(entryId, run, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
        const message = `installing ${entryId} was cancelled`;
        throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
      })
      .finally(() => this.#installs.delete(entryId));
    this.#installs.set(entryId, { promise, controller });
    return promise;
  }

  /** 停下正在进行的安装；没有在装时什么也不做。 */
  cancelInstall(entryId: string): void {
    this.#installs.get(entryId)?.controller.abort();
  }

  async #install<T>(
    entryId: string,
    run: (root: string, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const index = (await this.#loadIndex()) ?? (await this.index()).index;
    const entry = index.entries.find((item) => item.id === entryId);
    if (entry === undefined) {
      throw new HostError('INVALID_PARAMS', `no market entry ${entryId}`, {
        issues: [{ path: ['entry'], message: 'not in the market index' }],
      });
    }
    const totalBytes = entry.files.reduce((sum, file) => sum + file.size, 0);
    if (
      entry.files.length > ENTRY_MAX_FILES ||
      totalBytes > ENTRY_MAX_BYTES ||
      entry.files.some((file) => file.size > MARKET_FILE_MAX_BYTES)
    ) {
      throw new HostError('INVALID_PARAMS', `${entryId} exceeds the market entry size limits`, {
        issues: [{ path: ['entry'], message: 'entry too large' }],
      });
    }
    const received = new Map<string, number>();
    let lastSent = 0;
    const report = (phase: MarketInstallProgress['phase'], force = false) => {
      const now = this.#now();
      if (!force && now - lastSent < PROGRESS_INTERVAL_MS) return;
      lastSent = now;
      let receivedBytes = 0;
      for (const bytes of received.values()) receivedBytes += bytes;
      this.#emit({ entry: entryId, phase, receivedBytes, totalBytes });
    };
    report('download', true);

    await mkdir(join(this.#options.dir, 'installs'), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(this.#options.dir, 'installs', `${entryId}-`));
    try {
      const paths = new Set(entry.files.map((file) => file.path));
      const wrap = !PACKAGE_MARKERS.some((path) => paths.has(path)) && paths.has('SKILL.md');
      const root = join(stage, 'package');
      const filesRoot = wrap ? join(root, 'skills', entry.id) : root;
      // 一个文件失败就停下其余的，等它们都结束再删临时目录。
      const failed = new AbortController();
      const downloads = AbortSignal.any([signal, failed.signal]);
      let failure: unknown;
      await Promise.allSettled(
        entry.files.map(async (file) => {
          try {
            const bytes = await this.#entryFile(index, entry, file, {
              signal: downloads,
              onBytes: (count) => {
                received.set(file.path, count);
                report('download');
              },
            });
            received.set(file.path, file.size);
            report('download');
            const target = member(filesRoot, file.path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
          } catch (error) {
            if (!downloads.aborted) failure = error;
            failed.abort();
          }
        }),
      );
      signal.throwIfAborted();
      if (failure !== undefined) throw failure;
      if (wrap) await writeFile(join(root, 'wevir-plugin.json'), skillManifest(entry));
      report('install', true);
      return await run(root, signal);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  #emit(progress: MarketInstallProgress): void {
    for (const listener of [...this.#progressListeners]) {
      try {
        listener(progress);
      } catch (error) {
        this.#options.onWarning?.('a market install listener threw', { error });
      }
    }
  }

  /**
   * 条目目录里的一个文件，校验大小与 sha256。缓存在 `files/<commit>/<条目目录>/<path>`，用之前同样校验；从索引来自的镜像读起，
   * 失败换另外两家。`onBytes` 报这一次请求已收到的字节（换镜像时从 0 重新算）。
   */
  async #entryFile(
    index: WevirMarketIndex,
    entry: IndexEntry,
    file: EntryFile,
    options: { signal?: AbortSignal; onBytes?: (count: number) => void } = {},
  ): Promise<Buffer> {
    const repoPath = `${entry.path}/${file.path}`;
    const cached = join(this.#options.dir, 'files', index.commit, ...repoPath.split('/'));
    const matches = (bytes: Buffer) =>
      bytes.length === file.size &&
      createHash('sha256').update(bytes).digest('hex') === file.sha256;
    try {
      const bytes = await readFile(cached);
      if (matches(bytes)) return bytes;
    } catch {}

    await this.#acquireFileSlot();
    try {
      const first = (await this.#loadState()).indexMirror;
      const order = [
        ...(first === undefined ? [] : [first]),
        ...MIRRORS.filter((m) => m !== first),
      ];
      const failures: string[] = [];
      for (const mirror of order) {
        options.signal?.throwIfAborted();
        try {
          options.onBytes?.(0);
          const bytes = await this.#get(this.#mirrors[mirror](index.commit, repoPath), {
            maxBytes: file.size,
            timeoutMs: FETCH_TIMEOUT_MS,
            ...(options.signal !== undefined && { signal: options.signal }),
            ...(options.onBytes !== undefined && { onBytes: options.onBytes }),
          });
          if (!matches(bytes)) throw new Error('sha256 does not match the index');
          await mkdir(dirname(cached), { recursive: true, mode: 0o700 });
          const tmp = `${cached}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
          await writeFile(tmp, bytes, { mode: 0o600 });
          await rename(tmp, cached);
          return bytes;
        } catch (error) {
          options.signal?.throwIfAborted();
          failures.push(`${mirror}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const message = `could not read ${repoPath} from the plugin market: ${failures.join('; ')}`;
      throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
    } finally {
      this.#releaseFileSlot();
    }
  }

  async #acquireFileSlot(): Promise<void> {
    if (this.#fileSlots < FILE_CONCURRENCY) {
      this.#fileSlots++;
      return;
    }
    await new Promise<void>((resolve) => this.#fileQueue.push(resolve));
  }

  /** 把名额直接交给排队的下一个，没有排队的才归还。 */
  #releaseFileSlot(): void {
    const next = this.#fileQueue.shift();
    if (next === undefined) this.#fileSlots--;
    else next();
  }

  async #refresh(): Promise<MethodResult<'market.index'>> {
    const preference = this.#options.preference();
    const first =
      preference === 'auto'
        ? ((await this.#loadState()).mirror ?? (await this.#probe()))
        : preference;
    const order = [...(first === undefined ? [] : [first]), ...MIRRORS.filter((m) => m !== first)];
    const cached = await this.#loadIndex();
    const failures: string[] = [];
    for (const mirror of order) {
      try {
        const { index, bytes, signature } = await this.#download(mirror);
        if (cached !== undefined && index.sequence < cached.sequence) {
          throw new Error(`stale index (sequence ${index.sequence} < ${cached.sequence})`);
        }
        const fetchedAt = new Date(this.#now()).toISOString();
        await this.#saveIndex(bytes, signature);
        this.#index = index;
        const state = await this.#loadState();
        await this.#saveState({
          ...state,
          ...(preference === 'auto' && state.mirror !== mirror && { mirror, probedAt: fetchedAt }),
          indexMirror: mirror,
          fetchedAt,
        });
        return { index, mirror, fetchedAt };
      } catch (error) {
        failures.push(`${mirror}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const error = failures.join('; ');
    this.#options.onWarning?.('failed to refresh the plugin market index', { error });
    const state = await this.#loadState();
    if (cached !== undefined && state.indexMirror !== undefined && state.fetchedAt !== undefined) {
      return { index: cached, mirror: state.indexMirror, fetchedAt: state.fetchedAt, error };
    }
    const message = `could not read the plugin market: ${error}`;
    throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
  }

  /** 并发请求三家的签名文件，返回最先成功的那家并记住；都失败返回 undefined（下次再测）。 */
  #probe(): Promise<MarketMirror | undefined> {
    this.#probing ??= (async () => {
      try {
        const mirror = await Promise.any(
          MIRRORS.map(async (mirror) => {
            await this.#get(this.#mirrors[mirror]('dist', 'index.json.sig'), {
              maxBytes: SIGNATURE_MAX_BYTES,
              timeoutMs: PROBE_TIMEOUT_MS,
            });
            return mirror;
          }),
        );
        const state = await this.#loadState();
        await this.#saveState({ ...state, mirror, probedAt: new Date(this.#now()).toISOString() });
        return mirror;
      } catch {
        this.#options.onWarning?.('no plugin market mirror is reachable');
        return undefined;
      } finally {
        this.#probing = undefined;
      }
    })();
    return this.#probing;
  }

  async #download(mirror: MarketMirror) {
    const url = this.#mirrors[mirror];
    const [bytes, signatureBytes] = await Promise.all([
      this.#get(url('dist', 'index.json'), {
        maxBytes: INDEX_MAX_BYTES,
        timeoutMs: FETCH_TIMEOUT_MS,
      }),
      this.#get(url('dist', 'index.json.sig'), {
        maxBytes: SIGNATURE_MAX_BYTES,
        timeoutMs: FETCH_TIMEOUT_MS,
      }),
    ]);
    const signature = signatureBytes.toString('utf8').trim();
    if (!this.#verify(bytes, signature)) throw new Error('signature does not match');
    return { index: parseIndex(bytes), bytes, signature };
  }

  #verify(bytes: Buffer, signature: string): boolean {
    const raw = Buffer.from(signature, 'base64');
    if (raw.length !== 64) return false;
    return this.#keys.some((key) => verify(null, bytes, key, raw));
  }

  async #get(
    url: string,
    limits: {
      maxBytes: number;
      timeoutMs: number;
      signal?: AbortSignal;
      /** 已收到的字节，每来一块报一次。 */
      onBytes?: (count: number) => void;
    },
  ): Promise<Buffer> {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const response = await this.#fetch(url, {
      redirect: 'follow',
      signal: limits.signal === undefined ? timeout : AbortSignal.any([limits.signal, timeout]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > limits.maxBytes) {
      await response.body?.cancel();
      throw new Error('response too large');
    }
    if (response.body === null) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > limits.maxBytes) throw new Error('response too large');
      chunks.push(chunk);
      limits.onBytes?.(received);
    }
    return Buffer.concat(chunks);
  }

  async #loadState(): Promise<MarketState> {
    if (this.#state !== undefined) return this.#state;
    let state: MarketState = {};
    try {
      const raw = JSON.parse(await readFile(join(this.#options.dir, 'state.json'), 'utf8'));
      const mirror = MarketMirrorSchema.safeParse(raw?.mirror);
      const indexMirror = MarketMirrorSchema.safeParse(raw?.indexMirror);
      state = {
        ...(mirror.success && { mirror: mirror.data }),
        ...(typeof raw?.probedAt === 'string' && { probedAt: raw.probedAt }),
        ...(indexMirror.success && { indexMirror: indexMirror.data }),
        ...(typeof raw?.fetchedAt === 'string' && { fetchedAt: raw.fetchedAt }),
      };
    } catch {}
    this.#state = state;
    return state;
  }

  async #saveState(state: MarketState): Promise<void> {
    this.#state = state;
    await this.#write('state.json', `${JSON.stringify(state, null, 2)}\n`);
  }

  /** 缓存的索引在用之前重新验签：数据目录里的文件同样不可信。 */
  async #loadIndex(): Promise<WevirMarketIndex | undefined> {
    if (this.#index !== undefined) return this.#index;
    try {
      const [bytes, signature] = await Promise.all([
        readFile(join(this.#options.dir, 'index.json')),
        readFile(join(this.#options.dir, 'index.json.sig'), 'utf8'),
      ]);
      if (!this.#verify(bytes, signature.trim())) return undefined;
      this.#index = parseIndex(bytes);
    } catch {}
    return this.#index;
  }

  async #saveIndex(bytes: Buffer, signature: string): Promise<void> {
    await this.#write('index.json', bytes);
    await this.#write('index.json.sig', `${signature}\n`);
  }

  async #write(name: string, data: string | Buffer): Promise<void> {
    await mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
    const file = join(this.#options.dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  }
}

/**
 * 读索引时丢掉不认识的字段（市场仓库以后加字段，这里只是看不到），已知字段仍按 schema 检查。
 * 不认识的 `schemaVersion` 是不兼容的格式，当作读取失败：换镜像，都不行就回缓存。
 */
function parseIndex(bytes: Buffer): WevirMarketIndex {
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== 1) throw new Error(`unsupported index schemaVersion: ${JSON.stringify(version)}`);
  const parsed = WevirMarketIndexLenientSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`index does not match its schema: ${parsed.error.message}`);
  return parsed.data;
}

/** `skills/` 下的简便投稿装成插件时用的清单：id、名称、版本与描述取自索引。 */
function skillManifest(entry: IndexEntry): string {
  const manifest = {
    schemaVersion: 1,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    ...(entry.description !== undefined && { description: entry.description }),
    ...(entry.author !== undefined && { author: entry.author }),
    ...(entry.license !== undefined && { license: entry.license }),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
