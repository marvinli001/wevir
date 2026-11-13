import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, json, optionalText, text, toJson } from './rows.js';

export interface SyncEntityRecord {
  vaultId: string;
  entityId: string;
  entityType: string;
  projectId?: string;
  localKey: string;
  revision?: string;
  fingerprint?: string;
  materialized: boolean;
}

export interface SyncDraftRecord {
  vaultId: string;
  opId: string;
  entityId: string;
  kind: string;
  parents: string[];
  content: unknown;
  createdAt: string;
}

export interface SyncBlobRecord {
  vaultId: string;
  blobId: string;
  cipherSha256: string;
  cipherBytes: number;
  keyEpoch: string;
  cachePath: string;
  state: 'local' | 'reserved' | 'ready' | 'quarantined';
  uploadId?: string;
  uploadExpiresAt?: string;
  uploadAttempts: number;
  downloadAttempts: number;
  errorCode?: string;
}

export interface SyncCommitRecord {
  vaultId: string;
  commitId: string;
  body: string;
  state: 'queued' | 'pending' | 'committed';
  cursor?: string;
  attempts: number;
  retryAt: number;
}

export interface SyncCaptureRecord {
  vaultId: string;
  localSessionId: string;
  streamId: string;
  projectId: string;
  throughSeq: number;
  preparedSeq: number;
}

