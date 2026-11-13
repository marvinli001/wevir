import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const tempDir = useTempDir();
const hosts: RunningHost[] = [];
const clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of hosts.splice(0).reverse()) await host.shutdown();
});

async function boot(name: string) {
  const home = join(tempDir(), name, 'wevir');
  const userHome = join(tempDir(), name, 'user');
  mkdirSync(userHome, { recursive: true });
  const host = await startHost({
    home,
    userHome,
    pluginUserHome: userHome,
    importEnv: {},
    engine: 'echo',
    adapter: new EchoAdapter(),
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
  hosts.push(host);
  const token = JSON.parse(readFileSync(join(home, 'run/host.json'), 'utf8')).token as string;
  const client = await TestRpcClient.connect(host.url);
  clients.push(client);
  const hello = await client.hello(token);
  expect(hello.error).toBeUndefined();
  return { client, hello };
}

describe('isolated Host sync metadata', () => {
  it('exposes local status on two independent Hosts without enrollment or implicit consent', async () => {
    const first = await boot('first');
    const second = await boot('second');
    for (const { client, hello } of [first, second]) {
      expect(hello.result).toMatchObject({ features: { sync_metadata: true } });
      expect(await client.request('sync.status')).toEqual({
        protocol: 'wevir-sync/1',
        artifactRevision: 1,
        state: 'disabled',
        pending: 0,
        quarantined: 0,
        conflicts: 0,
      });
    }
    expect((first.hello.result as { hostId: string }).hostId).not.toBe(
      (second.hello.result as { hostId: string }).hostId,
    );
  });
});
