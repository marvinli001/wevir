// 用量统计（0.62.0，`usage.*`）：记下引擎报的每次模型请求，按客户端给的分桶聚合，成本按当前价格表现算。

import {
  type ProviderKind,
  USAGE_MAX_BUCKETS,
  USAGE_RECORDS_PAGE_MAX,
  type UsageAggregate,
  type UsageCost,
  type UsageFilter,
  type UsageModelAggregate,
  type UsagePrice,
  type UsageProviderAggregate,
  type UsageRecord,
  type UsageSummaryResult,
  type UsageTokens,
} from '@wevir/protocol';
import type { UsageRecordedEvent } from '@wevir/runtime-adapter';
import type { Storage, StoredUsageRow, UsageRow } from '@wevir/storage';
import { HostError } from '../errors.js';
import type { PricingStore } from './pricing.js';

/** 速度只算输出够多、耗时够长的请求，免得短请求的首字等待把速度拉低（照 cc-switch 的估算口径）。 */
const SPEED_MIN_OUTPUT = 200;
const SPEED_MIN_DURATION_MS = 1_000;
/** 引擎量出来的耗时超过一小时多半是量错了（会话挂着没动），不计。 */
const MAX_DURATION_MS = 60 * 60 * 1000;
/** `usage.changed` 最多每秒一次。 */
const NOTIFY_INTERVAL_MS = 1_000;

export interface UsageServiceOptions {
  storage: Storage;
  pricing: PricingStore;
  now?: () => number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 一次请求属于哪个会话、会话用的哪个 Provider 与模型（SessionManager 给）。 */
export interface UsageContext {
  sessionId: string;
  providerId: string;
  modelId: string;
}

export class UsageService {
  readonly #storage: Storage;
  readonly #pricing: PricingStore;
  readonly #now: () => number;
  readonly #onWarning: UsageServiceOptions['onWarning'];
  readonly #listeners = new Set<() => void>();
  #notifyTimer: NodeJS.Timeout | undefined;
  #lastNotify = 0;

  constructor(options: UsageServiceOptions) {
    this.#storage = options.storage;
    this.#pricing = options.pricing;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning;
  }

  /** 记一次请求；同一会话里重复的 `requestId` 不记。不抛错。 */
  record(context: UsageContext, event: UsageRecordedEvent): void {
    try {
      const provider = this.#storage.providers.get(context.providerId);
      const row: UsageRow = {
        sessionId: context.sessionId,
        requestId: event.requestId,
        at: this.#now(),
        source: provider?.kind ?? 'openai-compatible',
        providerId: context.providerId,
        providerName: provider?.displayName ?? context.providerId,
        ...(event.upstream !== undefined && { upstream: event.upstream }),
        model: event.model ?? context.modelId,
        inputTokens: count(event.inputTokens),
        outputTokens: count(event.outputTokens),
        cacheReadTokens: count(event.cacheReadTokens),
        cacheWriteTokens: count(event.cacheWriteTokens),
        reasoningTokens: count(event.reasoningTokens),
        ...timing(event),
      };
      if (this.#storage.usage.insert(row)) this.#changed();
    } catch (error) {
      this.#onWarning?.('failed to record usage', { error, sessionId: context.sessionId });
    }
  }

  /** `usage.changed`：有新记录或价格表换了时调用 `listener`，最多每秒一次。返回退订函数。 */
  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 价格表换了（PricingStore 的 `onChange`）。 */
  pricingChanged(): void {
    this.#changed();
  }

