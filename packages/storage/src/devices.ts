import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, integer, json, optionalText, orNull, text, toJson } from './rows.js';

/** `devices` 表的一行（0023_devices，协议 0.107.0 的 `device.*`；0025_device_push 加了推送的开关与计数）。 */
export interface DeviceRecord {
  id: string;
  name: string;
  /** `ios` / `android` / `macos` / `windows` / `linux` / `other`。 */
  platform: string;
  /** Noise 静态公钥，base64url。 */
  publicKey: string;
  permissions: string[];
  createdAt: string;
  lastSeenAt: string;
  /** secrets.json 里推送令牌的条目。 */
  pushTokenRef?: string;
  /** 这台设备的推送开关（0025）。 */
  pushEnabled: boolean;
  /** 加密推送用的计数，只增不减（0025）。 */
  pushCounter: number;
  /** `active` / `revoked`。 */
  status: string;
}

export interface DeviceRepository {
  /** 公钥已有 active 的记录时抛错（唯一索引）。 */
  insert(record: DeviceRecord): void;
  get(id: string): DeviceRecord | undefined;
  /** 这个公钥的 active 记录。 */
  findActive(publicKey: string): DeviceRecord | undefined;
  /** 全部设备，按配对先后。 */
  list(): DeviceRecord[];
  /** 改名称、平台、权限、最近在线、推送开关、计数或推送令牌条目；没有这条时返回 false。 */
  update(
    id: string,
    patch: Partial<
      Pick<
        DeviceRecord,
        'name' | 'platform' | 'permissions' | 'lastSeenAt' | 'pushEnabled' | 'pushCounter'
      > & {
        pushTokenRef: string | null;
      }
    >,
  ): boolean;
  /** 改成 `revoked` 并清掉推送令牌条目；已经是 `revoked` 或没有这条时返回 false。 */
  revoke(id: string): boolean;
}

export function createDeviceRepository(db: SqliteDatabase): DeviceRepository {
  const insert = db.prepare(`
    INSERT INTO devices (
      id, name, platform, public_key, permissions, created_at, last_seen_at, push_token_ref, status,
      push_enabled, push_counter
    ) VALUES (
      :id, :name, :platform, :publicKey, :permissions, :createdAt, :lastSeenAt, :pushTokenRef, :status,
      :pushEnabled, :pushCounter
    )`);
  const get = db.prepare('SELECT * FROM devices WHERE id = ?');
  const findActive = db.prepare("SELECT * FROM devices WHERE public_key = ? AND status = 'active'");
  const list = db.prepare('SELECT * FROM devices ORDER BY created_at, rowid');
  const revoke = db.prepare(
    "UPDATE devices SET status = 'revoked', push_token_ref = NULL, push_enabled = 0 WHERE id = ? AND status = 'active'",
  );
  const columns = {
    name: 'name',
    platform: 'platform',
    permissions: 'permissions',
    lastSeenAt: 'last_seen_at',
    pushTokenRef: 'push_token_ref',
    pushEnabled: 'push_enabled',
    pushCounter: 'push_counter',
  } as const;
  return {
    insert(record) {
      insert.run({
        id: record.id,
        name: record.name,
        platform: record.platform,
        publicKey: record.publicKey,
        permissions: toJson(record.permissions),
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        pushTokenRef: orNull(record.pushTokenRef),
        status: record.status,
        pushEnabled: record.pushEnabled ? 1 : 0,
        pushCounter: record.pushCounter,
      });
    },
    get: (id) => fromRow(get.get(id)),
    findActive: (publicKey) => fromRow(findActive.get(publicKey)),
    list: () => list.all().map((row) => fromRow(row) as DeviceRecord),
    update(id, patch) {
      const sets: string[] = [];
      const values: Record<string, string | number | null> = { id };
      for (const [key, column] of Object.entries(columns) as [keyof typeof columns, string][]) {
        const value = patch[key];
        if (value === undefined) continue;
        sets.push(`${column} = :${key}`);
        values[key] =
          key === 'permissions'
            ? toJson(value)
            : typeof value === 'boolean'
              ? Number(value)
              : (value as string | number | null);
      }
      if (sets.length === 0) return get.get(id) !== undefined;
      return changed(
        db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = :id`).run(values),
      );
    },
    revoke: (id) => changed(revoke.run(id)),
  };
}

function fromRow(row: SqlRow | undefined): DeviceRecord | undefined {
  if (row === undefined) return undefined;
  const record: DeviceRecord = {
    id: text(row, 'id'),
    name: text(row, 'name'),
    platform: text(row, 'platform'),
    publicKey: text(row, 'public_key'),
    permissions: json(row, 'permissions') as string[],
    createdAt: text(row, 'created_at'),
    lastSeenAt: text(row, 'last_seen_at'),
    status: text(row, 'status'),
    pushEnabled: integer(row, 'push_enabled') === 1,
    pushCounter: integer(row, 'push_counter'),
  };
  const pushTokenRef = optionalText(row, 'push_token_ref');
  if (pushTokenRef !== undefined) record.pushTokenRef = pushTokenRef;
  return record;
}
