import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, optionalText, text } from './rows.js';

/** `workspaces` 表的一行。线缆类型是 protocol 的 `Workspace`，`removedAt` 不上线缆。 */
export interface WorkspaceRecord {
  id: string;
  /** 目录的 realpath，唯一。 */
  rootPath: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  /** 软删除时间；有值表示已从列表中移除。 */
  removedAt?: string;
}

export interface WorkspaceRepository {
  /** 插入新工作区；`rootPath` 已存在（含已移除的）时抛唯一约束错误。 */
  insert(record: WorkspaceRecord): void;
  get(id: string): WorkspaceRecord | undefined;
  /** 按 realpath 查找，包括已移除的（再次添加时据此恢复原 id）。 */
  getByRootPath(rootPath: string): WorkspaceRecord | undefined;
  /** 按创建时间排序；默认不含已移除的。 */
  list(options?: { includeRemoved?: boolean }): WorkspaceRecord[];
  rename(id: string, displayName: string, updatedAt: string): boolean;
  /** 软删除；已移除或不存在时返回 false。 */
  markRemoved(id: string, removedAt: string): boolean;
  /** 撤销软删除；未移除或不存在时返回 false。 */
  restore(id: string, updatedAt: string): boolean;
}

export function createWorkspaceRepository(db: SqliteDatabase): WorkspaceRepository {
  const insert = db.prepare(`
    INSERT INTO workspaces (id, root_path, display_name, created_at, updated_at, removed_at)
    VALUES (:id, :rootPath, :displayName, :createdAt, :updatedAt, :removedAt)`);
  const get = db.prepare('SELECT * FROM workspaces WHERE id = ?');
  const getByRootPath = db.prepare('SELECT * FROM workspaces WHERE root_path = ?');
  const listActive = db.prepare(
    'SELECT * FROM workspaces WHERE removed_at IS NULL ORDER BY created_at, id',
  );
  const listAll = db.prepare('SELECT * FROM workspaces ORDER BY created_at, id');
  const rename = db.prepare('UPDATE workspaces SET display_name = ?, updated_at = ? WHERE id = ?');
  const markRemoved = db.prepare(
    'UPDATE workspaces SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL',
  );
  const restore = db.prepare(
    'UPDATE workspaces SET removed_at = NULL, updated_at = ? WHERE id = ? AND removed_at IS NOT NULL',
  );

  return {
    insert(record) {
      insert.run({
        id: record.id,
        rootPath: record.rootPath,
        displayName: record.displayName,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        removedAt: record.removedAt ?? null,
      });
    },
    get: (id) => toRecord(get.get(id)),
    getByRootPath: (rootPath) => toRecord(getByRootPath.get(rootPath)),
    list(options) {
      const rows = options?.includeRemoved ? listAll.all() : listActive.all();
      return rows.map(fromRow);
    },
    rename: (id, displayName, updatedAt) => changed(rename.run(displayName, updatedAt, id)),
    markRemoved: (id, removedAt) => changed(markRemoved.run(removedAt, removedAt, id)),
    restore: (id, updatedAt) => changed(restore.run(updatedAt, id)),
  };
}

function toRecord(row: SqlRow | undefined): WorkspaceRecord | undefined {
  return row ? fromRow(row) : undefined;
}

function fromRow(row: SqlRow): WorkspaceRecord {
  const record: WorkspaceRecord = {
    id: text(row, 'id'),
    rootPath: text(row, 'root_path'),
    displayName: text(row, 'display_name'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const removedAt = optionalText(row, 'removed_at');
  if (removedAt !== undefined) record.removedAt = removedAt;
  return record;
}
