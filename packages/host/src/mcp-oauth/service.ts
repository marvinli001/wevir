// 远程 MCP 服务的 OAuth（0.97.0，docs plugins.md「OAuth」）：发现授权服务器、选客户端（配置的 clientId → CIMD → 动态注册）、
// 浏览器授权码 + PKCE、保存与刷新令牌。令牌只在 Host：访问令牌、刷新令牌与客户端密钥存在 SecretStore，注册表只存元数据；引擎拿到的是
// 本机代理地址（proxy.ts）与 Host 每次启动新发的代理令牌。设计照 Codex 的 rmcp-client（perform_oauth_login.rs、
// oauth_client_registration.rs、oauth_callback.rs、oauth/refresh_lock.rs），写法是 Wevir 自己的。

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type ConnectorOAuth,
  type McpOAuthConfig,
  OAUTH_RESERVED_AUTHORIZE_PARAMS,
} from '@wevir/protocol';
import type { EngineMcpConfig } from '@wevir/runtime-adapter';
import type { SecretStore } from '@wevir/storage';
import { HostError } from '../errors.js';
import { type CallbackServer, callbackPage, listenCallback } from './callback.js';
import {
  type ClientAuthMethod,
  type ClientCredentials,
  callbackId,
  configuredAuthMethod,
  pkcePair,
  randomState,
  registerClient,
  revokeToken,
  TokenEndpointError,
  type TokenSet,
  tokenRequest,
} from './client.js';
import {
  type Discovery,
  discover,
  type OAuthFailure,
  OAuthLoginError,
  probe,
} from './discovery.js';
import {
  type AddressScope,
  checkEndpoint,
  isLoopbackHost,
  OAuthHttpError,
  scopeOf,
} from './http.js';

/**
 * Wevir 自己的 Client ID Metadata Document 地址（CIMD）。文件要由维护者托管在固定的 https 地址上，内容见 docs plugins.md「OAuth」；
 * 为空时跳过 CIMD，直接试动态注册。
 */
export const WEVIR_OAUTH_CLIENT_METADATA_URL = '';
/** 等浏览器回调的时间（照 Codex 的默认 300 秒）。 */
export const MCP_OAUTH_LOGIN_TIMEOUT_MS = 300_000;
/** 访问令牌剩下不到这么久时先刷新。 */
export const MCP_OAUTH_REFRESH_SKEW_MS = 60_000;
/** https 中转回调（`callbackUrl` 是 https 时）转到的本机路径：`http://127.0.0.1:<callbackPort>/callback`。 */
export const RELAY_CALLBACK_PATH = '/callback';
/** 本机代理的路径前缀：`/mcp/remote/<连接器 ID>`。 */
export const MCP_REMOTE_PATH = '/mcp/remote/';

export const tokenRef = (id: string) => `mcp-oauth:token:${id}`;
export const clientSecretRef = (id: string) => `mcp-oauth:client-secret:${id}`;
const registeredSecretRef = (issuer: string, redirectUri: string) =>
  `mcp-oauth:client:${createHash('sha256').update(`${issuer}\n${redirectUri}`).digest('hex').slice(0, 32)}`;

/** 注册表里一个连接器的 OAuth 元数据（不含令牌）。没有这项就是没登录。 */
export interface StoredOAuth {
  status: 'signed_in' | 'insufficient_scope';
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  registration: 'configured' | 'cimd' | 'dynamic';
  authMethod: ClientAuthMethod;
  /** 动态注册拿到的客户端密钥在密钥文件里的键。 */
  clientSecretRef?: string;
  resource: string;
  /** 授予的 scope。 */
  scopes?: string[];
  /** 服务器回 `insufficient_scope` 时要的 scope。 */
  requiredScopes?: string[];
}
/** 动态注册的客户端，按（issuer，重定向地址）复用。 */
export interface StoredOAuthClient {
  issuer: string;
  redirectUri: string;
  clientId: string;
  authMethod: ClientAuthMethod;
  clientSecretRef?: string;
}

/** 交给 OAuth 的连接器：配置已展开占位符。 */
export interface OAuthTarget {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  headers: Record<string, string>;
  auth?: 'oauth' | 'none';
  oauth?: McpOAuthConfig;
  /** 散装连接器的 `clientSecret` 存在密钥文件里（`clientSecretRef(id)`）。 */
  clientSecretStored: boolean;
  stored?: StoredOAuth;
}
export interface OAuthTargetRef {
  name: string;
  workspaceId?: string;
  pluginId?: string;
}

