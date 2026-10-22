import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { PluginRegistry } from '../plugins.js';
import {
  browse,
  type FakeOAuthOptions,
  type FakeOAuthServer,
  OAUTH_TOOL,
  SCOPED_TOOL,
  startFakeOAuth,
} from '../test-fixtures/oauth-mcp.js';
import { useTempDir } from '../test-utils.js';
import { checkEndpoint, OAuthHttpError } from './http.js';
import { McpRemoteProxy } from './proxy.js';
import { type McpOAuthOptions, McpOAuthService } from './service.js';
import { parseBearerChallenge } from './www-authenticate.js';

const temp = useTempDir();
let homes = 0;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

interface Setup {
  home: string;
  fake: FakeOAuthServer;
  store: PluginRegistry;
  oauth: McpOAuthService;
  proxy: McpRemoteProxy;
  port: number;
  logs: string[];
  /** 交给引擎的这个连接器的配置（代理地址与代理令牌）；没交时 undefined。 */
  engine(name?: string): Promise<{ url: string; headers?: Record<string, string> } | undefined>;
  /** 以引擎的身份经代理发一个 MCP 请求。 */
  call(body: unknown, headers?: Record<string, string>): Promise<Response>;
}

async function setup(
  fakeOptions: FakeOAuthOptions = {},
  serviceOptions: Partial<McpOAuthOptions> = {},
  existing?: { home: string; fake: FakeOAuthServer },
): Promise<Setup> {
  const fake = existing?.fake ?? (await startFakeOAuth(fakeOptions));
  if (!existing) cleanups.push(() => fake.close());
  homes += 1;
  const home = existing?.home ?? join(temp(), `home-${homes}`);
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', mirror: (line) => logs.push(line) });
  const oauth = new McpOAuthService({
    secrets: new FileSecretStore(home),
    onSecret: (value) => logger.addSecret(value),
    onWarning: (message) => logger.warn(message),
    ...serviceOptions,
  });
  const store = new PluginRegistry({
    home,
    userHome: join(temp(), 'user'),
    roots: () => [],
    adapter: new EchoAdapter({ stepDelayMs: 0 }),
    oauth,
    onWarning: (message) => logger.warn(message),
  });
  await store.load();
  await oauth.load();
  const proxy = new McpRemoteProxy({
    oauth,
    target: (id) => store.oauthTargetById(id),
    onError: (error) => logger.warn('proxy error', { error }),
  });
  const server: Server = createServer((req, res) => {
    if (!proxy.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  oauth.setPort(port);
  proxy.setPort(port);
  cleanups.push(() => {
    oauth.close();
    proxy.close();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const engine = async (name = 'remote') => {
    const item = (await store.engineConfig()).connectors.find((c) => c.name === name);
    return item?.config.transport === 'http' ? item.config : undefined;
  };
  const call = async (body: unknown, headers: Record<string, string> = {}) => {
    const config = await engine();
    if (!config) throw new Error('connector not handed to the engine');
    return fetch(config.url, {
      method: 'POST',
      headers: {
        ...config.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  };
  return { home, fake, store, oauth, proxy, port, logs, engine, call };
}

async function signIn(s: Setup, config: Record<string, unknown> = {}, name = 'remote') {
  const connector = await s.store.add(name, {
    transport: 'http',
    url: s.fake.url,
    ...config,
  } as never);
  const { loginId, authUrl } = await s.oauth.login({ name });
  const page = await browse(authUrl);
  return { connector, loginId, authUrl: new URL(authUrl), page };
}

const tools = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: OAUTH_TOOL } };
const status = async (s: Setup, name = 'remote') =>
  (await s.store.list()).connectors.find((c) => c.name === name)?.oauth;

describe('WWW-Authenticate', () => {
  it('取 Bearer 挑战的 resource_metadata、scope 与 error，引号转义与多个挑战', () => {
    expect(
      parseBearerChallenge(
        'Basic realm="x", Bearer realm="a\\"b", resource_metadata="https://a.example/prm", scope="read write"',
      ),
    ).toEqual({ resourceMetadata: 'https://a.example/prm', scope: 'read write' });
    expect(parseBearerChallenge('Bearer error="insufficient_scope", scope="files:write"')).toEqual({
      error: 'insufficient_scope',
      scope: 'files:write',
    });
    // 重复的参数作废；不合语法的 scope 丢掉。
    expect(parseBearerChallenge('Bearer scope="a", scope="b"')).toEqual({});
    expect(parseBearerChallenge('Bearer scope="a\\"b"')).toEqual({});
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseBearerChallenge('Bearer realm="unterminated')).toBeUndefined();
  });
});

describe('授权服务器端点检查', () => {
  it('只认 https；连接器在本机时放行本机 http；不去本机与局域网', () => {
    expect(() => checkEndpoint('https://auth.example.com/token', 'public')).not.toThrow();
    for (const [url, scope] of [
      ['http://auth.example.com/token', 'public'],
      ['https://127.0.0.1/token', 'public'],
      ['https://10.0.0.1/token', 'loopback'],
      ['https://169.254.169.254/latest', 'loopback'],
      ['http://192.168.1.2/token', 'private'],
      ['https://user:pw@auth.example.com/token', 'public'],
      ['https://localhost/token', 'public'],
    ] as const)
      expect(() => checkEndpoint(url, scope), url).toThrow(OAuthHttpError);
    expect(() => checkEndpoint('http://127.0.0.1:9/token', 'loopback')).not.toThrow();
    expect(() => checkEndpoint('https://192.168.1.2/token', 'private')).not.toThrow();
  });
});

describe('发现', () => {
  it.each([
    ['WWW-Authenticate 的 resource_metadata', { resourceMetadata: 'header' }],
    ['没有 resource_metadata 时的 well-known', { resourceMetadata: 'wellknown' }],
    ['OIDC Discovery（issuer 带路径）', { asMetadata: 'oidc', issuerPath: '/tenant' }],
    ['没有受保护资源元数据时回退到 origin', { resourceMetadata: 'none' }],
  ] as const)('%s', async (_label, options) => {
    const s = await setup(options);
    const { page, authUrl } = await signIn(s);
    expect(page.status).toBe(200);
    expect(authUrl.searchParams.get('resource')).toBe(s.fake.url);
    expect(await status(s)).toMatchObject({ status: 'signed_in', issuer: s.fake.issuer });
  });

  it('加连接器时探测：要 OAuth 的记成 auth=oauth、要登录，不交给引擎；带 Authorization 头的不探测', async () => {
    const s = await setup();
    const connector = await s.store.add('remote', { transport: 'http', url: s.fake.url });
    expect(connector.config).toMatchObject({ auth: 'oauth' });
    expect(connector.oauth).toEqual({ status: 'required' });
    expect(await s.engine()).toBeUndefined();
    const before = s.fake.requests.length;
    const plain = await s.store.add('plain', {
      transport: 'http',
      url: s.fake.url,
      headers: { Authorization: 'Bearer user-token' },
    });
    expect(s.fake.requests.length).toBe(before);
    expect(plain.oauth).toBeUndefined();
    // 网络不通不挡添加。
    const down = await s.store.add('down', { transport: 'http', url: 'http://127.0.0.1:9/mcp' });
    expect(down.config).not.toHaveProperty('auth');
  });

  it('授权服务器不支持 S256 时拒绝；元数据的端点不安全时拒绝', async () => {
    const s = await setup({ s256: false });
    await s.store.add('remote', { transport: 'http', url: s.fake.url, auth: 'oauth' });
    await expect(s.oauth.login({ name: 'remote' })).rejects.toMatchObject({
      code: 'MCP_OAUTH_FAILED',
      data: { reason: 'pkce_unsupported' },
    });
    const t = await setup({ endpointOrigin: 'https://10.0.0.8' });
    await t.store.add('remote', { transport: 'http', url: t.fake.url, auth: 'oauth' });
    await expect(t.oauth.login({ name: 'remote' })).rejects.toMatchObject({
      data: { reason: 'insecure_endpoint' },
    });
  });

  it('服务器不要登录时回 not_supported', async () => {
    const server = createServer((_req, res) => res.writeHead(200).end('{}'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const s = await setup();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    await s.store.add('open', { transport: 'http', url, auth: 'oauth' });
    await expect(s.oauth.login({ name: 'open' })).rejects.toMatchObject({
      data: { reason: 'not_supported' },
    });
  });
});

describe('客户端注册', () => {
  it('配置的 clientId 与密钥（Basic），密钥存在密钥文件里、视图只有 true', async () => {
    const s = await setup({
      dcr: false,
      clients: [{ id: 'pre-client', secret: 'pre-secret-9c1' }],
    });
    const { page, connector } = await signIn(s, {
      auth: 'oauth',
      oauth: { clientId: 'pre-client', clientSecret: 'pre-secret-9c1' },
    });
    expect(page.status).toBe(200);
    expect(connector.config).toMatchObject({
      oauth: { clientId: 'pre-client', clientSecret: true },
    });
    expect(s.fake.tokenRequests[0]).toMatchObject({
      basic_client_id: 'pre-client',
      basic_client_secret: 'pre-secret-9c1',
    });
    expect(s.fake.registrations).toEqual([]);
    expect(readFileSync(join(s.home, 'plugins', 'registry.json'), 'utf8')).not.toContain(
      'pre-secret-9c1',
    );
    expect(readFileSync(join(s.home, 'secrets.json'), 'utf8')).toContain('pre-secret-9c1');
    expect(s.store.appToolSecrets()).toContain('pre-secret-9c1');
  });

  it('CIMD：授权服务器支持且回 iss 时用 Wevir 的元数据地址，不注册', async () => {
    const s = await setup(
      { cimd: true, issParam: true },
      { clientMetadataUrl: 'https://wevir.example/oauth/client.json' },
    );
    const { authUrl, page } = await signIn(s);
    expect(page.status).toBe(200);
    expect(authUrl.searchParams.get('client_id')).toBe('https://wevir.example/oauth/client.json');
    // 回 iss 的服务器用共用的 /callback。
    expect(new URL(authUrl.searchParams.get('redirect_uri') ?? '').pathname).toBe('/callback');
    expect(s.fake.registrations).toEqual([]);
  });

  it('CIMD 常量为空时跳过，改用动态注册（公开客户端）', async () => {
    const s = await setup({ cimd: true, issParam: true });
    const { authUrl } = await signIn(s);
    expect(s.fake.registrations).toEqual([
      expect.objectContaining({
        client_name: 'Wevir',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    ]);
    expect(authUrl.searchParams.get('client_id')).toMatch(/^dyn-/);
    // 不回 iss 的服务器用按服务器区分的回调路径。
    const t = await setup();
    const other = await signIn(t);
    expect(new URL(other.authUrl.searchParams.get('redirect_uri') ?? '').pathname).toMatch(
      /^\/callback\/[A-Za-z0-9_-]{12}$/,
    );
  });

  it('都没有时回 client_id_required', async () => {
    const s = await setup({ dcr: false });
    await s.store.add('remote', { transport: 'http', url: s.fake.url, auth: 'oauth' });
    await expect(s.oauth.login({ name: 'remote' })).rejects.toMatchObject({
      code: 'MCP_OAUTH_FAILED',
      data: { reason: 'client_id_required' },
    });
  });
});

describe('授权码与回调', () => {
  it('PKCE S256 与 resource：假服务器核对 code_verifier；scope 优先用挑战里的', async () => {
    const s = await setup({ challengeScope: 'read', scopesSupported: ['read', 'write', 'admin'] });
    const { authUrl } = await signIn(s, { oauth: { scopes: ['config-scope'] } });
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('scope')).toBe('read');
    expect(s.fake.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      resource: s.fake.url,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(await status(s)).toMatchObject({ status: 'signed_in', scopes: ['read'] });
  });

  it('state 不对的回调不算数，iss 不对的拒绝', async () => {
    const s = await setup({ issParam: true });
    await s.store.add('remote', { transport: 'http', url: s.fake.url });
    const { authUrl } = await s.oauth.login({ name: 'remote' });
    const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri') ?? '');
    const wrong = await fetch(`${redirect.href}?state=nope&code=x&iss=${s.fake.issuer}`);
    expect(wrong.status).toBe(400);
    expect(await status(s)).toMatchObject({ status: 'signing_in' });
    s.fake.nextAuthorize = { iss: 'https://evil.example' };
    const page = await browse(authUrl);
    expect(page.status).toBe(400);
    expect(await status(s)).toEqual({ status: 'error', error: 'issuer_mismatch' });
    expect(s.fake.tokenRequests).toEqual([]);
  });

  it('用户拒绝、超时、取消与重复登录取消旧的', async () => {
    const s = await setup({}, { loginTimeoutMs: 300 });
    await s.store.add('remote', { transport: 'http', url: s.fake.url });
    s.fake.nextAuthorize = { deny: true };
    const denied = await s.oauth.login({ name: 'remote' });
    expect((await browse(denied.authUrl)).status).toBe(400);
    expect(await status(s)).toEqual({ status: 'error', error: 'denied' });

    const timed = await s.oauth.login({ name: 'remote' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await status(s)).toEqual({ status: 'error', error: 'timeout' });
    await expect(
      fetch(new URL(timed.authUrl).searchParams.get('redirect_uri') ?? ''),
    ).rejects.toThrow();

    const first = await s.oauth.login({ name: 'remote' });
    const second = await s.oauth.login({ name: 'remote' });
    await expect(browse(first.authUrl)).rejects.toThrow();
    s.oauth.cancel(second.loginId);
    expect(await status(s)).toEqual({ status: 'required' });
    expect(() => s.oauth.cancel(second.loginId)).toThrow();
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 只有一个 OAuth 连接器的插件包。 */
function oauthPlugin(fake: FakeOAuthServer, oauth: Record<string, unknown>): string {
  homes += 1;
  const root = join(temp(), `plugin-${homes}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'wevir-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'tracker-kit',
      name: 'Tracker kit',
      version: '1.0.0',
      description: 'OAuth test plugin',
      author: { name: 'Wevir tests' },
      license: 'MIT',
      connectors: { tracker: { transport: 'http', url: fake.url, auth: 'oauth', oauth } },
    }),
  );
  return root;
}

describe('预注册客户端（GitHub、Slack、Google 的形状）', () => {
  it('清单里的公开 secret 不要求用户填、照样打码；固定 callbackUrl 原样用；authorizeParams 与 prompt=consent；PKCE 照带', async () => {
    const port = await freePort();
    const callbackUrl = `http://127.0.0.1:${port}/oauth/callback`;
    const s = await setup({
      dcr: false,
      clients: [{ id: 'wevir-app', secret: 'public-secret-5d2' }],
      registeredRedirects: [callbackUrl],
      tokenTtlSec: 3600,
    });
    const { plugin } = await s.store.installPlugin(
      oauthPlugin(s.fake, {
        clientId: 'wevir-app',
        clientSecret: 'public-secret-5d2',
        callbackUrl,
        authorizeParams: { access_type: 'offline' },
      }),
    );
    const view = (await s.store.list()).connectors.find((c) => c.id === plugin.connectors[0]);
    expect(view?.config).toMatchObject({
      oauth: {
        clientId: 'wevir-app',
        clientSecret: true,
        authorizeParams: { access_type: 'offline' },
      },
    });
    expect(view?.missingInputs).toBeUndefined();
    expect(view?.oauth).toEqual({ status: 'required' });

    const ref = { name: 'tracker', pluginId: 'tracker-kit' };
    const { authUrl } = await s.oauth.login(ref);
    const query = new URL(authUrl).searchParams;
    expect(query.get('redirect_uri')).toBe(callbackUrl);
    expect(query.get('access_type')).toBe('offline');
    expect(query.get('prompt')).toBe('consent');
    expect(query.get('code_challenge_method')).toBe('S256');
    expect((await browse(authUrl)).status).toBe(200);
    expect(s.fake.tokenRequests[0]).toMatchObject({
      basic_client_id: 'wevir-app',
      basic_client_secret: 'public-secret-5d2',
      redirect_uri: callbackUrl,
    });
    expect(s.fake.tokenRequests[0]?.code_verifier).toMatch(/^[\w-]{43}$/);
    expect((await s.engine('tracker-kit_tracker'))?.url).toContain('/mcp/remote/');
    expect(JSON.stringify(await s.store.engineConfig())).not.toContain('public-secret-5d2');
    expect(JSON.stringify(await s.store.list())).not.toContain('public-secret-5d2');
    expect(s.store.appToolSecrets()).toContain('public-secret-5d2');
    // 不算用户密钥：不进密钥文件。
    expect(readFileSync(join(s.home, 'secrets.json'), 'utf8')).not.toContain('public-secret-5d2');

    // 手上已经有刷新令牌：不再加 prompt=consent。
    const again = await s.oauth.login(ref);
    expect(new URL(again.authUrl).searchParams.get('prompt')).toBeNull();
    s.oauth.cancel(again.loginId);
  });

  it('固定回调的登录同一时间只有一个；写了 prompt 的照写的', async () => {
    const callbackUrl = `http://127.0.0.1:${await freePort()}/callback`;
    const s = await setup({ dcr: false, clients: [{ id: 'fixed' }] });
    const config = (authorizeParams?: Record<string, string>) =>
      ({
        transport: 'http',
        url: s.fake.url,
        auth: 'oauth',
        oauth: { clientId: 'fixed', callbackUrl, ...(authorizeParams && { authorizeParams }) },
      }) as const;
    await s.store.add('one', config({ access_type: 'offline', prompt: 'select_account' }));
    await s.store.add('two', config());
    const first = await s.oauth.login({ name: 'one' });
    expect(new URL(first.authUrl).searchParams.get('prompt')).toBe('select_account');
    const second = await s.oauth.login({ name: 'two' });
    expect(new URL(second.authUrl).searchParams.get('redirect_uri')).toBe(callbackUrl);
    expect(await status(s, 'one')).toEqual({ status: 'required' });
    expect(() => s.oauth.cancel(first.loginId)).toThrow('No such sign-in');
    expect((await browse(second.authUrl)).status).toBe(200);
    expect(await status(s, 'two')).toMatchObject({ status: 'signed_in' });
  });

  it('https 的 callbackUrl 是中转页：原样作为 redirect_uri，本机在 callbackPort 的 /callback 上接；没给端口时拒绝', async () => {
    const relay = 'https://relay.example/oauth/callback/';
    const port = await freePort();
    const s = await setup({
      dcr: false,
      clients: [{ id: 'slack-app' }],
      registeredRedirects: [relay],
    });
    const config = (callbackPort?: number) =>
      ({
        transport: 'http',
        url: s.fake.url,
        auth: 'oauth',
        oauth: { clientId: 'slack-app', callbackUrl: relay, ...(callbackPort && { callbackPort }) },
      }) as const;
    await s.store.add('noport', config());
    await expect(s.oauth.login({ name: 'noport' })).rejects.toThrow('needs callbackPort');

    await s.store.add('slack', config(port));
    const { authUrl } = await s.oauth.login({ name: 'slack' });
    expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe(relay);
    const authorize = await fetch(authUrl, { redirect: 'manual' });
    const location = new URL(authorize.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(relay);
    // 中转页做的事：查询串原样转到本机。别的路径不认。
    expect((await fetch(`http://127.0.0.1:${port}/oauth/callback/${location.search}`)).status).toBe(
      404,
    );
    const page = await fetch(`http://127.0.0.1:${port}/callback${location.search}`);
    expect(page.status).toBe(200);
    expect(s.fake.tokenRequests[0]).toMatchObject({ redirect_uri: relay });
    expect(await status(s, 'slack')).toMatchObject({ status: 'signed_in' });
  });

  it('GitHub 形状：不过期、没有刷新令牌、scope 逗号分隔、出错回 200；回调地址没写端口时随机取；被撤销后要重新登录', async () => {
    const s = await setup({
      dcr: false,
      clients: [{ id: 'gh-app', secret: 'gh-public' }],
      tokenShape: 'github',
      scopesSupported: ['repo', 'read:org'],
    });
    await s.store.add('remote', {
      transport: 'http',
      url: s.fake.url,
      auth: 'oauth',
      oauth: {
        clientId: 'gh-app',
        clientSecret: 'gh-public',
        callbackUrl: 'http://127.0.0.1/callback',
      },
    });
    s.fake.nextAuthorize = { badCode: true };
    const failed = await s.oauth.login({ name: 'remote' });
    expect(new URL(failed.authUrl).searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect((await browse(failed.authUrl)).status).toBe(502);
    expect(await status(s)).toEqual({ status: 'error', error: 'token_exchange_failed' });

    const { authUrl } = await s.oauth.login({ name: 'remote' });
    expect((await browse(authUrl)).status).toBe(200);
    expect(await status(s)).toEqual({
      status: 'signed_in',
      issuer: s.fake.issuer,
      scopes: ['repo', 'read:org'],
    });
    expect((await s.call(tools)).status).toBe(200);
    s.fake.revokeAllAccess();
    expect((await s.call(tools)).status).toBe(401);
    expect(s.fake.tokenRequests.some((r) => r.grant_type === 'refresh_token')).toBe(false);
    expect(await status(s)).toEqual({ status: 'required', error: 'refresh_failed' });
  });

  it('Slack 形状：受保护资源元数据只在根上；token_type user、scope 在 authed_user 里；刷新与出错回 200 的 ok:false', async () => {
    const callbackUrl = `http://127.0.0.1:${await freePort()}/slack/callback`;
    const s = await setup({
      resourceMetadata: 'root',
      dcr: false,
      clients: [{ id: 'slack-app', secret: 'slack-public' }],
      tokenShape: 'slack',
      tokenTtlSec: 3600,
      rotateRefresh: true,
      registeredRedirects: [callbackUrl],
      scopesSupported: ['channels:history', 'chat:write'],
    });
    const { page } = await signIn(s, {
      auth: 'oauth',
      oauth: { clientId: 'slack-app', clientSecret: 'slack-public', callbackUrl },
    });
    expect(page.status).toBe(200);
    expect(await status(s)).toMatchObject({
      status: 'signed_in',
      scopes: ['channels:history', 'chat:write'],
    });
    expect(s.fake.requests.map((r) => r.path)).toContain('/.well-known/oauth-protected-resource');

    s.fake.revokeAllAccess();
    expect((await s.call(tools)).status).toBe(200);
    expect(s.fake.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      basic_client_id: 'slack-app',
    });
    s.fake.revokeAllAccess();
    s.fake.refreshTokens.clear();
    expect((await s.call(tools)).status).toBe(401);
    expect(await status(s)).toEqual({ status: 'required', error: 'refresh_failed' });
  });
});

describe('令牌刷新', () => {
  it('快过期时先刷新，刷新令牌轮换后写盘', async () => {
    // 有效期 30 秒，不到 60 秒的余量：每次用之前都先刷新。
    const s = await setup({ tokenTtlSec: 30, rotateRefresh: true });
    await signIn(s);
    const response = await s.call(tools);
    expect(await response.json()).toMatchObject({
      result: { content: [{ text: 'OAUTH-TOOL-CALLED 1' }] },
    });
    const refreshes = s.fake.tokenRequests.filter((r) => r.grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    const stored = readFileSync(join(s.home, 'secrets.json'), 'utf8');
    const current = [...s.fake.refreshTokens];
    expect(current).toHaveLength(1);
    expect(stored).toContain(current[0]);
    expect(stored).not.toContain(refreshes[0]?.refresh_token);
  });

  it('上游回 401 时刷新一次再发；并发请求只刷新一次', async () => {
    const s = await setup({ tokenDelayMs: 100 });
    await signIn(s);
    expect((await s.call(tools)).status).toBe(200);
    s.fake.revokeAllAccess();
    const results = await Promise.all([1, 2, 3, 4].map(() => s.call(tools)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(s.fake.tokenRequests.filter((r) => r.grant_type === 'refresh_token')).toHaveLength(1);
  });

  it('invalid_grant 后变成要登录，并从引擎配置里拿掉', async () => {
    const s = await setup({ rejectRefresh: true });
    await signIn(s);
    expect(await s.engine()).toBeDefined();
    const config = await s.engine();
    s.fake.revokeAllAccess();
    const response = await fetch(config?.url ?? '', {
      method: 'POST',
      headers: { ...config?.headers, 'content-type': 'application/json' },
      body: JSON.stringify(tools),
    });
    expect(response.status).toBe(401);
    // 不把上游的 resource_metadata 交给引擎（否则它会自己去做 OAuth 发现）。
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await status(s)).toEqual({ status: 'required', error: 'refresh_failed' });
    expect(await s.engine()).toBeUndefined();
    expect(readFileSync(join(s.home, 'secrets.json'), 'utf8')).not.toContain('at-');
  });
});

describe('insufficient_scope', () => {
  it('403 原样回给引擎，连接器标成需要更多权限，重新登录带上合并的 scope', async () => {
    const s = await setup({ challengeScope: 'read' });
    await signIn(s);
    const response = await s.call({ ...tools, params: { name: SCOPED_TOOL } });
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
    await expect
      .poll(() => status(s))
      .toMatchObject({
        status: 'insufficient_scope',
        scopes: ['read', 'write'],
      });
    // 已登录的照样交给引擎（别的工具还能用）。
    expect(await s.engine()).toBeDefined();
    const { authUrl } = await s.oauth.login({ name: 'remote' });
    expect(new URL(authUrl).searchParams.get('scope')).toBe('read write');
    await browse(authUrl);
    expect((await s.call({ ...tools, params: { name: SCOPED_TOOL } })).status).toBe(200);
    expect(await status(s)).toMatchObject({ status: 'signed_in' });
  });
});

describe('代理', () => {
  it('Mcp-Session-Id 往返，DELETE，替换 Authorization，拒绝错的令牌、Origin 与 Host', async () => {
    const s = await setup();
    expect((await signIn(s)).page.status).toBe(200);
    const config = await s.engine();
    expect(config?.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/mcp/remote/con_`));
    const init = await s.call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    const session = init.headers.get('mcp-session-id');
    expect(session).toMatch(/^mcp-/);
    expect(s.fake.sessions.has(session ?? '')).toBe(true);
    const listed = await s.call(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': session ?? '', 'mcp-protocol-version': '2025-06-18' },
    );
    expect(((await listed.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(
      2,
    );
    const deleted = await fetch(config?.url ?? '', {
      method: 'DELETE',
      headers: { ...config?.headers, 'mcp-session-id': session ?? '' },
    });
    expect(deleted.status).toBe(200);
    expect(s.fake.deleted).toEqual([session]);
    const proxyToken = config?.headers?.Authorization ?? '';
    // 没带令牌的是添加时的探测与登录时的发现。
    const upstream = s.fake.requests
      .filter((r) => r.path === '/mcp' && r.authorization !== undefined)
      .map((r) => r.authorization);
    expect(upstream).toHaveLength(3);
    for (const value of upstream) {
      expect(value).toMatch(/^Bearer at-/);
      expect(value).not.toBe(proxyToken);
    }
    expect((await s.call(tools, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await s.call(tools, { origin: 'http://evil.example' })).status).toBe(403);
    const hostHeader = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        config?.url ?? '',
        { method: 'POST', headers: { ...config?.headers, host: `evil.example:${s.port}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    expect(hostHeader).toBe(403);
  });

  it('SSE 流式不缓冲，引擎断开时取消上游', async () => {
    const s = await setup();
    await signIn(s);
    const config = await s.engine();
    const controller = new AbortController();
    const response = await fetch(config?.url ?? '', {
      headers: { ...config?.headers, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': open')) text += decoder.decode((await reader.read()).value);
    s.fake.pushEvent('{"hello":1}');
    while (!text.includes('{"hello":1}')) text += decoder.decode((await reader.read()).value);
    controller.abort();
    await expect.poll(() => s.fake.sseClosed).toBe(1);
  });

  it('不跟随跨 origin 的跳转', async () => {
    const other = createServer((_req, res) => res.writeHead(200).end('{}'));
    let hits = 0;
    other.on('request', () => {
      hits += 1;
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
    const s = await setup();
    await signIn(s);
    s.fake.options.redirectMcpTo = `http://127.0.0.1:${(other.address() as AddressInfo).port}/mcp`;
    expect((await s.call(tools)).status).toBe(502);
    expect(hits).toBe(0);
  });
});

describe('令牌的去处', () => {
  it('不出现在视图、注册表、引擎配置与日志里；退出登录撤销并删干净；删连接器不留残余', async () => {
    const s = await setup();
    await signIn(s);
    await s.call(tools);
    const access = [...s.fake.accessTokens.keys()];
    const refresh = [...s.fake.refreshTokens];
    expect(access.length).toBeGreaterThan(0);
    const places = {
      list: JSON.stringify(await s.store.list()),
      registry: readFileSync(join(s.home, 'plugins', 'registry.json'), 'utf8'),
      engine: JSON.stringify(await s.store.engineConfig()),
      logs: s.logs.join('\n'),
    };
    for (const [place, text] of Object.entries(places))
      for (const token of [...access, ...refresh]) expect(text, place).not.toContain(token);
    expect(readFileSync(join(s.home, 'secrets.json'), 'utf8')).toContain(access[0]);
    expect(s.store.appToolSecrets()).toEqual(expect.arrayContaining([access[0], refresh[0]]));

    await s.oauth.logout({ name: 'remote' });
    expect(s.fake.revoked).toEqual(expect.arrayContaining([access[0], refresh[0]]));
    expect(await status(s)).toEqual({ status: 'required' });
    const secrets = readFileSync(join(s.home, 'secrets.json'), 'utf8');
    for (const token of [...access, ...refresh]) expect(secrets).not.toContain(token);
    expect(await s.engine()).toBeUndefined();

    const { connector } = await signIn(s, {}, 'second');
    await s.store.add('third', {
      transport: 'http',
      url: s.fake.url,
      oauth: { clientId: 'x', clientSecret: 'third-secret-77' },
    });
    await s.store.removeConnector(connector.id);
    const third = (await s.store.list()).connectors.find((c) => c.name === 'third');
    await s.store.removeConnector(third?.id ?? '');
    expect(JSON.parse(readFileSync(join(s.home, 'secrets.json'), 'utf8')).secrets).toEqual({});
  });

  it('改地址后之前的令牌作废', async () => {
    const s = await setup();
    const { connector } = await signIn(s);
    await s.store.update(connector.id, {
      config: { transport: 'http', url: `${s.fake.origin}/other` },
    });
    expect(await status(s)).toEqual({ status: 'required' });
    expect(JSON.parse(readFileSync(join(s.home, 'secrets.json'), 'utf8')).secrets).toEqual({});
  });

  it('重启后令牌还在、代理令牌换新，照常工作', async () => {
    const s = await setup();
    await signIn(s);
    const before = await s.engine();
    const restarted = await setup({}, {}, { home: s.home, fake: s.fake });
    const after = await restarted.engine();
    expect(after?.headers?.Authorization).toBeDefined();
    expect(after?.headers?.Authorization).not.toBe(before?.headers?.Authorization);
    expect(await status(restarted)).toMatchObject({ status: 'signed_in' });
    expect((await restarted.call(tools)).status).toBe(200);
    // 旧的代理令牌在新的进程里不认。
    expect(
      (await restarted.call(tools, { authorization: before?.headers?.Authorization ?? '' })).status,
    ).toBe(401);
  });
});
