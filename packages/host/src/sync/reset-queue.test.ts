import { jcs, type SyncOperation } from '@wevir/protocol/sync';
import { describe, expect, it } from 'vitest';
import { useStorages, useTempDir } from '../test-utils.js';
import { sha256 } from './crypto.js';
import { rebaseResetCommits } from './reset-queue.js';

const temp = useTempDir(),
  stores = useStorages();
describe('RESET causal outbox mapping', () => {
  it('rewrites a child parent stored in a later immutable pending commit', () => {
    const storage = stores.open(temp());
    storage.transaction(() =>
      storage.sync.bindVault({
        vaultId: 'vault_synthetic',
        accountId: 'user_synthetic',
        deviceId: 'device_synthetic',
        originHostId: 'host_synthetic',
        appliedCursor: 'cursor_synthetic',
      }),
    );
    const vault = storage.sync.activeVault();
    if (!vault) throw new Error('missing synthetic vault');
    const prepared = ['operation_parent', 'operation_child'].map((opId, index) => {
      const operation: SyncOperation = {
        protocol: 'wevir-sync/1',
        vaultId: vault.vaultId,
        opId,
        entityId: 'entity_synthetic',
        entityType: 'memory',
        deviceId: vault.deviceId,
        deviceSeq: String(index + 1),
        kind: 'put',
        parents: index ? ['operation_parent'] : [],
        payload: { blobId: `blob_synthetic_${index}`, recordIndex: 0 },
        clientTime: '2026-11-13T00:00:00.000Z',
      };
      const manifest = { opId, ...operation.payload };
      const record = {
        opId,
        entityId: operation.entityId,
        kind: operation.kind,
        parents: operation.parents,
        content: { text: `Synthetic ${index}` },
      };
      const commit = {
        vaultId: vault.vaultId,
        commitId: `commit_synthetic_${index}`,
        body: jcs({
          commitId: `commit_synthetic_${index}`,
          operations: [operation],
          recordManifest: [manifest],
        }),
        state: 'queued' as const,
        attempts: 0,
        retryAt: 0,
      };
      storage.transaction(() => {
        storage.sync.putEntity({
          vaultId: vault.vaultId,
          entityId: operation.entityId,
          entityType: operation.entityType,
          localKey: 'memory:synthetic',
          revision: opId,
          materialized: true,
        });
        storage.sync.putOperation({
          ...operation,
          envelope: operation,
          manifest,
          record,
          direction: 'outbox',
          state: 'queued',
          digest: sha256(jcs({ operation, recordManifest: manifest })),
        });
        storage.sync.putCommit(commit);
      });
      return { commit, verified: new Map([[opId, record]]) };
    });
    rebaseResetCommits(storage, vault, 'job_synthetic', prepared);
    const drafts = storage.sync.drafts(vault.vaultId);
    const parent = drafts.find((value) => !value.parents.length);
    expect(parent).toBeDefined();
    expect(drafts.find((value) => value.opId !== parent?.opId)?.parents).toEqual([parent?.opId]);
  });
});
