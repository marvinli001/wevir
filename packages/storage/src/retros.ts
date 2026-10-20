import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, text } from './rows.js';

/**
 * `session_retros` 的一行（0016，任务回顾的投影）：`state` 是归约状态的 JSON 原文，由 Host 解析与校验——解析不了说明投影坏了，
 * Host 从事件重建，所以这里不解析。
 */
export interface RetroProjectionRecord {
  sessionId: string;
  schemaVersion: number;
  throughSeq: number;
  state: string;
  builtAt: string;
  updatedAt: string;
}

/** `session_retro_summaries` 的一行：模型摘要的 JSON 原文（协议的 `RetroSummary`），同样由 Host 解析。 */
export interface RetroSummaryRecord {
  sessionId: string;
  summary: string;
  createdAt: string;
}

export interface RetroRepository {
  get(sessionId: string): RetroProjectionRecord | undefined;
  /** 写入或替换一个会话的投影。 */
  put(record: RetroProjectionRecord): void;
  /** 删掉一个会话的投影（下次从头重放）；返回是否有行。 */
  remove(sessionId: string): boolean;
  getSummary(sessionId: string): RetroSummaryRecord | undefined;
  /** 写入或替换一个会话的摘要（每个会话留最近一份）。 */
  putSummary(record: RetroSummaryRecord): void;
}

export function createRetroRepository(db: SqliteDatabase): RetroRepository {
  const get = db.prepare('SELECT * FROM session_retros WHERE session_id = ?');
  const put = db.prepare(`
    INSERT INTO session_retros (session_id, schema_version, through_seq, state, built_at, updated_at)
    VALUES (:sessionId, :schemaVersion, :throughSeq, :state, :builtAt, :updatedAt)
    ON CONFLICT (session_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      through_seq = excluded.through_seq,
      state = excluded.state,
      built_at = excluded.built_at,
      updated_at = excluded.updated_at`);
  const remove = db.prepare('DELETE FROM session_retros WHERE session_id = ?');
  const getSummary = db.prepare('SELECT * FROM session_retro_summaries WHERE session_id = ?');
  const putSummary = db.prepare(`
    INSERT INTO session_retro_summaries (session_id, summary, created_at)
    VALUES (:sessionId, :summary, :createdAt)
    ON CONFLICT (session_id) DO UPDATE SET
      summary = excluded.summary,
      created_at = excluded.created_at`);
  return {
    get(sessionId) {
      const row = get.get(sessionId) as SqlRow | undefined;
      return row === undefined
        ? undefined
        : {
            sessionId: text(row, 'session_id'),
            schemaVersion: integer(row, 'schema_version'),
            throughSeq: integer(row, 'through_seq'),
            state: text(row, 'state'),
            builtAt: text(row, 'built_at'),
            updatedAt: text(row, 'updated_at'),
          };
    },
    put(record) {
      put.run({ ...record });
    },
    remove(sessionId) {
      return remove.run(sessionId).changes > 0;
    },
    getSummary(sessionId) {
      const row = getSummary.get(sessionId) as SqlRow | undefined;
      return row === undefined
        ? undefined
        : {
            sessionId: text(row, 'session_id'),
            summary: text(row, 'summary'),
            createdAt: text(row, 'created_at'),
          };
    },
    putSummary(record) {
      putSummary.run({ ...record });
    },
  };
}
