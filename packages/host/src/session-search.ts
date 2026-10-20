// 会话全文搜索（0.72.0，Host 功能 `session_search`）：用户和 Agent 显式查找以前的工作，结果带原文入口（会话、回合、`seq`）。
//
// 索引（storage 的 `search.ts`）是从事件派生的：只看已提交的用户消息与插话、Agent 的最终回答、命令与改动的文件名，与
// `wevir_session_read` 的条目一一对应（handoff.ts 的 `historyItems`），不看增量、思考与工具的完整输出。索引不存正文，片段与高亮在
// 查询时从事件重新取。每个会话一个水位（索引到哪个 `seq`），后台按批追上；查询前先同步追一小段，追不完就如实报 `indexing`。
//
// 只做显式查找：搜到的旧对话只是材料，不进上下文、不成为记忆，也不是执行授权。

import type {
  SearchHighlight,
  SearchHit,
  SearchIndexStatus,
  SearchQueryParams,
  SearchQueryResult,
  SearchScan,
  SessionId,
  UserContentPart,
  WorkspaceId,
} from '@wevir/protocol';
import { SEARCH_PAGE_MAX, SEARCH_SNIPPET_CHARS } from '@wevir/protocol';
import type { SearchFilter, SearchHitRecord, SearchRepository, Storage } from '@wevir/storage';

/** 索引看的事件类型；其余事件只推进水位。 */
export const SEARCH_SOURCE_TYPES = [
  'session.created',
  'session.handoff',
  'user.message',
  'user.steered',
  'assistant.message',
  'tool.started',
  'turn.undone',
  'turn.redone',
  'turn.rewound',
] as const;

/** 一条最多索引多少个字符（UTF-16）：粘进来的大段日志不让 trigram 倒排无限膨胀。片段同样只在这段里找。 */
export const SEARCH_INDEX_MAX_CHARS = 20_000;
/** 后台一批推进多少个 `seq`（一个事务；大样本上约 40 ms，Host 的事件循环不会卡太久）。 */
export const SEARCH_BATCH_EVENTS = 2_000;
/** 查询前同步追的上限。 */
export const SEARCH_QUERY_CATCH_UP = 2_000;
/** 回退扫描最多看范围内最新的多少条。 */
export const SEARCH_SCAN_LIMIT = 20_000;
/** 混合查询最多核对多少条 FTS 候选。 */
export const SEARCH_MIXED_CANDIDATES = 2_000;
/** 一次查询最多几个词。 */
export const SEARCH_MAX_TERMS = 8;
/** trigram 能匹配的最短词（Unicode 字符）。 */
export const TRIGRAM_MIN_CHARS = 3;
/** 片段里命中处之前留多少字符。 */
const SNIPPET_LEAD = 40;
/** 后台出错（不是索引损坏）之后隔多久再试。 */
const RETRY_MS = 30_000;

export type SearchDocKind = 'user_message' | 'assistant_message' | 'command' | 'file_change';

/** 一个事件对应的索引条目与文本；不进索引的事件是 `undefined`。与 `historyItems` 的取舍一致。 */
export function searchDoc(event: {
  type: string;
  payload: unknown;
}): { kind: SearchDocKind; turnId?: string; text: string } | undefined {
  const payload = event.payload as Record<string, unknown>;
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : undefined;
  let kind: SearchDocKind;
  let text: string;
  switch (event.type) {
    case 'user.message':
    case 'user.steered':
      kind = 'user_message';
      text = (payload.content as UserContentPart[])
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n');
      break;
    case 'assistant.message':
      kind = 'assistant_message';
      text = String(payload.text ?? '');
      break;
    case 'tool.started': {
      const display = (payload.display ?? {}) as {
        kind?: string;
        command?: string;
        summary?: string;
        paths?: string[];
      };
      const toolName = String(payload.toolName ?? '');
      if (display.kind === 'shell') {
        kind = 'command';
        text = display.command ?? display.summary ?? toolName;
      } else if (display.kind === 'edit' || display.kind === 'write') {
        kind = 'file_change';
        text = display.paths?.join('\n') ?? display.summary ?? toolName;
      } else {
        return undefined;
      }
      break;
    }
    default:
      return undefined;
  }
  text = clip(text.trim(), SEARCH_INDEX_MAX_CHARS);
  if (text === '') return undefined;
  return { kind, ...(turnId !== undefined && { turnId }), text };
}

