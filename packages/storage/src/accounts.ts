import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, optionalText, orNull, text } from './rows.js';

/** `subscription_accounts` 表的一行（0013_subscription_accounts，domain-model §3.6）。 */
export interface SubscriptionAccountRecord {
  /** 账号 ID，也是它的 Provider 的 ID；首个账号等于种类。 */
  id: string;
  kind: string;
  label?: string;
  createdAt: string;
}

export interface SubscriptionAccountRepository {
  /** 有就整行替换（`createdAt` 不变），没有就插入。 */
  upsert(record: SubscriptionAccountRecord): void;
  get(id: string): SubscriptionAccountRecord | undefined;
  /** 按添加的先后。 */
  list(): SubscriptionAccountRecord[];
  remove(id: string): boolean;
}

export function createSubscriptionAccountRepository(
  db: SqliteDatabase,
): SubscriptionAccountRepository {
  const upsert = db.prepare(`
    INSERT INTO subscription_accounts (id, kind, label, created_at)
    VALUES (:id, :kind, :label, :createdAt)
    ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, label = excluded.label`);
  const get = db.prepare('SELECT * FROM subscription_accounts WHERE id = ?');
  const list = db.prepare('SELECT * FROM subscription_accounts ORDER BY created_at, id');
  const remove = db.prepare('DELETE FROM subscription_accounts WHERE id = ?');
  return {
    upsert: (record) =>
      void upsert.run({
        id: record.id,
        kind: record.kind,
        label: orNull(record.label),
        createdAt: record.createdAt,
      }),
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    list: () => list.all().map(fromRow),
    remove: (id) => changed(remove.run(id)),
  };
}

function fromRow(row: SqlRow): SubscriptionAccountRecord {
  const label = optionalText(row, 'label');
  return {
    id: text(row, 'id'),
    kind: text(row, 'kind'),
    ...(label !== undefined && { label }),
    createdAt: text(row, 'created_at'),
  };
}