/** 注册表给 OAuth 的接口（plugins.ts 实现）。 */
export interface OAuthRegistry {
  target(ref: OAuthTargetRef): OAuthTarget | undefined;
  targetById(id: string): OAuthTarget | undefined;
  /** 全部 http 连接器。 */
  targets(): OAuthTarget[];
  /** 改一个连接器的 OAuth 元数据；`auth` 给了就一并写进配置。之后发 `plugins.changed` 并重载引擎配置。 */
  setOAuth(
    id: string,
    update: (stored: StoredOAuth | undefined) => StoredOAuth | undefined,
    auth?: 'oauth',
  ): Promise<void>;
  oauthClient(issuer: string, redirectUri: string): StoredOAuthClient | undefined;
  saveOAuthClient(client: StoredOAuthClient): Promise<void>;
  /** 只通知客户端重读（登录中、失败等不落盘的状态）。 */
  changed(): void;
}

interface Login {
  loginId: string;
  connectorId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  expectedPath: string;
  issuerBound: boolean;
  discovery: Discovery;
  client: ClientCredentials;
  registration: StoredOAuth['registration'];
  clientSecretRef?: string;
  scopes: string[];
  scope: AddressScope;
  callback: CallbackServer;
  /** 用配置的固定回调地址（没有按服务器区分的路径）：这样的登录同一时间只能有一个。 */
  fixedCallback: boolean;
  timer: NodeJS.Timeout;
  done: boolean;
}

export interface McpOAuthOptions {
  secrets: SecretStore;
  /** 每个令牌值都交给它（日志打码）。 */
  onSecret?: (value: string) => void;
  onWarning?: (message: string) => void;
  clientMetadataUrl?: string;
  loginTimeoutMs?: number;
  now?: () => number;
  /** 测试用：换掉 DNS 解析。 */
  lookup?: typeof dnsLookup;
}

const failed = (reason: OAuthFailure, message: string) =>
  new HostError('MCP_OAUTH_FAILED', message, { reason });
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const unique = (items: Iterable<string>) => [...new Set([...items].filter((item) => item !== ''))];
/** 刷新时服务器回这些错误码说明刷新令牌不能再用了，要重新登录。 */
const TRANSIENT_OAUTH_ERRORS = new Set(['temporarily_unavailable', 'server_error', 'slow_down']);

export function isOAuthConfig(config: { transport: string; auth?: string }): boolean {
  return config.transport === 'http' && config.auth === 'oauth';
}
export function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization');
}

export class McpOAuthService {
  readonly #options: McpOAuthOptions;
  #registry: OAuthRegistry | undefined;
  readonly #tokens = new Map<string, TokenSet>();
  /** 客户端密钥：键是密钥文件里的键。 */
  readonly #clientSecrets = new Map<string, string>();
  readonly #refreshing = new Map<string, Promise<TokenSet | undefined>>();
  readonly #logins = new Map<string, Login>();
  readonly #loginOf = new Map<string, string>();
  readonly #errors = new Map<string, OAuthFailure>();
  readonly #proxyTokens = new Map<string, string>();
  readonly #proxyIds = new Map<string, string>();
  #port: number | undefined;

  constructor(options: McpOAuthOptions) {
    this.#options = options;
  }

  get #now(): number {
    return (this.#options.now ?? Date.now)();
  }
  get #reg(): OAuthRegistry {
    if (!this.#registry) throw new Error('MCP OAuth is not bound to the plugin registry');
    return this.#registry;
  }

  bind(registry: OAuthRegistry): void {
    this.#registry = registry;
  }

  /** 启动时读回已登录连接器的令牌与客户端密钥。 */
  async load(): Promise<void> {
    for (const target of this.#reg.targets()) {
      if (target.clientSecretStored) await this.#readSecret(clientSecretRef(target.id));
      if (target.stored?.clientSecretRef) await this.#readSecret(target.stored.clientSecretRef);
      if (!target.stored) continue;
      const raw = await this.#options.secrets.get(tokenRef(target.id));
      const tokens = raw === undefined ? undefined : parseTokens(raw);
      if (tokens) this.#remember(target.id, tokens);
    }
  }

