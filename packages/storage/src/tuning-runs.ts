import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, optionalJson, optionalText, text, toNullableJson } from './rows.js';

/** `tuning_runs` 表的一行（0024_tuning_auto，协议 0.108.0）：一次调模型生成建议。 */
export interface TuningRunRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** `auto` 后台生成，`user` 用户点的生成。 */
  origin: string;
  /** `{inputTokens, outputTokens}`；引擎没报告时省略。 */
  usage?: unknown;
  /** 进入试用的条数。 */
  proposals: number;
  /** 没生成时的原因。 */
  reason?: string;
  createdAt: string;
}

/**
 * 一个会话里结束了的回合（`turn.finished`）：`turns` 是 completed 与 failed 的，`failedTurns` 是 failed 的；另有护栏命中次数，与用量记录里
 * 输入加输出的 token（没有用量记录时省略）。
 */
export interface SessionTurnCounts {
  turns: number;
  failedTurns: number;
  guardrailHits: number;
  tokens?: number;
}

export interface TuningRunRepository {
  insert(record: TuningRunRecord): void;
  /** 最新的一次；给了条件只看符合的。 */
  latest(options?: {
    workspaceId?: string;
    sessionId?: string;
    origin?: string;
  }): TuningRunRecord | undefined;
  /** `createdAt` 不早于 `since` 的，旧的在前（本月的消耗）。 */
  since(since: string): TuningRunRecord[];
  /** 这些会话的回合、护栏命中与 token（试用与总览的指标）；没有事件也没有用量记录的会话不在结果里。 */
  sessionCounts(sessionIds: readonly string[]): Map<string, SessionTurnCounts>;
  /** 这个会话在 `since` 之后结束了几个回合（completed 与 failed）。 */
  turnsSince(sessionId: string, since: string): number;
}

/** 一次查询最多带几个会话 ID（SQLite 的参数个数有上限）。 */
const IDS_PER_QUERY = 500;

export function createTuningRunRepository(db: SqliteDatabase): TuningRunRepository {
  const insert = db.prepare(`
    INSERT INTO tuning_runs (id, workspace_id, session_id, origin, usage_json, proposals, reason, created_at)
    VALUES (:id, :workspaceId, :sessionId, :origin, :usage, :proposals, :reason, :createdAt)`);
  const since = db.prepare(
    'SELECT * FROM tuning_runs WHERE created_at >= ? ORDER BY created_at, rowid',
  );
  const turnsSince = db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE session_id = ? AND type = 'turn.finished' AND ts > ?
      AND json_extract(payload, '$.outcome') IN ('completed', 'failed')`);

  return {
    insert(record) {
      insert.run({
        id: record.id,
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        origin: record.origin,
        usage: toNullableJson(record.usage),
        proposals: record.proposals,
        reason: record.reason ?? null,
        createdAt: record.createdAt,
      });
    },
    latest(options = {}) {
      const where: string[] = [];
      const args: string[] = [];
      if (options.workspaceId !== undefined) {
        where.push('workspace_id = ?');
        args.push(options.workspaceId);
      }
      if (options.sessionId !== undefined) {
        where.push('session_id = ?');
        args.push(options.sessionId);
      }
      if (options.origin !== undefined) {
        where.push('origin = ?');
        args.push(options.origin);
      }
      const sql = `SELECT * FROM tuning_runs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const row = db.prepare(sql).get(...args);
      return row ? fromRow(row) : undefined;
    },
    since: (at) => since.all(at).map(fromRow),
    sessionCounts(sessionIds) {
      const counts = new Map<string, SessionTurnCounts>();
      for (let start = 0; start < sessionIds.length; start += IDS_PER_QUERY) {
        const ids = sessionIds.slice(start, start + IDS_PER_QUERY);
        const rows = db
          .prepare(`
            SELECT session_id,
              SUM(CASE WHEN type = 'turn.finished'
                AND json_extract(payload, '$.outcome') IN ('completed', 'failed') THEN 1 ELSE 0 END) AS turns,
              SUM(CASE WHEN type = 'turn.finished'
                AND json_extract(payload, '$.outcome') = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN type = 'guardrail.blocked' THEN 1 ELSE 0 END) AS hits
            FROM events
            WHERE session_id IN (${ids.map(() => '?').join(', ')})
              AND type IN ('turn.finished', 'guardrail.blocked')
            GROUP BY session_id`)
          .all(...ids);
        for (const row of rows) {
          counts.set(text(row, 'session_id'), {
            turns: integer(row, 'turns'),
            failedTurns: integer(row, 'failed'),
            guardrailHits: integer(row, 'hits'),
          });
        }
        const usage = db
          .prepare(`
            SELECT session_id, SUM(input_tokens + output_tokens) AS tokens FROM usage_records
            WHERE session_id IN (${ids.map(() => '?').join(', ')}) GROUP BY session_id`)
          .all(...ids);
        for (const row of usage) {
          const id = text(row, 'session_id');
          const entry = counts.get(id) ?? { turns: 0, failedTurns: 0, guardrailHits: 0 };
          counts.set(id, { ...entry, tokens: integer(row, 'tokens') });
        }
      }
      return counts;
    },
    turnsSince: (sessionId, at) => integer(turnsSince.get(sessionId, at) ?? { n: 0 }, 'n'),
  };
}

function fromRow(row: SqlRow): TuningRunRecord {
  const usage = optionalJson(row, 'usage_json');
  const reason = optionalText(row, 'reason');
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    sessionId: text(row, 'session_id'),
    origin: text(row, 'origin'),
    ...(usage !== undefined && { usage }),
    proposals: integer(row, 'proposals'),
    ...(reason !== undefined && { reason }),
    createdAt: text(row, 'created_at'),
  };
}
