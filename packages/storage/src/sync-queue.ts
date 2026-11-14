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
  rebased?: boolean;
  outcome?: 'ready' | 'uncertain' | 'rejected' | 'recovered';
  errorCode?: string;
  queries?: number;
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
    memoryConflictEntities(
      vaultId: string,
      projectIds: readonly string[],
      after = '',
    ): SyncEntityRecord[] {
      return db
        .prepare(`SELECT e.* FROM sync_entities e WHERE e.vault_id = ? AND e.entity_type = 'memory'
        AND e.materialized = 1 AND e.entity_id > ?
        AND (e.project_id IS NULL OR e.project_id IN (SELECT value FROM json_each(?)))
        AND (SELECT COUNT(*) FROM sync_heads h WHERE h.vault_id = e.vault_id AND h.entity_id = e.entity_id) > 1
        ORDER BY e.entity_id LIMIT 101`)
        .all(vaultId, after, toJson(projectIds))
        .map(entityFromRow);
    },
    settingsConflictEntities(vaultId: string, after = ''): SyncEntityRecord[] {
      return db
        .prepare(`SELECT e.* FROM sync_entities e WHERE e.vault_id = ? AND e.entity_type = 'settings'
        AND e.materialized = 1 AND e.entity_id > ?
        AND (SELECT COUNT(*) FROM sync_heads h WHERE h.vault_id=e.vault_id AND h.entity_id=e.entity_id)>1
        ORDER BY e.entity_id LIMIT 101`)
        .all(vaultId, after)
        .map(entityFromRow);
    },
    sessionConflictEntities(
      vaultId: string,
      projectIds: readonly string[],
      after = '',
    ): SyncEntityRecord[] {
      return db
        .prepare(`SELECT e.* FROM sync_entities e WHERE e.vault_id = ? AND e.entity_type = 'session'
        AND e.materialized = 1 AND e.entity_id > ?
        AND e.project_id IN (SELECT value FROM json_each(?))
        AND ((SELECT COUNT(*) FROM sync_heads h WHERE h.vault_id=e.vault_id AND h.entity_id=e.entity_id)>1
          OR (NOT EXISTS (SELECT 1 FROM sync_heads h WHERE h.vault_id=e.vault_id AND h.entity_id=e.entity_id AND h.op_id=e.revision)
            AND (EXISTS (SELECT 1 FROM sync_drafts d WHERE d.vault_id=e.vault_id AND d.op_id=e.revision)
              OR EXISTS (SELECT 1 FROM sync_operations o WHERE o.vault_id=e.vault_id AND o.op_id=e.revision AND o.direction='outbox' AND o.state IN ('queued','pending')))))
        ORDER BY e.entity_id LIMIT 101`)
        .all(vaultId, after, toJson(projectIds))
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
    draft(vaultId: string, opId: string): SyncDraftRecord | undefined {
      const row = db
        .prepare('SELECT * FROM sync_drafts WHERE vault_id = ? AND op_id = ?')
        .get(vaultId, opId);
      return (
        row && {
          vaultId: text(row, 'vault_id'),
          opId: text(row, 'op_id'),
          entityId: text(row, 'entity_id'),
          kind: text(row, 'kind'),
          parents: json(row, 'parents') as string[],
          content: json(row, 'content'),
          createdAt: text(row, 'created_at'),
        }
      );
    },
    projectOperationId(vaultId: string, projectId: string): string | undefined {
      const committed = db
        .prepare(`SELECT op_id FROM sync_operations WHERE vault_id=? AND entity_id=?
        AND entity_type='project' AND state IN ('committed','applied') LIMIT 1`)
        .get(vaultId, projectId);
      if (committed) return text(committed, 'op_id');
      const root = db
        .prepare(`SELECT r.op_id FROM sync_snapshot_roots r JOIN sync_entities e
        ON e.vault_id=r.vault_id AND e.entity_id=r.entity_id
        WHERE r.vault_id=? AND r.entity_id=? AND e.entity_type='project' LIMIT 1`)
        .get(vaultId, projectId);
      if (root) return text(root, 'op_id');
      const pending = db
        .prepare(`SELECT d.op_id FROM sync_entities e JOIN sync_drafts d
        ON d.vault_id=e.vault_id AND d.op_id=e.revision
        WHERE e.vault_id=? AND e.entity_id=? AND e.entity_type='project'`)
        .get(vaultId, projectId);
      return pending ? text(pending, 'op_id') : undefined;
    },
    drafts(
      vaultId: string,
      limit = 256,
      scopes?: { categories: string[]; projectIds: string[] },
      prioritizeChunks = false,
    ): SyncDraftRecord[] {
      return db
        .prepare(`SELECT d.* FROM sync_drafts d JOIN sync_entities e USING (vault_id, entity_id)
          WHERE d.vault_id = :vaultId
          AND (:categories IS NULL OR e.entity_type IN (SELECT value FROM json_each(:categories)))
          AND (:projects IS NULL OR e.project_id IS NULL OR e.project_id IN (SELECT value FROM json_each(:projects)))
          ORDER BY CASE WHEN :prioritizeChunks AND json_extract(d.content,'$.body.schema')='wevir-chunk/1' THEN 0 ELSE 1 END, d.rowid LIMIT :limit`)
        .all({
          vaultId,
          limit,
          categories: scopes ? toJson(scopes.categories) : null,
          projects: scopes ? toJson(scopes.projectIds) : null,
          prioritizeChunks: Number(prioritizeChunks),
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
    draftsReferencing(vaultId: string, opIds: readonly string[]): string[] {
      return db
        .prepare(`SELECT d.op_id FROM sync_drafts d WHERE d.vault_id = :vaultId AND (
        EXISTS (SELECT 1 FROM json_each(d.parents) p WHERE p.value IN (SELECT value FROM json_each(:ids)))
        OR (json_extract(d.content,'$.body.schema') = 'wevir-bundle/1' AND EXISTS (
          SELECT 1 FROM json_each(d.content,'$.body.files') f, json_each(f.value,'$.parts') p
          WHERE json_extract(p.value,'$.opId') IN (SELECT value FROM json_each(:ids))))
        OR (json_extract(d.content,'$.body.schema') = 'wevir-bundle/1' AND EXISTS (
          SELECT 1 FROM json_each(d.content,'$.body.metadata.ruleVersions') r
          WHERE json_extract(r.value,'$.opId') IN (SELECT value FROM json_each(:ids))))) ORDER BY d.rowid`)
        .all({ vaultId, ids: toJson(opIds) })
        .map((row) => text(row, 'op_id'));
    },
    saveResetDraft(jobId: string, draft: SyncDraftRecord): void {
      transactionRequired();
      db.prepare(
        'INSERT OR IGNORE INTO sync_reset_drafts(vault_id,job_id,op_id,original) VALUES (?,?,?,?)',
      ).run(draft.vaultId, jobId, draft.opId, toJson(draft));
    },
    rebaseOperation(vaultId: string, opId: string, nextId: string): void {
      transactionRequired();
      const result = db
        .prepare(
          "UPDATE sync_operations SET rebased_to = ? WHERE vault_id = ? AND op_id = ? AND direction = 'outbox' AND state = 'queued' AND rebased_to IS NULL",
        )
        .run(nextId, vaultId, opId);
      if (Number(result.changes) !== 1) throw new Error('sync reset operation changed');
      db.prepare('DELETE FROM sync_heads WHERE vault_id = ? AND op_id = ?').run(vaultId, opId);
      db.prepare('UPDATE sync_file_journal SET op_id = ? WHERE vault_id = ? AND op_id = ?').run(
        nextId,
        vaultId,
        opId,
      );
    },
    rebaseCommit(vaultId: string, commitId: string): void {
      transactionRequired();
      const result = db
        .prepare(
          "UPDATE sync_commits SET rebased = 1 WHERE vault_id = ? AND commit_id = ? AND attempts = 0 AND state = 'queued' AND rebased = 0",
        )
        .run(vaultId, commitId);
      if (Number(result.changes) !== 1) throw new Error('sync reset commit changed');
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
    rewindCapture(vaultId: string, localSessionId: string, streamId: string): void {
      transactionRequired();
      db.prepare(
        'UPDATE sync_event_captures SET prepared_seq = 0 WHERE vault_id = ? AND local_session_id = ? AND stream_id = ?',
      ).run(vaultId, localSessionId, streamId);
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
      db.prepare(`INSERT INTO sync_commits (vault_id, commit_id, body, state, cursor, attempts, retry_at, outcome, error_code, queries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (vault_id, commit_id) DO UPDATE SET state = excluded.state, cursor = excluded.cursor,
        attempts = excluded.attempts, retry_at = excluded.retry_at, outcome=excluded.outcome, error_code=excluded.error_code, queries=excluded.queries`).run(
        commit.vaultId,
        commit.commitId,
        commit.body,
        commit.state,
        commit.cursor ?? null,
        commit.attempts,
        commit.retryAt,
        commit.outcome ?? 'ready',
        commit.errorCode ?? null,
        commit.queries ?? 0,
      );
    },
    commits(vaultId: string, pendingOnly = true): SyncCommitRecord[] {
      return db
        .prepare(
          `SELECT * FROM sync_commits WHERE vault_id = ? ${pendingOnly ? "AND state != 'committed' AND rebased = 0" : ''} ORDER BY rowid`,
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
          ...(integer(row, 'rebased') && { rebased: true }),
          ...(text(row, 'outcome') !== 'ready' && {
            outcome: text(row, 'outcome') as SyncCommitRecord['outcome'],
          }),
          ...(integer(row, 'queries') && { queries: integer(row, 'queries') }),
          ...(optionalText(row, 'error_code') && { errorCode: text(row, 'error_code') }),
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
