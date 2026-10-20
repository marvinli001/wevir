// 会话全文搜索（0.77.0，Host 功能 `session_search`）。
//
// 用户和 Agent 显式查找以前的工作：已提交的用户消息与插话、Agent 的最终回答、命令与改动的文件名。不含思考、增量与工具的完整输出。
// 索引是 Host 从事件派生的，不存正文：片段在查询时从事件重新取。搜到的内容只是材料，不会自动进上下文、成为记忆或授权。

import { z } from 'zod';
import {
  IsoTimeSchema,
  ProviderIdSchema,
  SeqSchema,
  SessionIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';

/** 查询串的上限（字符）。 */
export const SEARCH_QUERY_MAX_LENGTH = 200;
/** 一页最多几条。 */
export const SEARCH_PAGE_MAX = 50;
/** 片段的长度（字符，不含两端的省略号）。 */
export const SEARCH_SNIPPET_CHARS = 160;

/**
 * 一条结果是什么：`user_message` 用户消息与插话，`assistant_message` Agent 的回答，`command` 命令，`file_change` 改动的文件。开放
 * 字符串；查询里认不出的种类匹配不到任何东西。
 */
export const SEARCH_KINDS = [
  'user_message',
  'assistant_message',
  'command',
  'file_change',
] as const;
export const SearchKindSchema = z.string().min(1);
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** 查询的范围：先按它过滤，再排名与分页。 */
export const SearchScopeSchema = z.object({
  workspaceIds: z.array(WorkspaceIdSchema).max(100).optional(),
  sessionIds: z.array(SessionIdSchema).max(100).optional(),
  kinds: z.array(SearchKindSchema).max(20).optional(),
  /** 写这条时会话用的 Provider（接力之后算新的）。 */
  providerIds: z.array(ProviderIdSchema).max(50).optional(),
  /** 含两端。 */
  since: IsoTimeSchema.optional(),
  until: IsoTimeSchema.optional(),
  /** 默认不含已归档的会话；子会话看它的父会话。支线会话（只在父会话的窗格里）不在搜索范围内。 */
  includeArchived: z.boolean().optional(),
});
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchQueryParamsSchema = z.object({
  /** 空白分隔的词，都要出现；双引号括起来的算一个词。 */
  query: z.string().min(1).max(SEARCH_QUERY_MAX_LENGTH),
  scope: SearchScopeSchema.optional(),
  /** 默认 `relevance`；`recent` 按时间从新到旧。扫描（短查询）总是按时间。 */
  sort: z.enum(['relevance', 'recent']).optional(),
  limit: z.int().min(1).max(SEARCH_PAGE_MAX).optional(),
  offset: z.int().min(0).optional(),
});
export type SearchQueryParams = z.infer<typeof SearchQueryParamsSchema>;

/** 片段里命中的一段：UTF-16 下标，`[start, end)`。 */
export const SearchHighlightSchema = z.object({
  start: z.int().min(0),
  end: z.int().min(0),
});
export type SearchHighlight = z.infer<typeof SearchHighlightSchema>;

export const SearchHitSchema = z.object({
  sessionId: SessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionTitle: z.string(),
  /** 子会话的父会话；打开时进父会话的子会话视图。 */
  parentSessionId: SessionIdSchema.optional(),
  archived: z.literal(true).optional(),
  /** 原文入口：事件的 `seq`；`itemId` 是 `wevir_session_read` 的条目（`e<seq>`）。 */
  seq: SeqSchema,
  itemId: z.string().min(1),
  turnId: TurnIdSchema.optional(),
  kind: SearchKindSchema,
  providerId: ProviderIdSchema.optional(),
  ts: IsoTimeSchema,
  /** 折叠了空白的原文片段，前后截掉的地方是 `…`。 */
  snippet: z.string(),
  highlights: z.array(SearchHighlightSchema),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * 索引的状态：`ready` 已追上所有会话；`indexing` 还有会话没索引完（结果可能缺这些会话的内容，界面要说“索引中”，不能说没有）。
 * `fts` 为 false 时这个运行时的 SQLite 没有 FTS5 trigram，所有查询都是有上限的扫描。
 */
export const SearchIndexStatusSchema = z.object({
  state: z.enum(['ready', 'indexing']),
  fts: z.boolean(),
  pendingSessions: z.int().min(0),
  pendingEvents: z.int().min(0),
});
export type SearchIndexStatus = z.infer<typeof SearchIndexStatusSchema>;

/**
 * 回退扫描的范围：`examined` 是实际看了多少条（按时间从新到旧，或按相关度的前若干条），`limit` 是上限，`complete` 为 false 时更早的
 * 内容没有看过，空结果不代表没有。
 */
export const SearchScanSchema = z.object({
  examined: z.int().min(0),
  limit: z.int().min(1),
  complete: z.boolean(),
});
export type SearchScan = z.infer<typeof SearchScanSchema>;

export const SearchQueryResultSchema = z.object({
  hits: z.array(SearchHitSchema),
  nextOffset: z.int().min(0).nullable(),
  /**
   * `index` 全部经全文索引；`mixed` 长词经索引、不足 3 个字符的词在候选里逐条核对；`scan` 没有能用索引的词（都不足 3 个字符）或
   * 没有 FTS5，在范围内最新的若干条里逐条找。后两种带 `scan`。
   */
  mode: z.enum(['index', 'mixed', 'scan']),
  /** `scan` 的原因：`short_query`、`fts_unavailable`；开放字符串。 */
  reason: z.string().min(1).optional(),
  scan: SearchScanSchema.optional(),
  index: SearchIndexStatusSchema,
});
export type SearchQueryResult = z.infer<typeof SearchQueryResultSchema>;