  dispose(): void {
    if (this.#notifyTimer !== undefined) clearTimeout(this.#notifyTimer);
    this.#notifyTimer = undefined;
    this.#listeners.clear();
  }

  summary(edges: readonly number[], filter: UsageFilter | undefined): UsageSummaryResult {
    if (edges.length - 1 > USAGE_MAX_BUCKETS) {
      throw invalidEdges(`at most ${USAGE_MAX_BUCKETS} buckets`);
    }
    for (let i = 1; i < edges.length; i += 1) {
      if ((edges[i] as number) <= (edges[i - 1] as number)) {
        throw invalidEdges('edges must be strictly ascending');
      }
    }
    const from = edges[0] as number;
    const to = edges.at(-1) as number;
    const rows = this.#storage.usage.range(from, to);

    const sources = new Set<string>();
    const providers = new Map<string, { id: string; name: string; source: ProviderKind }>();
    const models = new Set<string>();
    const totals = emptyAggregate();
    const buckets = Array.from({ length: edges.length - 1 }, emptyAggregate);
    const byProvider = new Map<string, UsageProviderAggregate>();
    const byModel = new Map<string, UsageModelAggregate>();
    const matches = matcher(filter);
    let bucket = 0;

    for (const row of rows) {
      sources.add(row.source);
      // 同一个 Provider 取最近一次的名字。
      providers.set(row.providerId, {
        id: row.providerId,
        name: row.providerName,
        source: row.source as ProviderKind,
      });
      models.add(row.model);
      if (!matches(row)) continue;
      const priced = this.#price(row);
      while (bucket < buckets.length - 1 && row.at >= (edges[bucket + 1] as number)) bucket += 1;
      add(totals, row, priced);
      add(buckets[bucket] as UsageAggregate, row, priced);
      let provider = byProvider.get(row.providerId);
      if (provider === undefined) {
        provider = {
          ...emptyAggregate(),
          providerId: row.providerId,
          providerName: row.providerName,
          source: row.source as ProviderKind,
        };
        byProvider.set(row.providerId, provider);
      }
      provider.providerName = row.providerName;
      add(provider, row, priced);
      let model = byModel.get(row.model);
      if (model === undefined) {
        model = { ...emptyAggregate(), model: row.model };
        byModel.set(row.model, model);
      }
      add(model, row, priced);
    }

    const byRequests = (a: UsageAggregate, b: UsageAggregate) => b.requests - a.requests;
    return {
      totals,
      buckets,
      byProvider: [...byProvider.values()].sort(byRequests),
      byModel: [...byModel.values()].sort(byRequests),
      options: {
        sources: [...sources].sort() as ProviderKind[],
        providers: [...providers.values()].sort((a, b) => a.name.localeCompare(b.name)),
        models: [...models].sort(),
      },
      pricing: this.#pricing.status(),
    };
  }

  records(params: {
    from: number;
    to: number;
    filter?: UsageFilter | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }): { records: UsageRecord[]; total: number } {
    const limit = Math.min(params.limit ?? USAGE_RECORDS_PAGE_MAX, USAGE_RECORDS_PAGE_MAX);
    const { rows, total } = this.#storage.usage.page(
      params.from,
      params.to,
      {
        ...(nonEmpty(params.filter?.sources) && { sources: params.filter?.sources }),
        ...(nonEmpty(params.filter?.providerIds) && { providerIds: params.filter?.providerIds }),
        ...(nonEmpty(params.filter?.models) && { models: params.filter?.models }),
      },
      params.offset ?? 0,
      limit,
    );
    return { records: rows.map((row) => this.#toRecord(row)), total };
  }

  #toRecord(row: StoredUsageRow): UsageRecord {
    const priced = this.#price(row);
    return {
      id: String(row.id),
      at: row.at,
      sessionId: row.sessionId,
      requestId: row.requestId,
      source: row.source as ProviderKind,
      providerId: row.providerId,
      providerName: row.providerName,
      ...(row.upstream !== undefined && { upstream: row.upstream }),
      model: row.model,
      tokens: tokensOf(row),
      ...(priced !== undefined && {
        cost: priced.cost,
        price: priced.price,
        priceSource: priced.provider,
      }),
      ...(row.durationMs !== undefined && { durationMs: row.durationMs }),
      ...(row.firstTokenMs !== undefined && { firstTokenMs: row.firstTokenMs }),
    };
  }

  #price(row: UsageRow): { cost: UsageCost; price: UsagePrice; provider: string } | undefined {
    const baseURL = this.#storage.providers.get(row.providerId)?.baseURL;
    const match = this.#pricing.lookup(
      row.model,
      {
        source: row.source,
        ...(baseURL !== undefined && { baseURL }),
        ...(row.upstream !== undefined && { upstream: row.upstream }),
      },
      row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens,
    );
    if (match === undefined) return undefined;
    return {
      cost: costOf(tokensOf(row), match.price),
      price: match.price,
      provider: match.provider,
    };
  }

