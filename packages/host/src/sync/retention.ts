import type { Storage } from '@wevir/storage';
import type { SyncBlobCache } from './cache.js';

export async function collectSyncRecords(
  storage: Storage,
  cache: SyncBlobCache,
  vaultId: string,
): Promise<void> {
  const unused = storage.transaction(() => {
    const db = storage.db;
    db.exec('CREATE TEMP TABLE sync_retained_records (op_id TEXT PRIMARY KEY) WITHOUT ROWID');
    try {
      db.exec(
        'CREATE TEMP TABLE sync_record_edges (op_id TEXT NOT NULL, dependency TEXT NOT NULL)',
      );
      db.prepare(`INSERT INTO sync_record_edges
        SELECT o.op_id,json_extract(p.value,'$.opId') FROM sync_operations o,
          json_each(o.record,'$.content.files') f,json_each(f.value,'$.parts') p WHERE o.vault_id=:vaultId
        UNION SELECT o.op_id,json_extract(r.value,'$.opId') FROM sync_operations o,
          json_each(o.record,'$.content.metadata.ruleVersions') r WHERE o.vault_id=:vaultId
        UNION SELECT d.op_id,json_extract(p.value,'$.opId') FROM sync_drafts d,
          json_each(d.content,'$.body.files') f,json_each(f.value,'$.parts') p WHERE d.vault_id=:vaultId
        UNION SELECT d.op_id,json_extract(r.value,'$.opId') FROM sync_drafts d,
          json_each(d.content,'$.body.metadata.ruleVersions') r WHERE d.vault_id=:vaultId`).run({
        vaultId,
      });
      db.prepare(
        'UPDATE sync_operations SET material_referenced=1 WHERE vault_id=? AND material_referenced=0 AND op_id IN (SELECT dependency FROM sync_record_edges)',
      ).run(vaultId);
      db.prepare(`INSERT OR IGNORE INTO sync_retained_records
        WITH RECURSIVE recent AS (
          SELECT op_id, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY rowid DESC) AS n
          FROM sync_operations WHERE vault_id=:vaultId AND record IS NOT NULL
          AND COALESCE(json_extract(record,'$.content.schema'),'')!='wevir-chunk/1'
        ), conflict_entities AS (
          SELECT entity_id FROM sync_heads WHERE vault_id=:vaultId GROUP BY entity_id HAVING COUNT(*)>1
          UNION SELECT e.entity_id FROM sync_entities e WHERE e.vault_id=:vaultId
            AND NOT EXISTS(SELECT 1 FROM sync_heads h WHERE h.vault_id=e.vault_id AND h.op_id=e.revision)
            AND (EXISTS(SELECT 1 FROM sync_drafts d WHERE d.vault_id=e.vault_id AND d.op_id=e.revision)
              OR EXISTS(SELECT 1 FROM sync_operations o WHERE o.vault_id=e.vault_id AND o.op_id=e.revision AND o.state IN ('queued','pending')))
        ), parents(op_id,parent) AS (
          SELECT o.op_id,p.value FROM sync_operations o,json_each(o.envelope,'$.parents') p WHERE o.vault_id=:vaultId
          UNION ALL SELECT d.op_id,p.value FROM sync_drafts d,json_each(d.parents) p WHERE d.vault_id=:vaultId
        ), ancestors(op_id) AS (
          SELECT h.op_id FROM sync_heads h JOIN conflict_entities c USING(entity_id) WHERE h.vault_id=:vaultId
          UNION SELECT e.revision FROM sync_entities e JOIN conflict_entities c USING(entity_id) WHERE e.vault_id=:vaultId AND e.revision IS NOT NULL
          UNION SELECT p.parent FROM ancestors a JOIN parents p ON p.op_id=a.op_id
        ), edges(op_id,dependency) AS (
          SELECT op_id,dependency FROM sync_record_edges
        ), roots(op_id) AS (
          SELECT op_id FROM recent WHERE n<=32
          UNION SELECT op_id FROM sync_operations WHERE vault_id=:vaultId AND state NOT IN ('applied','committed')
          UNION SELECT e.revision FROM sync_entities e JOIN sync_operations o ON o.vault_id=e.vault_id AND o.op_id=e.revision
            WHERE e.vault_id=:vaultId AND o.record IS NOT NULL AND COALESCE(json_extract(o.record,'$.content.schema'),'')!='wevir-chunk/1'
          UNION SELECT h.op_id FROM sync_heads h JOIN sync_operations o ON o.vault_id=h.vault_id AND o.op_id=h.op_id
            WHERE h.vault_id=:vaultId AND o.record IS NOT NULL AND COALESCE(json_extract(o.record,'$.content.schema'),'')!='wevir-chunk/1'
          UNION SELECT o.op_id FROM sync_operations o WHERE o.vault_id=:vaultId AND json_extract(o.record,'$.content.schema')='wevir-chunk/1'
            AND o.material_referenced=0
          UNION SELECT op_id FROM ancestors
          UNION SELECT op_id FROM sync_operations WHERE rowid IN (SELECT MIN(rowid) FROM sync_operations WHERE vault_id=:vaultId AND json_extract(record,'$.content.schema')='wevir-session/1' GROUP BY entity_id)
          UNION SELECT op_id FROM sync_snapshot_roots WHERE vault_id=:vaultId
          UNION SELECT op_id FROM sync_bootstrap_entries WHERE vault_id=:vaultId
          UNION SELECT revision FROM sync_bundle_bindings WHERE vault_id=:vaultId
          UNION SELECT op_id FROM sync_bundle_applications WHERE vault_id=:vaultId AND state IN ('prepared','applying','conflict')
          UNION SELECT op_id FROM sync_material_journal WHERE vault_id=:vaultId AND state!='applied'
          UNION SELECT op_id FROM sync_file_journal WHERE vault_id=:vaultId
          UNION SELECT p.value FROM sync_drafts d,json_each(d.parents) p WHERE d.vault_id=:vaultId
          UNION SELECT p.value FROM sync_local_writes w,json_each(w.parents) p WHERE w.vault_id=:vaultId AND w.state='pending'
          UNION SELECT json_extract(p.value,'$.opId') FROM sync_drafts d,
            json_each(d.content,'$.body.files') f,json_each(f.value,'$.parts') p WHERE d.vault_id=:vaultId
          UNION SELECT json_extract(r.value,'$.opId') FROM sync_drafts d,
            json_each(d.content,'$.body.metadata.ruleVersions') r WHERE d.vault_id=:vaultId
        ), retained(op_id) AS (
          SELECT op_id FROM roots WHERE op_id IS NOT NULL
          UNION SELECT e.dependency FROM edges e JOIN retained r ON r.op_id=e.op_id
        ) SELECT op_id FROM retained`).run({ vaultId });
      db.prepare(`UPDATE sync_operations SET record=NULL WHERE vault_id=? AND state IN ('applied','committed')
        AND record IS NOT NULL AND op_id NOT IN (SELECT op_id FROM sync_retained_records)`).run(
        vaultId,
      );
      return db
        .prepare(`SELECT b.blob_id FROM sync_blobs b WHERE b.vault_id=:vaultId AND b.state='ready'
        AND NOT EXISTS(SELECT 1 FROM sync_operations o JOIN sync_retained_records r USING(op_id)
          WHERE o.vault_id=b.vault_id AND json_extract(o.envelope,'$.payload.blobId')=b.blob_id)
        AND NOT EXISTS(SELECT 1 FROM sync_bootstrap_entries e WHERE e.vault_id=b.vault_id AND json_extract(e.envelope,'$.payload.blobId')=b.blob_id)
        AND EXISTS(SELECT 1 FROM sync_operations o WHERE o.vault_id=b.vault_id AND json_extract(o.envelope,'$.payload.blobId')=b.blob_id AND o.state IN ('applied','committed'))`)
        .all({ vaultId })
        .map((row) => String(row.blob_id));
    } finally {
      db.exec('DROP TABLE IF EXISTS sync_record_edges; DROP TABLE sync_retained_records');
    }
  });
  for (const blobId of unused) {
    await cache.remove(vaultId, blobId);
    storage.db
      .prepare('DELETE FROM sync_blobs WHERE vault_id=? AND blob_id=?')
      .run(vaultId, blobId);
  }
}
