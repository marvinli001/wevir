// 用量统计的价格表（0.62.0）：models.dev 的 api.json 里每家服务商、每个模型的单价（美元 / 百万 token）。
//
// 来源是内置的，不可自定义。Host 启动时读数据目录里上次存的价格表，超过一天没刷新就去 models.dev 取一次（带 ETag），之后每小时
// 看一眼是否又过了一天（电脑睡过一觉也能补上）。取不到时沿用旧表，记下原因。只存算成本要用的字段，约几百 KB。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsagePrice, UsagePricing } from '@wevir/protocol';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const PRICING_SOURCE = 'models.dev';
/** 价格表多久刷新一次。 */
export const PRICING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 多久看一次是否该刷新。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
/** api.json 现在约 6 MB，超过这个数当作出错。 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const FILE_VERSION = 1;

/** 一档单价；`size` 是这一档开始的输入 token 数（含缓存），基础档没有。 */
interface Tier extends UsagePrice {
  size: number;
}

interface ModelPrice extends UsagePrice {
  /** 输入超过某个长度后的高档价，按 `size` 升序。 */
  tiers?: Tier[];
}

interface ProviderPrices {
  /** OpenAI 兼容服务的地址（models.dev 的 `api`），用来认出用户填的 Provider 是哪家。 */
  api?: string;
  models: Record<string, ModelPrice>;
}

interface PricingFile {
  version: number;
  fetchedAt: number;
  etag?: string;
  providers: Record<string, ProviderPrices>;
}

/** 找价格时的线索：会话的来源种类、Provider 的地址、OpenCode 的上游。 */
export interface PriceHints {
  source: string;
  baseURL?: string;
  upstream?: string;
}

export interface PriceMatch {
  /** 按输入长度选好的那一档。 */
  price: UsagePrice;
  /** models.dev 的服务商 ID。 */
  provider: string;
}

export interface PricingStoreOptions {
  /** 价格表存在哪（数据目录里的 JSON）。 */
  file: string;
  fetch?: typeof fetch;
  now?: () => number;
  url?: string;
  /** 价格表换了（刷新成功、内容有变）。 */
  onChange?: () => void;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

export class PricingStore {
  readonly #options: PricingStoreOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #table: PricingFile | undefined;
  #refreshing: Promise<void> | undefined;
  #lastError: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** 模型 ID（小写，也按去掉前缀的写法）→ 有它的服务商，查找时用；换表时重建。 */
  #index = new Map<string, Entry[]>();
  /** 价格表里不同的模型 ID 数（不分服务商）。 */
  #models = 0;
  /** 找过的结果：哪家的哪个模型（不含选档），没有是 null。 */
  #cache = new Map<string, Entry | null>();

  constructor(options: PricingStoreOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** 读存好的价格表，过期就在后台刷新，之后每小时检查一次。不抛错。 */
  async start(): Promise<void> {
    await this.load();
    this.#refreshIfStale();
    this.#timer = setInterval(() => this.#refreshIfStale(), CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 读数据目录里的价格表；没有或读不出来时当作没有。 */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#options.file, 'utf8')) as PricingFile;
      if (parsed.version === FILE_VERSION && typeof parsed.fetchedAt === 'number') {
        this.#use(parsed);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#options.onWarning?.('failed to read pricing table', { error });
      }
    }
  }

