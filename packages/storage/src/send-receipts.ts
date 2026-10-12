import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, integer, text } from './rows.js';

/**
 * - `accepted`：Host 已接受这次发送（写了 `user.message`），还没确认引擎收到。
 * - `confirmed`：引擎已确认收到。
 * - `unknown`：Host 重启时仍是 `accepted`，结果未知；不自动重发（ADR-0002 §4）。
 */
export type SendReceiptStatus = 'accepted' | 'confirmed' | 'unknown';

/**
 * `send_receipts` 表的一行：`session.send` 的 `clientMessageId` 回执。只记被接受的发送。
 * 同一会话里同一 `clientMessageId` 重发时，`fingerprint` 相同则返回原结果（`turnId`、`seq`），
 * 不同则 `CLIENT_MESSAGE_CONFLICT`（host-api.md `session.send`）。
 */
export interface SendReceiptRecord {
  sessionId: string;
  clientMessageId: string;
  /** 请求体指纹，见 `requestFingerprint`。 */
  fingerprint: string;
  status: SendReceiptStatus;
  turnId: string;
  /** 这次发送的 `user.message` 的 `seq`。 */
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface SendReceiptRepository {
  /** 插入回执；同一会话里 `clientMessageId` 已存在时抛主键约束错误。 */
  insert(record: SendReceiptRecord): void;
  get(sessionId: string, clientMessageId: string): SendReceiptRecord | undefined;
  setStatus(
    sessionId: string,
    clientMessageId: string,
    status: SendReceiptStatus,
    updatedAt: string,
  ): boolean;
  /** Host 启动对账：把所有 `accepted` 标为 `unknown`，返回条数。 */
  markAcceptedAsUnknown(updatedAt: string): number;
}

export function createSendReceiptRepository(db: SqliteDatabase): SendReceiptRepository {
  const insert = db.prepare(`
    INSERT INTO send_receipts (
      session_id, client_message_id, fingerprint, status, turn_id, seq, created_at, updated_at
    ) VALUES (
      :sessionId, :clientMessageId, :fingerprint, :status, :turnId, :seq, :createdAt, :updatedAt
    )`);
  const get = db.prepare(
    'SELECT * FROM send_receipts WHERE session_id = ? AND client_message_id = ?',
  );
  const setStatus = db.prepare(
    'UPDATE send_receipts SET status = ?, updated_at = ? WHERE session_id = ? AND client_message_id = ?',
  );
  const markAcceptedAsUnknown = db.prepare(
    "UPDATE send_receipts SET status = 'unknown', updated_at = ? WHERE status = 'accepted'",
  );

  return {
    insert(record) {
      insert.run({
        sessionId: record.sessionId,
        clientMessageId: record.clientMessageId,
        fingerprint: record.fingerprint,
        status: record.status,
        turnId: record.turnId,
        seq: record.seq,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },
    get(sessionId, clientMessageId) {
      const row = get.get(sessionId, clientMessageId);
      return row ? fromRow(row) : undefined;
    },
    setStatus: (sessionId, clientMessageId, status, updatedAt) =>
      changed(setStatus.run(status, updatedAt, sessionId, clientMessageId)),
    markAcceptedAsUnknown: (updatedAt) => Number(markAcceptedAsUnknown.run(updatedAt).changes),
  };
}

/**
 * 请求体指纹：对象键排序后的 JSON 的 SHA-256，形如 `sha256:<hex>`。键顺序不同、内容相同的请求
 * 指纹相同。Host 对 `session.send` 的 `content` 计算它。
 */
export function requestFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
  if (canonical === undefined) throw new TypeError('值不能序列化为 JSON');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function fromRow(row: SqlRow): SendReceiptRecord {
  return {
    sessionId: text(row, 'session_id'),
    clientMessageId: text(row, 'client_message_id'),
    fingerprint: text(row, 'fingerprint'),
    status: text(row, 'status') as SendReceiptStatus,
    turnId: text(row, 'turn_id'),
    seq: integer(row, 'seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}
