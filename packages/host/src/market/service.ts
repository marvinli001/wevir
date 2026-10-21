import { createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type MarketMirror,
  type MarketMirrorPreference,
  MarketMirrorSchema,
  type MarketStatus,
  type MethodResult,
  type WevirMarketIndex,
  WevirMarketIndexSchema,
} from '@wevir/protocol';
import { HostError } from '../errors.js';

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
/** `market.index` 不带 `refresh` 时，缓存在这么久之内直接用。 */
export const MARKET_INDEX_MAX_AGE_MS = 60 * 60 * 1000;

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
 * 官方插件市场（0.90.0，Host 功能 `plugin_market`）。不经 CDN，直接读 wevir-marketplace 仓库在 GitHub、CNB、Gitee 上的文件。
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
    const parsed = WevirMarketIndexSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success)
      throw new Error(`index does not match its schema: ${parsed.error.message}`);
    return { index: parsed.data, bytes, signature };
  }

  #verify(bytes: Buffer, signature: string): boolean {
    const raw = Buffer.from(signature, 'base64');
    if (raw.length !== 64) return false;
    return this.#keys.some((key) => verify(null, bytes, key, raw));
  }

  async #get(url: string, limits: { maxBytes: number; timeoutMs: number }): Promise<Buffer> {
    const response = await this.#fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(limits.timeoutMs),
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
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > limits.maxBytes) throw new Error('response too large');
    return body;
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
      const parsed = WevirMarketIndexSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (parsed.success) this.#index = parsed.data;
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
