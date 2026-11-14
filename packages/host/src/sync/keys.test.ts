import type { SecretStore } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import type { ZuvClient } from '../zuv/client.js';
import { SyncVaultKeys } from './keys.js';

describe('concurrent vault unlocks', () => {
  it('gives each caller independent key bytes', async () => {
    const keys = new SyncVaultKeys({
      client: {
        entitlements: { vault: { vaultId: 'vault_test', keyEpoch: '1' } },
      } as unknown as ZuvClient,
      secrets: {
        get: async () => Buffer.alloc(32, 71).toString('base64url'),
      } as unknown as SecretStore,
      onSecret: () => {},
    });
    const [first, second] = await Promise.all(
      [1, 2].map(() => keys.unlock('vault_test', '1', new AbortController().signal)),
    );
    first?.fill(0);
    expect(second).toEqual(Buffer.alloc(32, 71));
  });
});
