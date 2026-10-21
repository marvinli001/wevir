import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, json, optionalJson, optionalText, text, toJson, toNullableJson } from './rows.js';

/** 与 protocol `ClientIdentity` 同形。 */
export interface ClientIdentityRecord {
  deviceId: string;
  clientId: string;
  clientKind: string;
}

/** 与 protocol `ApprovalResolution` 同形。 */
export interface ApprovalResolutionRecord {
  reason: string;
  /** `reason` 为 `user` 时必有。 */
  optionId?: string;
  /** 做出决定的客户端；`reason` 为 `user` 时必有。 */
  decidedBy?: ClientIdentityRecord;
}

/** `approvals` 表的一行，对应 protocol `ApprovalRequest`。 */
export interface ApprovalRecord {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /** protocol `ApprovalOption[]`，原样存 JSON。 */
  options: unknown;
  /** protocol `ApprovalDetail | null`，原样存 JSON。 */
  detail: unknown;
  status: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: ApprovalResolutionRecord;
}

export interface ApprovalResolve {
  /** 结算后的状态，不能是 `pending`。 */
  status: string;
  resolvedAt: string;
  resolution: ApprovalResolutionRecord;
}

export interface ApprovalRepository {
  /** 插入一条审批（通常是 `pending`）；会话不存在时抛外键错误。 */
  insert(record: ApprovalRecord): void;
  get(id: string): ApprovalRecord | undefined;
  /** 会话内的审批，按创建时间排序；可按状态过滤。 */
  listBySession(sessionId: string, options?: { status?: string }): ApprovalRecord[];
  /** 所有会话里仍是 `pending` 的审批（Host 重启对账用）。 */
  listPending(): ApprovalRecord[];
  /**
   * 结算一条 `pending` 审批。只有当前仍是 `pending` 才生效，所以首个决定生效：已结算或不存在时
   * 返回 false，什么都不改。
   */
  resolve(id: string, resolve: ApprovalResolve): boolean;
  /**
   * 用户手动允许过的审批（从历史建议审批规则用，协议 0.80.0），带会话所在的项目，最近的在前，最多 `limit` 条；给了
   * `workspaceId` 只列这个项目的。
   */
  listUserApproved(options: {
    workspaceId?: string;
    limit: number;
  }): (ApprovalRecord & { workspaceId: string })[];
}

export function createApprovalRepository(db: SqliteDatabase): ApprovalRepository {
  const insert = db.prepare(`
    INSERT INTO approvals (
      id, session_id, turn_id, tool_call_id, options, detail, status, created_at,
      resolved_at, resolution_reason, resolution_option_id, decided_by
    ) VALUES (
      :id, :sessionId, :turnId, :toolCallId, :options, :detail, :status, :createdAt,
      :resolvedAt, :reason, :optionId, :decidedBy
    )`);
  const get = db.prepare('SELECT * FROM approvals WHERE id = ?');
  const listBySession = db.prepare(`
    SELECT * FROM approvals WHERE session_id = :sessionId AND (:status IS NULL OR status = :status)
    ORDER BY created_at, id`);
  const listPending = db.prepare(
    "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, id",
  );
  const listUserApproved = db.prepare(`
    SELECT approvals.*, sessions.workspace_id FROM approvals JOIN sessions ON sessions.id = approvals.session_id
    WHERE approvals.status = 'approved' AND approvals.resolution_reason = 'user'
      AND (:workspaceId IS NULL OR sessions.workspace_id = :workspaceId)
    ORDER BY approvals.created_at DESC, approvals.id DESC
    LIMIT :limit`);
  const resolve = db.prepare(`
    UPDATE approvals SET
      status = :status, resolved_at = :resolvedAt, resolution_reason = :reason,
      resolution_option_id = :optionId, decided_by = :decidedBy
    WHERE id = :id AND status = 'pending'`);

  return {
    insert(record) {
      insert.run({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        toolCallId: record.toolCallId,
        options: toJson(record.options),
        detail: toJson(record.detail ?? null),
        status: record.status,
        createdAt: record.createdAt,
        resolvedAt: record.resolvedAt ?? null,
        ...resolutionParams(record.resolution),
      });
    },
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    listBySession(sessionId, options) {
      return listBySession.all({ sessionId, status: options?.status ?? null }).map(fromRow);
    },
    listPending: () => listPending.all().map(fromRow),
    listUserApproved: ({ workspaceId, limit }) =>
      listUserApproved
        .all({ workspaceId: workspaceId ?? null, limit })
        .map((row) => ({ ...fromRow(row), workspaceId: text(row, 'workspace_id') })),
    resolve(id, { status, resolvedAt, resolution }) {
      if (status === 'pending') throw new TypeError('resolve() 的 status 不能是 pending');
      return changed(resolve.run({ id, status, resolvedAt, ...resolutionParams(resolution) }));
    },
  };
}

function resolutionParams(resolution: ApprovalResolutionRecord | undefined) {
  return {
    reason: resolution?.reason ?? null,
    optionId: resolution?.optionId ?? null,
    decidedBy: toNullableJson(resolution?.decidedBy),
  };
}

function fromRow(row: SqlRow): ApprovalRecord {
  const record: ApprovalRecord = {
    id: text(row, 'id'),
    sessionId: text(row, 'session_id'),
    turnId: text(row, 'turn_id'),
    toolCallId: text(row, 'tool_call_id'),
    options: json(row, 'options'),
    detail: json(row, 'detail'),
    status: text(row, 'status'),
    createdAt: text(row, 'created_at'),
  };
  const resolvedAt = optionalText(row, 'resolved_at');
  if (resolvedAt !== undefined) record.resolvedAt = resolvedAt;
  const reason = optionalText(row, 'resolution_reason');
  if (reason !== undefined) {
    const resolution: ApprovalResolutionRecord = { reason };
    const optionId = optionalText(row, 'resolution_option_id');
    if (optionId !== undefined) resolution.optionId = optionId;
    const decidedBy = optionalJson(row, 'decided_by');
    if (decidedBy !== undefined) resolution.decidedBy = decidedBy as ClientIdentityRecord;
    record.resolution = resolution;
  }
  return record;
}
