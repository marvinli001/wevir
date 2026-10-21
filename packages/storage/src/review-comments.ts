import type { SqliteDatabase, SqlRow } from './driver.js';
import {
  changed,
  integer,
  json,
  optionalJson,
  optionalText,
  orNull,
  text,
  toJson,
} from './rows.js';

/** `review_comments` 表的一行（0015_review_comments，协议 0.67.0 的 `review.*`）。 */
export interface ReviewCommentRecord {
  id: string;
  workspaceId: string;
  /** 批注所在目录的 realpath。 */
  dir: string;
  /** 在哪个会话里写的。 */
  sessionId?: string;
  path: string;
  previousPath?: string;
  /** `old` / `new`。 */
  side: string;
  startLine: number;
  endLine: number;
  /** DiffSource，原样存 JSON。 */
  source: unknown;
  base: string;
  head?: string;
  branch?: string;
  snippet: string;
  /** 片段前后各几行原文（`\n` 连接），重新定位时区分重复的片段。 */
  contextBefore: string;
  contextAfter: string;
  body: string;
  /** `pending` / `sent`。 */
  status: string;
  sent?: { sessionId: string; at: string; turnId?: string; pendingId?: string };
  /** agent 报出的审查发现（0018_review_findings）：ReviewFindingFields，原样存 JSON。 */
  finding?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCommentRepository {
  insert(record: ReviewCommentRecord): void;
  get(id: string): ReviewCommentRecord | undefined;
  /** 目录里的批注，按写的先后；给了 `status` 只列那一种。 */
  listByDir(dir: string, status?: string): ReviewCommentRecord[];
  countByDir(dir: string): number;
  setBody(id: string, body: string, updatedAt: string): boolean;
  markSent(id: string, sent: NonNullable<ReviewCommentRecord['sent']>): boolean;
  remove(id: string): boolean;
  /** 删掉在这些会话里写的批注（删会话时）。 */
  removeBySessions(sessionIds: readonly string[]): number;
}

export function createReviewCommentRepository(db: SqliteDatabase): ReviewCommentRepository {
  const insert = db.prepare(`
    INSERT INTO review_comments (
      id, workspace_id, dir, session_id, path, previous_path, side, start_line, end_line, source, base, head, branch,
      snippet, context_before, context_after, body, status, sent_session_id, sent_turn_id, sent_pending_id, sent_at,
      finding, created_at, updated_at
    ) VALUES (
      :id, :workspaceId, :dir, :sessionId, :path, :previousPath, :side, :startLine, :endLine, :source, :base, :head,
      :branch, :snippet, :contextBefore, :contextAfter, :body, :status, :sentSessionId, :sentTurnId, :sentPendingId,
      :sentAt, :finding, :createdAt, :updatedAt
    )`);
  const get = db.prepare('SELECT * FROM review_comments WHERE id = ?');
  const listByDir = db.prepare(
    'SELECT * FROM review_comments WHERE dir = ? ORDER BY created_at, id',
  );
  const listByDirStatus = db.prepare(
    'SELECT * FROM review_comments WHERE dir = ? AND status = ? ORDER BY created_at, id',
  );
  const countByDir = db.prepare('SELECT COUNT(*) AS n FROM review_comments WHERE dir = ?');
  const setBody = db.prepare('UPDATE review_comments SET body = ?, updated_at = ? WHERE id = ?');
  const markSent = db.prepare(`
    UPDATE review_comments
    SET status = 'sent', sent_session_id = :sessionId, sent_turn_id = :turnId, sent_pending_id = :pendingId,
      sent_at = :at, updated_at = :at
    WHERE id = :id`);
  const remove = db.prepare('DELETE FROM review_comments WHERE id = ?');
  const removeBySession = db.prepare('DELETE FROM review_comments WHERE session_id = ?');
  return {
    insert: (record) =>
      void insert.run({
        id: record.id,
        workspaceId: record.workspaceId,
        dir: record.dir,
        sessionId: orNull(record.sessionId),
        path: record.path,
        previousPath: orNull(record.previousPath),
        side: record.side,
        startLine: record.startLine,
        endLine: record.endLine,
        source: toJson(record.source),
        base: record.base,
        head: orNull(record.head),
        branch: orNull(record.branch),
        snippet: record.snippet,
        contextBefore: record.contextBefore,
        contextAfter: record.contextAfter,
        body: record.body,
        status: record.status,
        sentSessionId: orNull(record.sent?.sessionId),
        sentTurnId: orNull(record.sent?.turnId),
        sentPendingId: orNull(record.sent?.pendingId),
        sentAt: orNull(record.sent?.at),
        finding: record.finding === undefined ? null : toJson(record.finding),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    listByDir: (dir, status) =>
      (status === undefined ? listByDir.all(dir) : listByDirStatus.all(dir, status)).map(fromRow),
    countByDir: (dir) => integer(countByDir.get(dir) as SqlRow, 'n'),
    setBody: (id, body, updatedAt) => changed(setBody.run(body, updatedAt, id)),
    markSent: (id, sent) =>
      changed(
        markSent.run({
          id,
          sessionId: sent.sessionId,
          turnId: orNull(sent.turnId),
          pendingId: orNull(sent.pendingId),
          at: sent.at,
        }),
      ),
    remove: (id) => changed(remove.run(id)),
    removeBySessions(sessionIds) {
      let removed = 0;
      for (const id of sessionIds) removed += Number(removeBySession.run(id).changes);
      return removed;
    },
  };
}

function fromRow(row: SqlRow): ReviewCommentRecord {
  const sessionId = optionalText(row, 'session_id');
  const previousPath = optionalText(row, 'previous_path');
  const head = optionalText(row, 'head');
  const branch = optionalText(row, 'branch');
  const sentSessionId = optionalText(row, 'sent_session_id');
  const sentAt = optionalText(row, 'sent_at');
  const sentTurnId = optionalText(row, 'sent_turn_id');
  const sentPendingId = optionalText(row, 'sent_pending_id');
  const finding = optionalJson(row, 'finding');
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    dir: text(row, 'dir'),
    ...(sessionId !== undefined && { sessionId }),
    path: text(row, 'path'),
    ...(previousPath !== undefined && { previousPath }),
    side: text(row, 'side'),
    startLine: integer(row, 'start_line'),
    endLine: integer(row, 'end_line'),
    source: json(row, 'source'),
    base: text(row, 'base'),
    ...(head !== undefined && { head }),
    ...(branch !== undefined && { branch }),
    snippet: text(row, 'snippet'),
    contextBefore: text(row, 'context_before'),
    contextAfter: text(row, 'context_after'),
    body: text(row, 'body'),
    status: text(row, 'status'),
    ...(sentSessionId !== undefined &&
      sentAt !== undefined && {
        sent: {
          sessionId: sentSessionId,
          at: sentAt,
          ...(sentTurnId !== undefined && { turnId: sentTurnId }),
          ...(sentPendingId !== undefined && { pendingId: sentPendingId }),
        },
      }),
    ...(finding !== undefined && { finding }),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}
