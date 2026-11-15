import { describe, expect, it } from 'vitest';
import { MockSyncGateway } from './mock-sync.test-utils.js';

describe('sync mock server error parity', () => {
  it.each(['entityId', 'entityType', 'missing'] as const)(
    'matches parent rejection for %s',
    (difference) => {
      const gateway = new MockSyncGateway();
      const call = (path: string, method: string, value: unknown) =>
        gateway.handle(
          'user_fixture',
          'device_fixture',
          new URL(`https://zuv.test/api/wevir/sync/v1/${path}`),
          method,
          value,
          Buffer.alloc(0),
        );
      const opened = call('vaults/open', 'POST', { protocol: 'wevir-sync/1', consent: true })
        .value as { vaultId: string };
      call('scopes', 'PUT', {
        expectedRevision: '0',
        enabled: true,
        categories: ['memory', 'rule'],
        projectIds: [],
      });
      const parent = {
        protocol: 'wevir-sync/1',
        vaultId: opened.vaultId,
        opId: 'op_parent_fixture',
        entityType: 'memory',
        entityId: 'entity_fixture',
        deviceId: 'device_fixture',
        deviceSeq: '1',
        kind: 'delete',
        parents: [],
        clientTime: '2026-11-13T00:00:00.000Z',
      };
      call('commits', 'POST', {
        commitId: 'commit_parent_fixture',
        operations: [parent],
        recordManifest: [{ opId: parent.opId }],
      });
      const operation = {
        ...parent,
        opId: 'op_child_fixture',
        deviceSeq: '2',
        parents: [difference === 'missing' ? 'op_unknown_fixture' : parent.opId],
        ...(difference === 'entityId' && { entityId: 'entity_other_fixture' }),
        ...(difference === 'entityType' && { entityType: 'rule' }),
      };
      expect(() =>
        call('commits', 'POST', {
          commitId: 'commit_child_fixture',
          operations: [operation],
          recordManifest: [{ opId: operation.opId }],
        }),
      ).toThrowError(
        expect.objectContaining({
          code: difference === 'missing' ? 'MISSING_PARENT' : 'INTEGRITY_FAILED',
          status: difference === 'missing' ? 409 : 400,
        }),
      );
    },
  );
});
