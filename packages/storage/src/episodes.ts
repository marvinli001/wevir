import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, optionalText, text } from './rows.js';

export interface EpisodeRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  schemaVersion: number;
  throughSeq: number;
  digest: string;
  overrides: string;
  pinned: boolean;
  excluded: boolean;
  revision: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeRepository {
  get(id: string): EpisodeRecord | undefined;
  forSession(sessionId: string): EpisodeRecord | undefined;
  list(workspaceId: string): EpisodeRecord[];
  put(record: EpisodeRecord): void;
  removeWorkspace(workspaceId: string): void;
}

function record(row: SqlRow): EpisodeRecord {
  const deletedAt = optionalText(row, 'deleted_at');
  return {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    sessionId: text(row, 'session_id'),
    rootSessionId: text(row, 'root_session_id'),
    schemaVersion: integer(row, 'schema_version'),
    throughSeq: integer(row, 'through_seq'),
    digest: text(row, 'digest_json'),
    overrides: text(row, 'overrides_json'),
    pinned: integer(row, 'pinned') === 1,
    excluded: integer(row, 'excluded') === 1,
    revision: text(row, 'revision'),
    ...(deletedAt !== undefined && { deletedAt }),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function createEpisodeRepository(db: SqliteDatabase): EpisodeRepository {
  const get = db.prepare('SELECT * FROM episodes WHERE id = ?');
  const forSession = db.prepare('SELECT * FROM episodes WHERE session_id = ?');
  const list = db.prepare(
    'SELECT * FROM episodes WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC',
  );
  const put = db.prepare(`INSERT INTO episodes
    (id, workspace_id, session_id, root_session_id, schema_version, through_seq, digest_json,
     overrides_json, pinned, excluded, revision, deleted_at, created_at, updated_at)
    VALUES (:id, :workspaceId, :sessionId, :rootSessionId, :schemaVersion, :throughSeq, :digest,
      :overrides, :pinned, :excluded, :revision, :deletedAt, :createdAt, :updatedAt)
    ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, through_seq=excluded.through_seq,
      digest_json=excluded.digest_json, overrides_json=excluded.overrides_json, pinned=excluded.pinned,
      excluded=excluded.excluded, revision=excluded.revision, deleted_at=excluded.deleted_at,
      updated_at=excluded.updated_at`);
  const removeWorkspace = db.prepare('DELETE FROM episodes WHERE workspace_id = ?');
  return {
    get(id) {
      const row = get.get(id) as SqlRow | undefined;
      return row === undefined ? undefined : record(row);
    },
    forSession(id) {
      const row = forSession.get(id) as SqlRow | undefined;
      return row === undefined ? undefined : record(row);
    },
    list(workspaceId) {
      return (list.all(workspaceId) as SqlRow[]).map(record);
    },
    put(value) {
      put.run({
        ...value,
        pinned: Number(value.pinned),
        excluded: Number(value.excluded),
        deletedAt: value.deletedAt ?? null,
      });
    },
    removeWorkspace(workspaceId) {
      removeWorkspace.run(workspaceId);
    },
  };
}
