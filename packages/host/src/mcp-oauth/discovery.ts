// MCP Authorization 的发现（modelcontextprotocol.io 的 Authorization 一节）：先不带令牌请求一次服务器，401 时从 `WWW-Authenticate`
// 取受保护资源元数据（RFC 9728）的地址与 scope，没有时试 well-known；再按 RFC 8414 与 OIDC Discovery 的几种地址读授权服务器元数据。
// 都读不到受保护资源元数据时按 2025-03-26 版的做法把服务器的 origin 当授权服务器。

import type { lookup as dnsLookup } from 'node:dns';
import {
  type AddressScope,
  jsonObject,
  OAuthHttpError,
  type OAuthResponse,
  oauthRequest,
} from './http.js';
import { type BearerChallenge, parseBearerChallenge } from './www-authenticate.js';

/** 登录失败的原因（协议 `McpOAuthErrorReason`）。 */
export type OAuthFailure =
  | 'not_supported'
  | 'client_id_required'
  | 'pkce_unsupported'
  | 'insecure_endpoint'
  | 'discovery_failed'
  | 'registration_failed'
  | 'callback_unavailable'
  | 'denied'
  | 'authorization_failed'
  | 'timeout'
  | 'issuer_mismatch'
  | 'token_exchange_failed'
  | 'refresh_failed';

export class OAuthLoginError extends Error {
  constructor(
    readonly reason: OAuthFailure,
    message: string,
  ) {
    super(message);
  }
}

/** 授权服务器元数据（RFC 8414）里用到的字段。 */
export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
}

export interface Discovery {
  /** RFC 8707 的 `resource`：受保护资源元数据的 `resource`，没有时是服务器地址（去掉片段）。 */
  resource: string;
  metadata: AuthServerMetadata;
  /** 授权服务器的标识（元数据的 issuer，或读元数据用的地址）。 */
  issuer: string;
  /** `WWW-Authenticate` 给的 scope。 */
  challengeScopes?: string[];
  /** 受保护资源元数据的 `scopes_supported`。 */
  resourceScopes?: string[];
}

export interface DiscoveryOptions {
  scope: AddressScope;
  lookup?: typeof dnsLookup;
  signal?: AbortSignal;
}

/** MCP `initialize` 请求体，探测用。 */
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wevir', version: '0' },
  },
});

/**
 * 不带令牌请求一次服务器。回 401 时带上解析出的 Bearer 挑战。服务器地址是用户自己填的，不做地址范围检查。网络不通时抛
 * `OAuthHttpError('network')`。
 */
export async function probe(
  url: string,
  headers: Record<string, string>,
  options: { lookup?: typeof dnsLookup; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; challenge?: BearerChallenge }> {
  const response = await oauthRequest(url, {
    method: 'POST',
    scope: 'public',
    trusted: true,
    headers: {
      ...withoutAuthorization(headers),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: INITIALIZE,
    timeoutMs: options.timeoutMs ?? 5000,
    ...(options.lookup && { lookup: options.lookup }),
    ...(options.signal && { signal: options.signal }),
  }).catch((error: unknown) => {
    // 回 200 的服务器可能开着 SSE 流超过上限，这时它显然不要求登录。
    if (error instanceof OAuthHttpError && error.reason === 'too_large')
      return { status: 200, headers: {}, body: Buffer.alloc(0) } as OAuthResponse;
    throw error;
  });
  const challenge =
    response.status === 401
      ? parseBearerChallenge(response.headers['www-authenticate'])
      : undefined;
  return { status: response.status, ...(challenge && { challenge }) };
}

export function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
  );
}

/** RFC 9728 §3.1：先试带路径的 well-known，再试根。 */
export function resourceMetadataUrls(server: string): string[] {
  const url = new URL(server);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const base = `${url.origin}/.well-known/oauth-protected-resource`;
  return path === '' ? [base] : [`${base}${path}`, base];
}

/** RFC 8414 §3.1 与 OIDC Discovery 1.0 §4（MCP Authorization 规定的顺序）。 */
export function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  if (path === '')
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** 服务器地址的规范形式（RFC 8707、MCP Authorization 的 Canonical Server URI）：去掉片段，scheme 与主机小写由 URL 负责。 */
export function canonicalResource(server: string): string {
  const url = new URL(server);
  url.hash = '';
  return url.href;
}

