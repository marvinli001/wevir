// Google 服务账号 JWT bearer（RS256），只在 Host 进程内使用。
// https://developers.google.com/identity/protocols/oauth2/service-account（2026-10-15）
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { isObject } from './tools.js';
import type { GatewayProvider } from './types.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const REFRESH_BEFORE_MS = 5 * 60_000;

export class VertexAuthError extends Error {
  constructor() {
    // 不返回签名异常、JSON 片段或令牌服务的原文：它们可能包含凭据。
    super('Google Cloud 服务账号认证失败，请检查服务账号 JSON、权限、系统时间与网络');
  }
}

interface Token {
  value: string;
  expiresAt: number;
}
interface Entry {
  token?: Token;
  pending?: Promise<Token>;
}

export interface VertexAuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class VertexTokenCache {
  readonly #entries = new Map<string, Entry>();
  readonly #inflight = new Set<AbortController>();
  readonly #options: VertexAuthOptions;

  constructor(options: VertexAuthOptions = {}) {
    this.#options = options;
  }

  async get(json: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const key = fingerprint(json);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = {};
      this.#entries.set(key, entry);
    }
    const now = this.#options.now ?? Date.now;
    if (entry.token && entry.token.expiresAt - now() > REFRESH_BEFORE_MS) return entry.token.value;
    let pending = entry.pending;
    if (!pending) {
      const target = entry;
      pending = this.#exchange(json)
        .then((token) => {
          target.token = token;
          return token;
        })
        .finally(() => {
          delete target.pending;
        });
      target.pending = pending;
    }
    // 单条请求的取消不取消其他请求共用的交换；网关关闭与交换时限仍会中止它。
    return (await waitForToken(pending, signal)).value;
  }

  retain(providers: readonly GatewayProvider[]): void {
    const keys = new Set(
      providers.flatMap((p) => (p.serviceAccountJson ? [fingerprint(p.serviceAccountJson)] : [])),
    );
    for (const key of this.#entries.keys()) if (!keys.has(key)) this.#entries.delete(key);
  }

  close(): void {
    for (const controller of this.#inflight) controller.abort();
    this.#entries.clear();
  }

  async #exchange(json: string): Promise<Token> {
    const controller = new AbortController();
    this.#inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 20_000);
    try {
      const account: unknown = JSON.parse(json);
      if (
        !isObject(account) ||
        account.type !== 'service_account' ||
        typeof account.client_email !== 'string' ||
        !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(account.client_email) ||
        typeof account.private_key !== 'string' ||
        (account.token_uri !== undefined && account.token_uri !== GOOGLE_TOKEN_URL)
      )
        throw new VertexAuthError();
      const privateKey = createPrivateKey(account.private_key);
      if (privateKey.asymmetricKeyType !== 'rsa') throw new VertexAuthError();
      const now = this.#options.now ?? Date.now;
      const started = now();
      const iat = Math.floor(started / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', ...(typeof account.private_key_id === 'string' && { kid: account.private_key_id }) })}.${encode({ iss: account.client_email, scope: SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 })}`;
      const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
      const response = await (this.#options.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VertexAuthError();
      }
      const data = await tokenBody(response);
      if (
        !isObject(data) ||
        typeof data.access_token !== 'string' ||
        !/^[\x21-\x7e]+$/.test(data.access_token) ||
        data.token_type !== 'Bearer' ||
        typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      )
        throw new VertexAuthError();
      return {
        value: data.access_token,
        expiresAt: started + Math.min(data.expires_in, 3600) * 1000,
      };
    } catch {
      throw new VertexAuthError();
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(controller);
    }
  }
}

/** 令牌响应很小；先按原始字节拒绝超限，再解码 JSON。 */
async function tokenBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new VertexAuthError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new VertexAuthError();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function fingerprint(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

async function waitForToken(pending: Promise<Token>, signal: AbortSignal): Promise<Token> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function credentialOf(provider: GatewayProvider): string | undefined {
  return provider.kind === 'google-vertex' ? provider.serviceAccountJson : provider.apiKey;
}
