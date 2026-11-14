import { describe, expect, it } from 'vitest';
import { useStorages, useTempDir } from '../test-utils.js';
import type { ZuvClient } from '../zuv/client.js';
import type { SyncEngine } from './engine.js';
import { SyncOutboxRecovery } from './outbox-recovery.js';
import type { SyncDraftPayload } from './queue.js';

const temp = useTempDir(),
  stores = useStorages();
describe('explicit outbox branch identity', () => {
  it.each(['memory', 'session'] as const)(
    'preserves committed parents and declared session identity for %s deltas',
    async (entityType) => {
      const storage = stores.open(temp());
      storage.transaction(() => {
        storage.sync.bindVault({
          vaultId: 'vault_synthetic',
          accountId: 'user_synthetic',
          deviceId: 'device_synthetic',
          originHostId: 'host_synthetic',
          appliedCursor: 'cursor_synthetic',
        });
        storage.sync.setScopes('vault_synthetic', {
          revision: '1',
          enabled: true,
          categories: [entityType],
          projectIds: [],
        });
        storage.sync.putEntity({
          vaultId: 'vault_synthetic',
          entityId: 'entity_synthetic',
          entityType,
          localKey: 'synthetic',
          revision: 'op_pending',
          materialized: true,
        });
        storage.sync.putDraft({
          vaultId: 'vault_synthetic',
          opId: 'op_pending',
          entityId: 'entity_synthetic',
          kind: 'put',
          parents: ['op_committed'],
          createdAt: '2026-11-13T00:00:00.000Z',
          content: {
            schema: 'wevir-sync-draft/1',
            body:
              entityType === 'memory'
                ? { text: 'Synthetic' }
                : {
                    schema: 'wevir-session-state/1',
                    title: 'Synthetic',
                    source: {
                      hostId: 'host_synthetic',
                      deviceId: 'device_synthetic',
                      sessionId: 'ses_declared',
                      streamId: 'stream_synthetic',
                    },
                  },
          },
        });
      });
      const entitlements = {
        identity: { userId: 'user_synthetic', deviceId: 'device_synthetic' },
        subscriptionState: 'active',
      };
      const client = {
        signedIn: true,
        changingIdentity: false,
        entitlements,
        getEntitlements: async () => entitlements,
      } as unknown as ZuvClient;
      await new SyncOutboxRecovery({ storage, client, engine: {} as SyncEngine }).recover(
        { expectedDeviceId: 'device_synthetic', commitIds: [] },
        new AbortController().signal,
      );
      const [draft] = storage.sync.drafts('vault_synthetic');
      if (!draft) throw new Error('missing recovered synthetic draft');
      expect(draft?.parents).toEqual(['op_committed']);
      if (entityType === 'session')
        expect(
          ((draft.content as SyncDraftPayload).body as { source: { sessionId: string } }).source
            .sessionId,
        ).toBe('ses_declared');
    },
  );
});
