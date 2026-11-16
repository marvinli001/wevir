import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, type ThemeFile } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, expect, it } from 'vitest';
import { type RunningHost, startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const temp = useTempDir();
const hosts: RunningHost[] = [],
  clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of hosts.splice(0)) await host.shutdown();
});
const theme: ThemeFile = {
  schemaVersion: 1,
  name: 'Lagoon',
  dark: { background: '#101820', foreground: '#f1f5f9' },
};

it('publishes changes to subscribed windows and persists the active theme across Host restarts', async () => {
  const home = join(temp(), 'home');
  const start = async () => {
    const host = await startHost({
      home,
      engine: 'echo',
      adapter: new EchoAdapter(),
      logger: createLogger({ level: 'error', mirror: () => {} }),
    });
    hosts.push(host);
    const { token } = JSON.parse(await readFile(join(home, 'run', 'host.json'), 'utf8')) as {
      token: string;
    };
    const connect = async () => {
      const client = await TestRpcClient.connect(host.url);
      clients.push(client);
      const hello = await client.hello(token);
      expect(hello.result.features.themes).toBe(true);
      return client;
    };
    return { host, connect };
  };
  const { host, connect } = await start();
  const one = await connect(),
    two = await connect(),
    unrelated = await connect();
  await one.request('themes.list');
  await two.request('themes.list');
  expect(await one.request('themes.save', { id: 'lagoon', theme })).toMatchObject({ theme });
  await one.request('themes.setActive', { id: 'lagoon' });
  await two.until(
    () => two.notifications('themes.updated').find((update) => update.activeId === 'lagoon'),
    'other window updates',
  );
  expect(unrelated.notifications('themes.updated')).toEqual([]);
  expect(
    (await one.call('themes.save', { id: 'bad', theme: { ...theme, surprise: true } })).error?.data,
  ).toBeDefined();
  await host.shutdown();
  hosts.splice(hosts.indexOf(host), 1);
  const restarted = await start();
  const client = await restarted.connect();
  expect(await client.request('themes.list')).toMatchObject({ activeId: 'lagoon' });
  expect((await client.call('themes.setActive', { id: 'missing' })).error?.code).toBe(
    ErrorCode.INVALID_PARAMS,
  );
  expect(await client.request('themes.setActive', { id: null })).toEqual({ activeId: null });
});

it('allows theme reads and refuses writes without host.manage', async () => {
  const home = join(temp(), 'home');
  await mkdir(join(home, 'themes', 'lagoon'), { recursive: true });
  await writeFile(join(home, 'themes', 'lagoon', 'theme.json'), JSON.stringify(theme));
  const host = await startHost({
    home,
    engine: 'echo',
    adapter: new EchoAdapter(),
    logger: createLogger({ level: 'error', mirror: () => {} }),
    testConnectionGrant: () => ({
      principal: { kind: 'device', deviceId: 'synthetic-device' },
      permissions: ['session.read'],
    }),
  });
  hosts.push(host);
  const { token } = JSON.parse(await readFile(join(home, 'run', 'host.json'), 'utf8')) as {
    token: string;
  };
  const client = await TestRpcClient.connect(host.url);
  clients.push(client);
  expect((await client.hello(token)).error).toBeUndefined();
  expect(await client.request('themes.get', { id: 'lagoon' })).toMatchObject({ theme });
  for (const method of ['themes.save', 'themes.delete', 'themes.setActive']) {
    expect((await client.call(method)).error?.code).toBe(ErrorCode.DEVICE_FORBIDDEN);
  }
});
