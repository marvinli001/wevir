import { join } from 'node:path';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeRun, run, runFake, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const hosts: RunningHost[] = [];
const commands: FakeRun[] = [];
afterEach(async () => {
  for (const command of commands.splice(0)) {
    command.interrupt();
    await command.exit.catch(() => {});
  }
  for (const host of hosts.splice(0)) await host.shutdown();
});

async function setup() {
  const home = join(tempDir(), 'host');
  const secret = `zuv-${'B'.repeat(48)}`;
  const paths: string[] = [];
  let approved = false;
  const doFetch: typeof fetch = async (input) => {
    const url = String(input);
    paths.push(url);
    const response = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/start'))
      return response({
        requestId: 'cli-synthetic-request',
        authorizationUrl: 'https://zuv.wevir.si/connect/wevir-api?request=cli-synthetic-request',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        intervalMs: 1000,
      });
    if (url.endsWith('/poll'))
      return response(
        approved
          ? {
              state: 'delivered',
              secret,
              account: { id: 'cli-api-account', email: 'api@fixture.test', name: 'Fixture' },
              key: { id: 'fixture-key', prefix: secret.slice(0, 10) },
              baseURL: 'https://zuv.wevir.si/v1',
            }
          : { state: 'pending' },
      );
    if (url.endsWith('/complete')) return response({ state: 'completed' });
    if (url.endsWith('/cancel')) return response({ state: 'cancelled' });
    if (url.endsWith('/check')) return response({ ok: true });
    if (url.endsWith('/v1/models?protocol=all'))
      return response({
        data: [{ id: 'fixture/allowed', name: 'Fixture', protocols: ['responses'] }],
      });
    throw new Error('Unexpected synthetic API request');
  };
  hosts.push(
    await startHost({
      home,
      adapter: new EchoAdapter(),
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
      zuv: { fetch: doFetch, deviceName: 'Synthetic CLI Host' },
    }),
  );
  return {
    home,
    secret,
    paths,
    approve: () => {
      approved = true;
    },
  };
}

describe('CLI ZUV API authorization', () => {
  it('prints only the authorization link, account and prefix, then disconnects locally', async () => {
    const f = await setup();
    const command = runFake(['provider', 'login', 'zuv'], { home: f.home });
    commands.push(command);
    await command.waitFor('/connect/wevir-api?request=cli-synthetic-request');
    f.approve();
    expect(await command.exit).toBe(0);
    expect(command.out()).toContain('api@fixture.test');
    expect(command.out()).toContain(f.secret.slice(0, 10));
    expect(command.out() + command.err()).not.toContain(f.secret);
    const status = await run(['provider', 'status', 'zuv'], { home: f.home });
    expect(status.code).toBe(0);
    expect(status.out).toContain('api@fixture.test');
    const before = f.paths.length;
    expect((await run(['provider', 'logout', 'zuv'], { home: f.home })).code).toBe(0);
    expect(f.paths).toHaveLength(before);
    expect(
      f.paths.every((path) => !path.includes('/enrollment/') && !path.includes('/completions')),
    ).toBe(true);
  }, 15_000);

  it('cancels the Host authorization on interruption', async () => {
    const f = await setup();
    const command = runFake(['provider', 'login', 'zuv'], { home: f.home });
    commands.push(command);
    await command.waitFor('/connect/wevir-api?request=cli-synthetic-request');
    command.interrupt();
    expect(await command.exit).toBe(130);
    expect(f.paths.some((path) => path.endsWith('/cancel'))).toBe(true);
    expect(f.paths.some((path) => path.endsWith('/complete'))).toBe(false);
  }, 15_000);
});
