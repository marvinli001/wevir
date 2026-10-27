import type { SqliteDatabase } from './driver.js';
import { integer, text } from './rows.js';

// 会话投影的检查点：Host 内存里那份由事件推导的投影（`SessionProjection`）存到某个 `seq` 为止的样子，启动时从这里接着重放，
// 不必每个会话都从第一条事件重放。
//
// - **派生数据，不走迁移。** 打开库时建好；表坏了就删掉重建，不挡住 Host 启动。检查点没有、过期或读不出来时一律从头重放，
//   结果不变，只是慢。
// - **内容是 Host 的事。** `code` 标识算出它的投影代码（Host 换了投影代码，旧检查点作废），`data` 是 Host 序列化的投影；存储层
//   不解读。
// - **删会话一起删。** 对 `sessions` 是 ON DELETE CASCADE，与 `sessions.remove` 在同一个事务里。

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_projections (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  code        TEXT NOT NULL,
  data        BLOB NOT NULL
) STRICT;`;

/** 一个会话的投影检查点。 */
export interface ProjectionCheckpoint {
  /** 投影已应用到的最后一个事件。 */
  seq: number;
  /** 算出它的投影代码的标识。 */
  code: string;
  data: Uint8Array;
}

export interface ProjectionRepository {
  get(sessionId: string): ProjectionCheckpoint | undefined;
  /** 写入（替换）会话的检查点。 */
  put(sessionId: string, checkpoint: ProjectionCheckpoint): void;
}

export function createProjectionRepository(db: SqliteDatabase): ProjectionRepository {
  try {
    db.exec(TABLE_DDL);
  } catch {
    db.exec('DROP TABLE IF EXISTS session_projections');
    db.exec(TABLE_DDL);
  }
  const get = db.prepare('SELECT seq, code, data FROM session_projections WHERE session_id = ?');
  const put = db.prepare(`
    INSERT INTO session_projections (session_id, seq, code, data) VALUES (:sessionId, :seq, :code, :data)
    ON CONFLICT (session_id) DO UPDATE SET seq = excluded.seq, code = excluded.code, data = excluded.data`);

  return {
    get(sessionId) {
      const row = get.get(sessionId);
      if (!row || !(row.data instanceof Uint8Array)) return undefined;
      return { seq: integer(row, 'seq'), code: text(row, 'code'), data: row.data };
    },
    put(sessionId, checkpoint) {
      put.run({ sessionId, seq: checkpoint.seq, code: checkpoint.code, data: checkpoint.data });
    },
  };
}
