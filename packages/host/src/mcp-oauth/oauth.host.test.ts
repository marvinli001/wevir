// connector.login / loginCancel / logout 经 RPC：真实的 Host（echo 引擎）+ 假的 OAuth 服务。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { browse, type FakeOAuthServer, startFakeOAuth } from '../test-fixtures/oauth-mcp.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const temp = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function launch(home: string) {
  const logs: string[] = [];
  const host: RunningHost = await startHost({
    home,
    engine: 'echo',
    adapter: new EchoAdapter({ stepDelayMs: 0 }),
    logger: createLogger({ level: 'debug', mirror: (line) => logs.push(line) }),
  });
  const client = await TestRpcClient.connect(host.url);
  const stop = async () => {
    client.ws.terminate();
    await host.shutdown();
  };
  cleanups.push(stop);
  const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
  const hello = await client.hello(info.token);
  return { host, client, hello, logs, stop };
}

async function echoConnectors(client: TestRpcClient): Promise<string> {
  const { session } = await client.request('session.create', { providerId: 'mock' });
  const { subscriptionId } = await client.request('events.subscribe', {
    sessionId: session.id,
    sinceSeq: 0,
  });
  await client.request('session.send', {
    sessionId: session.id,
    content: [{ type: 'text', text: 'plugins' }],
  });
  await client.until(
    () => client.events(subscriptionId).find((item) => item.type === 'turn.finished'),
    'turn.finished',
  );
  return JSON.stringify(client.events(subscriptionId));
}

describe('connector.login 经 RPC', () => {
  it('功能位、自动判断、登录、状态通知、退出登录与错误码；重启后仍登录', async () => {
    const fake: FakeOAuthServer = await startFakeOAuth();
    cleanups.push(() => fake.close());
    const home = join(temp(), 'host');
    const { client, hello, logs, stop } = await launch(home);
    expect(hello.result.features.mcp_oauth).toBe(true);
    await client.request('provider.upsert', {
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'mock' }],
      defaultModelId: 'mock',
      apiKey: 'mock-not-a-secret',
    });
    const { connector } = await client.request('connector.add', {
      name: 'remote',
      config: { transport: 'http', url: fake.url },
    });
    expect(connector).toMatchObject({ config: { auth: 'oauth' }, oauth: { status: 'required' } });
    expect(await echoConnectors(client)).not.toContain('Connectors: remote');

    const changed = () => client.notifications('plugins.changed').length;
    const before = changed();
    const { loginId, authUrl } = await client.request('connector.login', { name: 'remote' });
    expect(loginId).toMatch(/^login_/);
    await client.until(() => (changed() > before ? true : undefined), 'plugins.changed');
    expect((await client.request('plugins.list', {})).connectors[0].oauth).toEqual({
      status: 'signing_in',
    });
    expect((await browse(authUrl)).body).toContain('Signed in');
    const list = await client.request('plugins.list', {});
    expect(list.connectors[0].oauth).toMatchObject({ status: 'signed_in', issuer: fake.issuer });
    expect(await echoConnectors(client)).toContain('Connectors: remote');
    const tokens = [...fake.accessTokens.keys(), ...fake.refreshTokens];
    for (const token of tokens) {
      expect(JSON.stringify(list)).not.toContain(token);
      expect(logs.join('\n')).not.toContain(token);
    }

    // 重启：令牌还在。
    await stop();
    const again = await launch(home);
    expect((await again.client.request('plugins.list', {})).connectors[0].oauth).toMatchObject({
      status: 'signed_in',
    });

    await again.client.request('connector.logout', { name: 'remote' });
    expect(fake.revoked.length).toBeGreaterThan(0);
    expect((await again.client.request('plugins.list', {})).connectors[0].oauth).toEqual({
      status: 'required',
    });
    const cancelled = await again.client.request('connector.login', { name: 'remote' });
    await again.client.request('connector.loginCancel', { loginId: cancelled.loginId });
    const unknown = await again.client.call('connector.loginCancel', { loginId: 'login_x' });
    expect(unknown.error?.code).toBe(ErrorCode.INVALID_PARAMS);

    const plain = await startFakeOAuth({ dcr: false });
    cleanups.push(() => plain.close());
    await again.client.request('connector.add', {
      name: 'noclient',
      config: { transport: 'http', url: plain.url },
    });
    const failed = await again.client.call('connector.login', { name: 'noclient' });
    expect(failed.error).toMatchObject({
      code: ErrorCode.MCP_OAUTH_FAILED,
      data: { reason: 'client_id_required' },
    });
    const missing = await again.client.call('connector.login', { name: 'nothere' });
    expect(missing.error?.code).toBe(ErrorCode.INVALID_PARAMS);
  }, 30_000);
});
