import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, integer, optionalText, orNull, text } from './rows.js';

/** `usage_records` 表的一行（0011_usage_records，协议 0.62.0 的用量统计）：一次模型请求。时间是 Unix 毫秒。 */
export interface UsageRow {
  sessionId: string;
  requestId: string;
  turnId?: string;
  workspaceId?: string;
  kind?: string;
  origin?: string;
  granularity?: string;
  modelCalls?: number;
  usageReported?: boolean;
  outcome?: string;
  supply?: UsageSupply;
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

export interface UsageSupply {
  toolCount: number;
  toolBytes: number;
  mcpNoteBytes: number;
  instructionBytes: number;
  requestBytes: number;
  wevirOutputBytes: number;
  wevirOutputBytesNew: number;
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
  byTurn(sessionIds: readonly string[]): UsageTurnRow[];
  /** 删一个 Provider 的全部记录（删 Provider 时），返回删了几条。 */
  deleteProvider(providerId: string): number;
  /** 一个会话记了几次请求，与输入、缓存写入、输出的 token 合计（不含缓存读取）。 */
  sessionTotals(sessionId: string): { requests: number; tokens: number };
}

export function createUsageRepository(db: SqliteDatabase): UsageRepository {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_records (
      session_id, request_id, at, source, provider_id, provider_name, upstream, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      duration_ms, first_token_ms, turn_id, workspace_id, kind, origin, granularity,
      model_calls, usage_reported, outcome, tool_count, tool_bytes, mcp_note_bytes,
      instruction_bytes, request_bytes, wevir_output_bytes, wevir_output_bytes_new
    ) VALUES (
      :sessionId, :requestId, :at, :source, :providerId, :providerName, :upstream, :model,
      :inputTokens, :outputTokens, :cacheReadTokens, :cacheWriteTokens, :reasoningTokens,
      :durationMs, :firstTokenMs, :turnId, :workspaceId, :kind, :origin, :granularity,
      :modelCalls, :usageReported, :outcome, :toolCount, :toolBytes, :mcpNoteBytes,
      :instructionBytes, :requestBytes, :wevirOutputBytes, :wevirOutputBytesNew
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
  const sessionTotals = db.prepare(`
    SELECT COUNT(*) AS requests,
      COALESCE(SUM(input_tokens + cache_write_tokens + output_tokens), 0) AS tokens
    FROM usage_records WHERE session_id = ?`);

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
          turnId: orNull(row.turnId),
          workspaceId: orNull(row.workspaceId),
          kind: orNull(row.kind),
          origin: orNull(row.origin),
          granularity: orNull(row.granularity),
          modelCalls: orNull(row.modelCalls),
          usageReported: row.usageReported === undefined ? null : Number(row.usageReported),
          outcome: orNull(row.outcome),
          toolCount: orNull(row.supply?.toolCount),
          toolBytes: orNull(row.supply?.toolBytes),
          mcpNoteBytes: orNull(row.supply?.mcpNoteBytes),
          instructionBytes: orNull(row.supply?.instructionBytes),
          requestBytes: orNull(row.supply?.requestBytes),
          wevirOutputBytes: orNull(row.supply?.wevirOutputBytes),
          wevirOutputBytesNew: orNull(row.supply?.wevirOutputBytesNew),
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
    byTurn(sessionIds) {
      const ids = JSON.stringify(sessionIds);
      const turns = new Map<string, UsageTurnRow>();
      const get = (sessionId: string, turnId?: string) => {
        const key = JSON.stringify([sessionId, turnId]);
        let turn = turns.get(key);
        if (turn === undefined) {
          turn = {
            sessionId,
            ...(turnId !== undefined && { turnId }),
            compactions: { manual: 0, auto: 0 },
            groups: [],
          };
          turns.set(key, turn);
        }
        return turn;
      };
      for (const event of db
        .prepare(`SELECT session_id, ts, type, payload FROM events
        WHERE session_id IN (SELECT value FROM json_each(?))
          AND type IN ('turn.started', 'turn.finished', 'context.compacted') ORDER BY session_id, seq`)
        .all(ids)) {
        const payload = JSON.parse(text(event, 'payload')) as {
          turnId: string;
          outcome?: string;
          trigger?: 'manual' | 'auto';
        };
        const turn = get(text(event, 'session_id'), payload.turnId);
        if (event.type === 'turn.started') turn.startedAt = text(event, 'ts');
        else if (event.type === 'turn.finished') {
          turn.finishedAt = text(event, 'ts');
          if (payload.outcome !== undefined) turn.outcome = payload.outcome;
        } else if (payload.trigger !== undefined) turn.compactions[payload.trigger] += 1;
      }
      const rows = db
        .prepare(`SELECT * FROM usage_records
        WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY at, id`)
        .all(ids)
        .map(fromRow);
      for (const row of rows) {
        const turn = get(row.sessionId, row.turnId);
        const precision = usagePrecision(row);
        let group = turn.groups.find((item) => item.precision === precision);
        if (group === undefined) {
          group = {
            precision,
            requests: 0,
            byKind: {},
            tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
            missingUsage: 0,
            records: [],
          };
          turn.groups.push(group);
        }
        const requests = precision === 'turn' ? row.modelCalls : 1;
        if (requests === undefined) group.requests = undefined;
        else if (group.requests !== undefined) group.requests += requests;
        if (requests !== undefined)
          group.byKind[row.kind ?? 'unknown'] =
            (group.byKind[row.kind ?? 'unknown'] ?? 0) + requests;
        if (row.usageReported === false) group.missingUsage += 1;
        else {
          group.tokens.input += row.inputTokens;
          group.tokens.cacheRead += row.cacheReadTokens;
          group.tokens.cacheWrite += row.cacheWriteTokens;
          group.tokens.output += row.outputTokens;
          group.tokens.reasoning += row.reasoningTokens;
        }
        group.records.push(row);
      }
      return [...turns.values()];
    },
    deleteProvider: (providerId) => Number(deleteProvider.run(providerId).changes),
    sessionTotals(sessionId) {
      const row = sessionTotals.get(sessionId) ?? {};
      return { requests: integer(row, 'requests'), tokens: integer(row, 'tokens') };
    },
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
    ...ledgerFields(row),
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

function ledgerFields(row: SqlRow): Partial<UsageRow> {
  const result: Partial<UsageRow> = {};
  for (const [key, column] of [
    ['turnId', 'turn_id'],
    ['workspaceId', 'workspace_id'],
    ['kind', 'kind'],
    ['origin', 'origin'],
    ['granularity', 'granularity'],
    ['outcome', 'outcome'],
  ] as const) {
    const value = optionalText(row, column);
    if (value !== undefined) result[key] = value;
  }
  const modelCalls = optionalInteger(row, 'model_calls');
  if (modelCalls !== undefined) result.modelCalls = modelCalls;
  if (row.usage_reported !== null) result.usageReported = row.usage_reported === 1;
  if (row.tool_count !== null)
    result.supply = {
      toolCount: integer(row, 'tool_count'),
      toolBytes: integer(row, 'tool_bytes'),
      mcpNoteBytes: integer(row, 'mcp_note_bytes'),
      instructionBytes: integer(row, 'instruction_bytes'),
      requestBytes: integer(row, 'request_bytes'),
      wevirOutputBytes: integer(row, 'wevir_output_bytes'),
      wevirOutputBytesNew: integer(row, 'wevir_output_bytes_new'),
    };
  return result;
}

export interface UsageTurnRow {
  sessionId: string;
  turnId?: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: string;
  compactions: { manual: number; auto: number };
  groups: Array<{
    precision: 'exact' | 'engine' | 'turn';
    requests: number | undefined;
    byKind: Record<string, number>;
    tokens: {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      reasoning: number;
    };
    missingUsage: number;
    records: StoredUsageRow[];
  }>;
}

export function usagePrecision(row: UsageRow): 'exact' | 'engine' | 'turn' {
  if (
    row.granularity === 'turn' ||
    (row.granularity === undefined && ['cursor', 'grok'].includes(row.source))
  )
    return 'turn';
  return row.origin === 'gateway' ? 'exact' : 'engine';
}
