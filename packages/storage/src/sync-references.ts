import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, json, optionalText, text, toJson } from './rows.js';

export interface SyncStreamRef {
  hostId: string;
  deviceId: string;
  sessionId: string;
  streamId: string;
}
export interface SyncContentRefRecord {
  vaultId: string;
  entityId: string;
  kind: 'episode' | 'retro-summary' | 'session';
  source: SyncStreamRef;
  localId?: string;
}

export function createSyncReferenceRepository(db: SqliteDatabase) {
  return {
    sessionDeclaration(vaultId: string, entityId: string): unknown {
      const row = db
        .prepare(`SELECT json_extract(record,'$.content') AS content FROM sync_operations
        WHERE vault_id=? AND entity_id=? AND state IN ('applied','committed')
        AND json_extract(record,'$.content.schema')='wevir-session/1' ORDER BY rowid LIMIT 1`)
        .get(vaultId, entityId);
      return row && json(row, 'content');
    },
    scopeInitialized(vaultId: string): boolean {
      return Boolean(
        db.prepare('SELECT scope_initialized FROM sync_vaults WHERE vault_id = ?').get(vaultId)
          ?.scope_initialized,
      );
    },
    setScopeInitialized(vaultId: string, value: boolean): void {
      db.prepare('UPDATE sync_vaults SET scope_initialized = ? WHERE vault_id = ?').run(
        Number(value),
        vaultId,
      );
    },
    historyBackfillPending(vaultId: string): boolean {
      return Boolean(
        db
          .prepare('SELECT history_backfill_pending FROM sync_vaults WHERE vault_id = ?')
          .get(vaultId)?.history_backfill_pending,
      );
    },
    setHistoryBackfillPending(vaultId: string, value: boolean): void {
      db.prepare('UPDATE sync_vaults SET history_backfill_pending = ? WHERE vault_id = ?').run(
        Number(value),
        vaultId,
      );
    },
    putContentRef(value: SyncContentRefRecord): void {
      if (!db.isTransaction) throw new Error('sync reference mapping requires a transaction');
      const old = db
        .prepare('SELECT * FROM sync_content_refs WHERE vault_id = ? AND entity_id = ?')
        .get(value.vaultId, value.entityId);
      if (
        old &&
        (text(old, 'kind') !== value.kind ||
          text(old, 'source') !== toJson(value.source) ||
          (optionalText(old, 'local_id') !== undefined &&
            optionalText(old, 'local_id') !== value.localId))
      )
        throw new Error('sync content binding changed');
      db.prepare(`INSERT INTO sync_content_refs (vault_id, entity_id, kind, source, local_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (vault_id, entity_id) DO UPDATE SET local_id = excluded.local_id`).run(
        value.vaultId,
        value.entityId,
        value.kind,
        toJson(value.source),
        value.localId ?? null,
      );
    },
    contentRefs(vaultId: string): SyncContentRefRecord[] {
      return db
        .prepare('SELECT * FROM sync_content_refs WHERE vault_id = ? ORDER BY rowid')
        .all(vaultId)
        .map(contentRef);
    },
    localContentRef(
      kind: SyncContentRefRecord['kind'],
      localId: string,
    ): SyncContentRefRecord | undefined {
      const row = db
        .prepare('SELECT * FROM sync_content_refs WHERE kind = ? AND local_id = ?')
        .get(kind, localId);
      return row && contentRef(row);
    },
    sourceLocalSeq(vaultId: string, source: SyncStreamRef, seq: string): number | undefined {
      const row = db
        .prepare(
          `SELECT local_seq FROM sync_source_events WHERE vault_id = ? AND host_id = ? AND session_id = ? AND stream_id = ? AND seq = ? AND local_seq IS NOT NULL`,
        )
        .get(vaultId, source.hostId, source.sessionId, source.streamId, seq);
      return row && integer(row, 'local_seq');
    },
    sourceThroughSeq(vaultId: string, source: SyncStreamRef, seq: string): number {
      const row = db
        .prepare(
          `SELECT MAX(local_seq) AS local_seq FROM sync_source_events WHERE vault_id = ? AND host_id = ? AND session_id = ? AND stream_id = ? AND (LENGTH(seq) < ? OR (LENGTH(seq) = ? AND seq <= ?))`,
        )
        .get(
          vaultId,
          source.hostId,
          source.sessionId,
          source.streamId,
          seq.length,
          seq.length,
          seq,
        );
      return row?.local_seq == null ? 0 : integer(row, 'local_seq');
    },
    sourceOrigins(
      localSessionId: string,
      fromSeq: number,
      throughSeq: number,
    ): Array<SyncStreamRef & { vaultId: string; seq: string; localSeq: number }> {
      return db
        .prepare(`SELECT s.vault_id, s.host_id, s.device_id, s.session_id, s.stream_id, e.seq, e.local_seq FROM sync_sources s
        JOIN sync_source_events e ON e.vault_id = s.vault_id AND e.host_id = s.host_id AND e.session_id = s.session_id AND e.stream_id = s.stream_id
        WHERE s.local_session_id = ? AND e.local_seq >= ? AND e.local_seq <= ? AND s.mirrored = 1 AND s.device_id IS NOT NULL`)
        .all(localSessionId, fromSeq, throughSeq)
        .map((row) => ({
          vaultId: text(row, 'vault_id'),
          hostId: text(row, 'host_id'),
          deviceId: text(row, 'device_id'),
          sessionId: text(row, 'session_id'),
          streamId: text(row, 'stream_id'),
          seq: text(row, 'seq'),
          localSeq: integer(row, 'local_seq'),
        }));
    },
    sourceOrigin(
      localSessionId: string,
      localSeq: number,
    ): (SyncStreamRef & { vaultId: string; seq: string }) | undefined {
      const row = db
        .prepare(`SELECT s.vault_id, s.host_id, s.device_id, s.session_id, s.stream_id, e.seq FROM sync_sources s
        JOIN sync_source_events e ON e.vault_id = s.vault_id AND e.host_id = s.host_id AND e.session_id = s.session_id AND e.stream_id = s.stream_id
        WHERE s.local_session_id = ? AND e.local_seq = ? AND s.mirrored = 1 AND s.device_id IS NOT NULL`)
        .get(localSessionId, localSeq);
      return (
        row && {
          vaultId: text(row, 'vault_id'),
          hostId: text(row, 'host_id'),
          deviceId: text(row, 'device_id'),
          sessionId: text(row, 'session_id'),
          streamId: text(row, 'stream_id'),
          seq: text(row, 'seq'),
        }
      );
    },
    markSessionDeleted(
      vaultId: string,
      entityId: string,
      localSessionId: string,
      opId: string,
    ): void {
      if (!db.isTransaction) throw new Error('sync tombstone requires a transaction');
      db.prepare(`INSERT INTO sync_session_deletions (vault_id, entity_id, local_session_id, op_id) VALUES (?, ?, ?, ?)
        ON CONFLICT (vault_id, entity_id) DO UPDATE SET op_id = excluded.op_id`).run(
        vaultId,
        entityId,
        localSessionId,
        opId,
      );
    },
    sessionDeleted(localSessionId: string): boolean {
      return Boolean(
        db
          .prepare('SELECT 1 FROM sync_session_deletions WHERE local_session_id = ? LIMIT 1')
          .get(localSessionId),
      );
    },
    clearSessionDeleted(vaultId: string, entityId: string): void {
      if (!db.isTransaction) throw new Error('sync restoration requires a transaction');
      db.prepare('DELETE FROM sync_session_deletions WHERE vault_id = ? AND entity_id = ?').run(
        vaultId,
        entityId,
      );
    },
  };
}
function contentRef(row: SqlRow): SyncContentRefRecord {
  return {
    vaultId: text(row, 'vault_id'),
    entityId: text(row, 'entity_id'),
    kind: text(row, 'kind') as SyncContentRefRecord['kind'],
    source: json(row, 'source') as SyncStreamRef,
    ...(optionalText(row, 'local_id') && { localId: text(row, 'local_id') }),
  };
}
