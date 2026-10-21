// 测试用：一个进程里的假授权服务器 + 受 OAuth 保护的 Streamable HTTP MCP 服务（node:http）。按选项切换发现方式（WWW-Authenticate
// 的 resource_metadata、well-known、OIDC Discovery）、客户端注册方式（预注册、CIMD、动态注册）、PKCE、`iss`、令牌有效期与刷新令牌
// 轮换；记录收到的请求，测试据此核对 PKCE、`resource` 与令牌替换。

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const OAUTH_TOOL = 'oauth_echo';
export const SCOPED_TOOL = 'oauth_write';

export interface FakeOAuthOptions {
  /** 受保护资源元数据怎么发现：`header` 只在 401 的 WWW-Authenticate 里，`wellknown` 只在 well-known（带路径），`none` 没有（回退到 origin）。 */
  resourceMetadata?: 'header' | 'wellknown' | 'none';
  /** 授权服务器元数据在哪：`oauth` RFC 8414，`oidc` 只有 OpenID Connect Discovery。 */
  asMetadata?: 'oauth' | 'oidc';
  /** 授权服务器的 issuer 路径，如 `/tenant`。 */
  issuerPath?: string;
  s256?: boolean;
  dcr?: boolean;
  cimd?: boolean;
  /** 声明 authorization_response_iss_parameter_supported，回调带 iss。 */
  issParam?: boolean;
  /** 预注册的客户端。 */
  clients?: Array<{ id: string; secret?: string }>;
  /** 访问令牌有效期（秒）；省略不给 expires_in。 */
  tokenTtlSec?: number;
  /** 刷新时发新的刷新令牌，旧的作废。 */
  rotateRefresh?: boolean;
  /** 刷新令牌一律拒绝（invalid_grant）。 */
  rejectRefresh?: boolean;
  /** 401 挑战里的 scope。 */
  challengeScope?: string;
  /** 受保护资源元数据的 scopes_supported。 */
  scopesSupported?: string[];
  /** 换令牌延迟（毫秒），测并发刷新。 */
  tokenDelayMs?: number;
  /** 授权服务器元数据里的端点用这个 origin（测不安全地址）。 */
  endpointOrigin?: string;
  /** 带了有效令牌的 MCP 请求一律 307 到这个地址（测不跟随跨 origin 跳转）。 */
  redirectMcpTo?: string;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  method: string;
  resource: string | undefined;
  scope: string;
}

export interface FakeOAuthServer {
  url: string;
  origin: string;
  issuer: string;
  close(): Promise<void>;
  /** 收到的请求（方法、路径、Authorization 头）。 */
  requests: Array<{ method: string; path: string; authorization?: string; body?: string }>;
  tokenRequests: Array<Record<string, string>>;
  authorizeRequests: URLSearchParams[];
  registrations: Array<Record<string, unknown>>;
  revoked: string[];
  /** 发出去的访问令牌与刷新令牌。 */
  accessTokens: Map<string, { expiresAt: number; scope: string }>;
  refreshTokens: Set<string>;
  /** MCP 会话 ID 与 DELETE 过的会话。 */
  sessions: Set<string>;
  deleted: string[];
  /** 工具调用次数。 */
  toolCalls: number;
  /** 让下一次授权回调用这些参数（拒绝、错 iss 等）。 */
  nextAuthorize: { deny?: boolean; iss?: string } | undefined;
  /** 让所有访问令牌作废（测 401 后刷新重发）。 */
  revokeAllAccess(): void;
  /** SSE：打开的 GET 流写一个事件。 */
  pushEvent(data: string): void;
  /** SSE 流断开了几次（客户端取消）。 */
  sseClosed: number;
  options: FakeOAuthOptions;
}

