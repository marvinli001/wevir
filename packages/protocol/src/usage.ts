// 用量统计（0.62.0，Host 功能 `usage_stats`）：Wevir 里每次模型请求用掉的 token 与按 models.dev 价格估的成本。
//
// Host 从引擎的 `usage.recorded` 记下每次请求（不进事件流，会话删了记录还在），按客户端给的时间段聚合。成本在查询时按
// Host 当前的价格表算：价格表来自 models.dev（内置来源，不可自定义），每天刷新一次。订阅来源（Claude、ChatGPT…）实际按
// 订阅计费，这里的成本是按 API 价格折算的估计。时间一律是 Unix 毫秒。

import { z } from 'zod';
import { ProviderKindSchema } from './entities.js';

/** token 用 Anthropic 的口径：`input` 不含缓存命中与缓存写入，`reasoning` 已含在 `output` 里。 */
export const UsageTokensSchema = z.object({
  input: z.int().min(0),
  output: z.int().min(0),
  cacheRead: z.int().min(0),
  cacheWrite: z.int().min(0),
  reasoning: z.int().min(0),
});
export type UsageTokens = z.infer<typeof UsageTokensSchema>;

/** 美元成本的组成；`total` 是四项之和（推理按输出价算，已在 `output` 里；没有缓存价时按输入价）。 */
export const UsageCostSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
  total: z.number().min(0),
});
export type UsageCost = z.infer<typeof UsageCostSchema>;

/** 单价（美元 / 百万 token，models.dev 的 `cost`）；没有的项省略。 */
export const UsagePriceSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).optional(),
  cacheWrite: z.number().min(0).optional(),
});
export type UsagePrice = z.infer<typeof UsagePriceSchema>;

