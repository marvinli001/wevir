import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, integer, optionalText, orNull, text } from './rows.js';

/** `usage_records` 表的一行（0011_usage_records，协议 0.62.0 的用量统计）：一次模型请求。时间是 Unix 毫秒。 */
export interface UsageRow {
  sessionId: string;
  requestId: string;
  at: number;
  /** 会话来源的种类（protocol `ProviderKind`）。 */
  source: string;
  providerId: string;
  providerName: string;
  upstream?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs?: number;
  firstTokenMs?: number;
}

/** 读出来的行多一个自增 `id`。 */
export interface StoredUsageRow extends UsageRow {
  id: number;
}

/** 每个数组省略表示不限，空数组表示什么都不要。 */
export interface UsageRowFilter {
  sources?: readonly string[];
  providerIds?: readonly string[];
  models?: readonly string[];
}

export interface UsageRepository {
  /** 记一次请求；`(sessionId, requestId)` 已有时不写，返回 false。 */
  insert(row: UsageRow): boolean;
  /** `[from, to)` 里的全部请求，按时间升序。 */
  range(from: number, to: number): StoredUsageRow[];
  /** `[from, to)` 里符合条件的请求，最新的在前，跳过 `offset` 条后最多 `limit` 条；`total` 是符合条件的总数。 */
  page(
    from: number,
    to: number,
    filter: UsageRowFilter,
    offset: number,
    limit: number,
  ): { rows: StoredUsageRow[]; total: number };
  /** 删一个 Provider 的全部记录（删 Provider 时），返回删了几条。 */
  deleteProvider(providerId: string): number;
}

export function createUsageRepository(db: SqliteDatabase): UsageRepository {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_records (
      session_id, request_id, at, source, provider_id, provider_name, upstream, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      duration_ms, first_token_ms
    ) VALUES (
      :sessionId, :requestId, :at, :source, :providerId, :providerName, :upstream, :model,
      :inputTokens, :outputTokens, :cacheReadTokens, :cacheWriteTokens, :reasoningTokens,
      :durationMs, :firstTokenMs
    )`);
  const range = db.prepare('SELECT * FROM usage_records WHERE at >= ? AND at < ? ORDER BY at, id');
  // 数组条件用 JSON 传：NULL 表示不限。
  const where = `
    WHERE at >= :from AND at < :to
      AND (:sources IS NULL OR source IN (SELECT value FROM json_each(:sources)))
      AND (:providerIds IS NULL OR provider_id IN (SELECT value FROM json_each(:providerIds)))
      AND (:models IS NULL OR model IN (SELECT value FROM json_each(:models)))`;
  const page = db.prepare(
    `SELECT * FROM usage_records ${where} ORDER BY at DESC, id DESC LIMIT :limit OFFSET :offset`,
  );
  const count = db.prepare(`SELECT COUNT(*) AS n FROM usage_records ${where}`);
  const deleteProvider = db.prepare('DELETE FROM usage_records WHERE provider_id = ?');

  return {
    insert(row) {
      return changed(
        insert.run({
          sessionId: row.sessionId,
          requestId: row.requestId,
          at: row.at,
          source: row.source,
          providerId: row.providerId,
          providerName: row.providerName,
          upstream: orNull(row.upstream),
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          reasoningTokens: row.reasoningTokens,
          durationMs: orNull(row.durationMs),
          firstTokenMs: orNull(row.firstTokenMs),
        }),
      );
    },
    range: (from, to) => range.all(from, to).map(fromRow),
    page(from, to, filter, offset, limit) {
      const params = {
        from,
        to,
        sources: jsonOrNull(filter.sources),
        providerIds: jsonOrNull(filter.providerIds),
        models: jsonOrNull(filter.models),
      };
      return {
        rows: page.all({ ...params, limit, offset }).map(fromRow),
        total: integer(count.get(params) ?? {}, 'n'),
      };
    },
    deleteProvider: (providerId) => Number(deleteProvider.run(providerId).changes),
  };
}

function jsonOrNull(values: readonly string[] | undefined): string | null {
  return values === undefined ? null : JSON.stringify(values);
}

function optionalInteger(row: SqlRow, column: string): number | undefined {
  return row[column] === null ? undefined : integer(row, column);
}

function fromRow(row: SqlRow): StoredUsageRow {
  const upstream = optionalText(row, 'upstream');
  const durationMs = optionalInteger(row, 'duration_ms');
  const firstTokenMs = optionalInteger(row, 'first_token_ms');
  return {
    id: integer(row, 'id'),
    sessionId: text(row, 'session_id'),
    requestId: text(row, 'request_id'),
    at: integer(row, 'at'),
    source: text(row, 'source'),
    providerId: text(row, 'provider_id'),
    providerName: text(row, 'provider_name'),
    ...(upstream !== undefined && { upstream }),
    model: text(row, 'model'),
    inputTokens: integer(row, 'input_tokens'),
    outputTokens: integer(row, 'output_tokens'),
    cacheReadTokens: integer(row, 'cache_read_tokens'),
    cacheWriteTokens: integer(row, 'cache_write_tokens'),
    reasoningTokens: integer(row, 'reasoning_tokens'),
    ...(durationMs !== undefined && { durationMs }),
    ...(firstTokenMs !== undefined && { firstTokenMs }),
  };
}