export async function startFakeOAuth(options: FakeOAuthOptions = {}): Promise<FakeOAuthServer> {
  const grants = new Map<string, Grant>();
  const dynamicClients = new Set<string>();
  const streams = new Set<ServerResponse>();
  let origin = '';
  const issuerPath = options.issuerPath ?? '';
  const state: FakeOAuthServer = {
    url: '',
    origin: '',
    issuer: '',
    close: async () => {},
    requests: [],
    tokenRequests: [],
    authorizeRequests: [],
    registrations: [],
    revoked: [],
    accessTokens: new Map(),
    refreshTokens: new Set(),
    sessions: new Set(),
    deleted: [],
    toolCalls: 0,
    nextAuthorize: undefined,
    revokeAllAccess: () => state.accessTokens.clear(),
    pushEvent: (data) => {
      for (const stream of streams) stream.write(`event: message\ndata: ${data}\n\n`);
    },
    sseClosed: 0,
    options,
  };
  const endpoint = (path: string) => `${options.endpointOrigin ?? origin}${path}`;
  const metadata = () => ({
    issuer: state.issuer,
    authorization_endpoint: endpoint('/authorize'),
    token_endpoint: endpoint('/token'),
    revocation_endpoint: endpoint('/revoke'),
    ...(options.dcr !== false && { registration_endpoint: endpoint('/register') }),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    ...(options.s256 !== false && { code_challenge_methods_supported: ['S256'] }),
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    ...(options.cimd && { client_id_metadata_document_supported: true }),
    ...(options.issParam && { authorization_response_iss_parameter_supported: true }),
  });
  const resourceMetadata = () => ({
    resource: state.url,
    authorization_servers: [state.issuer],
    ...(options.scopesSupported && { scopes_supported: options.scopesSupported }),
  });

  const issue = (scope: string) => {
    const access = `at-${randomBytes(12).toString('hex')}`;
    const refresh = `rt-${randomBytes(12).toString('hex')}`;
    const ttl = options.tokenTtlSec;
    state.accessTokens.set(access, {
      expiresAt: ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttl * 1000,
      scope,
    });
    state.refreshTokens.add(refresh);
    return { access, refresh };
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const body = await readBody(req);
    state.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(req.headers.authorization !== undefined && { authorization: req.headers.authorization }),
      ...(body !== '' && { body }),
    });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res
        .writeHead(status, { 'content-type': 'application/json', ...headers })
        .end(JSON.stringify(value));
    };
    const path = url.pathname;
    // ── 受保护资源元数据 ──
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      if (options.resourceMetadata === 'none') return json(404, {});
      if (options.resourceMetadata === 'header' && path !== '/prm') return json(404, {});
      if (path === '/.well-known/oauth-protected-resource/mcp')
        return json(200, resourceMetadata());
      return json(404, {});
    }
    if (path === '/prm') return json(200, resourceMetadata());
    // ── 授权服务器元数据 ──
    if (path === `/.well-known/oauth-authorization-server${issuerPath}`)
      return options.asMetadata === 'oidc' ? json(404, {}) : json(200, metadata());
    if (
      path === `/.well-known/openid-configuration${issuerPath}` ||
      (issuerPath !== '' && path === `${issuerPath}/.well-known/openid-configuration`)
    )
      return options.asMetadata === 'oidc' ? json(200, metadata()) : json(404, {});
    if (path === '/register') {
      const request = JSON.parse(body) as Record<string, unknown>;
      state.registrations.push(request);
      const id = `dyn-${randomBytes(6).toString('hex')}`;
      dynamicClients.add(id);
      return json(201, { client_id: id, token_endpoint_auth_method: 'none', ...request });
    }
    if (path === '/authorize') {
      const params = url.searchParams;
      state.authorizeRequests.push(params);
      const redirect = new URL(params.get('redirect_uri') ?? '');
      const next = state.nextAuthorize;
      state.nextAuthorize = undefined;
      redirect.searchParams.set('state', params.get('state') ?? '');
      if (next?.iss !== undefined) redirect.searchParams.set('iss', next.iss);
      else if (options.issParam) redirect.searchParams.set('iss', state.issuer);
      if (next?.deny) redirect.searchParams.set('error', 'access_denied');
      else {
        const code = `code-${randomBytes(8).toString('hex')}`;
        grants.set(code, {
          clientId: params.get('client_id') ?? '',
          redirectUri: params.get('redirect_uri') ?? '',
          challenge: params.get('code_challenge') ?? '',
          method: params.get('code_challenge_method') ?? '',
          resource: params.get('resource') ?? undefined,
          scope: params.get('scope') ?? '',
        });
        redirect.searchParams.set('code', code);
      }
      res.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (path === '/token') {
      const params = Object.fromEntries(new URLSearchParams(body));
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':')
        : undefined;
      state.tokenRequests.push({
        ...params,
        ...(basic && { basic_client_id: decodeURIComponent(basic[0] ?? '') }),
        ...(basic && { basic_client_secret: decodeURIComponent(basic[1] ?? '') }),
      });
      if (options.tokenDelayMs) await new Promise((r) => setTimeout(r, options.tokenDelayMs));
      if (params.grant_type === 'authorization_code') {
        const grant = grants.get(params.code ?? '');
        grants.delete(params.code ?? '');
        const verifier = params.code_verifier ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          grant?.method !== 'S256' ||
          grant.challenge !== challenge ||
          grant.redirectUri !== params.redirect_uri ||
          grant.resource !== params.resource
        )
          return json(400, { error: 'invalid_grant' });
        const configured = options.clients?.find((client) => client.id === grant.clientId);
        const secret =
          basic?.[1] !== undefined ? decodeURIComponent(basic[1]) : params.client_secret;
        if (configured?.secret !== undefined && configured.secret !== secret)
          return json(401, { error: 'invalid_client' });
        const { access, refresh } = issue(grant.scope);
        return json(200, {
          access_token: access,
          token_type: 'Bearer',
          refresh_token: refresh,
          ...(options.tokenTtlSec !== undefined && { expires_in: options.tokenTtlSec }),
          ...(grant.scope !== '' && { scope: grant.scope }),
        });
      }
      if (params.grant_type === 'refresh_token') {
        const refresh = params.refresh_token ?? '';
        if (options.rejectRefresh || !state.refreshTokens.has(refresh))
          return json(400, { error: 'invalid_grant' });
        const { access, refresh: rotated } = issue('');
        state.refreshTokens.delete(rotated);
        if (options.rotateRefresh) {
          state.refreshTokens.delete(refresh);
          state.refreshTokens.add(rotated);
        }
        return json(200, {
          access_token: access,
          token_type: 'bearer',
          ...(options.rotateRefresh && { refresh_token: rotated }),
          ...(options.tokenTtlSec !== undefined && { expires_in: options.tokenTtlSec }),
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (path === '/revoke') {
      const params = new URLSearchParams(body);
      state.revoked.push(params.get('token') ?? '');
      res.writeHead(200).end();
      return;
    }
    // ── 受保护的 MCP 服务 ──
    if (path === '/mcp') {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      const grant = token === undefined ? undefined : state.accessTokens.get(token);
      if (!grant || grant.expiresAt <= Date.now()) {
        const params = [
          ...(options.resourceMetadata !== 'wellknown' && options.resourceMetadata !== 'none'
            ? [`resource_metadata="${origin}/prm"`]
            : []),
          ...(options.challengeScope ? [`scope="${options.challengeScope}"`] : []),
        ];
        res
          .writeHead(401, {
            'www-authenticate': `Bearer realm="fake"${params.length ? `, ${params.join(', ')}` : ''}`,
          })
          .end();
        return;
      }
      if (options.redirectMcpTo !== undefined) {
        res.writeHead(307, { location: options.redirectMcpTo }).end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.flushHeaders();
        streams.add(res);
        res.write(': open\n\n');
        res.on('close', () => {
          streams.delete(res);
          state.sseClosed += 1;
        });
        return;
      }
      if (req.method === 'DELETE') {
        state.deleted.push(String(req.headers['mcp-session-id']));
        res.writeHead(200).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        json(200, { jsonrpc: '2.0', id: message.id, result }, headers);
      if (message.method === 'initialize') {
        const session = `mcp-${randomBytes(6).toString('hex')}`;
        state.sessions.add(session);
        return reply(
          {
            protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-oauth', version: '0.0.0' },
          },
          { 'mcp-session-id': session },
        );
      }
      if (message.method === 'tools/list')
        return reply({
          tools: [
            {
              name: OAUTH_TOOL,
              description: 'Echo through OAuth.',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: SCOPED_TOOL,
              description: 'Needs write scope.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      if (message.method === 'tools/call') {
        if (message.params?.name === SCOPED_TOOL && !grant.scope.split(' ').includes('write')) {
          res
            .writeHead(403, {
              'www-authenticate': 'Bearer error="insufficient_scope", scope="read write"',
            })
            .end();
          return;
        }
        state.toolCalls += 1;
        return reply({ content: [{ type: 'text', text: `OAUTH-TOOL-CALLED ${state.toolCalls}` }] });
      }
      return reply({});
    }
    res.writeHead(404).end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.origin = origin;
  state.url = `${origin}/mcp`;
  state.issuer = options.resourceMetadata === 'none' ? origin : `${origin}${issuerPath}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 模拟浏览器：打开授权地址，跟着跳到 Host 的回调地址，返回回调页。 */
export async function browse(authUrl: string): Promise<{ status: number; body: string }> {
  const authorize = await fetch(authUrl, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (location === null) throw new Error(`authorize answered ${authorize.status}`);
  const callback = await fetch(location, { headers: { 'accept-language': 'en' } });
  return { status: callback.status, body: await callback.text() };
}
