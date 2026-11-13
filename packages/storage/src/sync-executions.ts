import type { SqliteDatabase, SqlRow } from './driver.js';
import { json, optionalText, text, toJson } from './rows.js';

export interface SyncExecutionRecord {
  vaultId: string;
  localSessionId: string;
  runId: string;
  streamId: string;
  epoch: string;
  state: 'claimed' | 'offline' | 'conflict' | 'lost' | 'released';
  turnId?: string;
  fencingToken?: string;
  expiresAt?: string;
  source?: unknown;
}

export function createSyncExecutionRepository(db: SqliteDatabase) {
  return {
    updateSyncedExecutionOrigin(
      localSessionId: string,
      value: {
        syncContinuation?: unknown;
        recoveredFrom?: unknown;
        relatedTo?: string;
      },
    ): void {
      if (!db.isTransaction) throw new Error('sync source relation requires a transaction');
      const result = db
        .prepare(`UPDATE sessions SET origin=json_patch(origin,?)
        WHERE id=? AND engine='sync' AND json_extract(origin,'$.kind')='synced'`)
        .run(toJson(value), localSessionId);
      if (!result.changes) throw new Error('sync source relation target changed');
    },
    confirmRecoveredOutbox(vaultId: string, opId: string): void {
      if (!db.isTransaction) throw new Error('sync recovery confirmation requires a transaction');
      const operation = db
        .prepare(`SELECT entity_id,envelope FROM sync_operations
        WHERE vault_id=? AND op_id=? AND direction='outbox' AND rebased_to IS NOT NULL
        AND state IN ('queued','pending')`)
        .get(vaultId, opId);
      if (!operation) return;
      const superseded = db
        .prepare(`SELECT 1 FROM sync_operations child, json_each(child.envelope,'$.parents') p
        WHERE child.vault_id=? AND child.entity_id=? AND child.heads_applied=1
        AND child.rebased_to IS NULL AND p.value=? LIMIT 1`)
        .get(vaultId, text(operation, 'entity_id'), opId);
      if (superseded) return;
      const parents = (json(operation, 'envelope') as { parents: string[] }).parents;
      db.prepare(
        'DELETE FROM sync_heads WHERE vault_id=? AND entity_id=? AND op_id IN (SELECT value FROM json_each(?))',
      ).run(vaultId, text(operation, 'entity_id'), toJson(parents));
      db.prepare('INSERT OR IGNORE INTO sync_heads(vault_id,entity_id,op_id) VALUES (?,?,?)').run(
        vaultId,
        text(operation, 'entity_id'),
        opId,
      );
    },
    recoverOutboxOperation(vaultId: string, opId: string, recoveredOpId: string): void {
      if (!db.isTransaction) throw new Error('sync recovery requires a transaction');
      const result = db
        .prepare(`UPDATE sync_operations SET rebased_to=?
        WHERE vault_id=? AND op_id=? AND direction='outbox'
        AND state IN ('queued','pending') AND rebased_to IS NULL`)
        .run(recoveredOpId, vaultId, opId);
      if (!result.changes) throw new Error('sync recovery operation changed');
      db.prepare('DELETE FROM sync_heads WHERE vault_id=? AND op_id=?').run(vaultId, opId);
      db.prepare('UPDATE sync_file_journal SET op_id=? WHERE vault_id=? AND op_id=?').run(
        recoveredOpId,
        vaultId,
        opId,
      );
    },
    recoverOutboxCommit(vaultId: string, commitId: string): void {
      if (!db.isTransaction) throw new Error('sync recovery requires a transaction');
      const result = db
        .prepare(`UPDATE sync_commits SET rebased=1, outcome='recovered'
        WHERE vault_id=? AND commit_id=? AND state!='committed' AND rebased=0`)
        .run(vaultId, commitId);
      if (!result.changes) throw new Error('sync recovery commit changed');
    },
    rebindVaultDevice(
      vaultId: string,
      accountId: string,
      expectedDeviceId: string,
      deviceId: string,
      originHostId: string,
    ): void {
      if (!db.isTransaction) throw new Error('sync device recovery requires a transaction');
      const result = db
        .prepare(`UPDATE sync_vaults SET device_id=?, origin_host_id=?, device_seq='0'
        WHERE vault_id=? AND account_id=? AND device_id=?`)
        .run(deviceId, originHostId, vaultId, accountId, expectedDeviceId);
      if (!result.changes) throw new Error('sync device recovery binding changed');
    },
    execution(vaultId: string, sessionId: string): SyncExecutionRecord | undefined {
      const row = db
        .prepare('SELECT * FROM sync_executions WHERE vault_id = ? AND local_session_id = ?')
        .get(vaultId, sessionId);
      return row && executionFromRow(row);
    },
    putExecution(value: SyncExecutionRecord): void {
      if (!db.isTransaction) throw new Error('sync execution requires a transaction');
      db.prepare(`INSERT INTO sync_executions
        (vault_id, local_session_id, run_id, stream_id, epoch, state, turn_id, fencing_token, expires_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (vault_id, local_session_id) DO UPDATE SET
        run_id=excluded.run_id, stream_id=excluded.stream_id, epoch=excluded.epoch, state=excluded.state,
        turn_id=excluded.turn_id, fencing_token=excluded.fencing_token, expires_at=excluded.expires_at, source=excluded.source`).run(
        value.vaultId,
        value.localSessionId,
        value.runId,
        value.streamId,
        value.epoch,
        value.state,
        value.turnId ?? null,
        value.fencingToken ?? null,
        value.expiresAt ?? null,
        value.source === undefined ? null : toJson(value.source),
      );
    },
    outboxRecovery(vaultId: string, opId: string): { opId: string; source: unknown } | undefined {
      const row = db
        .prepare(
          'SELECT recovered_op_id, source FROM sync_outbox_recoveries WHERE vault_id=? AND op_id=?',
        )
        .get(vaultId, opId);
      return row && { opId: text(row, 'recovered_op_id'), source: json(row, 'source') };
    },
    putOutboxRecovery(vaultId: string, opId: string, recoveredOpId: string, source: unknown): void {
      if (!db.isTransaction) throw new Error('sync recovery requires a transaction');
      db.prepare(
        'INSERT INTO sync_outbox_recoveries (vault_id, op_id, recovered_op_id, source) VALUES (?, ?, ?, ?)',
      ).run(vaultId, opId, recoveredOpId, toJson(source));
    },
  };
}

function executionFromRow(row: SqlRow): SyncExecutionRecord {
  return {
    vaultId: text(row, 'vault_id'),
    localSessionId: text(row, 'local_session_id'),
    runId: text(row, 'run_id'),
    streamId: text(row, 'stream_id'),
    epoch: text(row, 'epoch'),
    state: text(row, 'state') as SyncExecutionRecord['state'],
    ...(optionalText(row, 'turn_id') && { turnId: text(row, 'turn_id') }),
    ...(optionalText(row, 'fencing_token') && { fencingToken: text(row, 'fencing_token') }),
    ...(optionalText(row, 'expires_at') && { expiresAt: text(row, 'expires_at') }),
    ...(row.source !== null && { source: json(row, 'source') }),
  };
}