  async #readSecret(ref: string): Promise<string | undefined> {
    const cached = this.#clientSecrets.get(ref);
    if (cached !== undefined) return cached;
    const value = await this.#options.secrets.get(ref);
    if (value !== undefined) {
      this.#clientSecrets.set(ref, value);
      this.#options.onSecret?.(value);
    }
    return value;
  }

  #remember(id: string, tokens: TokenSet): void {
    this.#tokens.set(id, tokens);
    this.#options.onSecret?.(tokens.accessToken);
    if (tokens.refreshToken) this.#options.onSecret?.(tokens.refreshToken);
  }

  /** RPC 服务开始监听后调用：代理在同一个端口上。 */
  setPort(port: number): void {
    this.#port = port;
  }

  // ── 注册表用 ─────────────────────────────────────────────────────────────────

  /** 视图里的登录状态；不用 OAuth 的连接器返回 undefined。 */
  view(
    id: string,
    config: { transport: string; auth?: string },
    stored?: StoredOAuth,
  ): ConnectorOAuth | undefined {
    if (!isOAuthConfig(config)) return undefined;
    if (this.#loginOf.has(id))
      return { status: 'signing_in', ...(stored && { issuer: stored.issuer }) };
    const tokens = this.#tokens.get(id);
    const error = this.#errors.get(id);
    if (stored && tokens) {
      const insufficient = stored.status === 'insufficient_scope';
      const scopes = insufficient ? stored.requiredScopes : stored.scopes;
      return {
        status: insufficient ? 'insufficient_scope' : 'signed_in',
        issuer: stored.issuer,
        ...(scopes !== undefined && scopes.length > 0 && { scopes }),
        ...(tokens.expiresAt !== undefined && {
          expiresAt: new Date(tokens.expiresAt).toISOString(),
        }),
      };
    }
    if (error !== undefined && error !== 'refresh_failed') return { status: 'error', error };
    return { status: 'required', ...(error !== undefined && { error }) };
  }

  /**
   * 交给引擎的配置：不用 OAuth 的返回 undefined（照原样交），没登录或代理还没开的返回 null（不交），已登录的换成本机代理地址与
   * 代理令牌。
   */
  engineConfig(
    id: string,
    config: { transport: string; auth?: string; toolTimeoutSec?: number },
    enabled: boolean,
  ): EngineMcpConfig | null | undefined {
    if (!isOAuthConfig(config)) return undefined;
    if (this.#port === undefined || !this.#tokens.has(id)) return null;
    return {
      transport: 'http',
      url: `http://127.0.0.1:${this.#port}${MCP_REMOTE_PATH}${encodeURIComponent(id)}`,
      headers: { Authorization: `Bearer ${this.#proxyToken(id)}` },
      enabled,
      ...(config.toolTimeoutSec !== undefined && { toolTimeoutSec: config.toolTimeoutSec }),
    };
  }

  #proxyToken(id: string): string {
    let token = this.#proxyTokens.get(id);
    if (token === undefined) {
      token = randomBytes(32).toString('base64url');
      this.#proxyTokens.set(id, token);
      this.#proxyIds.set(digest(token), id);
      this.#options.onSecret?.(token);
    }
    return token;
  }

  /** 进程内打码用：令牌、客户端密钥与代理令牌。 */
  secrets(): string[] {
    return unique([
      ...[...this.#tokens.values()].flatMap((tokens) => [
        tokens.accessToken,
        ...(tokens.refreshToken ? [tokens.refreshToken] : []),
      ]),
      ...this.#clientSecrets.values(),
      ...this.#proxyTokens.values(),
    ]);
  }

  /** 散装连接器的客户端密钥：给值就存，null 删除。 */
  async setClientSecret(id: string, value: string | null): Promise<void> {
    const ref = clientSecretRef(id);
    if (value === null) {
      await this.#options.secrets.delete(ref);
      this.#clientSecrets.delete(ref);
      return;
    }
    await this.#options.secrets.set(ref, value);
    this.#clientSecrets.set(ref, value);
    this.#options.onSecret?.(value);
  }

  /** 连接器删掉了（或地址、客户端变了，`tokensOnly`）：取消登录，删掉本机的令牌与客户端密钥。 */
  async forget(ids: Iterable<string>, tokensOnly = false): Promise<void> {
    for (const id of ids) {
      const loginId = this.#loginOf.get(id);
      if (loginId !== undefined) this.#finish(this.#logins.get(loginId), undefined);
      this.#tokens.delete(id);
      this.#errors.delete(id);
      await this.#options.secrets.delete(tokenRef(id)).catch(() => false);
      if (!tokensOnly) {
        this.#clientSecrets.delete(clientSecretRef(id));
        await this.#options.secrets.delete(clientSecretRef(id)).catch(() => false);
        const token = this.#proxyTokens.get(id);
        if (token !== undefined) this.#proxyIds.delete(digest(token));
        this.#proxyTokens.delete(id);
      }
    }
  }

  /**
   * 加连接器时探测要不要 OAuth：回 401 且能发现授权服务器时返回 `oauth`；不要登录、网络不通或认不出时返回 undefined（照旧，下次启动再判断）。
   */
  async detect(url: string, headers: Record<string, string> = {}): Promise<'oauth' | undefined> {
    try {
      const probed = await probe(url, headers, this.#lookup);
      if (probed.status !== 401) return undefined;
      await discover(url, headers, { scope: scopeOf(url), known: probed, ...this.#lookup });
      return 'oauth';
    } catch {
      return undefined;
    }
  }

  get #lookup(): { lookup?: typeof dnsLookup } {
    return this.#options.lookup ? { lookup: this.#options.lookup } : {};
  }

  /** 启动后在后台把还没判断过的 http 连接器探测一遍（没带 Authorization 头的）。 */
  async detectAll(): Promise<void> {
    for (const target of this.#reg.targets()) {
      if (target.auth !== undefined || hasAuthorizationHeader(target.headers)) continue;
      if ((await this.detect(target.url, target.headers)) === 'oauth')
        await this.#reg.setOAuth(target.id, (stored) => stored, 'oauth').catch(() => {});
    }
  }

  // ── 登录 ────────────────────────────────────────────────────────────────────

  async login(
    ref: OAuthTargetRef,
    scopes: string[] = [],
  ): Promise<{ loginId: string; authUrl: string }> {
    const target = this.#reg.target(ref);
    if (!target) throw new HostError('INVALID_PARAMS', 'MCP server not found', notFound);
    if (target.auth === 'none' || hasAuthorizationHeader(target.headers))
      throw failed('not_supported', 'This MCP server is set up without OAuth');
    this.#cancelFor(target.id);
    this.#errors.delete(target.id);
    const scope = scopeOf(target.url);
    const oauth = target.oauth ?? {};
    const fixedCallback = oauth.callbackUrl !== undefined;
    let discovery: Discovery;
    try {
      discovery = await discover(target.url, target.headers, { scope, ...this.#lookup });
    } catch (error) {
      throw toHostError(error);
    }
    if (oauth.resource !== undefined) discovery.resource = oauth.resource;
    const metadata = discovery.metadata;
    if (!metadata.code_challenge_methods_supported?.includes('S256'))
      throw failed('pkce_unsupported', 'The authorization server does not support PKCE with S256');
    try {
      checkEndpoint(metadata.authorization_endpoint, scope);
      checkEndpoint(metadata.token_endpoint, scope);
    } catch (error) {
      throw toHostError(error);
    }
    const issuerBound =
      metadata.authorization_response_iss_parameter_supported === true &&
      metadata.issuer !== undefined;
    // 回调地址：授权服务器回 `iss` 时用共用的 /callback，否则加上按服务器区分的一段（RFC 9700 §4.4）。配置了 callbackUrl 的
    // 原样用（Slack、Google 要求与注册的完全一致），防混淆靠 state 与同一时间只有一个这样的登录。
    // https 的 callbackUrl 是中转页（Slack 公开分发要求 https 回调）：它把查询串原样转到本机
    // `http://127.0.0.1:<callbackPort>/callback`，所以这时必须给 callbackPort，本机只认 /callback。
    const base = new URL(oauth.callbackUrl ?? 'http://127.0.0.1/callback');
    const relayed = base.protocol === 'https:' && !isLoopbackHost(base.hostname);
    if (relayed && oauth.callbackPort === undefined)
      throw failed('callback_unavailable', 'An https callback URL needs callbackPort');
    if (!relayed && (base.protocol !== 'http:' || !isLoopbackHost(base.hostname)))
      throw failed(
        'callback_unavailable',
        'The callback URL must be a loopback http URL or an https relay',
      );
    if (!issuerBound && !fixedCallback) {
      const id = callbackId(target.url);
      if (base.pathname.split('/').at(-1) !== id)
        base.pathname = `${base.pathname.replace(/\/$/, '')}/${id}`;
    }
    for (const other of [...this.#logins.values()])
      if (fixedCallback || other.fixedCallback) this.#finish(other, undefined);
    const login = { loginId: `login_${randomUUID()}` } as Login;
    let callback: CallbackServer;
    try {
      callback = await listenCallback(
        oauth.callbackPort ?? (base.port === '' ? 0 : Number(base.port)),
        (req, res) => void this.#callback(login, req, res),
      );
    } catch (error) {
      throw failed(
        'callback_unavailable',
        `Could not open the sign-in callback port: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (!relayed && base.port === '') base.port = String(callback.port);
      const redirectUri = base.href;
      const client = await this.#chooseClient(target, discovery, redirectUri, issuerBound, scope);
      const stored = target.stored;
      const requested = unique([
        ...(discovery.challengeScopes ?? oauth.scopes ?? discovery.resourceScopes ?? []),
        ...scopes,
        ...(stored?.status === 'insufficient_scope'
          ? [...(stored.scopes ?? []), ...(stored.requiredScopes ?? [])]
          : []),
      ]);
      const { verifier, challenge } = pkcePair();
      const state = randomState();
      const authUrl = new URL(metadata.authorization_endpoint);
      const extra = authorizeParams(oauth, this.#tokens.get(target.id));
      for (const [key, value] of Object.entries({
        ...extra,
        response_type: 'code',
        client_id: client.credentials.clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        resource: discovery.resource,
        ...(requested.length > 0 && { scope: requested.join(' ') }),
      }))
        authUrl.searchParams.set(key, value);
      Object.assign(login, {
        connectorId: target.id,
        state,
        verifier,
        redirectUri,
        expectedPath: relayed ? RELAY_CALLBACK_PATH : base.pathname,
        issuerBound,
        discovery,
        client: client.credentials,
        registration: client.registration,
        ...(client.secretRef !== undefined && { clientSecretRef: client.secretRef }),
        scopes: requested,
        scope,
        callback,
        fixedCallback,
        done: false,
        timer: setTimeout(
          () => this.#finish(login, 'timeout'),
          this.#options.loginTimeoutMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS,
        ),
      } satisfies Omit<Login, 'loginId'>);
      login.timer.unref?.();
      this.#logins.set(login.loginId, login);
      this.#loginOf.set(target.id, login.loginId);
      this.#reg.changed();
      return { loginId: login.loginId, authUrl: authUrl.href };
    } catch (error) {
      callback.close();
      throw toHostError(error);
    }
  }

  async #chooseClient(
    target: OAuthTarget,
    discovery: Discovery,
    redirectUri: string,
    issuerBound: boolean,
    scope: AddressScope,
  ): Promise<{
    credentials: ClientCredentials;
    registration: StoredOAuth['registration'];
    secretRef?: string;
  }> {
    const metadata = discovery.metadata;
    const oauth = target.oauth ?? {};
    if (oauth.clientId !== undefined && oauth.clientId !== '') {
      const secret = await this.#configuredSecret(target);
      const authMethod = configuredAuthMethod(
        secret,
        metadata.token_endpoint_auth_methods_supported,
      );
      return {
        credentials: {
          clientId: oauth.clientId,
          authMethod,
          ...(authMethod !== 'none' && secret !== undefined && { clientSecret: secret }),
        },
        registration: 'configured',
      };
    }
    // CIMD：授权服务器声明支持、接受公开客户端，且用共用的回环回调（文件里只能写一个固定的 redirect_uri）。
    const cimd = this.#options.clientMetadataUrl ?? WEVIR_OAUTH_CLIENT_METADATA_URL;
    if (
      cimd !== '' &&
      metadata.client_id_metadata_document_supported === true &&
      metadata.token_endpoint_auth_methods_supported?.includes('none') === true &&
      issuerBound &&
      target.oauth?.callbackUrl === undefined
    )
      return { credentials: { clientId: cimd, authMethod: 'none' }, registration: 'cimd' };
    if (metadata.registration_endpoint !== undefined) {
      const cached = this.#reg.oauthClient(discovery.issuer, redirectUri);
      if (cached) {
        const secret = cached.clientSecretRef
          ? await this.#readSecret(cached.clientSecretRef)
          : undefined;
        if (!cached.clientSecretRef || secret !== undefined)
          return {
            credentials: {
              clientId: cached.clientId,
              authMethod: cached.authMethod,
              ...(secret !== undefined && { clientSecret: secret }),
            },
            registration: 'dynamic',
            ...(cached.clientSecretRef && { secretRef: cached.clientSecretRef }),
          };
      }
      const credentials = await registerClient(metadata.registration_endpoint, redirectUri, {
        scope,
        ...this.#lookup,
      });
      let secretRef: string | undefined;
      if (credentials.clientSecret !== undefined) {
        secretRef = registeredSecretRef(discovery.issuer, redirectUri);
        await this.#options.secrets.set(secretRef, credentials.clientSecret);
        this.#clientSecrets.set(secretRef, credentials.clientSecret);
        this.#options.onSecret?.(credentials.clientSecret);
      }
      await this.#reg.saveOAuthClient({
        issuer: discovery.issuer,
        redirectUri,
        clientId: credentials.clientId,
        authMethod: credentials.authMethod,
        ...(secretRef !== undefined && { clientSecretRef: secretRef }),
      });
      return {
        credentials,
        registration: 'dynamic',
        ...(secretRef !== undefined && { secretRef }),
      };
    }
    throw failed(
      'client_id_required',
      'The authorization server needs a client ID: it supports neither client metadata documents nor dynamic registration',
    );
  }

  async #callback(login: Login, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== login.expectedPath || login.done) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const query = url.searchParams;
    // state 不对的请求不算这次登录的回调（可能是别的页面撞上来的），继续等。
    if (query.get('state') !== login.state) {
      callbackPage(req, res, 400, { ok: false, reason: 'state_mismatch' });
      return;
    }
    const issuer = login.discovery.metadata.issuer;
    const iss = query.get('iss');
    // RFC 9207 §2.4：声明了支持的必须带且相同；没声明但带了的也要相同。
    if (
      (login.issuerBound && iss !== issuer) ||
      (iss !== null && issuer !== undefined && iss !== issuer)
    ) {
      callbackPage(req, res, 400, { ok: false, reason: 'issuer_mismatch' });
      this.#finish(login, 'issuer_mismatch');
      return;
    }
    const error = query.get('error');
    if (error !== null) {
      const reason = error === 'access_denied' ? 'denied' : 'authorization_failed';
      callbackPage(req, res, 400, { ok: false, reason });
      this.#finish(login, reason);
      return;
    }
    const code = query.get('code');
    if (code === null || code === '') {
      callbackPage(req, res, 400, { ok: false, reason: 'authorization_failed' });
      this.#finish(login, 'authorization_failed');
      return;
    }
    login.done = true;
    clearTimeout(login.timer);
    try {
      const tokens = await tokenRequest(
        login.discovery.metadata.token_endpoint,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: login.redirectUri,
          code_verifier: login.verifier,
          resource: login.discovery.resource,
        },
        login.client,
        {
          scope: login.scope,
          ...this.#lookup,
          ...(this.#options.now && { now: this.#options.now }),
        },
      );
      await this.#signedIn(login, tokens);
      callbackPage(req, res, 200, { ok: true });
      this.#finish(login, undefined);
    } catch (error) {
      this.#options.onWarning?.(
        `MCP OAuth token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      callbackPage(req, res, 502, { ok: false, reason: 'token_exchange_failed' });
      this.#finish(login, 'token_exchange_failed');
    }
  }

  async #signedIn(login: Login, tokens: TokenSet): Promise<void> {
    const id = login.connectorId;
    if (!this.#reg.targetById(id)) return;
    await this.#options.secrets.set(tokenRef(id), JSON.stringify(tokens));
    this.#remember(id, tokens);
    const metadata = login.discovery.metadata;
    const scopes = tokens.scope !== undefined ? unique(tokens.scope.split(' ')) : login.scopes;
    try {
      await this.#reg.setOAuth(
        id,
        () => ({
          status: 'signed_in',
          issuer: login.discovery.issuer,
          tokenEndpoint: metadata.token_endpoint,
          ...(metadata.revocation_endpoint !== undefined && {
            revocationEndpoint: metadata.revocation_endpoint,
          }),
          clientId: login.client.clientId,
          registration: login.registration,
          authMethod: login.client.authMethod,
          ...(login.clientSecretRef !== undefined && { clientSecretRef: login.clientSecretRef }),
          resource: login.discovery.resource,
          ...(scopes.length > 0 && { scopes }),
        }),
        'oauth',
      );
    } catch (error) {
      this.#tokens.delete(id);
      await this.#options.secrets.delete(tokenRef(id)).catch(() => false);
      throw error;
    }
  }

  /** 结束一次登录：关回调服务器；`reason` 是失败原因，undefined 是成功或取消。 */
  #finish(login: Login | undefined, reason: OAuthFailure | undefined): void {
    if (!login || !this.#logins.has(login.loginId)) return;
    login.done = true;
    clearTimeout(login.timer);
    login.callback.close();
    this.#logins.delete(login.loginId);
    if (this.#loginOf.get(login.connectorId) === login.loginId)
      this.#loginOf.delete(login.connectorId);
    if (reason !== undefined) this.#errors.set(login.connectorId, reason);
    this.#reg.changed();
  }

  #cancelFor(id: string): void {
    const loginId = this.#loginOf.get(id);
    if (loginId !== undefined) this.#finish(this.#logins.get(loginId), undefined);
  }

  cancel(loginId: string): void {
    const login = this.#logins.get(loginId);
    if (!login)
      throw new HostError('INVALID_PARAMS', 'No such sign-in', {
        issues: [{ path: ['loginId'], message: 'No such sign-in' }],
      });
    this.#finish(login, undefined);
  }

  async logout(ref: OAuthTargetRef): Promise<void> {
    const target = this.#reg.target(ref);
    if (!target) throw new HostError('INVALID_PARAMS', 'MCP server not found', notFound);
    this.#cancelFor(target.id);
    const tokens = this.#tokens.get(target.id);
    const stored = target.stored;
    if (tokens && stored?.revocationEndpoint) {
      const client = await this.#credentials(target, stored).catch(() => undefined);
      if (client) {
        const options = { scope: scopeOf(target.url), ...this.#lookup };
        if (tokens.refreshToken)
          await revokeToken(
            stored.revocationEndpoint,
            tokens.refreshToken,
            'refresh_token',
            client,
            options,
          );
        await revokeToken(
          stored.revocationEndpoint,
          tokens.accessToken,
          'access_token',
          client,
          options,
        );
      }
    }
    await this.#signOut(target.id, undefined);
  }

  /** 删掉本机的令牌，连接器回到“要登录”。 */
  async #signOut(id: string, reason: OAuthFailure | undefined): Promise<void> {
    this.#tokens.delete(id);
    if (reason === undefined) this.#errors.delete(id);
    else this.#errors.set(id, reason);
    await this.#options.secrets.delete(tokenRef(id)).catch(() => false);
    await this.#reg
      .setOAuth(id, () => undefined)
      .catch((error: unknown) => {
        this.#options.onWarning?.(
          `Could not update the MCP server sign-in state: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /**
   * 配置的客户端密钥：用户填的在密钥文件里；插件清单里写死的是分发出去的客户端的公开密钥（照样打码，但不算用户密钥）。
   */
  async #configuredSecret(target: OAuthTarget): Promise<string | undefined> {
    if (target.clientSecretStored) return this.#readSecret(clientSecretRef(target.id));
    const literal = target.oauth?.clientSecret || undefined;
    if (literal !== undefined) this.#options.onSecret?.(literal);
    return literal;
  }

  async #credentials(target: OAuthTarget, stored: StoredOAuth): Promise<ClientCredentials> {
    let secret: string | undefined;
    if (stored.registration === 'dynamic' && stored.clientSecretRef)
      secret = await this.#readSecret(stored.clientSecretRef);
    else if (stored.registration === 'configured') secret = await this.#configuredSecret(target);
    return {
      clientId: stored.clientId,
      authMethod: stored.authMethod,
      ...(secret !== undefined && stored.authMethod !== 'none' && { clientSecret: secret }),
    };
  }

  // ── 代理用 ──────────────────────────────────────────────────────────────────

  /** 代理令牌对应的连接器 ID；不对时 undefined。 */
  proxyTarget(token: string): string | undefined {
    return this.#proxyIds.get(digest(token));
  }

  /** 可以用的访问令牌：快过期时先刷新。没登录或刷新失败时 undefined。 */
  async accessToken(id: string): Promise<string | undefined> {
    const tokens = this.#tokens.get(id);
    if (!tokens) return undefined;
    if (
      tokens.expiresAt !== undefined &&
      tokens.expiresAt - this.#now < MCP_OAUTH_REFRESH_SKEW_MS
    ) {
      const next = await this.#refresh(id, tokens.accessToken);
      if (next) return next.accessToken;
      const kept = this.#tokens.get(id);
      return kept && (kept.expiresAt === undefined || kept.expiresAt > this.#now)
        ? kept.accessToken
        : undefined;
    }
    return tokens.accessToken;
  }

  /** 上游回了 401：别人已经换过令牌就用新的，否则刷新一次。 */
  async afterUnauthorized(id: string, used: string): Promise<string | undefined> {
    const next = await this.#refresh(id, used);
    return next?.accessToken;
  }

  /** 同一个连接器的刷新只跑一个（照 Codex 的 refresh_lock）。`used` 不是现在的令牌时说明已经刷新过了。 */
  #refresh(id: string, used: string): Promise<TokenSet | undefined> {
    const current = this.#tokens.get(id);
    if (current && current.accessToken !== used) return Promise.resolve(current);
    let flight = this.#refreshing.get(id);
    if (!flight) {
      flight = this.#doRefresh(id).finally(() => this.#refreshing.delete(id));
      this.#refreshing.set(id, flight);
    }
    return flight;
  }

  async #doRefresh(id: string): Promise<TokenSet | undefined> {
    const target = this.#reg.targetById(id);
    const stored = target?.stored;
    const tokens = this.#tokens.get(id);
    if (!target || !stored || !tokens) return undefined;
    if (!tokens.refreshToken) {
      await this.#signOut(id, 'refresh_failed');
      return undefined;
    }
    try {
      const client = await this.#credentials(target, stored);
      const next = await tokenRequest(
        stored.tokenEndpoint,
        {
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
          resource: stored.resource,
        },
        client,
        {
          scope: scopeOf(target.url),
          ...this.#lookup,
          ...(this.#options.now && { now: this.#options.now }),
        },
      );
      // 刷新令牌轮换时旧的作废：先原子写盘，再用新的。
      const merged: TokenSet = {
        ...next,
        ...(next.refreshToken === undefined && { refreshToken: tokens.refreshToken }),
        ...(next.scope === undefined && tokens.scope !== undefined && { scope: tokens.scope }),
      };
      await this.#options.secrets.set(tokenRef(id), JSON.stringify(merged));
      if (!this.#tokens.has(id)) return undefined;
      this.#remember(id, merged);
      this.#reg.changed();
      return merged;
    } catch (error) {
      if (
        error instanceof TokenEndpointError &&
        error.oauthError !== undefined &&
        !TRANSIENT_OAUTH_ERRORS.has(error.oauthError)
      ) {
        this.#options.onWarning?.(
          `MCP OAuth refresh was rejected (${error.oauthError}); sign in again`,
        );
        await this.#signOut(id, 'refresh_failed');
        return undefined;
      }
      this.#options.onWarning?.(
        `MCP OAuth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** 上游回了 403 `insufficient_scope`：记下要的 scope，连接器标成“需要更多权限”。 */
  async insufficientScope(id: string, scope: string | undefined): Promise<void> {
    const required = scope === undefined ? [] : unique(scope.split(' '));
    await this.#reg
      .setOAuth(
        id,
        (stored) =>
          stored && {
            ...stored,
            status: 'insufficient_scope',
            requiredScopes: unique([...(stored.requiredScopes ?? []), ...required]),
          },
      )
      .catch(() => {});
  }

  /** Host 退出：取消进行中的登录。 */
  close(): void {
    for (const login of [...this.#logins.values()]) this.#finish(login, undefined);
  }
}

const notFound = { issues: [{ path: ['name'], message: 'MCP server not found' }] };

function toHostError(error: unknown): Error {
  if (error instanceof HostError) return error;
  if (error instanceof OAuthLoginError) return failed(error.reason, error.message);
  if (error instanceof OAuthHttpError)
    return failed(
      error.reason === 'insecure_endpoint' ? 'insecure_endpoint' : 'discovery_failed',
      error.message,
    );
  return error instanceof Error ? error : new Error(String(error));
}

const RESERVED_AUTHORIZE: ReadonlySet<string> = new Set(OAUTH_RESERVED_AUTHORIZE_PARAMS);

/**
 * 授权请求另加的参数（清单或配置的 `authorizeParams`，Host 自己设的那几个跳过）。Google 要 `access_type=offline` 才给刷新令牌，
 * 而且同一账号授权过以后只有带 `prompt=consent` 才再给：手上没有刷新令牌时自动加上（写了 `prompt` 的照写的）。
 */
function authorizeParams(
  oauth: McpOAuthConfig,
  tokens: TokenSet | undefined,
): Record<string, string> {
  const params = Object.fromEntries(
    Object.entries(oauth.authorizeParams ?? {}).filter(([key]) => !RESERVED_AUTHORIZE.has(key)),
  );
  if (params.access_type === 'offline' && params.prompt === undefined && !tokens?.refreshToken)
    params.prompt = 'consent';
  return params;
}

function parseTokens(raw: string): TokenSet | undefined {
  try {
    const value = JSON.parse(raw) as Partial<TokenSet>;
    if (typeof value.accessToken !== 'string' || value.accessToken === '') return undefined;
    return {
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === 'string' && { refreshToken: value.refreshToken }),
      ...(typeof value.expiresAt === 'number' && { expiresAt: value.expiresAt }),
      ...(typeof value.scope === 'string' && { scope: value.scope }),
    };
  } catch {
    return undefined;
  }
}
