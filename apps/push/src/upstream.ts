import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { type ClientHttp2Session, connect, constants } from 'node:http2';

/** APNs / FCM 一次请求的结果。`unregistered` 是令牌已失效（App 卸载、换了令牌），网关据此删掉绑定。 */
export type UpstreamResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unregistered' | 'rate_limited' | 'failed';
      status?: number;
      /** APNs 的 `reason` 或 FCM 的 `errorCode`：只给日志，从不含令牌或载荷。 */
      detail?: string;
    };

const UPSTREAM_TIMEOUT_MS = 10_000;
/** APNs 要求提供方令牌 20–60 分钟换一次。 */
const APNS_TOKEN_TTL_MS = 40 * 60_000;

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 读私钥（PEM）；读不了时报错，错误里不带密钥内容。 */
export function loadPrivateKey(pem: string, what: string): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch {
    throw new Error(`${what} is not a valid PEM private key`);
  }
}

// ── APNs ────────────────────────────────────────────────────────────

export const APNS_PRODUCTION_URL = 'https://api.push.apple.com';
export const APNS_SANDBOX_URL = 'https://api.sandbox.push.apple.com';

export interface ApnsMessage {
  token: string;
  sandbox: boolean;
  /** `alert` 是要显示的提醒（通知扩展解密改写），`background` 是静默推送（验证码）。 */
  pushType: 'alert' | 'background';
  /** 10 立即送达；静默推送必须是 5。 */
  priority: 5 | 10;
  /** Unix 秒：过了就不必送达。 */
  expiration: number;
  collapseId?: string;
  payload: Record<string, unknown>;
}

export interface ApnsSender {
  send(message: ApnsMessage): Promise<UpstreamResult>;
  close(): void;
}

export interface ApnsClientOptions {
  /** `.p8`（PEM）的内容。只从环境变量或挂载的文件读（config.ts）。 */
  key: string;
  keyId: string;
  teamId: string;
  /** App 的 bundle ID（`apns-topic`）。 */
  topic: string;
  productionUrl?: string;
  sandboxUrl?: string;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * APNs 的 HTTP/2 客户端，token 认证（ES256 的 JWT，40 分钟换一次）。每个地址一条 HTTP/2 会话，断了下次请求时重连。
 * 令牌在请求路径里，从不写进日志或错误信息。
 */
export class ApnsClient implements ApnsSender {
  readonly #key: KeyObject;
  readonly #keyId: string;
  readonly #teamId: string;
  readonly #topic: string;
  readonly #urls: { production: string; sandbox: string };
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #sessions = new Map<string, ClientHttp2Session>();
  #jwt: { value: string; at: number } | undefined;

  constructor(options: ApnsClientOptions) {
    this.#key = loadPrivateKey(options.key, 'the APNs key');
    this.#keyId = options.keyId;
    this.#teamId = options.teamId;
    this.#topic = options.topic;
    this.#urls = {
      production: options.productionUrl ?? APNS_PRODUCTION_URL,
      sandbox: options.sandboxUrl ?? APNS_SANDBOX_URL,
    };
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  }

  async send(message: ApnsMessage): Promise<UpstreamResult> {
    let result = await this.#request(message);
    if (!result.ok && result.status === 403 && /ProviderToken/.test(result.detail ?? '')) {
      // 提供方令牌过期或被拒：换一个再试一次。
      this.#jwt = undefined;
      result = await this.#request(message);
    }
    return result;
  }

  close(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }

  #token(): string {
    const now = this.#now();
    if (this.#jwt !== undefined && now - this.#jwt.at < APNS_TOKEN_TTL_MS) return this.#jwt.value;
    const unsigned = `${base64urlJson({ alg: 'ES256', kid: this.#keyId })}.${base64urlJson({
      iss: this.#teamId,
      iat: Math.floor(now / 1000),
    })}`;
    const signature = createSign('sha256')
      .update(unsigned)
      .sign({ key: this.#key, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    this.#jwt = { value: `${unsigned}.${signature}`, at: now };
    return this.#jwt.value;
  }

  #session(origin: string): ClientHttp2Session {
    const existing = this.#sessions.get(origin);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    session.on('error', () => {});
    const forget = () => {
      if (this.#sessions.get(origin) === session) this.#sessions.delete(origin);
    };
    session.on('close', forget);
    session.on('goaway', forget);
    session.unref();
    this.#sessions.set(origin, session);
    return session;
  }

  #request(message: ApnsMessage): Promise<UpstreamResult> {
    const origin = message.sandbox ? this.#urls.sandbox : this.#urls.production;
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: UpstreamResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let session: ClientHttp2Session;
      try {
        session = this.#session(origin);
      } catch (error) {
        done({ ok: false, reason: 'failed', detail: (error as Error).message });
        return;
      }
      const headers: Record<string, string> = {
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${message.token}`,
        authorization: `bearer ${this.#token()}`,
        'apns-topic': this.#topic,
        'apns-push-type': message.pushType,
        'apns-priority': String(message.priority),
        'apns-expiration': String(message.expiration),
        'content-type': 'application/json',
      };
      if (message.collapseId !== undefined) headers['apns-collapse-id'] = message.collapseId;
      const request = session.request(headers);
      request.setTimeout(this.#timeoutMs, () => {
        request.close(constants.NGHTTP2_CANCEL);
        done({ ok: false, reason: 'failed', detail: 'timeout' });
      });
      let status = 0;
      const chunks: Buffer[] = [];
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS]);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('error', (error) => done({ ok: false, reason: 'failed', detail: error.message }));
      request.on('end', () => {
        let reason: string | undefined;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            reason?: unknown;
          };
          if (typeof body.reason === 'string') reason = body.reason.slice(0, 64);
        } catch {}
        done(apnsResult(status, reason));
      });
      request.end(JSON.stringify(message.payload));
    });
  }
}

