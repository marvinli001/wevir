import { ZUV_API_PROVIDER_ID } from '@wevir/protocol';
import type { SecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderLock } from '../host-methods.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { ZuvApiConnection } from './api-connection.js';

const tempDir = useTempDir();
const storages = useStorages();
const connections: ZuvApiConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const storage = storages.open(tempDir());
  const values = new Map<string, string>([
    ['zuv.identity', 'synthetic subscription account B'],
    ['zuv.enrollment', 'synthetic subscription enrollment B'],
    ['sync.vault', 'synthetic sync secret'],
  ]);
  const secrets: SecretStore = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => values.delete(key),
  };
  const key = `zuv-${'A'.repeat(48)}`;
  const requests: Array<{
    url: string;
    headers: Headers;
    body?: Record<string, unknown>;
    method: string;
  }> = [];
  const state = {
    decision: 'delivered',
    checkError: '',
    modelsFail: false,
    modelsEmpty: false,
    pollLost: false,
    completeLost: false,
    completed: false,
  };
  const doFetch: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const response = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/start'))
      return response(
        {
          requestId: 'synthetic-authorization',
          authorizationUrl:
            'https://zuv.wevir.si/connect/wevir-api?request=synthetic-authorization',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          intervalMs: 2000,
        },
        201,
      );
    if (url.endsWith('/poll')) {
      if (state.pollLost) {
        state.pollLost = false;
        throw new Error('synthetic interrupted delivery');
      }
      if (state.decision !== 'delivered') return response({ error: state.decision }, 409);
      if (state.completed) return response({ error: 'authorization_completed' }, 409);
      return response({
        state: 'delivered',
        secret: key,
        account: { id: 'account-a', email: 'a@synthetic.test', name: 'API A' },
        key: { id: 'synthetic-key', prefix: key.slice(0, 10) },
        baseURL: 'https://zuv.wevir.si/v1',
      });
    }
    if (url.endsWith('/complete')) {
      state.completed = true;
      if (state.completeLost) {
        state.completeLost = false;
        throw new Error('synthetic lost acknowledgement');
      }
      return response({ state: 'completed' });
    }
    if (url.endsWith('/cancel')) return response({ state: 'cancelled' });
    if (url.endsWith('/check'))
      return state.checkError ? response({ error: state.checkError }, 409) : response({ ok: true });
    if (url.endsWith('/v1/models?protocol=all')) {
      if (state.modelsFail) throw new Error('synthetic model outage');
      if (state.modelsEmpty) return response({ data: [] });
      return response({
        data: [
          {
            id: 'test/allowed',
            name: 'Allowed model',
            protocols: ['responses'],
            owned_by: 'test',
            context_length: 8192,
            max_output_tokens: 1024,
            input_modalities: ['text'],
            output_modalities: ['text'],
            endpoints: ['chat'],
          },
        ],
      });
    }
    throw new Error('Unexpected synthetic endpoint');
  });
  const configured: unknown[] = [];
  const create = () => {
    const connection = new ZuvApiConnection({
      storage,
      secrets,
      providerLock: createProviderLock(),
      fetch: doFetch,
      hostName: 'Synthetic Host',
      applyProviders: async () => {
        configured.push(storage.providers.list());
      },
    });
    connections.push(connection);
    return connection;
  };
  return { storage, values, secrets, key, requests, state, configured, create };
}

