import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useStorages, useTempDir } from '../test-utils.js';
import { syncAncestors } from './ancestry.js';
import { SyncBlobCache } from './cache.js';
import { collectSyncRecords } from './retention.js';

const temp = useTempDir(),
  stores = useStorages();
describe('local sync record retention', () => {
  it('pins material dependency closures and conflicts while trimming confirmed records', async () => {
    const home = temp(),
      storage = stores.open(home),
      vaultId = 'vault_fixture';
    const put = (
      opId: string,
      entityId: string,
      entityType: string,
      content: unknown,
      parents: string[] = [],
    ) => {
      const envelope = {
        opId,
        entityId,
        entityType,
        parents,
        payload: { blobId: `blob_${opId}`, recordIndex: 0 },
      };
      storage.sync.putOperation({
        vaultId,
        opId,
        entityId,
        entityType,
        deviceId: 'device_fixture',
        deviceSeq: opId,
        envelope,
        manifest: {},
        digest: opId,
        record: { opId, entityId, parents, kind: 'put', content },
        direction: 'outbox',
        state: 'committed',
      });
    };
    storage.transaction(() => {
      storage.sync.bindVault({
        vaultId,
        accountId: 'user_fixture',
        deviceId: 'device_fixture',
        originHostId: 'device_fixture',
        appliedCursor: 'cursor_fixture',
      });
      for (let i = 0; i < 40; i++)
        put(
          `memory_op_${i}`,
          'memory_fixture',
          'memory',
          { schema: 'wevir-memory/1', markdown: `Revision ${i}` },
          i ? [`memory_op_${i - 1}`] : [],
        );
      storage.sync.putEntity({
        vaultId,
        entityId: 'memory_fixture',
        entityType: 'memory',
        localKey: 'memory:fixture',
        revision: 'memory_op_0',
        materialized: true,
      });
      put('part_kept_op', 'part_kept', 'artifact', { schema: 'wevir-chunk/1', data: 'AA' });
      put('part_unused_op', 'part_unused', 'artifact', { schema: 'wevir-chunk/1', data: 'AA' });
      storage.sync.applyHeads(vaultId, 'part_unused', 'part_unused_op', []);
      put('bundle_unused_op', 'bundle_unused', 'artifact', {
        schema: 'wevir-bundle/1',
        files: [{ parts: [{ entityId: 'part_unused', opId: 'part_unused_op' }] }],
      });
      for (let i = 0; i < 32; i++)
        put(`bundle_new_${i}`, 'bundle_unused', 'artifact', {
          schema: 'wevir-bundle/1',
          files: [],
        });
      put('rule_kept_op', 'rule_kept', 'rule', {
        schema: 'wevir-bundle/1',
        files: [{ parts: [{ entityId: 'part_kept', opId: 'part_kept_op' }] }],
      });
      put('bundle_kept_op', 'bundle_kept', 'workspace-snapshot', {
        schema: 'wevir-bundle/1',
        metadata: { ruleVersions: [{ entityId: 'rule_kept', opId: 'rule_kept_op' }] },
      });
      storage.sync.applyHeads(vaultId, 'bundle_kept', 'bundle_kept_op', []);
    });
    await collectSyncRecords(storage, new SyncBlobCache(join(home, 'sync/blobs')), vaultId);
    expect(storage.sync.getOperation(vaultId, 'part_kept_op')?.record).toBeDefined();
    expect(storage.sync.getOperation(vaultId, 'part_unused_op')?.record).toBeUndefined();
    expect(storage.sync.getOperation(vaultId, 'memory_op_0')?.record).toBeDefined();
    expect(storage.sync.getOperation(vaultId, 'memory_op_1')).toMatchObject({
      digest: 'memory_op_1',
      envelope: { parents: ['memory_op_0'] },
    });
    expect(storage.sync.getOperation(vaultId, 'memory_op_1')?.record).toBeUndefined();
    expect(storage.sync.portableVersionIds(vaultId)).not.toContain('memory_op_1');
    expect(syncAncestors(storage, vaultId, 'memory_fixture', 'memory_op_39')?.size).toBe(40);
  });
});
