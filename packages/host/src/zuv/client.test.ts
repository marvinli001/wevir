import { createPublicKey, verify } from 'node:crypto';
import type { SecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../sync/crypto.js';
import { ZuvClient } from './client.js';

function mock() {
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (name) => values.get(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => values.delete(name),
  };
  let now = Date.parse('2026-11-13T00:00:00.000Z');
  let subscriptionState = 'active';
  let networkFailure = '';
  let challenge = '';
  let publicKey: { kty: string; crv: string; x: string };
  let refreshes = 0;
  const entitlements = () => ({
    protocol: 'wevir-sync/1',
    vault: null,
    identity: { userId: 'user_fixture', deviceId: 'device_fixture' },
    deviceScopes: ['identity', 'inference', 'sync', 'recovery'],
    subscriptionState,
    syncState: 'disabled',
    quota: { physicalBytes: 0 },
    retentionUntil: null,
    recovery: { eligible: false, requiresApproval: false },
    limits: { blobBytes: 4194304 },
  });
  const request = vi.fn<typeof fetch>(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === networkFailure) throw new Error('synthetic upstream network failure');
    const body = options?.body === undefined ? undefined : Buffer.from(options.body as Uint8Array);
    const value = body === undefined ? undefined : JSON.parse(body.toString());
    const headers = new Headers(options?.headers);
    if (path === '/api/wevir/enrollment/start') {
      challenge = value.codeChallenge;
      publicKey = value.publicKey;
      expect(value.codeChallengeMethod).toBe('S256');
      return Response.json({
        enrollmentId: 'enrollment_fixture',
        verificationUri: 'https://zuv.test/console/devices/enroll?id=enrollment_fixture',
        intervalMs: 5000,
        expiresAt: new Date(now + 600000).toISOString(),
      });
    }
    const [head, payload, signature] = (headers.get('dpop') ?? '').split('.') as [
      string,
      string,
      string,
    ];
    expect(
      verify(
        null,
        Buffer.from(`${head}.${payload}`),
        createPublicKey({ key: publicKey, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    const proof = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(proof.htm).toBe(options?.method);
    expect(proof.htu).toBe(`https://zuv.test${path}`);
    if (body) expect(proof.bht).toBe(sha256(body));
    if (path === '/api/wevir/enrollment/poll') {
      expect(sha256(value.codeVerifier)).toBe(challenge);
      expect(proof.ath).toBe(sha256('enrollment_fixture'));
      return Response.json({
        state: 'approved',
        deviceId: 'device_fixture',
        grant: 'synthetic-grant-for-test',
        expiresAt: new Date(now + 300000).toISOString(),
        clientId: 'wevir',
      });
    }
    if (path === '/api/wevir/token' || path === '/api/wevir/refresh') {
      expect(proof.ath).toBe(sha256(value.token));
      expect(headers.has('authorization')).toBe(false);
      if (path.endsWith('/refresh')) refreshes++;
      return Response.json({
        client_id: 'wevir',
        token_type: 'DPoP',
        access_token: `synthetic-access-${refreshes}-token`,
        refresh_token: `synthetic-refresh-${refreshes}-token`,
        expires_in: 900,
      });
    }
    expect(headers.get('authorization')).toBe(`DPoP synthetic-access-${refreshes}-token`);
    expect(proof.ath).toBe(sha256(`synthetic-access-${refreshes}-token`));
    if (path === '/api/wevir/entitlements') return Response.json(entitlements());
    if (path === '/api/wevir/v1/models')
      return Response.json({
        object: 'list',
        data: [{ id: 'synthetic-model', object: 'model', owned_by: 'synthetic' }],
      });
    return Response.json({ error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } }, { status: 404 });
  });
  const options = { origin: 'https://zuv.test', secrets, fetch: request, now: () => now };
  const client = new ZuvClient(options);
  const login = async () => {
    await client.beginEnrollment('Synthetic device');
    await client.pollEnrollment();
    await client.getEntitlements();
  };
  return {
    client,
    login,
    values,
    request,
    options,
    entitlements,
    advance: (ms: number) => {
      now += ms;
    },
    expire: () => {
      subscriptionState = 'expired';
    },
    fail: (path: string) => {
      networkFailure = path;
    },
  };
}

describe('Host-owned ZUV identity', () => {
  it('ignores an entitlement response that belongs to the identity before sign-out', async () => {
    const h = mock();
    await h.login();
    const send = h.request.getMockImplementation();
    if (!send) throw new Error('missing synthetic fetch');
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    h.request.mockImplementation(async (...args) => {
      const response = await send(...args);
      if (new URL(String(args[0])).pathname === '/api/wevir/entitlements') {
        arrived();
        await gate;
      }
      return response;
    });
    const pending = h.client.getEntitlements();
    await seen;
    await h.client.logout();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(h.client.signedIn).toBe(false);
    expect(h.values.size).toBe(0);
  });
  it('waits for the prior vault application to drain before clearing its identity', async () => {
    const h = mock();
    await h.login();
    let release = () => {};
    const draining = new Promise<void>((resolve) => {
      release = resolve;
    });
    const peer = new ZuvClient({ ...h.options, onIdentityChanging: () => draining });
    await peer.load();
    const loggingOut = peer.logout();
    expect(peer.signedIn).toBe(true);
    expect(peer.changingIdentity).toBe(true);
    await expect(
      peer.authorizeInference('https://zuv.test/api/wevir/v1/responses', Buffer.from('{}')),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(h.values.size).toBeGreaterThan(0);
    release();
    await loggingOut;
    expect(peer.changingIdentity).toBe(false);
    expect(peer.signedIn).toBe(false);
    expect(h.values.size).toBe(0);
    await peer.close();
  });
  it('rejects late network responses after close without overwriting credentials', async () => {
    const h = mock();
    await h.login();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const client = new ZuvClient({
      ...h.options,
      fetch: async (input, options) => {
        const response = await h.options.fetch(input, options);
        arrived();
        await gate;
        return response;
      },
    });
    await client.load();
    const snapshot = new Map(h.values);
    const request = client.getEntitlements();
    await entered;
    await client.close();
    release();
    await expect(request).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(h.values).toEqual(snapshot);
    await expect(client.getEntitlements()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('does no network work before login and enrolls with PKCE and a device proof', async () => {
    const h = mock();
    await h.client.load();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.client.signedIn).toBe(false);
    await h.login();
    expect(h.client.enrollment).toBeUndefined();
    expect(h.client.deviceId).toBe('device_fixture');
    expect(h.client.entitlements).toEqual(h.entitlements());
    expect(await h.client.models()).toEqual(['synthetic-model']);
    const restored = new ZuvClient(h.options);
    await restored.load();
    expect(restored.signedIn).toBe(true);
    expect(restored.entitlements).toEqual(h.entitlements());
  });

  it('keeps the identity after subscription expiry or a transient network failure', async () => {
    const h = mock();
    await h.login();
    h.expire();
    await h.client.getEntitlements();
    await expect(
      h.client.authorizeInference('https://zuv.test/api/wevir/v1/responses', Buffer.from('{}')),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
    h.fail('/api/wevir/entitlements');
    await expect(h.client.getEntitlements()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(h.client.signedIn).toBe(true);
    expect(h.client.entitlements?.subscriptionState).toBe('expired');
    expect(h.client.requiresLogin).toBe(false);
  });

  it('serializes token refresh and retains the device key and identity', async () => {
    const h = mock();
    await h.login();
    h.advance(901000);
    await Promise.all([h.client.getEntitlements(), h.client.getEntitlements()]);
    expect(
      h.request.mock.calls.filter((call) => String(call[0]).endsWith('/refresh')),
    ).toHaveLength(1);
    expect(h.client.requiresLogin).toBe(false);
    expect(h.client.deviceId).toBe('device_fixture');
  });

  it('persists uncertain refresh state across restart and never replays its one-use token', async () => {
    const h = mock();
    await h.login();
    h.advance(901000);
    h.fail('/api/wevir/refresh');
    await expect(h.client.getEntitlements()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const restored = new ZuvClient(h.options);
    await restored.load();
    expect(restored.requiresLogin).toBe(true);
    await expect(restored.getEntitlements()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(
      h.request.mock.calls.filter((call) => String(call[0]).endsWith('/refresh')),
    ).toHaveLength(1);
  });

  it('never signs another provider or redirect target and logout clears credentials', async () => {
    const h = mock();
    await h.login();
    const before = h.request.mock.calls.length;
    await expect(
      h.client.authorizeInference('https://other.test/api/wevir/v1/responses', Buffer.from('{}')),
    ).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    await expect(
      h.client.authorizeInference(
        'https://zuv.test/api/wevir/v1/responses?redirect=other',
        Buffer.from('{}'),
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    expect(h.request.mock.calls).toHaveLength(before);
    await h.client.logout();
    expect(h.client.signedIn).toBe(false);
    expect(h.values.size).toBe(0);
  });

  it('does not reuse a saved identity after changing the configured origin', async () => {
    const h = mock();
    await h.login();
    const original = new Map(h.values);
    const changed = new ZuvClient({ ...h.options, origin: 'https://other.test' });
    await expect(changed.load()).rejects.toThrow('ZUV credentials unreadable');
    expect(h.values).toEqual(original);
  });
});