  #changed(): void {
    if (this.#notifyTimer !== undefined) return;
    const wait = Math.max(0, this.#lastNotify + NOTIFY_INTERVAL_MS - this.#now());
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = undefined;
      this.#lastNotify = this.#now();
      for (const listener of this.#listeners) listener();
    }, wait);
    this.#notifyTimer.unref?.();
  }
}

/** 美元成本：单价是每百万 token；没有缓存价时按输入价算。 */
export function costOf(tokens: UsageTokens, price: UsagePrice): UsageCost {
  const input = (tokens.input * price.input) / 1e6;
  const output = (tokens.output * price.output) / 1e6;
  const cacheRead = (tokens.cacheRead * (price.cacheRead ?? price.input)) / 1e6;
  const cacheWrite = (tokens.cacheWrite * (price.cacheWrite ?? price.input)) / 1e6;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function timing(event: UsageRecordedEvent): { durationMs?: number; firstTokenMs?: number } {
  const duration = event.durationMs;
  if (duration === undefined || !(duration > 0) || duration > MAX_DURATION_MS) return {};
  const first = event.firstTokenMs;
  return {
    durationMs: Math.round(duration),
    ...(first !== undefined &&
      first >= 0 &&
      first <= duration && { firstTokenMs: Math.round(first) }),
  };
}

function tokensOf(row: UsageRow): UsageTokens {
  return {
    input: row.inputTokens,
    output: row.outputTokens,
    cacheRead: row.cacheReadTokens,
    cacheWrite: row.cacheWriteTokens,
    reasoning: row.reasoningTokens,
  };
}

function emptyAggregate(): UsageAggregate {
  return {
    requests: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: 0,
    unpriced: 0,
    timing: {
      timedRequests: 0,
      outputTokens: 0,
      durationMs: 0,
      firstTokenCount: 0,
      firstTokenMs: 0,
    },
  };
}

function add(target: UsageAggregate, row: UsageRow, priced: { cost: UsageCost } | undefined): void {
  target.requests += 1;
  target.tokens.input += row.inputTokens;
  target.tokens.output += row.outputTokens;
  target.tokens.cacheRead += row.cacheReadTokens;
  target.tokens.cacheWrite += row.cacheWriteTokens;
  target.tokens.reasoning += row.reasoningTokens;
  if (priced === undefined) target.unpriced += 1;
  else target.cost += priced.cost.total;
  if (
    row.durationMs !== undefined &&
    row.durationMs >= SPEED_MIN_DURATION_MS &&
    row.outputTokens >= SPEED_MIN_OUTPUT
  ) {
    target.timing.timedRequests += 1;
    target.timing.outputTokens += row.outputTokens;
    target.timing.durationMs += row.durationMs;
  }
  if (row.firstTokenMs !== undefined) {
    target.timing.firstTokenCount += 1;
    target.timing.firstTokenMs += row.firstTokenMs;
  }
}

function matcher(filter: UsageFilter | undefined): (row: UsageRow) => boolean {
  const sources = nonEmpty(filter?.sources);
  const providers = nonEmpty(filter?.providerIds);
  const models = nonEmpty(filter?.models);
  return (row) =>
    (sources === undefined || sources.has(row.source)) &&
    (providers === undefined || providers.has(row.providerId)) &&
    (models === undefined || models.has(row.model));
}

/** 协议里空数组与省略都表示不限。 */
function nonEmpty(values: readonly string[] | undefined): Set<string> | undefined {
  return values === undefined || values.length === 0 ? undefined : new Set(values);
}

function invalidEdges(message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path: ['edges'], message }] });
}
