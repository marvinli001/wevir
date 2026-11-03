import type { SqliteDatabase, SqlRow } from './driver.js';
import { text } from './rows.js';

export interface SessionContextRecord {
  sessionId: string;
  engineSessionKey: string;
  text: string;
  hash: string;
  receipt: string;
  createdAt: string;
}
export interface SessionContextRepository {
  get(sessionId: string, engineSessionKey: string): SessionContextRecord | undefined;
  put(record: SessionContextRecord): void;
}
export function createSessionContextRepository(db: SqliteDatabase): SessionContextRepository {
  const get = db.prepare(
    'SELECT * FROM session_contexts WHERE session_id=? AND engine_session_key=?',
  );
  const put = db.prepare(
    'INSERT INTO session_contexts VALUES(:sessionId,:engineSessionKey,:text,:hash,:receipt,:createdAt) ON CONFLICT DO NOTHING',
  );
  return {
    get(sessionId, key) {
      const row = get.get(sessionId, key) as SqlRow | undefined;
      return row === undefined
        ? undefined
        : {
            sessionId: text(row, 'session_id'),
            engineSessionKey: text(row, 'engine_session_key'),
            text: text(row, 'text'),
            hash: text(row, 'hash'),
            receipt: text(row, 'receipt_json'),
            createdAt: text(row, 'created_at'),
          };
    },
    put(record) {
      put.run({ ...record });
    },
  };
}