describe('ZUV API connection', () => {
  it('installs an ordinary payg provider and keeps subscription credentials and requests separate', async () => {
    const f = fixture();
    const connection = f.create();
    await connection.load();
    const first = await connection.login();
    expect(first.status).toBe('authorizing');
    expect(await connection.login()).toEqual(first);
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection.get()).toMatchObject({
      status: 'connected',
      account: { id: 'account-a' },
      keyPrefix: f.key.slice(0, 10),
      modelCount: 1,
    });
    expect(JSON.stringify(connection.get())).not.toContain(f.key);
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toMatchObject({
      kind: 'openai-compatible',
      baseURL: 'https://zuv.wevir.si/v1',
      secretRef: 'zuv.api.key',
      models: [expect.objectContaining({ id: 'test/allowed', contextWindow: 8192 })],
    });
    expect(f.values.get('zuv.identity')).toBe('synthetic subscription account B');
    expect(f.values.get('zuv.enrollment')).toBe('synthetic subscription enrollment B');
    expect(f.values.get('sync.vault')).toBe('synthetic sync secret');
    const authenticated = f.requests.filter((request) => request.method === 'GET');
    expect(authenticated).toHaveLength(2);
    for (const request of authenticated) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${f.key}`);
      expect(request.headers.has('dpop')).toBe(false);
    }
    expect(
      f.requests.every(
        (request) =>
          !request.url.includes('/api/public/') &&
          !request.url.includes('/enrollment/') &&
          !request.url.includes('/api/wevir/v1/') &&
          !request.url.includes('/completions') &&
          !request.url.includes('/responses'),
      ),
    ).toBe(true);
    const before = f.requests.length;
    await connection.disconnect();
    expect(f.requests).toHaveLength(before);
    expect(connection.get().status).toBe('disconnected');
    expect(f.values.has('zuv.api.key')).toBe(false);
    expect(f.values.has('zuv.api.connection')).toBe(false);
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toMatchObject({
      enabled: false,
    });
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).not.toHaveProperty('secretRef');
    expect(f.values.get('zuv.identity')).toBe('synthetic subscription account B');
  });

  it('resumes a lost delivery and a lost completion acknowledgement after Host restart', async () => {
    const f = fixture();
    const connection = f.create();
    f.state.pollLost = true;
    f.state.completeLost = true;
    await connection.login();
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.state.completed).toBe(true);
    expect(f.values.has('zuv.api.authorization')).toBe(true);
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toBeUndefined();
    await connection.close();
    const resumed = f.create();
    await resumed.load();
    await vi.advanceTimersByTimeAsync(2000);
    expect(resumed.get().status).toBe('connected');
    expect(f.requests.filter((request) => request.url.endsWith('/start'))).toHaveLength(1);
    expect(f.requests.filter((request) => request.url.endsWith('/poll'))).toHaveLength(2);
    expect(f.values.has('zuv.api.authorization')).toBe(false);
    const afterLogin = f.requests.length;
    await resumed.close();
    const restarted = f.create();
    await restarted.load();
    expect(restarted.get().status).toBe('connected');
    expect(f.requests).toHaveLength(afterLogin);
    await restarted.refreshModels();
    expect(f.requests.slice(afterLogin).every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['authorization_denied', 'authorization_expired', 'authorization_cancelled'])(
    'leaves no provider after %s',
    async (decision) => {
      const f = fixture();
      f.state.decision = decision;
      const connection = f.create();
      await connection.login();
      await vi.advanceTimersByTimeAsync(2000);
      expect(connection.get()).toMatchObject({ status: 'error', error: decision });
      expect(f.values.has('zuv.api.key')).toBe(false);
      expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toBeUndefined();
    },
  );

  it('cancels the pending request without creating a provider', async () => {
    const f = fixture();
    const connection = f.create();
    const pending = await connection.login();
    await connection.cancel(pending.login?.requestId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.get().status).toBe('disconnected');
    expect(f.requests.filter((request) => request.url.endsWith('/cancel'))).toHaveLength(1);
    expect(f.requests.filter((request) => request.url.endsWith('/poll'))).toHaveLength(0);
    expect(f.values.has('zuv.api.authorization')).toBe(false);
  });

  it('clears an interrupted credential write when cancellation races completed delivery', async () => {
    const f = fixture();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const set = f.secrets.set;
    f.secrets.set = async (name, value) => {
      if (name === 'zuv.api.key') {
        entered();
        await blocked;
      }
      await set(name, value);
    };
    const connection = f.create();
    const pending = await connection.login();
    const polling = vi.advanceTimersByTimeAsync(2000);
    await writing;
    const cancelled = connection.cancel(pending.login?.requestId);
    release();
    await polling;
    await cancelled;
    expect(f.values.has('zuv.api.key')).toBe(false);
    expect(f.values.has('zuv.api.connection')).toBe(false);
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toBeUndefined();
    const restarted = f.create();
    await restarted.load();
    expect(restarted.get().status).toBe('disconnected');
  });

  it('reports model loading separately from successful login', async () => {
    const f = fixture();
    f.state.modelsFail = true;
    const connection = f.create();
    await connection.login();
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection.get()).toMatchObject({ status: 'connected', modelsError: 'network' });
    expect(connection.get().error).toBeUndefined();
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toBeUndefined();
    f.state.modelsFail = false;
    await connection.refreshModels();
    expect(connection.get().modelsError).toBeUndefined();
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toBeDefined();
  });

  it('removes stale model choices when the key no longer permits any models', async () => {
    const f = fixture();
    const connection = f.create();
    await connection.login();
    await vi.advanceTimersByTimeAsync(2000);
    f.state.modelsEmpty = true;
    await connection.refreshModels();
    expect(connection.get()).toMatchObject({
      status: 'connected',
      modelsError: 'no_models',
      modelCount: 0,
    });
    expect(f.storage.providers.get(ZUV_API_PROVIDER_ID)).toMatchObject({
      models: [],
      enabled: false,
    });
    expect(f.values.get('zuv.api.key')).toBe(f.key);
    expect(f.requests.filter((request) => request.url.endsWith('/start'))).toHaveLength(1);
  });

  it.each([
    'key_disabled',
    'key_revoked',
    'key_expired',
    'key_limit_reached',
    'key_window_limit',
    'key_replaced',
  ])('keeps %s visible without acquiring a replacement', async (code) => {
    const f = fixture();
    const connection = f.create();
    await connection.login();
    await vi.advanceTimersByTimeAsync(2000);
    f.state.checkError = code;
    await connection.refreshModels();
    expect(connection.get()).toMatchObject({ status: 'connected', error: code });
    expect(f.requests.filter((request) => request.url.endsWith('/start'))).toHaveLength(1);
    expect(f.values.get('zuv.api.key')).toBe(f.key);
  });
});
