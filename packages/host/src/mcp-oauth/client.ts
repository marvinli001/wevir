// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// `callbackId` 改写自 openai/codex codex-rs/rmcp-client/src/oauth_callback.rs（callback_id_from_server_url），提交
// 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d。修改：Rust 改为 TypeScript。文件其余部分是 Wevir 按各 RFC 写的。
// 授权服务器的几个端点：动态客户端注册（RFC 7591）、换令牌与刷新（RFC 6749 §4.1.3 / §6，带 RFC 8707 的 `resource`）、撤销（RFC 7009）。
// 另有 PKCE（RFC 7636，只用 S256）与回调路径（照 Codex 的 oauth_callback.rs）。

import { createHash, randomBytes } from 'node:crypto';
import type { lookup as dnsLookup } from 'node:dns';
import { OAuthLoginError } from './discovery.js';
import { type AddressScope, jsonObject, OAuthHttpError, oauthRequest } from './http.js';

const BEARER_TYPES = new Set(['bearer', 'user']);

export type ClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
  authMethod: ClientAuthMethod;
}

/** 存在密钥文件里的令牌（一个连接器一份 JSON）。 */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** 毫秒时间戳；服务器没给 `expires_in` 时省略。 */
  expiresAt?: number;
  /** 授予的 scope（空格分隔）。 */
  scope?: string;
}

export interface EndpointOptions {
  scope: AddressScope;
  lookup?: typeof dnsLookup;
  now?: () => number;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function randomState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 按服务器区分的回调路径段：服务器地址（去掉片段）的 SHA-256 前 9 字节，base64url。授权服务器不回 `iss` 时用它把回调绑到发起登录的
 * 服务器上（RFC 9700 §4.4.2.2，照 Codex `callback_id_from_server_url`）。
 */
export function callbackId(server: string): string {
  const url = new URL(server);
  url.hash = '';
  return createHash('sha256').update(url.href).digest().subarray(0, 9).toString('base64url');
}

/** 换令牌失败：`oauthError` 是服务器回的 `error`（如 `invalid_grant`），网络不通时没有。 */
export class TokenEndpointError extends Error {
  constructor(
    message: string,
    readonly oauthError?: string,
  ) {
    super(message);
  }
}

function authHeaders(client: ClientCredentials): Record<string, string> {
  if (client.authMethod !== 'client_secret_basic' || client.clientSecret === undefined) return {};
  // RFC 6749 §2.3.1：先按 application/x-www-form-urlencoded 编码再 Base64。
  const id = encodeURIComponent(client.clientId);
  const secret = encodeURIComponent(client.clientSecret);
  return { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
}

function authParams(client: ClientCredentials): Record<string, string> {
  if (client.authMethod === 'client_secret_basic') return {};
  return {
    client_id: client.clientId,
    ...(client.authMethod === 'client_secret_post' &&
      client.clientSecret !== undefined && { client_secret: client.clientSecret }),
  };
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
  client: ClientCredentials,
  options: EndpointOptions,
) {
  return oauthRequest(endpoint, {
    method: 'POST',
    scope: options.scope,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...authHeaders(client),
    },
    body: new URLSearchParams({ ...params, ...authParams(client) }).toString(),
    ...(options.lookup && { lookup: options.lookup }),
  });
}

/** 换令牌或刷新。失败抛 `TokenEndpointError`。 */
export async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  client: ClientCredentials,
  options: EndpointOptions,
): Promise<TokenSet> {
  let response: Awaited<ReturnType<typeof postForm>>;
  try {
    response = await postForm(endpoint, params, client, options);
  } catch (error) {
    if (error instanceof OAuthHttpError && error.reason === 'insecure_endpoint')
      throw new OAuthLoginError('insecure_endpoint', error.message);
    throw new TokenEndpointError(error instanceof Error ? error.message : String(error));
  }
  const body = jsonObject(response);
  // GitHub 与 Slack 出错也回 200：GitHub 带 `error`，Slack 是 `{ ok: false, error }`。
  const code = typeof body?.error === 'string' ? body.error : undefined;
  if (response.status !== 200 || !body || code !== undefined || body.ok === false)
    throw new TokenEndpointError(
      `The token endpoint answered HTTP ${response.status}${code ? ` (${code})` : ''}`,
      code ?? (body?.ok === false ? 'unknown_error' : undefined),
    );
  // Slack 的旧形状把用户令牌放在 `authed_user` 里。
  const user = body.authed_user;
  const nested =
    typeof user === 'object' && user !== null ? (user as Record<string, unknown>) : undefined;
  const source = typeof body.access_token === 'string' || !nested ? body : nested;
  const access = source.access_token;
  const type = source.token_type;
  if (typeof access !== 'string' || access === '')
    throw new TokenEndpointError('The token response has no access_token');
  // Slack 用户令牌的 token_type 是 `user`，用法同 Bearer；省略的也按 Bearer。DPoP 等别的类型用不了。
  if (type !== undefined && !(typeof type === 'string' && BEARER_TYPES.has(type.toLowerCase())))
    throw new TokenEndpointError('The token response is not a Bearer token');
  const expiresIn = Number(source.expires_in);
  const now = options.now ?? Date.now;
  const scope = source.scope ?? nested?.scope;
  // GitHub OAuth App 的令牌没有 expires_in 与 refresh_token：一直有效，直到被撤销。
  return {
    accessToken: access,
    ...(typeof source.refresh_token === 'string' &&
      source.refresh_token !== '' && { refreshToken: source.refresh_token }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 && { expiresAt: now() + expiresIn * 1000 }),
    // GitHub 的 scope 用逗号分隔。
    ...(typeof scope === 'string' && {
      scope: scope
        .split(/[\s,]+/)
        .filter(Boolean)
        .join(' '),
    }),
  };
}

