import type { SecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncVaultKeys } from './keys.js';
import { SyncLifecycle } from './lifecycle.js';

function fixture() {
  const stored = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (key) => stored.get(key),
    set: async (key, value) => {
      stored.set(key, value);
    },
    delete: async (key) => stored.delete(key),
  };
  const request = {
    requestId: 'request_synthetic',
    state: 'requested',
    notBefore: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  let lost = false;
  const client = {
    signedIn: true,
    requiresLogin: false,
    changingIdentity: false,
    transport: { origin: 'https://synthetic.invalid' },
    entitlements: {
      identity: { userId: 'account_synthetic', deviceId: 'device_synthetic' },
      vault: { vaultId: 'vault_synthetic', keyEpoch: '1' },
      subscriptionState: 'expired',
    },
    getEntitlements: vi.fn(async () => client.entitlements),
    json: vi.fn(async (_schema: string, method: string, path: string) => {
      if (path.endsWith('/complete')) {
        request.state = 'completed';
        client.entitlements.vault.keyEpoch = '2';
        if (lost) throw new ZuvRequestError('NETWORK_ERROR');
        return { requestId: request.requestId, state: 'completed', keyEpoch: '2' };
      }
      if (method === 'GET' || path.endsWith('/requests')) return { ...request };
      throw new Error('unexpected route');
    }),
  };
  const keys = { unlock: vi.fn(async () => new Uint8Array(32).fill(1)) };
  const lifecycle = new SyncLifecycle({
    client: client as unknown as ZuvClient,
    keys: keys as unknown as SyncVaultKeys,
    secrets,
  });
  return {
    lifecycle,
    client,
    keys,
    stored,
    request,
    loseResponse: () => {
      lost = true;
    },
  };
}

describe('controlled recovery lifecycle', () => {
  it('persists a request and never completes before approval or the cooling time', async () => {
    const f = fixture();
    await f.lifecycle.request('vault_synthetic');
    await expect(f.lifecycle.complete('vault_synthetic', 'request_synthetic')).rejects.toThrow(
      'RECOVERY_REQUIRED',
    );
    f.request.state = 'approved';
    f.request.notBefore = new Date(Date.now() + 60000).toISOString();
    await expect(f.lifecycle.complete('vault_synthetic', 'request_synthetic')).rejects.toThrow(
      'RECOVERY_REQUIRED',
    );
    expect(f.client.json.mock.calls.filter((call) => call[2].endsWith('/complete'))).toHaveLength(
      0,
    );
    expect(f.keys.unlock).not.toHaveBeenCalled();
  });

  it('completes an approved expired-account recovery and only returns safe status', async () => {
    const f = fixture();
    await f.lifecycle.request('vault_synthetic');
    f.request.state = 'approved';
    const result = await f.lifecycle.complete('vault_synthetic', 'request_synthetic');
    expect(result).toMatchObject({
      keyEpoch: '2',
      unlocked: true,
      request: { state: 'completed' },
    });
    expect(f.keys.unlock).toHaveBeenCalledWith('vault_synthetic', '2', expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain('keyMaterial');
  });

  it('queries a lost complete response and does not rotate a second time', async () => {
    const f = fixture();
    await f.lifecycle.request('vault_synthetic');
    f.request.state = 'approved';
    f.loseResponse();
    await expect(f.lifecycle.complete('vault_synthetic', 'request_synthetic')).rejects.toThrow(
      'NETWORK_ERROR',
    );
    expect((await f.lifecycle.complete('vault_synthetic', 'request_synthetic')).unlocked).toBe(
      true,
    );
    expect(f.client.json.mock.calls.filter((call) => call[2].endsWith('/complete'))).toHaveLength(
      1,
    );
  });

  it('rejects a different vault or a pending request from another identity', async () => {
    const f = fixture();
    await f.lifecycle.request('vault_synthetic');
    await expect(f.lifecycle.status('vault_other')).rejects.toThrow('AUTH_REQUIRED');
    f.client.entitlements.identity.userId = 'account_other';
    await expect(f.lifecycle.complete('vault_synthetic', 'request_synthetic')).rejects.toThrow(
      'AUTH_REQUIRED',
    );
  });
});