export function createSyncQueueRepository(db: SqliteDatabase) {
  const transactionRequired = () => {
    if (!db.isTransaction) throw new Error('sync queue mutation requires a storage transaction');
  };
  return {
    entity(vaultId: string, entityId: string): SyncEntityRecord | undefined {
      const row = db
        .prepare('SELECT * FROM sync_entities WHERE vault_id = ? AND entity_id = ?')
        .get(vaultId, entityId);
      return row && entityFromRow(row);
    },
    localEntity(vaultId: string, localKey: string): SyncEntityRecord | undefined {
      const row = db
        .prepare(
          'SELECT * FROM sync_entities WHERE vault_id = ? AND local_key = ? AND materialized = 1',
        )
        .get(vaultId, localKey);
      return row && entityFromRow(row);
    },
    entities(vaultId: string): SyncEntityRecord[] {
      return db
        .prepare('SELECT * FROM sync_entities WHERE vault_id = ? ORDER BY rowid')
        .all(vaultId)
        .map(entityFromRow);
    },
    putEntity(entity: SyncEntityRecord): void {
      transactionRequired();
      const previous = db
        .prepare(
          'SELECT entity_type, project_id, local_key FROM sync_entities WHERE vault_id = ? AND entity_id = ?',
        )
        .get(entity.vaultId, entity.entityId);
      if (
        previous &&
        (text(previous, 'entity_type') !== entity.entityType ||
          optionalText(previous, 'project_id') !== entity.projectId ||
          text(previous, 'local_key') !== entity.localKey)
      )
        throw new Error('sync entity binding changed');
      db.prepare(`INSERT INTO sync_entities (vault_id, entity_id, entity_type, project_id, local_key, revision, fingerprint, materialized)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (vault_id, entity_id) DO UPDATE SET
        revision = excluded.revision, fingerprint = excluded.fingerprint, materialized = excluded.materialized`).run(
        entity.vaultId,
        entity.entityId,
        entity.entityType,
        entity.projectId ?? null,
        entity.localKey,
        entity.revision ?? null,
        entity.fingerprint ?? null,
        Number(entity.materialized),
      );
    },
    putDraft(draft: SyncDraftRecord): void {
      transactionRequired();
      db.prepare(
        'INSERT INTO sync_drafts (vault_id, op_id, entity_id, kind, parents, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        draft.vaultId,
        draft.opId,
        draft.entityId,
        draft.kind,
        toJson(draft.parents),
        toJson(draft.content),
        draft.createdAt,
      );
    },
    drafts(
      vaultId: string,
      limit = 256,
      scopes?: { categories: string[]; projectIds: string[] },
    ): SyncDraftRecord[] {
      return db
        .prepare(`SELECT d.* FROM sync_drafts d JOIN sync_entities e USING (vault_id, entity_id)
          WHERE d.vault_id = :vaultId
          AND (:categories IS NULL OR e.entity_type IN (SELECT value FROM json_each(:categories)))
          AND (:projects IS NULL OR e.project_id IS NULL OR e.project_id IN (SELECT value FROM json_each(:projects)))
          ORDER BY d.rowid LIMIT :limit`)
        .all({
          vaultId,
          limit,
          categories: scopes ? toJson(scopes.categories) : null,
          projects: scopes ? toJson(scopes.projectIds) : null,
        })
        .map((row) => ({
          vaultId: text(row, 'vault_id'),
          opId: text(row, 'op_id'),
          entityId: text(row, 'entity_id'),
          kind: text(row, 'kind'),
          parents: json(row, 'parents') as string[],
          content: json(row, 'content'),
          createdAt: text(row, 'created_at'),
        }));
    },
    removeDraft(vaultId: string, opId: string): void {
      transactionRequired();
      db.prepare('DELETE FROM sync_drafts WHERE vault_id = ? AND op_id = ?').run(vaultId, opId);
    },
    capture(capture: SyncCaptureRecord): void {
      transactionRequired();
      db.prepare(`INSERT INTO sync_event_captures (vault_id, local_session_id, stream_id, project_id, through_seq, prepared_seq)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (vault_id, local_session_id, stream_id)
        DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq)`).run(
        capture.vaultId,
        capture.localSessionId,
        capture.streamId,
        capture.projectId,
        capture.throughSeq,
        capture.preparedSeq,
      );
    },
    captures(vaultId: string): SyncCaptureRecord[] {
      return db
        .prepare(
          'SELECT * FROM sync_event_captures WHERE vault_id = ? AND through_seq > prepared_seq ORDER BY rowid',
        )
        .all(vaultId)
        .map((row) => ({
          vaultId: text(row, 'vault_id'),
          localSessionId: text(row, 'local_session_id'),
          streamId: text(row, 'stream_id'),
          projectId: text(row, 'project_id'),
          throughSeq: integer(row, 'through_seq'),
          preparedSeq: integer(row, 'prepared_seq'),
        }));
    },
    captureRange(
      vaultId: string,
      localSessionId: string,
      streamId: string,
    ): SyncCaptureRecord | undefined {
      const row = db
        .prepare(
          'SELECT * FROM sync_event_captures WHERE vault_id = ? AND local_session_id = ? AND stream_id = ?',
        )
        .get(vaultId, localSessionId, streamId);
      return row
        ? {
            vaultId,
            localSessionId,
            streamId,
            projectId: text(row, 'project_id'),
            throughSeq: integer(row, 'through_seq'),
            preparedSeq: integer(row, 'prepared_seq'),
          }
        : undefined;
    },
    prepareCapture(capture: SyncCaptureRecord, throughSeq: number): void {
      transactionRequired();
      const result = db
        .prepare(
          'UPDATE sync_event_captures SET prepared_seq = ? WHERE vault_id = ? AND local_session_id = ? AND stream_id = ? AND prepared_seq = ? AND through_seq >= ?',
        )
        .run(
          throughSeq,
          capture.vaultId,
          capture.localSessionId,
          capture.streamId,
          capture.preparedSeq,
          throughSeq,
        );
      if (!result.changes) throw new Error('sync capture changed');
    },
    blob(vaultId: string, blobId: string): SyncBlobRecord | undefined {
      const row = db
        .prepare('SELECT * FROM sync_blobs WHERE vault_id = ? AND blob_id = ?')
        .get(vaultId, blobId);
      return row && blobFromRow(row);
    },
    putBlob(blob: SyncBlobRecord): void {
      const previous = db
        .prepare(
          'SELECT cipher_sha256, cipher_bytes, key_epoch FROM sync_blobs WHERE vault_id = ? AND blob_id = ?',
        )
        .get(blob.vaultId, blob.blobId);
      if (
        previous &&
        (text(previous, 'cipher_sha256') !== blob.cipherSha256 ||
          integer(previous, 'cipher_bytes') !== blob.cipherBytes ||
          (text(previous, 'key_epoch') !== '' && text(previous, 'key_epoch') !== blob.keyEpoch))
      )
        throw new Error('sync blob identity changed');
      db.prepare(`INSERT INTO sync_blobs (vault_id, blob_id, cipher_sha256, cipher_bytes, key_epoch, cache_path, state, upload_id, upload_expires_at, upload_attempts, download_attempts, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (vault_id, blob_id) DO UPDATE SET cache_path = excluded.cache_path,
        state = excluded.state, upload_id = excluded.upload_id, upload_expires_at = excluded.upload_expires_at,
        upload_attempts = excluded.upload_attempts, download_attempts = excluded.download_attempts, error_code = excluded.error_code`).run(
        blob.vaultId,
        blob.blobId,
        blob.cipherSha256,
        blob.cipherBytes,
        blob.keyEpoch,
        blob.cachePath,
        blob.state,
        blob.uploadId ?? null,
        blob.uploadExpiresAt ?? null,
        blob.uploadAttempts,
        blob.downloadAttempts,
        blob.errorCode ?? null,
      );
    },
    putCommit(commit: SyncCommitRecord): void {
      transactionRequired();
      const previous = db
        .prepare('SELECT body FROM sync_commits WHERE vault_id = ? AND commit_id = ?')
        .get(commit.vaultId, commit.commitId);
      if (previous && text(previous, 'body') !== commit.body)
        throw new Error('sync commit identity changed');
      db.prepare(`INSERT INTO sync_commits (vault_id, commit_id, body, state, cursor, attempts, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (vault_id, commit_id) DO UPDATE SET state = excluded.state, cursor = excluded.cursor,
        attempts = excluded.attempts, retry_at = excluded.retry_at`).run(
        commit.vaultId,
        commit.commitId,
        commit.body,
        commit.state,
        commit.cursor ?? null,
        commit.attempts,
        commit.retryAt,
      );
    },
    commits(vaultId: string, pendingOnly = true): SyncCommitRecord[] {
      return db
        .prepare(
          `SELECT * FROM sync_commits WHERE vault_id = ? ${pendingOnly ? "AND state != 'committed'" : ''} ORDER BY rowid`,
        )
        .all(vaultId)
        .map((row) => ({
          vaultId: text(row, 'vault_id'),
          commitId: text(row, 'commit_id'),
          body: text(row, 'body'),
          state: text(row, 'state') as SyncCommitRecord['state'],
          ...(optionalText(row, 'cursor') !== undefined && { cursor: text(row, 'cursor') }),
          attempts: integer(row, 'attempts'),
          retryAt: integer(row, 'retry_at'),
        }));
    },
    pages(
      vaultId: string,
    ): Array<{ pageId: string; fromCursor: string; nextCursor: string; opIds: string[] }> {
      return db
        .prepare('SELECT * FROM sync_pages WHERE vault_id = ? AND applied = 0 ORDER BY rowid')
        .all(vaultId)
        .map((row) => ({
          pageId: text(row, 'page_id'),
          fromCursor: text(row, 'from_cursor'),
          nextCursor: text(row, 'next_cursor'),
          opIds: json(row, 'op_ids') as string[],
        }));
    },
    putVerifiedRecord(vaultId: string, opId: string, record: unknown): void {
      db.prepare(
        "UPDATE sync_operations SET record = ? WHERE vault_id = ? AND op_id = ? AND state IN ('received', 'quarantined')",
      ).run(toJson(record), vaultId, opId);
    },
    vaultTransport(vaultId: string): {
      keyEpoch: string;
      state: string;
      errorCode?: string;
      retryAt: number;
      lastSyncAt?: string;
    } {
      const row = db.prepare('SELECT * FROM sync_vaults WHERE vault_id = ?').get(vaultId);
      if (!row) throw new Error('sync vault not found');
      return {
        keyEpoch: text(row, 'key_epoch'),
        state: text(row, 'transport_state'),
        ...(optionalText(row, 'last_error') !== undefined && {
          errorCode: text(row, 'last_error'),
        }),
        retryAt: integer(row, 'retry_at'),
        ...(optionalText(row, 'last_sync_at') !== undefined && {
          lastSyncAt: text(row, 'last_sync_at'),
        }),
      };
    },
    setVaultTransport(
      vaultId: string,
      value: {
        keyEpoch: string;
        state: string;
        errorCode?: string;
        retryAt: number;
        lastSyncAt?: string;
      },
    ): void {
      db.prepare(
        'UPDATE sync_vaults SET key_epoch = ?, transport_state = ?, last_error = ?, retry_at = ?, last_sync_at = ? WHERE vault_id = ?',
      ).run(
        value.keyEpoch,
        value.state,
        value.errorCode ?? null,
        value.retryAt,
        value.lastSyncAt ?? null,
        vaultId,
      );
    },
  };
}