/** 撤销一个令牌（RFC 7009）；尽力而为，失败不报错。 */
export async function revokeToken(
  endpoint: string,
  token: string,
  hint: 'access_token' | 'refresh_token',
  client: ClientCredentials,
  options: EndpointOptions,
): Promise<void> {
  try {
    await postForm(endpoint, { token, token_type_hint: hint }, client, options);
  } catch {
    // 撤销失败也照样删掉本机的令牌。
  }
}

/** 动态注册一个公开客户端（RFC 7591）。 */
export async function registerClient(
  endpoint: string,
  redirectUri: string,
  options: EndpointOptions,
): Promise<ClientCredentials> {
  let response: Awaited<ReturnType<typeof oauthRequest>>;
  try {
    response = await oauthRequest(endpoint, {
      method: 'POST',
      scope: options.scope,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Wevir',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      ...(options.lookup && { lookup: options.lookup }),
    });
  } catch (error) {
    if (error instanceof OAuthHttpError && error.reason === 'insecure_endpoint')
      throw new OAuthLoginError('insecure_endpoint', error.message);
    throw new OAuthLoginError(
      'registration_failed',
      `Client registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = jsonObject(response);
  if (response.status < 200 || response.status >= 300 || typeof body?.client_id !== 'string')
    throw new OAuthLoginError(
      'registration_failed',
      `Client registration answered HTTP ${response.status}`,
    );
  const secret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  const method = body.token_endpoint_auth_method;
  const authMethod: ClientAuthMethod =
    secret === undefined || method === 'none'
      ? 'none'
      : method === 'client_secret_post'
        ? 'client_secret_post'
        : 'client_secret_basic';
  return {
    clientId: body.client_id,
    authMethod,
    ...(authMethod !== 'none' && secret !== undefined && { clientSecret: secret }),
  };
}

/** 预先注册的客户端用哪种认证：有密钥时优先 Basic（RFC 6749 要求服务器支持），服务器只列了 post 时用 post。 */
export function configuredAuthMethod(
  secret: string | undefined,
  supported: string[] | undefined,
): ClientAuthMethod {
  if (secret === undefined || secret === '') return 'none';
  if (supported === undefined || supported.includes('client_secret_basic'))
    return 'client_secret_basic';
  return supported.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
}
