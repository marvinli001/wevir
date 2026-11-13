import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, json, optionalText, text, toJson } from './rows.js';
import { createSyncMaterialRepository } from './sync-materials.js';
import { createSyncQueueRepository } from './sync-queue.js';
import { createSyncReferenceRepository } from './sync-references.js';

export interface SyncVaultRecord {
  vaultId: string;
  accountId: string;
  deviceId: string;
  originHostId: string;
  deviceSeq: string;
  active: boolean;
  enabled: boolean;
  revision: string;
  categories: string[];
  projectIds: string[];
  appliedCursor: string;
}

export interface SyncOperationRecord {
  vaultId: string;
  opId: string;
  deviceId: string;
  deviceSeq: string;
  entityType: string;
  entityId: string;
  projectId?: string;
  envelope: unknown;
  manifest: unknown;
  digest: string;
  record?: unknown;
  direction: 'outbox' | 'inbox';
  state: 'queued' | 'pending' | 'committed' | 'received' | 'applied' | 'quarantined';
  commitId?: string;
  errorCode?: string;
}

export interface SyncSourceRecord {
  vaultId: string;
  hostId: string;
  sessionId: string;
  streamId: string;
  localSessionId?: string;
  mirrored: boolean;
  deviceId?: string;
}

export class SyncStorageError extends Error {
  constructor(
    readonly code:
      | 'VAULT_BOUND'
      | 'DEVICE_CHANGED'
      | 'OP_ID_REUSED'
      | 'PROJECT_CHANGED'
      | 'MISSING_PARENT'
      | 'INTEGRITY_FAILED'
      | 'CURSOR_CONFLICT',
  ) {
    super(code);
    this.name = 'SyncStorageError';
  }
}