function apnsResult(status: number, reason: string | undefined): UpstreamResult {
  if (status === 200) return { ok: true };
  const detail = reason ?? `HTTP ${status}`;
  if (status === 410) return { ok: false, reason: 'unregistered', status, detail };
  if (
    status === 400 &&
    (reason === 'BadDeviceToken' ||
      reason === 'DeviceTokenNotForTopic' ||
      reason === 'Unregistered')
  ) {
    return { ok: false, reason: 'unregistered', status, detail };
  }
  if (status === 429) return { ok: false, reason: 'rate_limited', status, detail };
  return { ok: false, reason: 'failed', status, detail };
}

// ── FCM ─────────────────────────────────────────────────────────────

export const FCM_URL = 'https://fcm.googleapis.com';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** 服务账号 JSON 里用到的几项。 */
export interface FcmCredentials {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmMessage {
  token: string;
  /** FCM 的 data 消息：值都是字符串。 */
  data: Record<string, string>;
  collapseKey?: string;
  ttlSeconds: number;
}

export interface FcmSender {
  send(message: FcmMessage): Promise<UpstreamResult>;
  close(): void;
}

export interface FcmClientOptions {
  credentials: FcmCredentials;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * FCM HTTP v1 的客户端：服务账号签一个 RS256 的 JWT 换 OAuth 访问令牌（缓存到过期前一分钟），发高优先级的 data 消息（App 收到后本地
 * 解密、生成通知）。
 */
export class FcmClient implements FcmSender {
  readonly #credentials: FcmCredentials;
  readonly #key: KeyObject;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #access: { token: string; expiresAt: number } | undefined;

  constructor(options: FcmClientOptions) {
    this.#credentials = options.credentials;
    this.#key = loadPrivateKey(options.credentials.private_key, 'the FCM service account key');
    this.#baseUrl = (options.baseUrl ?? FCM_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  }

  async send(message: FcmMessage): Promise<UpstreamResult> {
    let result = await this.#send(message);
    if (!result.ok && result.status === 401) {
      this.#access = undefined;
      result = await this.#send(message);
    }
    return result;
  }

  close(): void {}

  async #accessToken(): Promise<string> {
    const now = this.#now();
    if (this.#access !== undefined && now < this.#access.expiresAt) return this.#access.token;
    const tokenUri = this.#credentials.token_uri ?? GOOGLE_TOKEN_URI;
    const iat = Math.floor(now / 1000);
    const unsigned = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson({
      iss: this.#credentials.client_email,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = createSign('sha256').update(unsigned).sign(this.#key).toString('base64url');
    const response = await this.#fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`FCM token request failed with HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('FCM token response has no token');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.#access = { token: body.access_token, expiresAt: now + (expiresIn - 60) * 1000 };
    return this.#access.token;
  }

  async #send(message: FcmMessage): Promise<UpstreamResult> {
    let response: Response;
    try {
      const token = await this.#accessToken();
      response = await this.#fetch(
        `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#credentials.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: message.token,
              data: message.data,
              android: {
                priority: 'HIGH',
                ttl: `${message.ttlSeconds}s`,
                ...(message.collapseKey !== undefined && { collapse_key: message.collapseKey }),
              },
            },
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      return { ok: false, reason: 'failed', detail: (error as Error).message };
    }
    if (response.ok) return { ok: true };
    let errorCode: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: { status?: unknown; details?: { errorCode?: unknown }[] };
      };
      const detail = body.error?.details?.find((entry) => typeof entry.errorCode === 'string');
      const code = detail?.errorCode ?? body.error?.status;
      if (typeof code === 'string') errorCode = code.slice(0, 64);
    } catch {}
    const status = response.status;
    const detail = errorCode ?? `HTTP ${status}`;
    if (errorCode === 'UNREGISTERED' || errorCode === 'SENDER_ID_MISMATCH' || status === 404) {
      return { ok: false, reason: 'unregistered', status, detail };
    }
    if (status === 429 || errorCode === 'QUOTA_EXCEEDED') {
      return { ok: false, reason: 'rate_limited', status, detail };
    }
    return { ok: false, reason: 'failed', status, detail };
  }
}
