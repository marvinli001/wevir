import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, json, optionalText, text, toJson } from './rows.js';

export interface SyncBootstrapJob {
  vaultId: string;
  jobId: string;
  accountId: string;
  deviceId: string;
  hostId: string;
  origin: string;
  scopeRevision: string;
  categories: string[];
  projectIds: string[];
  fromCursor: string;
  pendingBefore: number;
  state: 'creating' | 'metadata' | 'records' | 'staged' | 'failed';
  errorCode?: string;
  active?: boolean;
}
export interface SyncBootstrapEntry {
  vaultId: string;
  jobId: string;
  position: number;
  opId: string;
  entityId: string;
  envelope: unknown;
  manifest: unknown;
  digest: string;
  selected: boolean;
  record?: unknown;
  recordDigest?: string;
  applied?: boolean;
}
export interface SyncBootstrapApplication {
  vaultId: string;
  jobId: string;
  snapshotCursor: string;
  state: 'applying' | 'applied' | 'acknowledged';
  scopeRevision?: string;
  scopeAttempt?: string;
  errorCode?: string;
}
export function createSyncBootstrapRepository(db: SqliteDatabase) {
  const requireTransaction = () => {
    if (!db.isTransaction) throw new Error('sync bootstrap requires a transaction');
  };
  const job = (vaultId: string, jobId: string) => {
    const row = db
      .prepare('SELECT * FROM sync_bootstrap_jobs WHERE vault_id = ? AND job_id = ?')
      .get(vaultId, jobId);
    return row && jobFromRow(row);
  };
  return {
    bootstrapJob: job,
    activeBootstrapJob(vaultId: string): SyncBootstrapJob | undefined {
      const row = db
        .prepare('SELECT * FROM sync_bootstrap_jobs WHERE vault_id = ? AND active = 1')
        .get(vaultId);
      return row && jobFromRow(row);
    },
    closeBootstrapJob(vaultId: string, jobId: string): void {
      requireTransaction();
      db.prepare('UPDATE sync_bootstrap_jobs SET active = 0 WHERE vault_id = ? AND job_id = ?').run(
        vaultId,
        jobId,
      );
    },
    reconsentBootstrap(vaultId: string, jobId: string, revision: string): void {
      requireTransaction();
      db.prepare(
        'UPDATE sync_bootstrap_jobs SET scope_revision = ? WHERE vault_id = ? AND job_id = ? AND active = 1',
      ).run(revision, vaultId, jobId);
      db.prepare(
        'UPDATE sync_bootstrap_applications SET scope_revision = NULL,scope_attempt = NULL WHERE vault_id = ? AND job_id = ?',
      ).run(vaultId, jobId);
    },
    putRestoredRecord(vaultId: string, opId: string, digest: string, record: unknown): void {
      requireTransaction();
      const operation = db
        .prepare('SELECT digest FROM sync_operations WHERE vault_id = ? AND op_id = ?')
        .get(vaultId, opId);
      if (!operation || operation.digest !== digest)
        throw new Error('restored record identity changed');
      db.prepare('UPDATE sync_operations SET record = ? WHERE vault_id = ? AND op_id = ?').run(
        toJson(record),
        vaultId,
        opId,
      );
    },
    bootstrapApplication(vaultId: string, jobId: string): SyncBootstrapApplication | undefined {
      const row = db
        .prepare('SELECT * FROM sync_bootstrap_applications WHERE vault_id = ? AND job_id = ?')
        .get(vaultId, jobId);
      return (
        row && {
          vaultId,
          jobId,
          snapshotCursor: text(row, 'snapshot_cursor'),
          state: text(row, 'state') as SyncBootstrapApplication['state'],
          ...(optionalText(row, 'scope_revision') && {
            scopeRevision: text(row, 'scope_revision'),
          }),
          ...(optionalText(row, 'scope_attempt') && { scopeAttempt: text(row, 'scope_attempt') }),
          ...(optionalText(row, 'error_code') && { errorCode: text(row, 'error_code') }),
        }
      );
    },
    bootstrapEntry(vaultId: string, jobId: string, opId: string): SyncBootstrapEntry | undefined {
      const row = db
        .prepare(
          'SELECT * FROM sync_bootstrap_entries WHERE vault_id = ? AND job_id = ? AND op_id = ?',
        )
        .get(vaultId, jobId, opId);
      return row && entryFromRow(row);
    },
    putBootstrapApplication(value: SyncBootstrapApplication): void {
      requireTransaction();
      const old = db
        .prepare(
          'SELECT snapshot_cursor FROM sync_bootstrap_applications WHERE vault_id = ? AND job_id = ?',
        )
        .get(value.vaultId, value.jobId);
      if (old && old.snapshot_cursor !== value.snapshotCursor)
        throw new Error('sync bootstrap cursor changed');
      db.prepare(`INSERT INTO sync_bootstrap_applications (vault_id,job_id,snapshot_cursor,state,scope_revision,scope_attempt,error_code)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(vault_id,job_id) DO UPDATE SET state=excluded.state,scope_revision=excluded.scope_revision,scope_attempt=excluded.scope_attempt,error_code=excluded.error_code`).run(
        value.vaultId,
        value.jobId,
        value.snapshotCursor,
        value.state,
        value.scopeRevision ?? null,
        value.scopeAttempt ?? null,
        value.errorCode ?? null,
      );
    },
    markBootstrapEntryApplied(vaultId: string, jobId: string, opId: string): void {
      requireTransaction();
      const operation = db
        .prepare('SELECT state FROM sync_operations WHERE vault_id = ? AND op_id = ?')
        .get(vaultId, opId);
      if (!operation || !['applied', 'committed'].includes(text(operation, 'state')))
        throw new Error('sync bootstrap record is not applied');
      db.prepare(
        'UPDATE sync_bootstrap_entries SET applied = 1 WHERE vault_id = ? AND job_id = ? AND op_id = ? AND selected = 1',
      ).run(vaultId, jobId, opId);
    },
    bootstrapHeadCandidates(
      vaultId: string,
      jobId: string,
    ): Array<{ entityId: string; opId: string }> {
      return db
        .prepare(`SELECT e.entity_id,e.op_id FROM sync_bootstrap_entries e WHERE e.vault_id = ? AND e.job_id = ? AND e.selected = 1
        AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_entries child JOIN json_each(child.envelope,'$.parents') parent
          WHERE child.vault_id=e.vault_id AND child.job_id=e.job_id AND child.entity_id=e.entity_id AND parent.value=e.op_id)
        ORDER BY e.position`)
        .all(vaultId, jobId)
        .map((row) => ({ entityId: text(row, 'entity_id'), opId: text(row, 'op_id') }));
    },
    reconcileBootstrapHeads(vaultId: string, jobId: string): void {
      requireTransaction();
      const incomplete = db
        .prepare(
          'SELECT 1 FROM sync_bootstrap_entries WHERE vault_id = ? AND job_id = ? AND selected = 1 AND applied = 0 LIMIT 1',
        )
        .get(vaultId, jobId);
      if (incomplete) throw new Error('sync bootstrap has unapplied records');
      db.prepare(`DELETE FROM sync_heads WHERE vault_id = :vaultId AND entity_id IN (
        SELECT entity_id FROM sync_bootstrap_entries WHERE vault_id = :vaultId AND job_id = :jobId AND selected = 1)
        AND NOT EXISTS (SELECT 1 FROM sync_operations op WHERE op.vault_id = :vaultId AND op.op_id = sync_heads.op_id
          AND op.direction = 'outbox' AND op.state IN ('queued','pending') AND op.rebased_to IS NULL)`).run(
        {
          vaultId,
          jobId,
        },
      );
      db.prepare(`INSERT OR IGNORE INTO sync_heads(vault_id,entity_id,op_id)
        SELECT e.vault_id,e.entity_id,e.op_id FROM sync_bootstrap_entries e WHERE e.vault_id = ? AND e.job_id = ? AND e.selected = 1
        AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_entries child JOIN json_each(child.envelope,'$.parents') parent
          WHERE child.vault_id=e.vault_id AND child.job_id=e.job_id AND child.entity_id=e.entity_id AND parent.value=e.op_id)`).run(
        vaultId,
        jobId,
      );
    },
    bootstrapJobs(vaultId: string): SyncBootstrapJob[] {
      return db
        .prepare(
          'SELECT * FROM sync_bootstrap_jobs WHERE vault_id = ? ORDER BY rowid DESC LIMIT 100',
        )
        .all(vaultId)
        .map(jobFromRow);
    },
    putBootstrapJob(value: SyncBootstrapJob): void {
      requireTransaction();
      if (job(value.vaultId, value.jobId)) throw new Error('sync bootstrap already exists');
      db.prepare(`INSERT INTO sync_bootstrap_jobs
        (vault_id, job_id, account_id, device_id, host_id, origin, scope_revision, categories, project_ids, from_cursor, pending_before, state, error_code, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.vaultId,
        value.jobId,
        value.accountId,
        value.deviceId,
        value.hostId,
        value.origin,
        value.scopeRevision,
        toJson(value.categories),
        toJson(value.projectIds),
        value.fromCursor,
        value.pendingBefore,
        value.state,
        value.errorCode ?? null,
        Number(value.active !== false),
      );
    },
    setBootstrapState(
      vaultId: string,
      jobId: string,
      state: SyncBootstrapJob['state'],
      errorCode?: string,
    ): void {
      requireTransaction();
      db.prepare(
        'UPDATE sync_bootstrap_jobs SET state = ?, error_code = ? WHERE vault_id = ? AND job_id = ?',
      ).run(state, errorCode ?? null, vaultId, jobId);
    },
    putBootstrapEntry(value: SyncBootstrapEntry): void {
      requireTransaction();
      const old = db
        .prepare(
          'SELECT digest, position, selected FROM sync_bootstrap_entries WHERE vault_id = ? AND job_id = ? AND op_id = ?',
        )
        .get(value.vaultId, value.jobId, value.opId);
      if (
        old &&
        (old.digest !== value.digest ||
          integer(old, 'position') !== value.position ||
          Boolean(integer(old, 'selected')) !== value.selected)
      )
        throw new Error('sync bootstrap entry changed');
      db.prepare(`INSERT OR IGNORE INTO sync_bootstrap_entries
        (vault_id, job_id, position, op_id, entity_id, envelope, manifest, digest, selected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.vaultId,
        value.jobId,
        value.position,
        value.opId,
        value.entityId,
        toJson(value.envelope),
        toJson(value.manifest),
        value.digest,
        Number(value.selected),
      );
    },
    putBootstrapRecord(
      vaultId: string,
      jobId: string,
      opId: string,
      record: unknown,
      digest: string,
    ): void {
      requireTransaction();
      const old = db
        .prepare(
          'SELECT selected, record_digest FROM sync_bootstrap_entries WHERE vault_id = ? AND job_id = ? AND op_id = ?',
        )
        .get(vaultId, jobId, opId);
      if (
        !old ||
        !integer(old, 'selected') ||
        (old.record_digest !== null && old.record_digest !== digest)
      )
        throw new Error('sync bootstrap record changed');
      db.prepare(
        'UPDATE sync_bootstrap_entries SET record = ?, record_digest = ? WHERE vault_id = ? AND job_id = ? AND op_id = ?',
      ).run(toJson(record), digest, vaultId, jobId, opId);
    },
    bootstrapEntries(
      vaultId: string,
      jobId: string,
      after = -1,
      records = false,
    ): SyncBootstrapEntry[] {
      return db
        .prepare(`SELECT vault_id, job_id, position, op_id, entity_id, envelope, manifest, digest, selected,
        ${records ? 'record' : 'NULL AS record'}, record_digest, applied FROM sync_bootstrap_entries
        WHERE vault_id = ? AND job_id = ? AND position > ? ${records ? 'AND selected = 1' : ''} ORDER BY position LIMIT ${records ? 1 : 256}`)
        .all(vaultId, jobId, after)
        .map(entryFromRow);
    },
    bootstrapCounts(
      vaultId: string,
      jobId: string,
    ): { operations: number; selected: number; staged: number; applied: number } {
      const row = db
        .prepare(`SELECT COUNT(*) AS operations, COALESCE(SUM(selected),0) AS selected,
        COALESCE(SUM(selected = 1 AND record IS NOT NULL),0) AS staged,
        COALESCE(SUM(selected = 1 AND applied = 1),0) AS applied FROM sync_bootstrap_entries WHERE vault_id = ? AND job_id = ?`)
        .get(vaultId, jobId);
      return {
        operations: Number(row?.operations),
        selected: Number(row?.selected),
        staged: Number(row?.staged),
        applied: Number(row?.applied),
      };
    },
  };
}
function jobFromRow(row: SqlRow): SyncBootstrapJob {
  return {
    vaultId: text(row, 'vault_id'),
    jobId: text(row, 'job_id'),
    accountId: text(row, 'account_id'),
    deviceId: text(row, 'device_id'),
    hostId: text(row, 'host_id'),
    origin: text(row, 'origin'),
    scopeRevision: text(row, 'scope_revision'),
    categories: json(row, 'categories') as string[],
    projectIds: json(row, 'project_ids') as string[],
    fromCursor: text(row, 'from_cursor'),
    pendingBefore: integer(row, 'pending_before'),
    state: text(row, 'state') as SyncBootstrapJob['state'],
    active: Boolean(integer(row, 'active')),
    ...(optionalText(row, 'error_code') && { errorCode: text(row, 'error_code') }),
  };
}
function entryFromRow(row: SqlRow): SyncBootstrapEntry {
  return {
    vaultId: text(row, 'vault_id'),
    jobId: text(row, 'job_id'),
    position: integer(row, 'position'),
    opId: text(row, 'op_id'),
    entityId: text(row, 'entity_id'),
    envelope: json(row, 'envelope'),
    manifest: json(row, 'manifest'),
    digest: text(row, 'digest'),
    selected: Boolean(integer(row, 'selected')),
    applied: Boolean(integer(row, 'applied')),
    ...(row.record !== null && { record: json(row, 'record') }),
    ...(optionalText(row, 'record_digest') && { recordDigest: text(row, 'record_digest') }),
  };
}