export function createSyncRepository(db: SqliteDatabase) {
  const getVault = (vaultId: string): SyncVaultRecord | undefined => {
    const row = db.prepare('SELECT * FROM sync_vaults WHERE vault_id = ?').get(vaultId);
    return row && vaultFromRow(row);
  };
  const getOperation = (vaultId: string, opId: string): SyncOperationRecord | undefined => {
    const row = db
      .prepare('SELECT * FROM sync_operations WHERE vault_id = ? AND op_id = ?')
      .get(vaultId, opId);
    return row && operationFromRow(row);
  };
  const requireTransaction = () => {
    if (!db.isTransaction) throw new Error('sync mutation requires a storage transaction');
  };
  const missingParents = (
    vaultId: string,
    entityId: string,
    parents: readonly string[],
  ): string[] =>
    parents.filter((parent) => {
      const op = db
        .prepare(
          'SELECT entity_id, heads_applied FROM sync_operations WHERE vault_id = ? AND op_id = ?',
        )
        .get(vaultId, parent);
      return !op || op.entity_id !== entityId || !integer(op, 'heads_applied');
    });
  return {
    ...createSyncQueueRepository(db),
    ...createSyncMaterialRepository(db),
    ...createSyncReferenceRepository(db),
    vaults(): SyncVaultRecord[] {
      return db.prepare('SELECT * FROM sync_vaults ORDER BY rowid').all().map(vaultFromRow);
    },
    counts(vaultId: string): { pending: number; quarantined: number; conflicts: number } {
      const pending = db
        .prepare(
          `SELECT (
            (SELECT COUNT(*) FROM sync_operations WHERE vault_id = :vaultId AND direction = 'outbox' AND state IN ('queued', 'pending')) +
            (SELECT COUNT(*) FROM sync_drafts WHERE vault_id = :vaultId) +
            (SELECT COUNT(*) FROM sync_event_captures WHERE vault_id = :vaultId AND through_seq > prepared_seq)
          ) AS n`,
        )
        .get({ vaultId });
      const quarantined = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sync_operations WHERE vault_id = ? AND state = 'quarantined'",
        )
        .get(vaultId);
      const conflicts = db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
            SELECT entity_id FROM sync_heads WHERE vault_id = ? GROUP BY entity_id HAVING COUNT(*) > 1
            UNION SELECT entity_id FROM sync_material_journal WHERE vault_id = ? AND state = 'conflict'
          )`,
        )
        .get(vaultId, vaultId);
      return {
        pending: Number(pending?.n),
        quarantined: Number(quarantined?.n),
        conflicts: Number(conflicts?.n),
      };
    },
    getVault,
    activeVault(): SyncVaultRecord | undefined {
      const row = db.prepare('SELECT * FROM sync_vaults WHERE active = 1').get();
      return row && vaultFromRow(row);
    },
    bindVault(
      input: Pick<
        SyncVaultRecord,
        'vaultId' | 'accountId' | 'deviceId' | 'originHostId' | 'appliedCursor'
      >,
    ): void {
      requireTransaction();
      const active = db.prepare('SELECT vault_id FROM sync_vaults WHERE active = 1').get();
      if (active && active.vault_id !== input.vaultId) throw new SyncStorageError('VAULT_BOUND');
      const current = getVault(input.vaultId);
      if (current) {
        if (
          current.accountId !== input.accountId ||
          current.deviceId !== input.deviceId ||
          current.originHostId !== input.originHostId
        )
          throw new SyncStorageError('DEVICE_CHANGED');
        db.prepare('UPDATE sync_vaults SET active = 1 WHERE vault_id = ?').run(input.vaultId);
      } else {
        db.prepare(
          'INSERT INTO sync_vaults (vault_id, account_id, device_id, origin_host_id, applied_cursor) VALUES (?, ?, ?, ?, ?)',
        ).run(
          input.vaultId,
          input.accountId,
          input.deviceId,
          input.originHostId,
          input.appliedCursor,
        );
      }
    },
    detachVault(vaultId: string): void {
      db.prepare('UPDATE sync_vaults SET active = 0, enabled = 0 WHERE vault_id = ?').run(vaultId);
    },
    setScopes(
      vaultId: string,
      scopes: Pick<SyncVaultRecord, 'revision' | 'enabled' | 'categories' | 'projectIds'>,
    ): void {
      db.prepare(
        'UPDATE sync_vaults SET revision = ?, enabled = ?, categories = ?, project_ids = ? WHERE vault_id = ?',
      ).run(
        scopes.revision,
        Number(scopes.enabled),
        toJson(scopes.categories),
        toJson(scopes.projectIds),
        vaultId,
      );
    },
    nextDeviceSeq(vaultId: string): string {
      requireTransaction();
      const row = db.prepare('SELECT device_seq FROM sync_vaults WHERE vault_id = ?').get(vaultId);
      if (!row) throw new Error('sync vault not found');
      const next = String(BigInt(text(row, 'device_seq')) + 1n);
      db.prepare('UPDATE sync_vaults SET device_seq = ? WHERE vault_id = ?').run(next, vaultId);
      return next;
    },
    bindProject(vaultId: string, projectId: string, workspaceId?: string): void {
      db.prepare(
        'INSERT INTO sync_projects (vault_id, project_id, workspace_id) VALUES (?, ?, ?) ON CONFLICT (vault_id, project_id) DO UPDATE SET workspace_id = excluded.workspace_id',
      ).run(vaultId, projectId, workspaceId ?? null);
    },
    projects(vaultId: string): Array<{ projectId: string; workspaceId?: string }> {
      return db
        .prepare('SELECT * FROM sync_projects WHERE vault_id = ? ORDER BY project_id')
        .all(vaultId)
        .map((row) => ({
          projectId: text(row, 'project_id'),
          ...(optionalText(row, 'workspace_id') !== undefined && {
            workspaceId: text(row, 'workspace_id'),
          }),
        }));
    },
    putSource(source: SyncSourceRecord): void {
      const args = [source.vaultId, source.hostId, source.sessionId, source.streamId];
      const existing = db
        .prepare(
          'SELECT * FROM sync_sources WHERE vault_id = ? AND host_id = ? AND session_id = ? AND stream_id = ?',
        )
        .get(...args);
      if (
        existing &&
        (Boolean(integer(existing, 'mirrored')) !== source.mirrored ||
          optionalText(existing, 'local_session_id') !== source.localSessionId)
      )
        throw new SyncStorageError('INTEGRITY_FAILED');
      db.prepare(
        'INSERT OR IGNORE INTO sync_sources (vault_id, host_id, session_id, stream_id, local_session_id, mirrored, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        ...args,
        source.localSessionId ?? null,
        Number(source.mirrored),
        source.deviceId ?? null,
      );
    },
    sources(vaultId: string): SyncSourceRecord[] {
      return db
        .prepare('SELECT * FROM sync_sources WHERE vault_id = ? ORDER BY rowid')
        .all(vaultId)
        .map((row) => ({
          vaultId: text(row, 'vault_id'),
          hostId: text(row, 'host_id'),
          sessionId: text(row, 'session_id'),
          streamId: text(row, 'stream_id'),
          ...(optionalText(row, 'local_session_id') !== undefined && {
            localSessionId: text(row, 'local_session_id'),
          }),
          mirrored: Boolean(integer(row, 'mirrored')),
          ...(optionalText(row, 'device_id') && { deviceId: text(row, 'device_id') }),
        }));
    },
    sourceEvent(
      source: Pick<SyncSourceRecord, 'vaultId' | 'hostId' | 'sessionId' | 'streamId'>,
      seq: string,
      sha256: string,
      localSeq?: number,
    ): void {
      const args = [source.vaultId, source.hostId, source.sessionId, source.streamId, seq];
      const current = db
        .prepare(
          'SELECT sha256 FROM sync_source_events WHERE vault_id = ? AND host_id = ? AND session_id = ? AND stream_id = ? AND seq = ?',
        )
        .get(...args);
      if (current && current.sha256 !== sha256) throw new SyncStorageError('INTEGRITY_FAILED');
      db.prepare(
        'INSERT OR IGNORE INTO sync_source_events (vault_id, host_id, session_id, stream_id, seq, sha256, local_seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(...args, sha256, localSeq ?? null);
    },
    getOperation,
    missingParents,
    putOperation(op: SyncOperationRecord): boolean {
      requireTransaction();
      const current = getOperation(op.vaultId, op.opId);
      if (current) {
        if (current.digest !== op.digest) throw new SyncStorageError('OP_ID_REUSED');
        return false;
      }
      const entity = db
        .prepare(
          'SELECT project_id, entity_type FROM sync_operations WHERE vault_id = ? AND entity_id = ? LIMIT 1',
        )
        .get(op.vaultId, op.entityId);
      if (
        entity &&
        (optionalText(entity, 'project_id') !== op.projectId ||
          entity.entity_type !== op.entityType)
      )
        throw new SyncStorageError('PROJECT_CHANGED');
      db.prepare(`INSERT INTO sync_operations (vault_id, op_id, device_id, device_seq, entity_type, entity_id, project_id, envelope, manifest, digest, record, direction, state, commit_id, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        op.vaultId,
        op.opId,
        op.deviceId,
        op.deviceSeq,
        op.entityType,
        op.entityId,
        op.projectId ?? null,
        toJson(op.envelope),
        toJson(op.manifest),
        op.digest,
        op.record === undefined ? null : toJson(op.record),
        op.direction,
        op.state,
        op.commitId ?? null,
        op.errorCode ?? null,
      );
      return true;
    },
    operations(
      vaultId: string,
      direction: 'outbox' | 'inbox',
      state: SyncOperationRecord['state'],
      limit = 256,
    ): SyncOperationRecord[] {
      return db
        .prepare(
          'SELECT * FROM sync_operations WHERE vault_id = ? AND direction = ? AND state = ? ORDER BY rowid LIMIT ?',
        )
        .all(vaultId, direction, state, limit)
        .map(operationFromRow);
    },
    markOperation(
      vaultId: string,
      opId: string,
      state: SyncOperationRecord['state'],
      errorCode?: string,
    ): void {
      db.prepare(
        'UPDATE sync_operations SET state = ?, error_code = ? WHERE vault_id = ? AND op_id = ?',
      ).run(state, errorCode ?? null, vaultId, opId);
    },
    heads(vaultId: string, entityId: string): string[] {
      return db
        .prepare('SELECT op_id FROM sync_heads WHERE vault_id = ? AND entity_id = ? ORDER BY op_id')
        .all(vaultId, entityId)
        .map((row) => text(row, 'op_id'));
    },
    applyHeads(vaultId: string, entityId: string, opId: string, parents: readonly string[]): void {
      requireTransaction();
      const current = db
        .prepare(
          'SELECT entity_id, heads_applied FROM sync_operations WHERE vault_id = ? AND op_id = ?',
        )
        .get(vaultId, opId);
      if (!current || current.entity_id !== entityId)
        throw new SyncStorageError('INTEGRITY_FAILED');
      if (integer(current, 'heads_applied')) return;
      if (missingParents(vaultId, entityId, parents).length)
        throw new SyncStorageError('MISSING_PARENT');
      for (const parent of parents)
        db.prepare('DELETE FROM sync_heads WHERE vault_id = ? AND entity_id = ? AND op_id = ?').run(
          vaultId,
          entityId,
          parent,
        );
      db.prepare(
        'INSERT OR IGNORE INTO sync_heads (vault_id, entity_id, op_id) VALUES (?, ?, ?)',
      ).run(vaultId, entityId, opId);
      db.prepare(
        'UPDATE sync_operations SET heads_applied = 1 WHERE vault_id = ? AND op_id = ?',
      ).run(vaultId, opId);
    },
    restartPull(vaultId: string, expectedCursor: string, initialCursor: string): void {
      requireTransaction();
      if (getVault(vaultId)?.appliedCursor !== expectedCursor)
        throw new SyncStorageError('CURSOR_CONFLICT');
      // Pages are replayable delivery groups; operations, revisions and the outbox remain intact.
      db.prepare('DELETE FROM sync_pages WHERE vault_id = ? AND applied = 0').run(vaultId);
      db.prepare('UPDATE sync_vaults SET applied_cursor = ? WHERE vault_id = ?').run(
        initialCursor,
        vaultId,
      );
    },
    putPage(page: {
      vaultId: string;
      pageId: string;
      fromCursor: string;
      nextCursor: string;
      opIds: string[];
    }): void {
      requireTransaction();
      const current = db
        .prepare('SELECT * FROM sync_pages WHERE vault_id = ? AND page_id = ?')
        .get(page.vaultId, page.pageId);
      if (
        current &&
        (current.from_cursor !== page.fromCursor ||
          current.next_cursor !== page.nextCursor ||
          current.op_ids !== toJson(page.opIds))
      )
        throw new SyncStorageError('INTEGRITY_FAILED');
      db.prepare(
        'INSERT OR IGNORE INTO sync_pages (vault_id, page_id, from_cursor, next_cursor, op_ids) VALUES (?, ?, ?, ?, ?)',
      ).run(page.vaultId, page.pageId, page.fromCursor, page.nextCursor, toJson(page.opIds));
    },
    applyPage(vaultId: string, pageId: string): void {
      requireTransaction();
      const page = db
        .prepare('SELECT * FROM sync_pages WHERE vault_id = ? AND page_id = ?')
        .get(vaultId, pageId);
      if (!page) throw new Error('sync page not found');
      if (integer(page, 'applied')) return;
      if (getVault(vaultId)?.appliedCursor !== page.from_cursor)
        throw new SyncStorageError('CURSOR_CONFLICT');
      for (const opId of json(page, 'op_ids') as string[]) {
        const op = getOperation(vaultId, opId);
        if (!op || !['applied', 'committed'].includes(op.state))
          throw new SyncStorageError('INTEGRITY_FAILED');
      }
      db.prepare('UPDATE sync_pages SET applied = 1 WHERE vault_id = ? AND page_id = ?').run(
        vaultId,
        pageId,
      );
      db.prepare('UPDATE sync_vaults SET applied_cursor = ? WHERE vault_id = ?').run(
        text(page, 'next_cursor'),
        vaultId,
      );
    },
  };
}

