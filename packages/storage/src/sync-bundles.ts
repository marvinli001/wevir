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
  scopeRoot?: string;
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
  paused?: boolean;
  state: 'prepared' | 'applying' | 'applied' | 'conflict' | 'abandoned';
}
export function createSyncBundleRepository(db: SqliteDatabase) {
  const transactionRequired = () => {
    if (!db.isTransaction) throw new Error('sync bundle mutation requires a transaction');
  };
  return {
    packageVersions(vaultId: string, entityId: string, after = ''): string[] {
      return db
        .prepare(`SELECT op_id FROM (
        SELECT op_id FROM sync_operations WHERE vault_id=:vaultId AND entity_id=:entityId
          AND state!='quarantined' AND record IS NOT NULL
          AND (direction='outbox' OR state IN ('applied','committed'))
        UNION SELECT op_id FROM sync_drafts WHERE vault_id=:vaultId AND entity_id=:entityId
        UNION SELECT op_id FROM sync_bundle_applications WHERE vault_id=:vaultId AND entity_id=:entityId AND state IN ('prepared','applying','conflict')
      ) WHERE op_id > :after ORDER BY op_id LIMIT 101`)
        .all({ vaultId, entityId, after })
        .map((row) => text(row, 'op_id'));
    },
    clearBundleSources(vaultId: string, entityId: string): void {
      transactionRequired();
      db.prepare('DELETE FROM sync_bundle_sources WHERE vault_id=? AND entity_id=?').run(
        vaultId,
        entityId,
      );
    },
    rebindBundle(previous: SyncBundleBinding, next: SyncBundleBinding): void {
      transactionRequired();
      const result = db
        .prepare(`UPDATE sync_bundle_bindings SET target_key=?,target_anchor=?,target_path=?,target_kind=?,
        scope_root=?,revision=?,fingerprint=?,manifest=? WHERE vault_id=? AND entity_id=? AND target_key=? AND fingerprint=? AND revision IS ?
        AND NOT EXISTS (SELECT 1 FROM sync_bundle_applications WHERE vault_id=? AND entity_id=? AND state IN ('prepared','applying','conflict'))`)
        .run(
          next.targetKey,
          next.targetAnchor,
          next.targetPath,
          next.targetKind,
          next.scopeRoot ?? null,
          next.revision ?? null,
          next.fingerprint,
          toJson(next.manifest),
          previous.vaultId,
          previous.entityId,
          previous.targetKey,
          previous.fingerprint,
          previous.revision ?? null,
          previous.vaultId,
          previous.entityId,
        );
      if (Number(result.changes) !== 1) throw new Error('sync bundle binding changed');
    },
    packageEntities(vaultId: string, after = ''): import('./sync-queue.js').SyncEntityRecord[] {
      return db
        .prepare(`SELECT e.* FROM sync_entities e WHERE e.vault_id = ? AND e.entity_id > ? AND e.entity_type IN ('rule','skill-bundle','artifact')
        AND EXISTS(SELECT 1 FROM sync_operations o WHERE o.vault_id=e.vault_id AND o.entity_id=e.entity_id AND json_extract(o.record,'$.content.schema')='wevir-bundle/1'
          AND COALESCE(json_extract(o.record,'$.content.metadata.schema'),'') NOT IN ('wevir-image/1','wevir-shared-files/1')) ORDER BY e.entity_id LIMIT 101`)
        .all(vaultId, after)
        .map((row) => ({
          vaultId: text(row, 'vault_id'),
          entityId: text(row, 'entity_id'),
          entityType: text(row, 'entity_type'),
          localKey: text(row, 'local_key'),
          materialized: Boolean(integer(row, 'materialized')),
          ...(optionalText(row, 'project_id') && { projectId: text(row, 'project_id') }),
          ...(optionalText(row, 'revision') && { revision: text(row, 'revision') }),
          ...(optionalText(row, 'fingerprint') && { fingerprint: text(row, 'fingerprint') }),
        }));
    },
    reauthorizeBundleApplication(
      vaultId: string,
      opId: string,
      previousDigest: string,
      scopeRevision: string,
      digest: string,
    ): void {
      transactionRequired();
      const result = db
        .prepare(
          'UPDATE sync_bundle_applications SET scope_revision = ?,digest = ?,paused = 0 WHERE vault_id = ? AND op_id = ? AND digest = ?',
        )
        .run(scopeRevision, digest, vaultId, opId, previousDigest);
      if (Number(result.changes) !== 1) throw new Error('sync bundle application changed');
    },
    bundleSource(vaultId: string, localKey: string): string | undefined {
      const row = db
        .prepare('SELECT entity_id FROM sync_bundle_sources WHERE vault_id = ? AND local_key = ?')
        .get(vaultId, localKey);
      return row && text(row, 'entity_id');
    },
    putBundleSource(vaultId: string, localKey: string, entityId: string): void {
      transactionRequired();
      db.prepare(
        'INSERT INTO sync_bundle_sources(vault_id,local_key,entity_id) VALUES (?,?,?) ON CONFLICT(vault_id,local_key) DO UPDATE SET entity_id=excluded.entity_id',
      ).run(vaultId, localKey, entityId);
    },
    bundleTargetBinding(vaultId: string, targetKey: string): SyncBundleBinding | undefined {
      const row = db
        .prepare('SELECT * FROM sync_bundle_bindings WHERE vault_id = ? AND target_key = ?')
        .get(vaultId, targetKey);
      return row && bindingFromRow(row);
    },
    pauseBundleApplication(vaultId: string, opId: string, paused: boolean): void {
      transactionRequired();
      db.prepare(
        'UPDATE sync_bundle_applications SET paused = ? WHERE vault_id = ? AND op_id = ?',
      ).run(Number(paused), vaultId, opId);
    },
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
      db.prepare(`INSERT INTO sync_bundle_bindings(vault_id,entity_id,target_key,target_anchor,target_path,target_kind,scope_root,revision,fingerprint,manifest)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(vault_id,entity_id) DO UPDATE SET revision=excluded.revision,
        fingerprint=excluded.fingerprint,manifest=excluded.manifest`).run(
        value.vaultId,
        value.entityId,
        value.targetKey,
        value.targetAnchor,
        value.targetPath,
        value.targetKind,
        value.scopeRoot ?? null,
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
    ...(optionalText(row, 'scope_root') && { scopeRoot: text(row, 'scope_root') }),
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
    paused: Boolean(integer(row, 'paused')),
    state: text(row, 'state') as SyncBundleApplication['state'],
    ...(optionalText(row, 'previous_revision') && {
      previousRevision: text(row, 'previous_revision'),
    }),
  };
}
