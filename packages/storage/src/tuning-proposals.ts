import type { SqliteDatabase, SqlRow } from './driver.js';
import {
  changed,
  optionalJson,
  optionalText,
  orNull,
  text,
  toJson,
  toNullableJson,
} from './rows.js';

/** `tuning_proposals` 表的一行（0020_tuning_proposals，协议 0.87.0 的 `tuning.proposal.*`；0024_tuning_auto 加了来源与结论）。 */
export interface TuningProposalRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: string;
  title: string;
  target: string;
  /** 生成时目标的散列。 */
  baseHash: string;
  /** 改动，原样存 JSON。 */
  payload: unknown;
  evidence: unknown;
  /** `pending`、`stale`、`accepted`、`rejected`；0024 起还有 `trial`、`reverted`。 */
  status: string;
  /** `user`、`auto`、`agent`（0024）；旧行是 `user`。 */
  origin: string;
  /** 试用的结论（0024），原样存 JSON。 */
  outcome?: unknown;
  /** 生成它的那次操作的用量与模型。 */
  usage?: unknown;
  createdAt: string;
  decidedAt?: string;
  /** 采纳之后下一个会话开的档案版本。 */
  versionId?: string;
}

export type TuningProposalPatch = Partial<
  Pick<TuningProposalRecord, 'payload' | 'status' | 'decidedAt' | 'versionId' | 'outcome'>
>;

export interface TuningProposalRepository {
  insert(record: TuningProposalRecord): void;
  get(id: string): TuningProposalRecord | undefined;
  /** 新的在前（按处理时刻，没处理的按建立时刻；同一刻的按写入先后，即模型给出的先后）；`statuses` 给了只列这些状态的。 */
  list(options?: {
    workspaceId?: string;
    statuses?: readonly string[];
    limit?: number;
  }): TuningProposalRecord[];
  /** 只改给出的字段。没有这一行时 false。 */
  update(id: string, patch: TuningProposalPatch): boolean;
  delete(id: string): boolean;
  /** 这个项目里采纳了或在试用、还没有版本的，旧的在前（下一个版本的 `cause`）。 */
  unversioned(workspaceId: string): TuningProposalRecord[];
}

export function createTuningProposalRepository(db: SqliteDatabase): TuningProposalRepository {
  const insert = db.prepare(`
    INSERT INTO tuning_proposals (id, workspace_id, session_id, kind, title, target, base_hash, payload_json,
      evidence_json, status, origin, outcome_json, usage_json, created_at, decided_at, version_id)
    VALUES (:id, :workspaceId, :sessionId, :kind, :title, :target, :baseHash, :payload, :evidence, :status,
      :origin, :outcome, :usage, :createdAt, :decidedAt, :versionId)`);
  const get = db.prepare('SELECT * FROM tuning_proposals WHERE id = ?');
  const remove = db.prepare('DELETE FROM tuning_proposals WHERE id = ?');
  const unversioned = db.prepare(
    "SELECT * FROM tuning_proposals WHERE workspace_id = ? AND status IN ('accepted', 'trial') AND version_id IS NULL ORDER BY decided_at, id",
  );
  const order = 'ORDER BY COALESCE(decided_at, created_at) DESC, rowid';

  return {
    insert(record) {
      insert.run({
        id: record.id,
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        kind: record.kind,
        title: record.title,
        target: record.target,
        baseHash: record.baseHash,
        payload: toJson(record.payload),
        evidence: toJson(record.evidence),
        status: record.status,
        origin: record.origin,
        outcome: toNullableJson(record.outcome),
        usage: toNullableJson(record.usage),
        createdAt: record.createdAt,
        decidedAt: orNull(record.decidedAt),
        versionId: orNull(record.versionId),
      });
    },
    get: (id) => {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    list(options = {}) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (options.workspaceId !== undefined) {
        where.push('workspace_id = ?');
        args.push(options.workspaceId);
      }
      if (options.statuses !== undefined) {
        if (options.statuses.length === 0) return [];
        where.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
        args.push(...options.statuses);
      }
      const sql = `SELECT * FROM tuning_proposals ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ${order} LIMIT ?`;
      return db
        .prepare(sql)
        .all(...args, options.limit ?? -1)
        .map(fromRow);
    },
    update(id, patch) {
      const sets: string[] = [];
      const args: (string | null)[] = [];
      if ('payload' in patch) {
        sets.push('payload_json = ?');
        args.push(toJson(patch.payload));
      }
      if (patch.status !== undefined) {
        sets.push('status = ?');
        args.push(patch.status);
      }
      if ('decidedAt' in patch) {
        sets.push('decided_at = ?');
        args.push(patch.decidedAt ?? null);
      }
      if ('versionId' in patch) {
        sets.push('version_id = ?');
        args.push(patch.versionId ?? null);
      }
      if ('outcome' in patch) {
        sets.push('outcome_json = ?');
        args.push(toNullableJson(patch.outcome));
      }
      if (sets.length === 0) return get.get(id) !== undefined;
      return changed(
        db.prepare(`UPDATE tuning_proposals SET ${sets.join(', ')} WHERE id = ?`).run(...args, id),
      );
    },
    delete: (id) => changed(remove.run(id)),
    unversioned: (workspaceId) => unversioned.all(workspaceId).map(fromRow),
  };
}

function fromRow(row: SqlRow): TuningProposalRecord {
  const usage = optionalJson(row, 'usage_json');
  const outcome = optionalJson(row, 'outcome_json');
  const decidedAt = optionalText(row, 'decided_at');
  const versionId = optionalText(row, 'version_id');
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    sessionId: text(row, 'session_id'),
    kind: text(row, 'kind'),
    title: text(row, 'title'),
    target: text(row, 'target'),
    baseHash: text(row, 'base_hash'),
    payload: JSON.parse(text(row, 'payload_json')),
    evidence: JSON.parse(text(row, 'evidence_json')),
    status: text(row, 'status'),
    origin: text(row, 'origin'),
    ...(outcome !== undefined && { outcome }),
    ...(usage !== undefined && { usage }),
    createdAt: text(row, 'created_at'),
    ...(decidedAt !== undefined && { decidedAt }),
    ...(versionId !== undefined && { versionId }),
  };
}