export type SyncRepository = ReturnType<typeof createSyncRepository>;

function vaultFromRow(row: SqlRow): SyncVaultRecord {
  return {
    vaultId: text(row, 'vault_id'),
    accountId: text(row, 'account_id'),
    deviceId: text(row, 'device_id'),
    originHostId: text(row, 'origin_host_id'),
    deviceSeq: text(row, 'device_seq'),
    active: Boolean(integer(row, 'active')),
    enabled: Boolean(integer(row, 'enabled')),
    revision: text(row, 'revision'),
    categories: json(row, 'categories') as string[],
    projectIds: json(row, 'project_ids') as string[],
    appliedCursor: text(row, 'applied_cursor'),
  };
}

function operationFromRow(row: SqlRow): SyncOperationRecord {
  const projectId = optionalText(row, 'project_id');
  const record = row.record === null ? undefined : json(row, 'record');
  const commitId = optionalText(row, 'commit_id');
  const errorCode = optionalText(row, 'error_code');
  return {
    vaultId: text(row, 'vault_id'),
    opId: text(row, 'op_id'),
    deviceId: text(row, 'device_id'),
    deviceSeq: text(row, 'device_seq'),
    entityType: text(row, 'entity_type'),
    entityId: text(row, 'entity_id'),
    ...(projectId !== undefined && { projectId }),
    envelope: json(row, 'envelope'),
    manifest: json(row, 'manifest'),
    digest: text(row, 'digest'),
    ...(record !== undefined && { record }),
    direction: text(row, 'direction') as SyncOperationRecord['direction'],
    state: text(row, 'state') as SyncOperationRecord['state'],
    ...(commitId !== undefined && { commitId }),
    ...(errorCode !== undefined && { errorCode }),
  };
}
