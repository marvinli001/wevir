import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AccountState, PROTOCOL_VERSION, type ProviderProfile } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { startMockZuv } from './mock.test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('ZUV account on isolated Hosts', () => {
  it('enrolls through Host RPC without exposing secrets or enabling content sync, and gates old clients', async () => {
    const mock = await startMockZuv();
    cleanups.push(() => mock.close());
    const boot = async (name: string) => {
      const home = join(tempDir(), name, 'wevir');
      const userHome = join(tempDir(), name, 'user');
      mkdirSync(userHome, { recursive: true });
      const host = await startHost({
        home,
        userHome,
        pluginUserHome: userHome,
        importEnv: {},
        adapter: new EchoAdapter(),
        engine: 'echo',
        zuv: { origin: mock.origin, allowLoopback: true, deviceName: `Synthetic ${name}` },
        logger: createLogger({ mirror: () => {} }),
      });
      cleanups.push(() => host.shutdown());
      const token = JSON.parse(readFileSync(join(home, 'run/host.json'), 'utf8')).token as string;
      const connect = async (version = PROTOCOL_VERSION) => {
        const client = await TestRpcClient.connect(host.url);
        cleanups.push(() => client.ws.terminate());
        const hello = await client.call('host.hello', {
          token,
          protocolVersion: version,
          clientKind: 'desktop',
          clientId: `test-${name}`,
          deviceId: `test-${name}`,
          capabilities: { subscription_kinds: true },
        });
        expect(hello.error).toBeUndefined();
        return client;
      };
      return { home, client: await connect(), connect };
    };
    const first = await boot('first');
    const second = await boot('second');
    expect(mock.requests).toEqual([]);
    expect((await first.client.request('account.get', { kind: 'zuv' })).account.status).toBe(
      'signed_out',
    );
    expect(mock.requests).toEqual([]);
    const login = (await first.client.request('account.login', { kind: 'zuv', method: 'browser' }))
      .account;
    expect(login.status).toBe('signing_in');
    mock.approve(login.login?.authUrl as string);
    await first.client.until(
      () =>
        first.client
          .notifications('account.updated')
          .find(
            (params) =>
              (params.account as { kind: string; status: string }).kind === 'zuv' &&
              (params.account as { status: string }).status === 'signed_in',
          ),
      'ZUV enrollment',
    );
    const account = (await first.client.request('account.get', { kind: 'zuv' })).account;
    expect(account).toMatchObject({
      status: 'signed_in',
      zuv: { subscriptionState: 'active', syncState: 'disabled' },
    });
    expect((await second.client.request('account.get', { kind: 'zuv' })).account.status).toBe(
      'signed_out',
    );
    await expect
      .poll(async () =>
        (await first.client.request('provider.list')).providers.some(
          (provider: ProviderProfile) => provider.kind === 'zuv',
        ),
      )
      .toBe(true);
    const provider = (await first.client.request('provider.list')).providers.find(
      (provider: ProviderProfile) => provider.kind === 'zuv',
    );
    expect(provider).toMatchObject({
      id: 'zuv',
      hasSecret: false,
      models: [{ id: 'synthetic-model' }],
    });
    expect(await first.client.request('sync.status')).not.toHaveProperty('binding');
    expect(mock.requests.some((path) => path.includes('/sync/'))).toBe(false);
    const stored = JSON.parse(
      (await new FileSecretStore(first.home).get('zuv.identity')) as string,
    );
    const rendererData = JSON.stringify({
      account,
      provider,
      notifications: first.client.notifications('account.updated'),
    });
    for (const secret of [
      stored.key.privateKey,
      stored.tokens.accessToken,
      stored.tokens.refreshToken,
    ])
      expect(rendererData).not.toContain(secret);
    const old = await first.connect('0.170.0');
    expect(
      (await old.request('account.list')).accounts.some(
        (value: AccountState) => value.kind === 'zuv',
      ),
    ).toBe(false);
    expect(
      (await old.request('provider.list')).providers.some(
        (value: ProviderProfile) => value.kind === 'zuv',
      ),
    ).toBe(false);
    await first.client.request('account.logout', { kind: 'zuv' });
    expect(await new FileSecretStore(first.home).get('zuv.identity')).toBeUndefined();
    expect(mock.errors).toEqual([]);
  });
});