  status(): UsagePricing {
    return {
      source: PRICING_SOURCE,
      ...(this.#table !== undefined && { fetchedAt: this.#table.fetchedAt }),
      models: this.#models,
      refreshing: this.#refreshing !== undefined,
      ...(this.#lastError !== undefined && { lastError: this.#lastError }),
    };
  }

  /** 从 models.dev 重新取；正在取时等那一次。失败不抛错，原因在 `status().lastError`。 */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#download().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /**
   * 找一个模型的单价。先找会话来源对应的那家（Claude → anthropic、ChatGPT → openai、OpenCode → 它的上游、自填的 Provider →
   * 按地址认），再找模型名对应的厂商，最后任意一家有这个模型的。单价全是 0 的（订阅里的免费价）只在找不到别的时才用。
   * `promptTokens` 是这次请求的输入（含缓存），用来选高档价；`at` 是请求的时刻，按时段计价的服务商（`peakFactor`）用它。
   */
  lookup(
    model: string,
    hints: PriceHints,
    promptTokens: number,
    at?: number,
  ): PriceMatch | undefined {
    const key = `${model}\u0000${hints.source}\u0000${hints.baseURL ?? ''}\u0000${hints.upstream ?? ''}`;
    let base = this.#cache.get(key);
    if (base === undefined) {
      base = this.#find(model, hints) ?? null;
      this.#cache.set(key, base);
    }
    if (base === null) return undefined;
    const entry = this.#table?.providers[base.provider]?.models[base.key];
    if (entry === undefined) return undefined;
    const price = tierFor(entry, promptTokens);
    const factor = at === undefined ? 1 : peakFactor(base.provider, at);
    return { provider: base.provider, price: factor === 1 ? price : scaled(price, factor) };
  }

  #refreshIfStale(): void {
    const fetchedAt = this.#table?.fetchedAt;
    if (fetchedAt !== undefined && this.#now() - fetchedAt < PRICING_MAX_AGE_MS) return;
    void this.refresh();
  }

  async #download(): Promise<void> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.#table?.etag !== undefined) headers['if-none-match'] = this.#table.etag;
      const response = await this.#fetch(this.#options.url ?? MODELS_DEV_URL, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 304 && this.#table !== undefined) {
        await response.body?.cancel();
        await this.#save({ ...this.#table, fetchedAt: this.#now() });
        this.#lastError = undefined;
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_RESPONSE_BYTES) throw new Error('response too large');
      const body = (await response.json()) as unknown;
      const etag = response.headers.get('etag') ?? undefined;
      const table = compact(body, this.#now(), etag);
      if (Object.keys(table.providers).length === 0) throw new Error('no prices in response');
      await this.#save(table);
      this.#lastError = undefined;
      this.#options.onChange?.();
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#options.onWarning?.('failed to refresh pricing table', { error: this.#lastError });
    }
  }

  async #save(table: PricingFile): Promise<void> {
    this.#use(table);
    const file = this.#options.file;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(table), { mode: 0o600 });
    await rename(tmp, file);
  }

  #use(table: PricingFile): void {
    this.#table = table;
    this.#cache.clear();
    // 按完整 ID 与去掉 `厂商/` 前缀的 ID 各登记一次（聚合服务写 `anthropic/claude-…`）。
    const index = new Map<string, Entry[]>();
    const ids = new Set<string>();
    const add = (id: string, entry: Entry) => {
      const list = index.get(id);
      if (list === undefined) index.set(id, [entry]);
      else if (!list.some((e) => e.provider === entry.provider && e.key === entry.key))
        list.push(entry);
    };
    for (const [provider, prices] of Object.entries(table.providers)) {
      for (const key of Object.keys(prices.models)) {
        const id = key.toLowerCase();
        ids.add(id);
        add(id, { provider, key });
        const slash = id.lastIndexOf('/');
        if (slash >= 0) add(id.slice(slash + 1), { provider, key });
      }
    }
    this.#index = index;
    this.#models = ids.size;
  }

  #find(model: string, hints: PriceHints): Entry | undefined {
    const table = this.#table;
    if (table === undefined) return undefined;
    const candidates = modelCandidates(model);
    const preferred = [...preferredProviders(hints, table), ...labsFor(candidates.at(-1) ?? model)];
    const priceOf = (entry: Entry) => table.providers[entry.provider]?.models[entry.key];
    let free: Entry | undefined;
    for (const provider of preferred) {
      for (const id of candidates) {
        const entries = (this.#index.get(id.toLowerCase()) ?? []).filter(
          (e) => e.provider === provider,
        );
        // 同一家里完整 ID 相同的优先于只有后半段相同的。
        const entry = entries.find((e) => e.key.toLowerCase() === id.toLowerCase()) ?? entries[0];
        if (entry === undefined) continue;
        const price = priceOf(entry);
        if (price !== undefined && !isFree(price)) return entry;
        free ??= entry;
      }
    }
    // 来源那家没有：在有这个模型的各家里取最多家给的那个价格（多是厂商的原价，转售的加价各不相同），一样多时一手厂商优先。
    for (const id of candidates) {
      const groups = new Map<string, Entry[]>();
      for (const entry of this.#index.get(id.toLowerCase()) ?? []) {
        const price = priceOf(entry);
        if (price === undefined) continue;
        if (isFree(price)) {
          free ??= entry;
          continue;
        }
        const signature = `${price.input}/${price.output}/${price.cacheRead ?? ''}/${price.cacheWrite ?? ''}`;
        const group = groups.get(signature);
        if (group === undefined) groups.set(signature, [entry]);
        else group.push(entry);
      }
      let best: Entry[] | undefined;
      for (const group of groups.values()) {
        group.sort((a, b) => byProviderRank(a.provider, b.provider));
        if (
          best === undefined ||
          group.length > best.length ||
          (group.length === best.length &&
            byProviderRank((group[0] as Entry).provider, (best[0] as Entry).provider) < 0)
        ) {
          best = group;
        }
      }
      if (best !== undefined) return best[0];
    }
    return free;
  }
}

