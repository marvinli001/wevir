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
        (vault_id, job_id, account_id, device_id, host_id, origin, scope_revision, categories, project_ids, from_cursor, pending_before, state, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        ${records ? 'record' : 'NULL AS record'}, record_digest FROM sync_bootstrap_entries
        WHERE vault_id = ? AND job_id = ? AND position > ? ${records ? 'AND selected = 1' : ''} ORDER BY position LIMIT ${records ? 1 : 256}`)
        .all(vaultId, jobId, after)
        .map(entryFromRow);
    },
    bootstrapCounts(
      vaultId: string,
      jobId: string,
    ): { operations: number; selected: number; staged: number } {
      const row = db
        .prepare(`SELECT COUNT(*) AS operations, COALESCE(SUM(selected),0) AS selected,
        COALESCE(SUM(selected = 1 AND record IS NOT NULL),0) AS staged FROM sync_bootstrap_entries WHERE vault_id = ? AND job_id = ?`)
        .get(vaultId, jobId);
      return {
        operations: Number(row?.operations),
        selected: Number(row?.selected),
        staged: Number(row?.staged),
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
    ...(row.record !== null && { record: json(row, 'record') }),
    ...(optionalText(row, 'record_digest') && { recordDigest: text(row, 'record_digest') }),
  };
}
