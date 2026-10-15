import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, text } from './rows.js';

/** `environments` 表的一行（0004_environments，domain-model §3.10）。线缆类型是 protocol 的 `Environment`。 */
export interface EnvironmentRecord {
  id: string;
  name: string;
  /** 现在只有 `{ kind: 'local' }`。 */
  location: { kind: string };
  /** 按顺序，第一个是主文件夹。 */
  folders: { workspaceId: string; worktree: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentRepository {
  insert(record: EnvironmentRecord): void;
  get(id: string): EnvironmentRecord | undefined;
  /** 按创建时间。 */
  list(): EnvironmentRecord[];
  /** 整行替换（id 与 createdAt 不变）；不存在时返回 false。 */
  update(record: EnvironmentRecord): boolean;
  remove(id: string): boolean;
}

export function createEnvironmentRepository(db: SqliteDatabase): EnvironmentRepository {
  const insert = db.prepare(`
    INSERT INTO environments (id, name, location, folders, created_at, updated_at)
    VALUES (:id, :name, :location, :folders, :createdAt, :updatedAt)`);
  const get = db.prepare('SELECT * FROM environments WHERE id = ?');
  const list = db.prepare('SELECT * FROM environments ORDER BY created_at, id');
  const update = db.prepare(`
    UPDATE environments SET name = :name, location = :location, folders = :folders, updated_at = :updatedAt
    WHERE id = :id`);
  const remove = db.prepare('DELETE FROM environments WHERE id = ?');
  const params = (record: EnvironmentRecord) => ({
    id: record.id,
    name: record.name,
    location: JSON.stringify(record.location),
    folders: JSON.stringify(record.folders),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return {
    insert: (record) => void insert.run(params(record)),
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    list: () => list.all().map(fromRow),
    update(record) {
      const { createdAt: _, ...values } = params(record);
      return changed(update.run(values));
    },
    remove: (id) => changed(remove.run(id)),
  };
}

function fromRow(row: SqlRow): EnvironmentRecord {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    location: JSON.parse(text(row, 'location')) as EnvironmentRecord['location'],
    folders: JSON.parse(text(row, 'folders')) as EnvironmentRecord['folders'],
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}
