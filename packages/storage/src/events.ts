import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, json, text, toJson } from './rows.js';

/**
 * `events` 表的一行：protocol `WevirEventEnvelope` 的存储形式。`payload` 的形状按 `type` 由 protocol
 * 定义，这里原样存 JSON。
 */
export interface EventRecord {
  sessionId: string;
  /** 会话内从 1 开始连续递增，`(sessionId, seq)` 唯一。 */
  seq: number;
  ts: string;
  type: string;
  source: string;
  payload: unknown;
}

/**
 * 事件行的读写。只追加，不提供修改和删除。`seq` 由调用方给出；原子分配、合并增量与回放是事件库
 * （T2.2）的事，它在 `transaction()` 里组合这里的函数。
 */
export interface EventRepository {
  /** 追加一条事件；`(sessionId, seq)` 已存在时抛主键约束错误，会话不存在时抛外键错误。 */
  insert(event: EventRecord): void;
  /** 按 `seq` 升序读取 `seq > afterSeq`（默认 0，即从头）的事件，最多 `limit` 条（默认不限）。 */
  list(sessionId: string, options?: { afterSeq?: number; limit?: number }): EventRecord[];
  /**
   * 同 `list`（不限条数），但逐行读出，不把结果一次全读进内存：长会话从头重放时内存不随会话长度涨。迭代完（或中途放弃）之前别再
   * 调用它。
   */
  iterate(sessionId: string, options?: { afterSeq?: number }): IterableIterator<EventRecord>;
  /** 会话里最大的 `seq`；没有事件时为 0。 */
  lastSeq(sessionId: string): number;
  /** 每个会话的事件 payload 的字节数之和（0.43.0，`session.usage`）；没有事件的会话不在里面。 */
  payloadBytes(): Map<string, number>;
  /**
   * 事件里引用的消息图片（0.43.0）：图片 ID → 引用它的会话。只看 payload 里 `"imageId":"…"` 的写法（Host 写事件时的 JSON 没有空格）。
   */
  imageRefs(): Map<string, Set<string>>;
}

export function createEventRepository(db: SqliteDatabase): EventRepository {
  const insert = db.prepare(`
    INSERT INTO events (session_id, seq, ts, type, source, payload)
    VALUES (:sessionId, :seq, :ts, :type, :source, :payload)`);
  // LIMIT -1 表示不限。
  const list = db.prepare(`
    SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const iterate = db.prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq');
  const lastSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?',
  );

  const payloadBytes = db.prepare(
    'SELECT session_id, SUM(length(CAST(payload AS BLOB))) AS bytes FROM events GROUP BY session_id',
  );
  const withImages = db.prepare(
    `SELECT session_id, payload FROM events WHERE payload LIKE '%"imageId":"%'`,
  );

  return {
    insert(event) {
      insert.run({
        sessionId: event.sessionId,
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        source: event.source,
        payload: toJson(event.payload),
      });
    },
    list(sessionId, options) {
      return list.all(sessionId, options?.afterSeq ?? 0, options?.limit ?? -1).map(fromRow);
    },
    *iterate(sessionId, options) {
      // for…of 在中途放弃时调用行迭代器的 return()，语句随之复位，不留着读事务。
      for (const row of iterate.iterate(sessionId, options?.afterSeq ?? 0)) yield fromRow(row);
    },
    lastSeq: (sessionId) => integer(lastSeq.get(sessionId) ?? {}, 'seq'),
    payloadBytes() {
      const bytes = new Map<string, number>();
      for (const row of payloadBytes.all()) {
        bytes.set(text(row, 'session_id'), integer(row, 'bytes'));
      }
      return bytes;
    },
    imageRefs() {
      const refs = new Map<string, Set<string>>();
      for (const row of withImages.all()) {
        const sessionId = text(row, 'session_id');
        for (const match of text(row, 'payload').matchAll(IMAGE_ID)) {
          const imageId = match[1] as string;
          const sessions = refs.get(imageId) ?? new Set<string>();
          sessions.add(sessionId);
          refs.set(imageId, sessions);
        }
      }
      return refs;
    },
  };
}

const IMAGE_ID = /"imageId":"([^"\\]+)"/g;

function fromRow(row: SqlRow): EventRecord {
  return {
    sessionId: text(row, 'session_id'),
    seq: integer(row, 'seq'),
    ts: text(row, 'ts'),
    type: text(row, 'type'),
    source: text(row, 'source'),
    payload: json(row, 'payload'),
  };
}