function entityFromRow(row: SqlRow): SyncEntityRecord {
  return {
    vaultId: text(row, 'vault_id'),
    entityId: text(row, 'entity_id'),
    entityType: text(row, 'entity_type'),
    ...(optionalText(row, 'project_id') !== undefined && { projectId: text(row, 'project_id') }),
    localKey: text(row, 'local_key'),
    ...(optionalText(row, 'revision') !== undefined && { revision: text(row, 'revision') }),
    ...(optionalText(row, 'fingerprint') !== undefined && {
      fingerprint: text(row, 'fingerprint'),
    }),
    materialized: Boolean(integer(row, 'materialized')),
  };
}

function blobFromRow(row: SqlRow): SyncBlobRecord {
  return {
    vaultId: text(row, 'vault_id'),
    blobId: text(row, 'blob_id'),
    cipherSha256: text(row, 'cipher_sha256'),
    cipherBytes: integer(row, 'cipher_bytes'),
    keyEpoch: text(row, 'key_epoch'),
    cachePath: text(row, 'cache_path'),
    state: text(row, 'state') as SyncBlobRecord['state'],
    uploadAttempts: integer(row, 'upload_attempts'),
    downloadAttempts: integer(row, 'download_attempts'),
    ...(optionalText(row, 'upload_id') !== undefined && { uploadId: text(row, 'upload_id') }),
    ...(optionalText(row, 'upload_expires_at') !== undefined && {
      uploadExpiresAt: text(row, 'upload_expires_at'),
    }),
    ...(optionalText(row, 'error_code') !== undefined && { errorCode: text(row, 'error_code') }),
  };
}