/** 价格表里的一个模型：哪家、在那家的 ID。 */
interface Entry {
  provider: string;
  key: string;
}

function isFree(price: UsagePrice): boolean {
  return price.input === 0 && price.output === 0;
}

/** 选输入长度对应的那一档：输入超过某档的 `size` 就用那一档。 */
function tierFor(entry: ModelPrice, promptTokens: number): UsagePrice {
  let chosen: UsagePrice = entry;
  for (const tier of entry.tiers ?? []) {
    if (promptTokens > tier.size) chosen = tier;
  }
  const { input, output, cacheRead, cacheWrite } = chosen;
  return {
    input,
    output,
    ...(cacheRead !== undefined && { cacheRead }),
    ...(cacheWrite !== undefined && { cacheWrite }),
  };
}

/** 北京时间（UTC+8，没有夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 按时段计价：DeepSeek 官方在北京时间周一至周五 9:00–12:00、14:00–18:00 是高峰，单价是空闲时段的两倍；models.dev 记的是空闲
 * 时段的价（按汇率折成美元）。法定节假日也算空闲，这里认不出，照工作日算。其余服务商不分时段。
 */
export function peakFactor(provider: string, at: number): number {
  if (provider !== 'deepseek') return 1;
  const beijing = new Date(at + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) ? 2 : 1;
}

function scaled(price: UsagePrice, factor: number): UsagePrice {
  return {
    input: price.input * factor,
    output: price.output * factor,
    ...(price.cacheRead !== undefined && { cacheRead: price.cacheRead * factor }),
    ...(price.cacheWrite !== undefined && { cacheWrite: price.cacheWrite * factor }),
  };
}

/**
 * 模型 ID 的几种写法，越靠前越精确：原样、去掉 `厂商/` 前缀、去掉 `[1m]` 这类后缀、去掉日期（`-20251001`、`-2025-10-01`）、
 * 去掉 `-latest`、去掉思考档位（Antigravity 的 `gemini-3.8-flash-high`、`…-thinking`；价格表里只有不带档位的）。
 */
export function modelCandidates(model: string): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (id.length > 0 && !out.includes(id)) out.push(id);
  };
  add(model);
  let id = model.trim();
  id = id.replace(/\[[^\]]*\]$/, '');
  add(id);
  const slash = id.lastIndexOf('/');
  if (slash >= 0) {
    id = id.slice(slash + 1);
    add(id);
  }
  id = id.replace(/:[a-z-]+$/i, '');
  add(id);
  const undated = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  add(undated);
  const unaliased = undated.replace(/-latest$/, '');
  add(unaliased);
  add(unaliased.replace(/(-(minimal|low|medium|high|xhigh|extra-high|thinking))+$/i, ''));
  return out;
}

/** 按模型名猜厂商（找不到来源那家时用）。 */
function labsFor(model: string): string[] {
  const id = model.toLowerCase();
  if (id.startsWith('claude')) return ['anthropic'];
  if (/^(gpt|o\d|codex|chatgpt)/.test(id)) return ['openai'];
  if (id.startsWith('gemini') || id.startsWith('gemma')) return ['google'];
  if (id.startsWith('grok')) return ['xai'];
  if (id.startsWith('deepseek')) return ['deepseek'];
  if (id.startsWith('kimi')) return ['moonshotai', 'moonshotai-cn'];
  if (id.startsWith('glm')) return ['zai', 'zhipuai'];
  if (id.startsWith('qwen')) return ['alibaba', 'alibaba-cn'];
  if (id.startsWith('minimax')) return ['minimax', 'minimax-cn'];
  if (id.startsWith('mistral') || id.startsWith('devstral') || id.startsWith('codestral')) {
    return ['mistral'];
  }
  return [];
}

/** 一手厂商排在聚合服务前面，其余按 ID。 */
const FIRST_PARTY = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'moonshotai',
  'zai',
  'zhipuai',
  'alibaba',
  'minimax',
  'mistral',
];

function byProviderRank(a: string, b: string): number {
  const ra = FIRST_PARTY.indexOf(a);
  const rb = FIRST_PARTY.indexOf(b);
  if (ra !== rb)
    return (ra === -1 ? FIRST_PARTY.length : ra) - (rb === -1 ? FIRST_PARTY.length : rb);
  return a.localeCompare(b);
}

