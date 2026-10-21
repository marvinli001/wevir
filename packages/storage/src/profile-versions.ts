import type { SqliteDatabase, SqlRow } from './driver.js';
import {
  integer,
  optionalJson,
  optionalText,
  orNull,
  text,
  toJson,
  toNullableJson,
} from './rows.js';

/** `profile_versions` 表的一行（0019_profile_versions，协议 0.85.0 的 `tuning.*`）。 */
export interface ProfileVersionRecord {
  id: string;
  /** 省略是全局档案。 */
  workspaceId?: string;
  /** 范围内的序号，从 1 起。 */
  seq: number;
  fingerprint: string;
  /** 每层的条目与层散列，原样存 JSON。 */
  manifest: unknown;
  createdAt: string;
  /** 这一版由什么产生；会话开始时自动生成的省略。 */
  cause?: unknown;
}

/** `ensure` 要插入的版本：`seq` 由仓储按范围取下一个。 */
export type NewProfileVersion = Omit<ProfileVersionRecord, 'seq'>;

export interface ProfileVersionRepository {
  /**
   * 范围里最新的版本指纹相同就返回它（`created` 为 false），否则用下一个序号插入 `next`。查与插之间没有异步，同时建会话的两个
   * 调用不会开出两个一样的版本。
   */
  ensure(next: NewProfileVersion): { version: ProfileVersionRecord; created: boolean };
  get(id: string): ProfileVersionRecord | undefined;
  latest(workspaceId: string | undefined): ProfileVersionRecord | undefined;
  /** 序号比 `seq` 小的里最大的那个：前一版。 */
  previous(workspaceId: string | undefined, seq: number): ProfileVersionRecord | undefined;
  /** 新的在前；`beforeSeq` 给了只列序号比它小的。 */
  list(
    workspaceId: string | undefined,
    options?: { beforeSeq?: number; limit?: number },
  ): ProfileVersionRecord[];
  /** 每个版本建了几个会话。没有会话的版本不在结果里。 */
  sessionCounts(ids: readonly string[]): Map<string, number>;
  /** 用这个版本建的会话，新的在前。 */
  sessionIds(id: string, limit: number): string[];
  /** 全部版本的 manifest（清理没有引用的文本时用）。 */
  manifests(): unknown[];
}

export function createProfileVersionRepository(db: SqliteDatabase): ProfileVersionRepository {
  const scope = "COALESCE(workspace_id, '') = ?";
  const insert = db.prepare(`
    INSERT INTO profile_versions (id, workspace_id, seq, fingerprint, manifest_json, created_at, cause_json)
    VALUES (:id, :workspaceId, :seq, :fingerprint, :manifest, :createdAt, :cause)`);
  const get = db.prepare('SELECT * FROM profile_versions WHERE id = ?');
  const latest = db.prepare(
    `SELECT * FROM profile_versions WHERE ${scope} ORDER BY seq DESC LIMIT 1`,
  );
  const previous = db.prepare(
    `SELECT * FROM profile_versions WHERE ${scope} AND seq < ? ORDER BY seq DESC LIMIT 1`,
  );
  const list = db.prepare(
    `SELECT * FROM profile_versions WHERE ${scope} AND seq < ? ORDER BY seq DESC LIMIT ?`,
  );
  const sessionCount = db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE profile_version_id = ?',
  );
  const sessionIds = db.prepare(
    'SELECT id FROM sessions WHERE profile_version_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  );
  const manifests = db.prepare('SELECT manifest_json FROM profile_versions');
  const read = (row: SqlRow | undefined) => (row ? fromRow(row) : undefined);
  const latestOf = (workspaceId: string | undefined) => read(latest.get(workspaceId ?? ''));

  return {
    ensure(next) {
      // 查与插都是同步语句，中间不会插进别的调用。
      const current = latestOf(next.workspaceId);
      if (current !== undefined && current.fingerprint === next.fingerprint) {
        return { version: current, created: false };
      }
      const version: ProfileVersionRecord = { ...next, seq: (current?.seq ?? 0) + 1 };
      insert.run({
        id: version.id,
        workspaceId: orNull(version.workspaceId),
        seq: version.seq,
        fingerprint: version.fingerprint,
        manifest: toJson(version.manifest),
        createdAt: version.createdAt,
        cause: toNullableJson(version.cause),
      });
      return { version, created: true };
    },
    get: (id) => read(get.get(id)),
    latest: latestOf,
    previous: (workspaceId, seq) => read(previous.get(workspaceId ?? '', seq)),
    list: (workspaceId, options = {}) =>
      list
        .all(workspaceId ?? '', options.beforeSeq ?? Number.MAX_SAFE_INTEGER, options.limit ?? -1)
        .map(fromRow),
    sessionCounts(ids) {
      const counts = new Map<string, number>();
      for (const id of ids) {
        const n = integer(sessionCount.get(id) ?? {}, 'n');
        if (n > 0) counts.set(id, n);
      }
      return counts;
    },
    sessionIds: (id, limit) => sessionIds.all(id, limit).map((row) => text(row, 'id')),
    manifests: () => manifests.all().map((row) => JSON.parse(text(row, 'manifest_json'))),
  };
}

function fromRow(row: SqlRow): ProfileVersionRecord {
  const workspaceId = optionalText(row, 'workspace_id');
  const cause = optionalJson(row, 'cause_json');
  return {
    id: text(row, 'id'),
    ...(workspaceId !== undefined && { workspaceId }),
    seq: integer(row, 'seq'),
    fingerprint: text(row, 'fingerprint'),
    manifest: JSON.parse(text(row, 'manifest_json')),
    createdAt: text(row, 'created_at'),
    ...(cause !== undefined && { cause }),
  };
}
