import type { SqliteDatabase, SqlRow } from './driver.js';
import { json, optionalText, text } from './rows.js';

export interface SyncLocalWriteRecord {
  id: string;
  vaultId: string;
  entityId: string;
  entityType: string;
  projectId?: string;
  localKey: string;
  path: string;
  content: unknown;
  kind: 'put' | 'delete';
  parents: string[];
  nextHash: string;
  state: 'pending' | 'abandoned';
}

export interface SyncMaterialJournalRecord {
  vaultId: string;
  opId: string;
  entityId: string;
  localKey: string;
  targetPath: string;
  stagedPath?: string;
  previousHash?: string;
  nextHash: string;
  backupPath?: string;
  state: 'staged' | 'applied' | 'conflict';
}

export function createSyncMaterialRepository(db: SqliteDatabase) {
  return {
    putLocalWrite(value: SyncLocalWriteRecord): void {
      if (!db.isTransaction) throw new Error('sync file capture requires a transaction');
      db.prepare(`INSERT INTO sync_local_writes (id, vault_id, entity_id, entity_type, project_id, local_key, path, content, kind, parents, next_hash, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.id,
        value.vaultId,
        value.entityId,
        value.entityType,
        value.projectId ?? null,
        value.localKey,
        value.path,
        JSON.stringify(value.content),
        value.kind,
        JSON.stringify(value.parents),
        value.nextHash,
        value.state,
      );
    },
    localWrites(vaultId: string): SyncLocalWriteRecord[] {
      return db
        .prepare('SELECT * FROM sync_local_writes WHERE vault_id = ? ORDER BY rowid')
        .all(vaultId)
        .map((row) => ({
          id: text(row, 'id'),
          vaultId: text(row, 'vault_id'),
          entityId: text(row, 'entity_id'),
          entityType: text(row, 'entity_type'),
          ...(optionalText(row, 'project_id') && { projectId: text(row, 'project_id') }),
          localKey: text(row, 'local_key'),
          path: text(row, 'path'),
          content: json(row, 'content'),
          kind: text(row, 'kind') as SyncLocalWriteRecord['kind'],
          parents: json(row, 'parents') as string[],
          nextHash: text(row, 'next_hash'),
          state: text(row, 'state') as SyncLocalWriteRecord['state'],
        }));
    },
    abandonLocalWrite(id: string): void {
      db.prepare("UPDATE sync_local_writes SET state = 'abandoned' WHERE id = ?").run(id);
    },
    removeLocalWrite(id: string): void {
      if (!db.isTransaction) throw new Error('sync file capture requires a transaction');
      db.prepare('DELETE FROM sync_local_writes WHERE id = ?').run(id);
    },
    owner(localKey: string): string | undefined {
      const row = db
        .prepare('SELECT vault_id FROM sync_resource_owners WHERE local_key = ?')
        .get(localKey);
      return row && text(row, 'vault_id');
    },
    claimResource(localKey: string, vaultId: string): boolean {
      if (!db.isTransaction) throw new Error('sync resource ownership requires a transaction');
      db.prepare(
        'INSERT OR IGNORE INTO sync_resource_owners (local_key, vault_id) VALUES (?, ?)',
      ).run(localKey, vaultId);
      return (
        db.prepare('SELECT vault_id FROM sync_resource_owners WHERE local_key = ?').get(localKey)
          ?.vault_id === vaultId
      );
    },
    foreignSource(vaultId: string, localSessionId: string): boolean {
      return Boolean(
        db
          .prepare(
            'SELECT 1 FROM sync_sources WHERE local_session_id = ? AND (vault_id != ? OR mirrored = 1) LIMIT 1',
          )
          .get(localSessionId, vaultId),
      );
    },
    sourceFingerprint(
      vaultId: string,
      hostId: string,
      sessionId: string,
      streamId: string,
      seq: string,
    ): string | undefined {
      const row = db
        .prepare(
          'SELECT sha256 FROM sync_source_events WHERE vault_id = ? AND host_id = ? AND session_id = ? AND stream_id = ? AND seq = ?',
        )
        .get(vaultId, hostId, sessionId, streamId, seq);
      return row && text(row, 'sha256');
    },
    fileBaseline(
      vaultId: string,
      entityId: string,
    ): { path: string; fingerprint: string; opId?: string } | undefined {
      const row = db
        .prepare(
          'SELECT path, fingerprint, op_id FROM sync_file_journal WHERE vault_id = ? AND entity_id = ?',
        )
        .get(vaultId, entityId);
      return (
        row && {
          path: text(row, 'path'),
          fingerprint: text(row, 'fingerprint'),
          ...(optionalText(row, 'op_id') && { opId: text(row, 'op_id') }),
        }
      );
    },
    putFileBaseline(value: {
      vaultId: string;
      entityId: string;
      entityType: string;
      projectId?: string;
      path: string;
      fingerprint: string;
      opId?: string;
    }): void {
      db.prepare(`INSERT INTO sync_file_journal (vault_id, entity_id, entity_type, project_id, path, fingerprint, op_id) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (vault_id, entity_id) DO UPDATE SET path = excluded.path, fingerprint = excluded.fingerprint, op_id = excluded.op_id`).run(
        value.vaultId,
        value.entityId,
        value.entityType,
        value.projectId ?? null,
        value.path,
        value.fingerprint,
        value.opId ?? null,
      );
    },
    materialJournal(vaultId: string, opId: string): SyncMaterialJournalRecord | undefined {
      const row = db
        .prepare('SELECT * FROM sync_material_journal WHERE vault_id = ? AND op_id = ?')
        .get(vaultId, opId);
      return row && journalFromRow(row);
    },
    materialJournals(vaultId: string): SyncMaterialJournalRecord[] {
      return db
        .prepare('SELECT * FROM sync_material_journal WHERE vault_id = ? ORDER BY rowid')
        .all(vaultId)
        .map(journalFromRow);
    },
    putMaterialJournal(value: SyncMaterialJournalRecord): void {
      db.prepare(`INSERT INTO sync_material_journal (vault_id, op_id, entity_id, local_key, target_path, staged_path, previous_hash, next_hash, backup_path, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (vault_id, op_id) DO UPDATE SET
        staged_path = excluded.staged_path, backup_path = excluded.backup_path, state = excluded.state`).run(
        value.vaultId,
        value.opId,
        value.entityId,
        value.localKey,
        value.targetPath,
        value.stagedPath ?? null,
        value.previousHash ?? null,
        value.nextHash,
        value.backupPath ?? null,
        value.state,
      );
    },
    setIncludeHistory(vaultId: string, value: boolean): void {
      db.prepare('UPDATE sync_vaults SET include_history = ? WHERE vault_id = ?').run(
        Number(value),
        vaultId,
      );
    },
    includeHistory(vaultId: string): boolean {
      return Boolean(
        db.prepare('SELECT include_history FROM sync_vaults WHERE vault_id = ?').get(vaultId)
          ?.include_history,
      );
    },
    setProjectName(vaultId: string, projectId: string, name: string): void {
      db.prepare(
        'UPDATE sync_projects SET display_name = ? WHERE vault_id = ? AND project_id = ?',
      ).run(name, vaultId, projectId);
    },
    projectName(vaultId: string, projectId: string): string | undefined {
      const row = db
        .prepare('SELECT display_name FROM sync_projects WHERE vault_id = ? AND project_id = ?')
        .get(vaultId, projectId);
      return row ? optionalText(row, 'display_name') : undefined;
    },
  };
}

function journalFromRow(row: SqlRow): SyncMaterialJournalRecord {
  return {
    vaultId: text(row, 'vault_id'),
    opId: text(row, 'op_id'),
    entityId: text(row, 'entity_id'),
    localKey: text(row, 'local_key'),
    targetPath: text(row, 'target_path'),
    nextHash: text(row, 'next_hash'),
    state: text(row, 'state') as SyncMaterialJournalRecord['state'],
    ...(optionalText(row, 'staged_path') && { stagedPath: text(row, 'staged_path') }),
    ...(optionalText(row, 'previous_hash') && { previousHash: text(row, 'previous_hash') }),
    ...(optionalText(row, 'backup_path') && { backupPath: text(row, 'backup_path') }),
  };
}
