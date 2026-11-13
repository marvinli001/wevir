import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, json, optionalText, text, toJson } from './rows.js';

export interface SyncBundleManifest {
  files: Array<{ path: string; bytes: number; sha256: string; executable: boolean }>;
  exclusions: string[];
  metadata?: unknown;
  deleted?: boolean;
}
export interface SyncBundleBinding {
  vaultId: string;
  entityId: string;
  targetKey: string;
  targetAnchor: string;
  targetPath: string;
  targetKind: 'file' | 'directory';
  revision?: string;
  fingerprint: string;
  manifest: SyncBundleManifest;
}
export interface SyncBundleChange {
  path: string;
  previousPath?: string;
  previous?: { sha256: string; executable: boolean };
  next?: { sha256: string; executable: boolean };
}
export interface SyncBundleApplication {
  vaultId: string;
  opId: string;
  entityId: string;
  deviceId: string;
  scopeRevision: string;
  previousRevision?: string;
  previousHash: string;
  nextHash: string;
  digest: string;
  operation: unknown;
  content: unknown;
  files: SyncBundleChange[];
  manifest: SyncBundleManifest;
  publish: boolean;
  state: 'prepared' | 'applying' | 'applied' | 'conflict' | 'abandoned';
}
export function createSyncBundleRepository(db: SqliteDatabase) {
  const transactionRequired = () => {
    if (!db.isTransaction) throw new Error('sync bundle mutation requires a transaction');
  };
  return {
    bundleBinding(vaultId: string, entityId: string): SyncBundleBinding | undefined {
      const row = db
        .prepare('SELECT * FROM sync_bundle_bindings WHERE vault_id = ? AND entity_id = ?')
        .get(vaultId, entityId);
      return row && bindingFromRow(row);
    },
    bundleBindings(vaultId: string, after = ''): SyncBundleBinding[] {
      return db
        .prepare(
          'SELECT * FROM sync_bundle_bindings WHERE vault_id = ? AND entity_id > ? ORDER BY entity_id LIMIT 1',
        )
        .all(vaultId, after)
        .map(bindingFromRow);
    },
    putBundleBinding(value: SyncBundleBinding): void {
      transactionRequired();
      const old = db
        .prepare(
          'SELECT target_path,target_kind,target_key,target_anchor FROM sync_bundle_bindings WHERE vault_id = ? AND entity_id = ?',
        )
        .get(value.vaultId, value.entityId);
      if (
        old &&
        (old.target_path !== value.targetPath ||
          old.target_kind !== value.targetKind ||
          old.target_key !== value.targetKey ||
          old.target_anchor !== value.targetAnchor)
      )
        throw new Error('sync bundle target changed');
      db.prepare(`INSERT INTO sync_bundle_bindings(vault_id,entity_id,target_key,target_anchor,target_path,target_kind,revision,fingerprint,manifest)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(vault_id,entity_id) DO UPDATE SET revision=excluded.revision,
        fingerprint=excluded.fingerprint,manifest=excluded.manifest`).run(
        value.vaultId,
        value.entityId,
        value.targetKey,
        value.targetAnchor,
        value.targetPath,
        value.targetKind,
        value.revision ?? null,
        value.fingerprint,
        toJson(value.manifest),
      );
    },
    bundleApplication(vaultId: string, opId: string): SyncBundleApplication | undefined {
      const row = db
        .prepare('SELECT * FROM sync_bundle_applications WHERE vault_id = ? AND op_id = ?')
        .get(vaultId, opId);
      return row && applicationFromRow(row);
    },
    pendingBundleApplication(vaultId: string, entityId: string): SyncBundleApplication | undefined {
      const row = db
        .prepare(
          "SELECT * FROM sync_bundle_applications WHERE vault_id = ? AND entity_id = ? AND state IN ('prepared','applying','conflict') LIMIT 1",
        )
        .get(vaultId, entityId);
      return row && applicationFromRow(row);
    },
    pendingBundleApplications(vaultId: string, after = ''): SyncBundleApplication[] {
      return db
        .prepare(
          "SELECT * FROM sync_bundle_applications WHERE vault_id = ? AND op_id > ? AND state IN ('prepared','applying','conflict') ORDER BY op_id LIMIT 1",
        )
        .all(vaultId, after)
        .map(applicationFromRow);
    },
    putBundleApplication(value: SyncBundleApplication): void {
      transactionRequired();
      const old = db
        .prepare('SELECT digest FROM sync_bundle_applications WHERE vault_id = ? AND op_id = ?')
        .get(value.vaultId, value.opId);
      if (old) {
        if (old.digest !== value.digest)
          throw new Error('sync bundle application identity changed');
        return;
      }
      db.prepare(`INSERT INTO sync_bundle_applications(vault_id,op_id,entity_id,device_id,scope_revision,previous_revision,previous_hash,next_hash,
        digest,operation,content,files,manifest,publish,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.vaultId,
        value.opId,
        value.entityId,
        value.deviceId,
        value.scopeRevision,
        value.previousRevision ?? null,
        value.previousHash,
        value.nextHash,
        value.digest,
        toJson(value.operation),
        toJson(value.content),
        toJson(value.files),
        toJson(value.manifest),
        Number(value.publish),
        value.state,
      );
    },
    setBundleApplicationState(
      vaultId: string,
      opId: string,
      state: SyncBundleApplication['state'],
    ): void {
      transactionRequired();
      db.prepare(
        'UPDATE sync_bundle_applications SET state = ? WHERE vault_id = ? AND op_id = ?',
      ).run(state, vaultId, opId);
    },
  };
}
function bindingFromRow(row: SqlRow): SyncBundleBinding {
  return {
    vaultId: text(row, 'vault_id'),
    entityId: text(row, 'entity_id'),
    targetKey: text(row, 'target_key'),
    targetAnchor: text(row, 'target_anchor'),
    targetPath: text(row, 'target_path'),
    targetKind: text(row, 'target_kind') as SyncBundleBinding['targetKind'],
    fingerprint: text(row, 'fingerprint'),
    manifest: json(row, 'manifest') as unknown as SyncBundleManifest,
    ...(optionalText(row, 'revision') && { revision: text(row, 'revision') }),
  };
}
function applicationFromRow(row: SqlRow): SyncBundleApplication {
  return {
    vaultId: text(row, 'vault_id'),
    opId: text(row, 'op_id'),
    entityId: text(row, 'entity_id'),
    deviceId: text(row, 'device_id'),
    scopeRevision: text(row, 'scope_revision'),
    previousHash: text(row, 'previous_hash'),
    nextHash: text(row, 'next_hash'),
    digest: text(row, 'digest'),
    operation: json(row, 'operation'),
    content: json(row, 'content'),
    files: json(row, 'files') as unknown as SyncBundleChange[],
    manifest: json(row, 'manifest') as unknown as SyncBundleManifest,
    publish: Boolean(integer(row, 'publish')),
    state: text(row, 'state') as SyncBundleApplication['state'],
    ...(optionalText(row, 'previous_revision') && {
      previousRevision: text(row, 'previous_revision'),
    }),
  };
}
