import type { SqliteDatabase, SqliteStatement, SqlParams, SqlRow } from './driver.js';
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
 * 补发时判断哪些内容已被取代用的一行（`replayIndex`）：只有几个小字段，不读整条 payload。
 */
export interface ReplayIndexRow {
  seq: number;
  type:
    | 'assistant.delta'
    | 'assistant.message'
    | 'assistant.thought'
    | 'tool.updated'
    | 'tool.finished';
  /**
   * `assistant.delta`：`<streamId>:<blockIndex>`；`assistant.message` / `assistant.thought`：`replaces` 的 JSON 文本；工具：
   * `toolCallId`。
   */
  key: string | null;
  /** 工具事件带不带 `output`；别的类型为 false。 */
  hasOutput: boolean;
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
  /** 跨会话按时间倒序列出额度路由决定；复合游标保证相同时刻也不重不漏。 */
  routingDecisions(options: {
    limit: number;
    cursor?: { at: string; sessionId: string; seq: number };
  }): EventRecord[];
  /**
   * 同 `list`（不限条数），但逐行读出，不把结果一次全读进内存：长会话从头重放时内存不随会话长度涨。迭代完（或中途放弃）之前别再
   * 调用它。
   */
  iterate(sessionId: string, options?: { afterSeq?: number }): IterableIterator<EventRecord>;
  /** 按类型/回合流式读出；omitToolOutput 仅去掉工具事件的 output，不用于完整事件重放。 */
  iterateTypes(
    sessionId: string,
    types: readonly string[],
    options?: {
      turnId?: string;
      omitToolOutput?: boolean;
    },
  ): IterableIterator<EventRecord>;
  /** 会话里最大的 `seq`；没有事件时为 0。 */
  lastSeq(sessionId: string): number;
  /** `afterSeq < seq <= throughSeq` 里助手增量、已提交消息与工具更新的索引，按 `seq` 升序（`ReplayIndexRow`）。 */
  replayIndex(sessionId: string, afterSeq: number, throughSeq: number): ReplayIndexRow[];
  /** 每个会话的事件 payload 的字节数之和（0.43.0，`session.usage`）；没有事件的会话不在里面。 */
  payloadBytes(): Map<string, number>;
  /**
   * 事件里引用的消息图片（0.43.0）：图片 ID → 引用它的会话。只看 payload 里 `"imageId":"…"` 的写法（Host 写事件时的 JSON 没有空格）。
   */
  imageRefs(): Map<string, Set<string>>;
}

export function createEventRepository(db: SqliteDatabase): EventRepository {
  const typedQueries = new Map<string, SqliteStatement>();
  const insert = db.prepare(`
    INSERT INTO events (session_id, seq, ts, type, source, payload)
    VALUES (:sessionId, :seq, :ts, :type, :source, :payload)`);
  // LIMIT -1 表示不限。
  const list = db.prepare(`
    SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const iterate = db.prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq');
  const routingDecisions = db.prepare(`
    SELECT * FROM events WHERE type = 'routing.decided'
      AND (:at IS NULL OR (json_extract(payload, '$.at'), session_id, seq) < (:at, :sessionId, :seq))
    ORDER BY json_extract(payload, '$.at') DESC, session_id DESC, seq DESC LIMIT :limit`);
  const lastSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?',
  );
  const replayIndex = db.prepare(`
    SELECT seq, type,
      CASE type
        WHEN 'assistant.delta'
          THEN json_extract(payload, '$.streamId') || ':' || json_extract(payload, '$.blockIndex')
        WHEN 'assistant.message' THEN json_extract(payload, '$.replaces')
        WHEN 'assistant.thought' THEN json_extract(payload, '$.replaces')
        ELSE json_extract(payload, '$.toolCallId')
      END AS key,
      type IN ('tool.updated', 'tool.finished') AND json_type(payload, '$.output') IS NOT NULL
        AS has_output
    FROM events
    WHERE session_id = ? AND seq > ? AND seq <= ? AND type IN (
      'assistant.delta', 'assistant.message', 'assistant.thought', 'tool.updated', 'tool.finished'
    )
    ORDER BY seq`);

  const payloadBytes = db.prepare(
    'SELECT session_id, payload_bytes AS bytes FROM event_session_metrics',
  );
  const withImages = db.prepare(
    'SELECT session_id, image_id FROM event_image_refs ORDER BY image_id, session_id',
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
    routingDecisions({ limit, cursor }) {
      return routingDecisions
        .all({
          at: cursor?.at ?? null,
          sessionId: cursor?.sessionId ?? null,
          seq: cursor?.seq ?? null,
          limit,
        })
        .map(fromRow);
    },
    *iterate(sessionId, options) {
      // for…of 在中途放弃时调用行迭代器的 return()，语句随之复位，不留着读事务。
      for (const row of iterate.iterate(sessionId, options?.afterSeq ?? 0)) yield fromRow(row);
    },
    *iterateTypes(sessionId, types, options) {
      if (types.length === 0) return;
      const key = `${types.length}:${options?.turnId !== undefined}:${options?.omitToolOutput === true}`;
      let query = typedQueries.get(key);
      if (query === undefined) {
        const payload = options?.omitToolOutput
          ? "CASE WHEN type IN ('tool.updated', 'tool.finished') THEN json_remove(payload, '$.output') ELSE payload END"
          : 'payload';
        query =
          db.prepare(`SELECT session_id, seq, ts, type, source, ${payload} AS payload FROM events
          WHERE session_id = :sessionId AND type IN (${types.map((_, index) => `:type${index}`).join(', ')})
          ${options?.turnId !== undefined ? "AND json_extract(payload, '$.turnId') = :turnId" : ''}
          ORDER BY seq`);
        typedQueries.set(key, query);
      }
      const params: SqlParams = { sessionId };
      types.forEach((type, index) => {
        params[`type${index}`] = type;
      });
      if (options?.turnId !== undefined) params.turnId = options.turnId;
      for (const row of query.iterate(params)) yield fromRow(row);
    },
    lastSeq: (sessionId) => integer(lastSeq.get(sessionId) ?? {}, 'seq'),
    replayIndex(sessionId, afterSeq, throughSeq) {
      return replayIndex.all(sessionId, afterSeq, throughSeq).map((row) => ({
        seq: integer(row, 'seq'),
        type: text(row, 'type') as ReplayIndexRow['type'],
        key: row.key === null ? null : String(row.key),
        hasOutput: integer(row, 'has_output') === 1,
      }));
    },
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
        const imageId = text(row, 'image_id');
        const sessions = refs.get(imageId) ?? new Set<string>();
        sessions.add(sessionId);
        refs.set(imageId, sessions);
      }
      return refs;
    },
  };
}

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
