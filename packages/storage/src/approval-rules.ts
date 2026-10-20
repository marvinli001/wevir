import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, integer, optionalText, orNull, text } from './rows.js';

/** `approval_rules` 表的一行（0017_approval_rules，协议 0.78.0 的 `approvalRule.*`）。 */
export interface ApprovalRuleRecord {
  id: string;
  /** 省略是全局规则。 */
  workspaceId?: string;
  /** `command_prefix`。 */
  kind: string;
  /** 命令前缀，原样存 JSON 数组。 */
  prefix: string[];
  /** `approval` / `suggestion`。 */
  source: string;
  sourceSessionId?: string;
  sourceApprovalId?: string;
  createdAt: string;
  useCount: number;
  lastUsedAt?: string;
}

export interface ApprovalRuleRepository {
  /** 同一范围里已有同样的前缀时不插入，返回已有的那条。 */
  insert(record: ApprovalRuleRecord): ApprovalRuleRecord;
  get(id: string): ApprovalRuleRecord | undefined;
  /** 全部规则，按创建先后（同一毫秒的按插入顺序）。 */
  list(): ApprovalRuleRecord[];
  /** 对这个项目有效的：全局的与这个项目的。 */
  listEffective(workspaceId: string | undefined): ApprovalRuleRecord[];
  recordUse(ids: readonly string[], at: string): void;
  remove(id: string): boolean;
  /** 删掉某个项目的规则（删项目时）。 */
  removeByWorkspace(workspaceId: string): number;
}

export function createApprovalRuleRepository(db: SqliteDatabase): ApprovalRuleRepository {
  const insert = db.prepare(`
    INSERT INTO approval_rules (
      id, workspace_id, kind, prefix, source, source_session_id, source_approval_id, created_at, use_count, last_used_at
    ) VALUES (
      :id, :workspaceId, :kind, :prefix, :source, :sourceSessionId, :sourceApprovalId, :createdAt, :useCount, :lastUsedAt
    )
    ON CONFLICT DO NOTHING`);
  const findSame = db.prepare(
    "SELECT * FROM approval_rules WHERE COALESCE(workspace_id, '') = ? AND kind = ? AND prefix = ?",
  );
  const get = db.prepare('SELECT * FROM approval_rules WHERE id = ?');
  const list = db.prepare('SELECT * FROM approval_rules ORDER BY created_at, rowid');
  const listGlobal = db.prepare(
    'SELECT * FROM approval_rules WHERE workspace_id IS NULL ORDER BY created_at, rowid',
  );
  const listEffective = db.prepare(
    'SELECT * FROM approval_rules WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY created_at, rowid',
  );
  const recordUse = db.prepare(
    'UPDATE approval_rules SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
  );
  const remove = db.prepare('DELETE FROM approval_rules WHERE id = ?');
  const removeByWorkspace = db.prepare('DELETE FROM approval_rules WHERE workspace_id = ?');
  return {
    insert(record) {
      const prefix = JSON.stringify(record.prefix);
      insert.run({
        id: record.id,
        workspaceId: orNull(record.workspaceId),
        kind: record.kind,
        prefix,
        source: record.source,
        sourceSessionId: orNull(record.sourceSessionId),
        sourceApprovalId: orNull(record.sourceApprovalId),
        createdAt: record.createdAt,
        useCount: record.useCount,
        lastUsedAt: orNull(record.lastUsedAt),
      });
      return fromRow(findSame.get(record.workspaceId ?? '', record.kind, prefix) as SqlRow);
    },
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    list: () => list.all().map(fromRow),
    listEffective: (workspaceId) =>
      (workspaceId === undefined ? listGlobal.all() : listEffective.all(workspaceId)).map(fromRow),
    recordUse(ids, at) {
      for (const id of ids) recordUse.run(at, id);
    },
    remove: (id) => changed(remove.run(id)),
    removeByWorkspace: (workspaceId) => Number(removeByWorkspace.run(workspaceId).changes),
  };
}

function fromRow(row: SqlRow): ApprovalRuleRecord {
  const workspaceId = optionalText(row, 'workspace_id');
  const sourceSessionId = optionalText(row, 'source_session_id');
  const sourceApprovalId = optionalText(row, 'source_approval_id');
  const lastUsedAt = optionalText(row, 'last_used_at');
  return {
    id: text(row, 'id'),
    ...(workspaceId !== undefined && { workspaceId }),
    kind: text(row, 'kind'),
    prefix: JSON.parse(text(row, 'prefix')) as string[],
    source: text(row, 'source'),
    ...(sourceSessionId !== undefined && { sourceSessionId }),
    ...(sourceApprovalId !== undefined && { sourceApprovalId }),
    createdAt: text(row, 'created_at'),
    useCount: integer(row, 'use_count'),
    ...(lastUsedAt !== undefined && { lastUsedAt }),
  };
}