// ── 查询词与匹配 ───────────────────────────────────────────────────

export interface SearchTerm {
  text: string;
  /** 折叠后的（小写、去变音符号），匹配用。 */
  folded: string;
  /** 够长，FTS trigram 能匹配。 */
  indexable: boolean;
}

/** 空白分隔的词，双引号括起来的算一个词；空白折叠，按折叠后去重，最多 `SEARCH_MAX_TERMS` 个。 */
export function parseQuery(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const text = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const folded = fold(text).folded;
    if (folded === '' || seen.has(folded)) continue;
    seen.add(folded);
    terms.push({ text, folded, indexable: Array.from(folded).length >= TRIGRAM_MIN_CHARS });
    if (terms.length >= SEARCH_MAX_TERMS) break;
  }
  return terms;
}

/** FTS5 查询串：每个词一个短语（trigram 下就是子串），都要出现。 */
export function ftsQuery(terms: readonly SearchTerm[]): string {
  return terms.map((term) => `"${term.text.replaceAll('"', '""')}"`).join(' AND ');
}

/**
 * 扫描时给 SQL 预筛的 LIKE 模式：payload 是 JSON，词按 JSON 转义后再转义 `%` `_` `\`。LIKE 只对 ASCII 不分大小写，含有分大小写的
 * 非 ASCII 字母（如希腊、西里尔字母）的词不预筛，只在 JS 里核对。
 */