/** 一次请求。 */
export const UsageRecordSchema = z.object({
  id: z.string().min(1),
  at: z.int().min(0),
  /** 会话可能已经删了，所以只是字符串。 */
  sessionId: z.string().min(1),
  /** 引擎给这次请求的 ID（Claude 的 `msg_…`、OpenCode 的消息 ID、Codex 的回合与累计用量…），会话内唯一。 */
  requestId: z.string().min(1),
  /** 请求所在会话的来源种类。 */
  source: ProviderKindSchema,
  providerId: z.string().min(1),
  /** 记录时 Provider 的显示名（Provider 删了也能显示）。 */
  providerName: z.string(),
  /** 来源后面实际接的上游（OpenCode 的 `providerID`）。 */
  upstream: z.string().optional(),
  model: z.string().min(1),
  tokens: UsageTokensSchema,
  /** 价格表里找不到这个模型时省略。 */
  cost: UsageCostSchema.optional(),
  /** 算成本用的单价（超过 20 万输入 token 时是高档价）。 */
  price: UsagePriceSchema.optional(),
  /** 按哪家的价格算的（models.dev 的服务商 ID，如 `anthropic`）。 */
  priceSource: z.string().optional(),
  durationMs: z.int().min(0).optional(),
  firstTokenMs: z.int().min(0).optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** 速度与首字的原始和，客户端自己除：速度 = `outputTokens / durationMs`，平均首字 = `firstTokenMs / firstTokenCount`。 */
export const UsageTimingSchema = z.object({
  /** 有 `durationMs` 的请求数与它们的输出 token、耗时之和。 */
  timedRequests: z.int().min(0),
  outputTokens: z.int().min(0),
  durationMs: z.int().min(0),
  firstTokenCount: z.int().min(0),
  firstTokenMs: z.int().min(0),
});
export type UsageTiming = z.infer<typeof UsageTimingSchema>;

/** 一组请求的合计。 */
export const UsageAggregateSchema = z.object({
  requests: z.int().min(0),
  tokens: UsageTokensSchema,
  /** 能估价的请求的美元成本之和。 */
  cost: z.number().min(0),
  /** 价格表里找不到模型、没算进 `cost` 的请求数。 */
  unpriced: z.int().min(0),
  timing: UsageTimingSchema,
});
export type UsageAggregate = z.infer<typeof UsageAggregateSchema>;

/** 只统计符合条件的请求；每个数组省略或为空表示不限。 */
export const UsageFilterSchema = z.object({
  sources: z.array(ProviderKindSchema).optional(),
  providerIds: z.array(z.string().min(1)).optional(),
  models: z.array(z.string().min(1)).optional(),
});
export type UsageFilter = z.infer<typeof UsageFilterSchema>;

/** 价格表的状态。 */
export const UsagePricingSchema = z.object({
  /** 固定是 `models.dev`。 */
  source: z.string(),
  /** 现在用的价格表是什么时候从 models.dev 取到的；还没取到过时省略（此时所有请求都不能估价）。 */
  fetchedAt: z.int().min(0).optional(),
  /** 价格表里的模型数。 */
  models: z.int().min(0),
  /** 正在刷新。 */
  refreshing: z.boolean(),
  /** 最近一次刷新失败的原因；之后成功了就省略。 */
  lastError: z.string().optional(),
});
export type UsagePricing = z.infer<typeof UsagePricingSchema>;

/**
 * `usage.summary`：`edges` 是升序的时间点，统计 `[edges[0], edges.at(-1))`，`buckets[i]` 是 `[edges[i], edges[i+1])`。
 * 分桶由客户端按自己的时区算（按小时、按天），最多 `USAGE_MAX_BUCKETS` 个；不是升序时 `INVALID_PARAMS`。
 */
export const UsageSummaryParamsSchema = z.object({
  edges: z.array(z.int().min(0)).min(2),
  filter: UsageFilterSchema.optional(),
});

export const UsageProviderAggregateSchema = UsageAggregateSchema.extend({
  providerId: z.string().min(1),
  providerName: z.string(),
  source: ProviderKindSchema,
});
export type UsageProviderAggregate = z.infer<typeof UsageProviderAggregateSchema>;

export const UsageModelAggregateSchema = UsageAggregateSchema.extend({
  model: z.string().min(1),
});
export type UsageModelAggregate = z.infer<typeof UsageModelAggregateSchema>;

export const UsageSummaryResultSchema = z.object({
  totals: UsageAggregateSchema,
  buckets: z.array(UsageAggregateSchema),
  /** 按请求数从多到少。 */
  byProvider: z.array(UsageProviderAggregateSchema),
  byModel: z.array(UsageModelAggregateSchema),
  /** 这个时间段里出现过的来源、Provider 与模型（不受 `filter` 限制），给筛选菜单用。 */
  options: z.object({
    sources: z.array(ProviderKindSchema),
    providers: z.array(
      z.object({ id: z.string().min(1), name: z.string(), source: ProviderKindSchema }),
    ),
    models: z.array(z.string().min(1)),
  }),
  pricing: UsagePricingSchema,
});
export type UsageSummaryResult = z.infer<typeof UsageSummaryResultSchema>;

/** `usage.records`：`[from, to)` 里的请求，最新的在前，按 `offset` / `limit` 分页（`limit` 最多 `USAGE_RECORDS_PAGE_MAX`）。 */
export const UsageRecordsParamsSchema = z.object({
  from: z.int().min(0),
  to: z.int().min(0),
  filter: UsageFilterSchema.optional(),
  offset: z.int().min(0).optional(),
  limit: z.int().min(1).optional(),
});

export const UsageRecordsResultSchema = z.object({
  records: z.array(UsageRecordSchema),
  /** 符合条件的总数。 */
  total: z.int().min(0),
});

/** `usage.pricing`：价格表的状态；`refresh: true` 时先从 models.dev 重新取（失败不报错，看 `lastError`）。 */
export const UsagePricingParamsSchema = z.object({
  refresh: z.boolean().optional(),
});

export const UsagePricingResultSchema = z.object({
  pricing: UsagePricingSchema,
});

/** `usage.changed` 通知：有了新的请求记录或价格表换了。发给调用过 `usage.*` 的连接，最多每秒一次；客户端重读它在看的。 */
export const UsageChangedParamsSchema = z.object({});
