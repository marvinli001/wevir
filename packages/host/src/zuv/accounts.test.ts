import type { SecretStore } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { ZuvAccounts } from './accounts.js';
import { ZuvClient } from './client.js';
import { startMockZuv } from './mock.test-utils.js';

describe('ZUV enrollment ownership', () => {
  it.each(['restart', 'cancel'] as const)('ignores an old poll after %s', async (action) => {
    const server = await startMockZuv();
    const values = new Map<string, string>();
    const secrets: SecretStore = {
      get: async (name) => values.get(name),
      set: async (name, value) => {
        values.set(name, value);
      },
      delete: async (name) => values.delete(name),
    };
    let release = () => {},
      arrived = () => {},
      held = false;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      seen = new Promise<void>((r) => {
        arrived = r;
      });
    const client = new ZuvClient({
      origin: server.origin,
      allowLoopback: true,
      secrets,
      fetch: async (...args) => {
        if (new URL(String(args[0])).pathname.endsWith('/enrollment/poll') && !held) {
          held = true;
          arrived();
          await gate;
          return Response.json(
            { error: { code: 'ENROLLMENT_EXPIRED', message: 'ENROLLMENT_EXPIRED' } },
            { status: 401 },
          );
        }
        return fetch(...args);
      },
    });
    const accounts = new ZuvAccounts(client, 'Synthetic');
    try {
      await accounts.load();
      const first = await accounts.login('zuv', 'browser');
      await seen;
      if (action === 'restart') await accounts.login('zuv', 'browser');
      else await accounts.cancelLogin('zuv', first.login?.loginId);
      const expected = client.enrollment?.enrollmentId;
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(client.enrollment?.enrollmentId).toBe(expected);
      const state = await accounts.read('zuv');
      expect(state.status).toBe(action === 'restart' ? 'signing_in' : 'signed_out');
      expect(state.lastError).toBeUndefined();
    } finally {
      release();
      await accounts.close();
      await server.close();
    }
  });
});