/** models.dev 里没写 `api` 的几家一手厂商的地址。 */
const KNOWN_HOSTS: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  'api.x.ai': 'xai',
  'api.mistral.ai': 'mistral',
  'api.groq.com': 'groq',
  'openrouter.ai': 'openrouter',
  'ai-gateway.vercel.sh': 'vercel',
  'api.fireworks.ai': 'fireworks-ai',
  'ark.cn-beijing.volces.com': 'volcengine',
  'api.moonshot.ai': 'moonshotai',
  'api.moonshot.cn': 'moonshotai-cn',
};

function preferredProviders(hints: PriceHints, table: PricingFile): string[] {
  switch (hints.source) {
    case 'claude':
      return ['anthropic'];
    case 'chatgpt':
      return ['openai'];
    case 'grok':
      return ['xai'];
    case 'antigravity':
      return ['google'];
    case 'deepseek-official':
      return ['deepseek'];
    case 'google-vertex':
      return ['google-vertex', 'google'];
    case 'opencode':
      return hints.upstream !== undefined ? [hints.upstream] : ['opencode'];
  }
  if (hints.baseURL === undefined) return [];
  const provider = providerForUrl(hints.baseURL, table);
  return provider === undefined ? [] : [provider];
}

/** 按地址认出是哪家：主机名相同、路径最长匹配的那家。 */
export function providerForUrl(
  baseURL: string,
  table: { providers: Record<string, ProviderPrices> },
): string | undefined {
  let target: URL;
  try {
    target = new URL(baseURL);
  } catch {
    return undefined;
  }
  let best: { provider: string; length: number } | undefined;
  for (const [provider, prices] of Object.entries(table.providers)) {
    if (prices.api === undefined) continue;
    let api: URL;
    try {
      api = new URL(prices.api);
    } catch {
      continue;
    }
    if (api.hostname !== target.hostname) continue;
    const path = api.pathname.replace(/\/+$/, '');
    if (!target.pathname.startsWith(path)) continue;
    if (best === undefined || path.length > best.length) best = { provider, length: path.length };
  }
  return best?.provider ?? KNOWN_HOSTS[target.hostname];
}

/** 把 models.dev 的 api.json 压成价格表：只留有 `cost.input` 与 `cost.output` 的模型。 */
export function compact(body: unknown, fetchedAt: number, etag?: string): PricingFile {
  const providers: Record<string, ProviderPrices> = {};
  if (body !== null && typeof body === 'object') {
    for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
      const provider = value as { api?: unknown; models?: Record<string, { cost?: unknown }> };
      if (provider === null || typeof provider !== 'object' || provider.models === undefined)
        continue;
      const models: Record<string, ModelPrice> = {};
      for (const [modelId, model] of Object.entries(provider.models)) {
        const price = modelPrice(model?.cost);
        if (price !== undefined) models[modelId] = price;
      }
      if (Object.keys(models).length === 0) continue;
      providers[id] = {
        ...(typeof provider.api === 'string' && { api: provider.api }),
        models,
      };
    }
  }
  return { version: FILE_VERSION, fetchedAt, ...(etag !== undefined && { etag }), providers };
}

function priceOf(cost: Record<string, unknown>): UsagePrice | undefined {
  const { input, output, cache_read: cacheRead, cache_write: cacheWrite } = cost;
  if (!isPrice(input) || !isPrice(output)) return undefined;
  return {
    input,
    output,
    ...(isPrice(cacheRead) && { cacheRead }),
    ...(isPrice(cacheWrite) && { cacheWrite }),
  };
}

function modelPrice(cost: unknown): ModelPrice | undefined {
  if (cost === null || typeof cost !== 'object') return undefined;
  const record = cost as Record<string, unknown>;
  const base = priceOf(record);
  if (base === undefined) return undefined;
  const tiers: Tier[] = [];
  if (Array.isArray(record.tiers)) {
    for (const raw of record.tiers as Array<Record<string, unknown>>) {
      const tier = raw?.tier as { type?: unknown; size?: unknown } | undefined;
      const price = raw !== null && typeof raw === 'object' ? priceOf(raw) : undefined;
      if (price === undefined || tier?.type !== 'context' || typeof tier.size !== 'number')
        continue;
      tiers.push({ ...price, size: tier.size });
    }
  }
  if (
    tiers.length === 0 &&
    record.context_over_200k !== null &&
    typeof record.context_over_200k === 'object'
  ) {
    const price = priceOf(record.context_over_200k as Record<string, unknown>);
    if (price !== undefined) tiers.push({ ...price, size: 200_000 });
  }
  tiers.sort((a, b) => a.size - b.size);
  return tiers.length > 0 ? { ...base, tiers } : base;
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