export function likePattern(term: SearchTerm): string | undefined {
  for (const char of term.text) {
    if (char > '\u007f' && char.toLowerCase() !== char.toUpperCase()) return undefined;
  }
  const json = JSON.stringify(term.text).slice(1, -1);
  return `%${json.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * 按码点折叠：小写、去掉组合附加符号。`starts` / `ends` 把折叠后每个 UTF-16 下标映射回原文的范围，命中处可以换算回原文。
 */
export function fold(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    let mapped = char
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase();
    if (mapped === '') mapped = char;
    for (let i = 0; i < mapped.length; i += 1) {
      starts.push(index);
      ends.push(index + char.length);
    }
    folded += mapped;
    index += char.length;
  }
  return { folded, starts, ends };
}

/** 词在原文里的全部命中（原文 UTF-16 下标），按起点排序、重叠的合并。 */
export function findMatches(text: string, terms: readonly SearchTerm[]): SearchHighlight[] {
  const { folded, starts, ends } = fold(text);
  const ranges: SearchHighlight[] = [];
  for (const term of terms) {
    if (term.folded === '') continue;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term.folded, from);
      if (at < 0) break;
      ranges.push({
        start: starts[at] as number,
        end: ends[at + term.folded.length - 1] as number,
      });
      from = at + term.folded.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchHighlight[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** 每个词都出现。 */
export function containsAll(text: string, terms: readonly SearchTerm[]): boolean {
  const { folded } = fold(text);
  return terms.every((term) => folded.includes(term.folded));
}

/** 片段：空白折叠后，从第一处命中前一点开始截 `SEARCH_SNIPPET_CHARS` 个字符，高亮换算到片段里（含开头的 `…`）。 */
export function snippetOf(
  text: string,
  terms: readonly SearchTerm[],
): { snippet: string; highlights: SearchHighlight[] } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const matches = findMatches(clean, terms);
  let start = 0;
  if (matches.length > 0) start = Math.max(0, (matches[0] as SearchHighlight).start - SNIPPET_LEAD);
  let end = Math.min(clean.length, start + SEARCH_SNIPPET_CHARS);
  if (end - start < SEARCH_SNIPPET_CHARS) start = Math.max(0, end - SEARCH_SNIPPET_CHARS);
  // 不切开代理对。
  if (start > 0 && isLowSurrogate(clean.charCodeAt(start))) start -= 1;
  if (end < clean.length && isLowSurrogate(clean.charCodeAt(end))) end += 1;
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  const highlights = matches.flatMap((match) => {
    const from = Math.max(match.start, start);
    const to = Math.min(match.end, end);
    return from < to
      ? [{ start: from - start + prefix.length, end: to - start + prefix.length }]
      : [];
  });
  return { snippet: `${prefix}${clean.slice(start, end)}${suffix}`, highlights };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = isLowSurrogate(text.charCodeAt(max)) ? max - 1 : max;
  return text.slice(0, end);
}

// ── 索引与查询 ─────────────────────────────────────────────────────

/** 查询时的额外限制：Agent 只能搜它所在的项目。 */
export interface SearchLimits {
  workspaceIds?: readonly WorkspaceId[];
}

export interface SessionSearchOptions {
  storage: Storage;
  onError?: (error: unknown) => void;
  /** 新事件写入后多久追一次索引，默认 250 ms。 */
  liveDelayMs?: number;
  batchEvents?: number;
  scanLimit?: number;
}

export class SearchQueryError extends Error {
  override name = 'SearchQueryError';
}

/** 索引坏了（库文件里的索引页、FTS 表本身）：删掉重建。 */
export function isIndexCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /malformed|corrupt|SQLITE_CORRUPT|vtable constructor failed|no such table: search_/i.test(
    message,
  );
}

export class SessionSearch {
  readonly #storage: Storage;
  readonly #repo: SearchRepository;
  readonly #onError: (error: unknown) => void;
  readonly #liveDelayMs: number;
  readonly #batchEvents: number;
  readonly #scanLimit: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: SessionSearchOptions) {
    this.#storage = options.storage;
    this.#repo = options.storage.search;
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] session search:', error));
    this.#liveDelayMs = options.liveDelayMs ?? 250;
    this.#batchEvents = options.batchEvents ?? SEARCH_BATCH_EVENTS;
    this.#scanLimit = options.scanLimit ?? SEARCH_SCAN_LIMIT;
  }

  /** 开始在后台追索引（Host 启动后调一次）。 */
  start(): void {
    this.#schedule(0);
  }

  /** 有新事件写入（`EventStore.listenAll`）：稍后追一次。 */
  notify(): void {
    if (this.#timer === undefined) this.#schedule(this.#liveDelayMs);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * 同步推进水位，最多推进 `maxEvents` 个 `seq`（增量等不看的事件也算），返回是否还有没追上的会话。每段一个事务；在别人的事务里调用
   * 时什么都不做。
   */
  catchUp(maxEvents: number): boolean {
    if (this.#closed || this.#storage.db.isTransaction) return true;
    let budget = maxEvents;
    const lagging = this.#repo.lagging();
    for (const lag of lagging) {
      let indexed = lag.indexedSeq;
      let provider = lag.providerId;
      while (indexed < lag.lastSeq) {
        if (budget <= 0) return true;
        const through = Math.min(lag.lastSeq, indexed + Math.min(budget, this.#batchEvents));
        const from = indexed;
        provider = this.#storage.transaction(() =>
          this.#indexRange(lag.sessionId, from, through, provider),
        );
        budget -= through - indexed;
        indexed = through;
      }
    }
    return false;
  }

  status(): SearchIndexStatus {
    this.#guard(() => this.catchUp(SEARCH_QUERY_CATCH_UP), undefined);
    return this.#status();
  }

  /** 删掉整个索引重新建（派生数据，事件不动）。 */
  rebuild(): SearchIndexStatus {
    this.#repo.reset();
    this.#schedule(0);
    return this.#status();
  }

  /**
   * 查询：先按范围过滤，再排名与分页。`limits` 是调用方的硬限制（Agent 的项目），与 `params.scope` 取交集。索引坏了时重建并返回
   * 空结果、状态为 `indexing`。
   */
  query(params: SearchQueryParams, limits: SearchLimits = {}): SearchQueryResult {
    const terms = parseQuery(params.query);
    if (terms.length === 0) throw new SearchQueryError('query has no words');
    const limit = Math.min(params.limit ?? 20, SEARCH_PAGE_MAX);
    const offset = params.offset ?? 0;
    const filter = this.#filter(params, limits);
    const result = this.#guard(
      () => {
        this.catchUp(SEARCH_QUERY_CATCH_UP);
        return this.#query(terms, filter, params.sort ?? 'relevance', limit, offset);
      },
      () => ({ hits: [], nextOffset: null, mode: 'index' as const }),
    );
    return { ...result, index: this.#status() };
  }

  #query(
    terms: readonly SearchTerm[],
    filter: SearchFilter,
    sort: 'relevance' | 'recent',
    limit: number,
    offset: number,
  ): Omit<SearchQueryResult, 'index'> {
    const indexable = terms.filter((term) => term.indexable);
    if (this.#repo.fts && indexable.length === terms.length) {
      const rows = this.#repo.match(ftsQuery(terms), filter, { sort, limit: limit + 1, offset });
      const page = rows.slice(0, limit);
      return {
        hits: page.flatMap((row) =>
          this.#hit(row, this.#repo.payload(row.sessionId, row.seq), terms),
        ),
        nextOffset: rows.length > limit ? offset + limit : null,
        mode: 'index',
      };
    }
    if (this.#repo.fts && indexable.length > 0) {
      // 长词走索引，短词在候选里逐条核对。
      const candidates = this.#repo.match(ftsQuery(indexable), filter, {
        sort,
        limit: SEARCH_MIXED_CANDIDATES,
        offset: 0,
      });
      const verified: Array<{ row: SearchHitRecord; text: string }> = [];
      for (const row of candidates) {
        const text = this.#text(row, this.#repo.payload(row.sessionId, row.seq));
        if (text !== undefined && containsAll(text, terms)) verified.push({ row, text });
        if (verified.length > offset + limit) break;
      }
      const scan: SearchScan = {
        examined: candidates.length,
        limit: SEARCH_MIXED_CANDIDATES,
        complete: candidates.length < SEARCH_MIXED_CANDIDATES,
      };
      return {
        hits: verified
          .slice(offset, offset + limit)
          .map(({ row, text }) => this.#build(row, text, terms)),
        nextOffset: verified.length > offset + limit ? offset + limit : null,
        mode: 'mixed',
        scan,
      };
    }
    // 没有能用索引的词（都不足 3 个字符）或没有 FTS5：在范围内最新的若干条里逐条找。
    const likes = terms.flatMap((term) => likePattern(term) ?? []);
    const { examined, hits } = this.#repo.scan(filter, likes, this.#scanLimit);
    const verified: Array<{ row: SearchHitRecord; text: string }> = [];
    for (const row of hits) {
      const text = this.#text(row, row.payload);
      if (text !== undefined && containsAll(text, terms)) verified.push({ row, text });
      if (verified.length > offset + limit) break;
    }
    return {
      hits: verified
        .slice(offset, offset + limit)
        .map(({ row, text }) => this.#build(row, text, terms)),
      nextOffset: verified.length > offset + limit ? offset + limit : null,
      mode: 'scan',
      reason: this.#repo.fts ? 'short_query' : 'fts_unavailable',
      scan: { examined, limit: this.#scanLimit, complete: examined < this.#scanLimit },
    };
  }

  #filter(params: SearchQueryParams, limits: SearchLimits): SearchFilter {
    const scope = params.scope ?? {};
    let workspaceIds: readonly string[] | undefined = scope.workspaceIds;
    if (limits.workspaceIds !== undefined) {
      const allowed = new Set<string>(limits.workspaceIds);
      workspaceIds =
        workspaceIds === undefined
          ? limits.workspaceIds
          : workspaceIds.filter((id) => allowed.has(id));
    }
    return {
      ...(workspaceIds !== undefined && { workspaceIds }),
      ...(scope.sessionIds !== undefined && { sessionIds: scope.sessionIds }),
      ...(scope.kinds !== undefined && { kinds: scope.kinds }),
      ...(scope.providerIds !== undefined && { providerIds: scope.providerIds }),
      ...(scope.since !== undefined && { since: scope.since }),
      ...(scope.until !== undefined && { until: scope.until }),
      ...(scope.includeArchived === true && { includeArchived: true }),
    };
  }

  #text(row: SearchHitRecord, payload: unknown): string | undefined {
    if (payload === undefined) return undefined;
    return searchDoc({ type: eventTypeOf(row.kind), payload })?.text;
  }

  #hit(row: SearchHitRecord, payload: unknown, terms: readonly SearchTerm[]): SearchHit[] {
    const text = this.#text(row, payload);
    return text === undefined ? [] : [this.#build(row, text, terms)];
  }

  #build(row: SearchHitRecord, text: string, terms: readonly SearchTerm[]): SearchHit {
    const { snippet, highlights } = snippetOf(text, terms);
    return {
      sessionId: row.sessionId as SessionId,
      workspaceId: row.workspaceId as WorkspaceId,
      sessionTitle: row.sessionTitle,
      ...(row.parentSessionId !== undefined && {
        parentSessionId: row.parentSessionId as SessionId,
      }),
      ...(row.archived && { archived: true as const }),
      seq: row.seq,
      itemId: `e${row.seq}`,
      ...(row.turnId !== undefined && { turnId: row.turnId as SearchHit['turnId'] }),
      kind: row.kind,
      ...(row.providerId !== undefined && { providerId: row.providerId }),
      ts: row.ts,
      snippet,
      highlights,
    };
  }

  /** 一段事件进索引，返回段末时会话用的 Provider。在事务里调用。 */
  #indexRange(
    sessionId: string,
    afterSeq: number,
    throughSeq: number,
    providerId: string | undefined,
  ): string | undefined {
    let provider = providerId;
    for (const event of this.#repo.sourceEvents(
      sessionId,
      afterSeq,
      throughSeq,
      SEARCH_SOURCE_TYPES,
    )) {
      const payload = event.payload as Record<string, unknown>;
      switch (event.type) {
        case 'session.created':
          provider = String(payload.providerId);
          break;
        case 'session.handoff':
          provider = String((payload.to as { providerId: string }).providerId);
          break;
        case 'turn.undone':
          this.#repo.setTurnHidden(sessionId, String(payload.turnId), true);
          break;
        case 'turn.redone':
          this.#repo.setTurnHidden(sessionId, String(payload.turnId), false);
          break;
        case 'turn.rewound':
          this.#repo.removeTurn(sessionId, String(payload.turnId));
          break;
        default: {
          const doc = searchDoc(event);
          if (doc === undefined) break;
          this.#repo.insert(
            {
              sessionId,
              seq: event.seq,
              ...(doc.turnId !== undefined && { turnId: doc.turnId }),
              kind: doc.kind,
              ...(provider !== undefined && { providerId: provider }),
              ts: event.ts,
            },
            doc.text,
          );
        }
      }
    }
    this.#repo.setProgress(sessionId, throughSeq, provider);
    return provider;
  }

  #status(): SearchIndexStatus {
    const pending = this.#repo.pending();
    return {
      state: pending.sessions > 0 ? 'indexing' : 'ready',
      fts: this.#repo.fts,
      pendingSessions: pending.sessions,
      pendingEvents: pending.events,
    };
  }

  /** 跑 `fn`；索引坏了就重建，有 `fallback` 时返回它（没有时照样抛）。 */
  #guard<T>(fn: () => T, fallback: (() => T) | undefined): T {
    try {
      return fn();
    } catch (error) {
      if (!isIndexCorruption(error)) throw error;
      this.#onError(error);
      this.rebuild();
      if (fallback === undefined) throw error;
      return fallback();
    }
  }

  #schedule(delayMs: number): void {
    if (this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#tick();
    }, delayMs);
    this.#timer.unref?.();
  }

  #tick(): void {
    try {
      if (this.catchUp(this.#batchEvents)) this.#schedule(0);
    } catch (error) {
      this.#onError(error);
      if (isIndexCorruption(error)) {
        try {
          this.rebuild();
        } catch (rebuildError) {
          this.#onError(rebuildError);
          this.#schedule(RETRY_MS);
        }
      } else {
        this.#schedule(RETRY_MS);
      }
    }
  }
}

/** 索引条目的种类 → 取文用的事件类型（插话与用户消息取文相同）。 */
function eventTypeOf(kind: string): string {
  switch (kind) {
    case 'user_message':
      return 'user.message';
    case 'assistant_message':
      return 'assistant.message';
    default:
      return 'tool.started';
  }
}