/** 发现授权服务器。`known` 是之前探测到的结果（省一次请求）。 */
export async function discover(
  server: string,
  headers: Record<string, string>,
  options: DiscoveryOptions & { known?: { status: number; challenge?: BearerChallenge } },
): Promise<Discovery> {
  let probed = options.known;
  if (probed === undefined) {
    try {
      probed = await probe(server, headers, options);
    } catch (error) {
      throw new OAuthLoginError(
        'discovery_failed',
        `Could not reach the MCP server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const challenge = probed.challenge;
  const resourceMetadata = await readResourceMetadata(server, challenge, options);
  let issuers: string[];
  let resource = canonicalResource(server);
  let resourceScopes: string[] | undefined;
  if (resourceMetadata) {
    issuers = strings(resourceMetadata.authorization_servers) ?? [];
    if (issuers.length === 0)
      throw new OAuthLoginError(
        'not_supported',
        'The protected resource metadata lists no authorization server',
      );
    const declared = resourceMetadata.resource;
    if (typeof declared === 'string') {
      if (!resourceMatches(declared, server))
        throw new OAuthLoginError(
          'discovery_failed',
          'The protected resource metadata is for a different resource',
        );
      resource = declared;
    }
    resourceScopes = strings(resourceMetadata.scopes_supported);
  } else {
    if (probed.status !== 401)
      throw new OAuthLoginError('not_supported', 'The MCP server does not ask for OAuth');
    issuers = [new URL(server).origin];
  }
  let lastError: OAuthLoginError | undefined;
  for (const issuer of issuers) {
    try {
      const metadata = await readAuthServerMetadata(issuer, options);
      if (metadata)
        return {
          resource,
          metadata,
          issuer: metadata.issuer ?? issuer,
          ...(challenge?.scope !== undefined && { challengeScopes: challenge.scope.split(' ') }),
          ...(resourceScopes !== undefined && { resourceScopes }),
        };
    } catch (error) {
      if (error instanceof OAuthLoginError && error.reason === 'insecure_endpoint') throw error;
      lastError = error instanceof OAuthLoginError ? error : undefined;
    }
  }
  throw (
    lastError ??
    new OAuthLoginError(
      resourceMetadata ? 'discovery_failed' : 'not_supported',
      'Could not read the authorization server metadata',
    )
  );
}

/** RFC 9728 §3.3：元数据的 `resource` 要是同一个 origin，服务器路径以它的路径开头。 */
function resourceMatches(declared: string, server: string): boolean {
  try {
    const a = new URL(declared);
    const b = new URL(server);
    if (a.origin !== b.origin) return false;
    const path = a.pathname.replace(/\/$/, '');
    return b.pathname === path || b.pathname.startsWith(`${path}/`) || path === '';
  } catch {
    return false;
  }
}

async function readResourceMetadata(
  server: string,
  challenge: BearerChallenge | undefined,
  options: DiscoveryOptions,
): Promise<Record<string, unknown> | undefined> {
  const candidates = challenge?.resourceMetadata
    ? [challenge.resourceMetadata]
    : resourceMetadataUrls(server);
  for (const url of candidates) {
    const response = await get(url, options);
    if (response?.status === 200) {
      const value = jsonObject(response);
      if (value) return value;
    }
  }
  return undefined;
}

async function readAuthServerMetadata(
  issuer: string,
  options: DiscoveryOptions,
): Promise<AuthServerMetadata | undefined> {
  for (const url of authServerMetadataUrls(issuer)) {
    const response = await get(url, options);
    if (response?.status !== 200) continue;
    const value = jsonObject(response);
    if (!value) continue;
    const metadata = authServerMetadata(value);
    if (!metadata)
      throw new OAuthLoginError(
        'discovery_failed',
        `Invalid authorization server metadata at ${url}`,
      );
    // RFC 8414 §3.3：issuer 要与读元数据用的标识相同（末尾斜杠不算）。
    if (
      metadata.issuer !== undefined &&
      metadata.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')
    )
      throw new OAuthLoginError(
        'discovery_failed',
        `Authorization server issuer mismatch at ${url}`,
      );
    return metadata;
  }
  return undefined;
}

function authServerMetadata(value: Record<string, unknown>): AuthServerMetadata | undefined {
  const text = (key: string) =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined;
  const authorization = text('authorization_endpoint');
  const token = text('token_endpoint');
  if (authorization === undefined || token === undefined) return undefined;
  const list = (key: string) => strings(value[key]);
  const flag = (key: string) => value[key] === true;
  const issuer = text('issuer');
  const registration = text('registration_endpoint');
  const revocation = text('revocation_endpoint');
  const challenges = list('code_challenge_methods_supported');
  const authMethods = list('token_endpoint_auth_methods_supported');
  const scopes = list('scopes_supported');
  return {
    authorization_endpoint: authorization,
    token_endpoint: token,
    ...(issuer !== undefined && { issuer }),
    ...(registration !== undefined && { registration_endpoint: registration }),
    ...(revocation !== undefined && { revocation_endpoint: revocation }),
    ...(challenges !== undefined && { code_challenge_methods_supported: challenges }),
    ...(authMethods !== undefined && { token_endpoint_auth_methods_supported: authMethods }),
    ...(scopes !== undefined && { scopes_supported: scopes }),
    ...(flag('client_id_metadata_document_supported') && {
      client_id_metadata_document_supported: true,
    }),
    ...(flag('authorization_response_iss_parameter_supported') && {
      authorization_response_iss_parameter_supported: true,
    }),
  };
}

/** GET 一个元数据地址；地址不安全时抛 `insecure_endpoint`，其余失败返回 undefined（换下一个地址）。 */
async function get(url: string, options: DiscoveryOptions): Promise<OAuthResponse | undefined> {
  try {
    return await oauthRequest(url, {
      scope: options.scope,
      headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' },
      ...(options.lookup && { lookup: options.lookup }),
      ...(options.signal && { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof OAuthHttpError && error.reason === 'insecure_endpoint')
      throw new OAuthLoginError('insecure_endpoint', error.message);
    return undefined;
  }
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}
