import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  PUSH_APNS_BODY_LOC_KEY,
  PUSH_APNS_TITLE_LOC_KEY,
  PUSH_CLOCK_SKEW_MS,
  PUSH_DATA_CODE_KEY,
  PUSH_DATA_KIND_KEY,
  PUSH_DATA_PAYLOAD_KEY,
  PUSH_GATEWAY_PATHS,
  PUSH_MAX_TTL_MS,
  PUSH_REQUEST_MAX_BYTES,
  PUSH_SIGNATURE_HEADER,
  PUSH_VERIFY_CODE_BYTES,
  PUSH_VERIFY_TTL_MS,
  PushBindRequestSchema,
  type PushGatewayErrorCode,
  type PushPlatform,
  PushSendRequestSchema,
  PushUnbindRequestSchema,
  PushVerifyRequestSchema,
  pushSignatureMessage,
} from '@wevir/protocol';
import { type BindingStore, bindingKey, MemoryBindingStore, routeKey } from './bindings.js';
import { DEFAULT_PUSH_LIMITS, ExpiringSet, type PushLimits, WindowLimiter } from './limits.js';
import { type PushLogger, silentLogger } from './log.js';
import type { ApnsSender, FcmSender, UpstreamResult } from './upstream.js';

/** 健康检查等普通请求的头与整个请求的时限。 */
const HTTP_TIMEOUT_MS = 10_000;
/** 验证码最多试错几次。 */
const MAX_CODE_ATTEMPTS = 5;
/** 记着的验证码与随机数的上限。 */
const MAX_PENDING_CODES = 100_000;
const MAX_NONCES = 1_000_000;
/** 多久清理一次长期不用的绑定，与“长期”是多久。 */
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
const BINDING_IDLE_MS = 180 * 24 * 60 * 60_000;

const STATUS: Record<PushGatewayErrorCode, number> = {
  bad_request: 400,
  bad_signature: 401,
  stale_request: 401,
  bad_code: 403,
  not_bound: 404,
  unregistered: 410,
  rate_limited: 429,
  upstream_failed: 502,
  platform_unavailable: 503,
};

export interface PushGatewayOptions {
  /** APNs（正式与开发环境共用一份凭据）。不给时 `apns` 与 `apns_sandbox` 的请求回 `platform_unavailable`。 */
  apns?: ApnsSender;
  /** FCM。不给时 `fcm` 的请求回 `platform_unavailable`。 */
  fcm?: FcmSender;
  /** 绑定的存储；省略时只在内存里。 */
  bindings?: BindingStore;
  limits?: Partial<PushLimits>;
  logger?: PushLogger;
  /**
   * 在反向代理后面：来源地址取 `X-Forwarded-For` 的最后一项（代理追加的那一项）。直接对外时不要打开，不然谁都能伪造来源地址
   * 绕过限速。
   */
  trustProxy?: boolean;
  tls?: { cert: string | Buffer; key: string | Buffer };
  now?: () => number;
}

export interface PushGatewayStats {
  bindings: number;
  pendingCodes: number;
}

interface PendingCode {
  code: Buffer;
  expiresAt: number;
  attempts: number;
}

/** zod schema 的 `safeParse`（不直接依赖 zod：它经 @wevir/protocol 打包进来）。 */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

class RequestError extends Error {
  readonly code: PushGatewayErrorCode;

  constructor(code: PushGatewayErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Wevir 的推送网关（ADR-0017 §6 与补记 6，apps/push/README.md）：只有它持有 APNs / FCM 的凭据。
 *
 * - **只替绑定过的电脑发**：手机经 `verify` 让网关给它的令牌推一个验证码，Host 拿着手机交来的验证码、用路由密钥（Ed25519）签名
 *   `bind`，网关才记下 `(路由 ID, 平台, 令牌)`。之后 `send` 只对绑定过的组合转发：别人既拿不到验证码，也签不了这台电脑的请求。
 * - **只见令牌与密文**：载荷是 Host 用与那台手机的共享密钥加密的，网关原样放进 APNs / FCM 的请求；存储里只有绑定的哈希，不存令牌。
 *   日志只记哈希的前几位与结果，不记令牌、载荷、验证码与地址。
 * - **限制**：按来源地址限请求频率，按令牌限验证码与推送，按路由限推送、绑定次数与绑定数。签名请求的时间戳要在五分钟内，随机数不能
 *   重用。
 */
export class PushGatewayServer {
  readonly #apns: ApnsSender | undefined;
  readonly #fcm: FcmSender | undefined;
  readonly #bindings: BindingStore;
  readonly #limits: PushLimits;
  readonly #logger: PushLogger;
  readonly #trustProxy: boolean;
  readonly #now: () => number;
  readonly #server: Server;
  readonly #startedAt: number;
  readonly #codes = new Map<string, PendingCode>();
  readonly #nonces: ExpiringSet;
  readonly #requestsBySource: WindowLimiter;
  readonly #verifiesBySource: WindowLimiter;
  readonly #verifiesByToken: WindowLimiter;
  readonly #sendsByRoute: WindowLimiter;
  readonly #sendsByToken: WindowLimiter;
  readonly #bindsByRoute: WindowLimiter;
  readonly #prune: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: PushGatewayOptions = {}) {
    this.#apns = options.apns;
    this.#fcm = options.fcm;
    this.#bindings = options.bindings ?? new MemoryBindingStore();
    this.#limits = { ...DEFAULT_PUSH_LIMITS, ...options.limits };
    this.#logger = options.logger ?? silentLogger;
    this.#trustProxy = options.trustProxy === true;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    const hour = 60 * 60_000;
    const now = this.#now;
    this.#nonces = new ExpiringSet(2 * PUSH_CLOCK_SKEW_MS, MAX_NONCES, now);
    this.#requestsBySource = new WindowLimiter(
      this.#limits.requestsPerMinutePerSource,
      60_000,
      now,
    );
    this.#verifiesBySource = new WindowLimiter(this.#limits.verifiesPerHourPerSource, hour, now);
    this.#verifiesByToken = new WindowLimiter(this.#limits.verifiesPerHourPerToken, hour, now);
    this.#sendsByRoute = new WindowLimiter(this.#limits.sendsPerHourPerRoute, hour, now);
    this.#sendsByToken = new WindowLimiter(this.#limits.sendsPerHourPerToken, hour, now);
    this.#bindsByRoute = new WindowLimiter(this.#limits.bindsPerHourPerRoute, hour, now);
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      void this.#handle(req, res);
    };
    this.#server =
      options.tls === undefined
        ? createHttpServer(handler)
        : createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler);
    this.#server.headersTimeout = HTTP_TIMEOUT_MS;
    this.#server.requestTimeout = HTTP_TIMEOUT_MS;
    this.#server.on('clientError', (_error, socket) => socket.destroy());
    this.#prune = setInterval(() => {
      const removed = this.#bindings.prune(this.#now() - BINDING_IDLE_MS);
      if (removed > 0) this.#logger.info('pruned idle bindings', { removed });
    }, PRUNE_INTERVAL_MS);
    this.#prune.unref?.();
  }

  /** 开始监听，返回实际的端口（`port` 为 0 时由系统分配）。 */
  listen(port: number, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ port, ...(host !== undefined && { host }) }, () => {
        this.#server.off('error', reject);
        resolve((this.#server.address() as AddressInfo).port);
      });
    });
  }

  stats(): PushGatewayStats {
    return { bindings: this.#bindings.count(), pendingCodes: this.#codes.size };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#prune);
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#apns?.close();
    this.#fcm?.close();
    this.#bindings.close();
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/';
    if (path === PUSH_GATEWAY_PATHS.health && (req.method === 'GET' || req.method === 'HEAD')) {
      this.#json(res, 200, {
        status: 'ok',
        bindings: this.#bindings.count(),
        apns: this.#apns !== undefined,
        fcm: this.#fcm !== undefined,
        uptimeSeconds: Math.floor((this.#now() - this.#startedAt) / 1000),
      });
      return;
    }
    const route = Object.values(PUSH_GATEWAY_PATHS).find(
      (candidate) => candidate === path && candidate !== PUSH_GATEWAY_PATHS.health,
    );
    if (route === undefined || req.method !== 'POST') {
      req.resume();
      this.#json(res, 404, { error: { code: 'bad_request', message: 'not found' } });
      return;
    }
    try {
      if (!this.#requestsBySource.take(tag(this.#sourceOf(req)))) {
        throw new RequestError('rate_limited', 'too many requests from this address');
      }
      const body = await readBody(req);
      const status = await this.#route(route, req, body);
      this.#json(res, status, {});
    } catch (error) {
      if (error instanceof RequestError) {
        this.#logger.info('request rejected', { path: route, code: error.code });
        this.#json(res, STATUS[error.code], {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      this.#logger.error('request failed', { path: route, error: (error as Error).message });
      this.#json(res, 500, { error: { code: 'upstream_failed', message: 'internal error' } });
    }
  }

  async #route(path: string, req: IncomingMessage, body: Buffer): Promise<number> {
    switch (path) {
      case PUSH_GATEWAY_PATHS.verify:
        return this.#verify(req, body);
      case PUSH_GATEWAY_PATHS.bind:
        return this.#bind(req, body);
      case PUSH_GATEWAY_PATHS.unbind:
        return this.#unbind(req, body);
      default:
        return this.#send(req, body);
    }
  }

  /** 手机要一个验证码：网关经这个令牌推给它，回 202。同一令牌再要时旧的作废。 */
  async #verify(req: IncomingMessage, body: Buffer): Promise<number> {
    const request = parse(PushVerifyRequestSchema, body);
    if (!this.#verifiesBySource.take(tag(this.#sourceOf(req)))) {
      throw new RequestError('rate_limited', 'too many verification requests from this address');
    }
    const key = bindingKey(request.routeId, request.platform, request.token);
    if (!this.#verifiesByToken.take(key)) {
      throw new RequestError('rate_limited', 'too many verification requests for this token');
    }
    this.#requirePlatform(request.platform);
    const code = randomBytes(PUSH_VERIFY_CODE_BYTES);
    const now = this.#now();
    this.#codes.delete(key);
    this.#codes.set(key, { code, expiresAt: now + PUSH_VERIFY_TTL_MS, attempts: 0 });
    this.#trimCodes(now);
    const result = await this.#deliver(request.platform, request.token, {
      kind: 'verify',
      code: code.toString('base64url'),
      expiresAt: now + PUSH_VERIFY_TTL_MS,
    });
    this.#logger.info('verification sent', {
      route: tag(request.routeId),
      token: tag(request.token),
      platform: request.platform,
      result: result.ok ? 'ok' : result.reason,
    });
    this.#upstreamError(result);
    return 202;
  }

  /** Host 带着验证码绑定。 */
  #bind(req: IncomingMessage, body: Buffer): number {
    const request = this.#signed(PushBindRequestSchema, PUSH_GATEWAY_PATHS.bind, req, body);
    const route = routeKey(request.routeId);
    if (!this.#bindsByRoute.take(route)) {
      throw new RequestError('rate_limited', 'too many binding changes for this computer');
    }
    const key = bindingKey(request.routeId, request.platform, request.token);
    const pending = this.#codes.get(key);
    const given = Buffer.from(request.code, 'base64url');
    if (pending === undefined || pending.expiresAt <= this.#now()) {
      this.#codes.delete(key);
      throw new RequestError('bad_code', 'verification code is wrong or expired');
    }
    if (given.length !== pending.code.length || !timingSafeEqual(given, pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= MAX_CODE_ATTEMPTS) this.#codes.delete(key);
      throw new RequestError('bad_code', 'verification code is wrong or expired');
    }
    this.#codes.delete(key);
    const added = this.#bindings.add(key, route, this.#limits.maxBindingsPerRoute);
    if (added === 'limit') {
      throw new RequestError('rate_limited', 'this computer has too many bound devices');
    }
    this.#logger.info('bound', {
      route: tag(request.routeId),
      token: tag(request.token),
      platform: request.platform,
    });
    return 200;
  }

  #unbind(req: IncomingMessage, body: Buffer): number {
    const request = this.#signed(PushUnbindRequestSchema, PUSH_GATEWAY_PATHS.unbind, req, body);
    if (!this.#bindsByRoute.take(routeKey(request.routeId))) {
      throw new RequestError('rate_limited', 'too many binding changes for this computer');
    }
    const removed = this.#bindings.remove(
      bindingKey(request.routeId, request.platform, request.token),
    );
    this.#logger.info('unbound', {
      route: tag(request.routeId),
      token: tag(request.token),
      removed,
    });
    return 200;
  }

  async #send(req: IncomingMessage, body: Buffer): Promise<number> {
    const request = this.#signed(PushSendRequestSchema, PUSH_GATEWAY_PATHS.send, req, body);
    const now = this.#now();
    if (request.expiresAt <= now || request.expiresAt > now + PUSH_MAX_TTL_MS) {
      throw new RequestError('bad_request', 'expiresAt is in the past or too far ahead');
    }
    const key = bindingKey(request.routeId, request.platform, request.token);
    if (!this.#bindings.has(key)) {
      throw new RequestError('not_bound', 'this token is not bound to this computer');
    }
    if (!this.#sendsByRoute.take(routeKey(request.routeId)) || !this.#sendsByToken.take(key)) {
      throw new RequestError('rate_limited', 'too many pushes');
    }
    this.#requirePlatform(request.platform);
    const result = await this.#deliver(request.platform, request.token, {
      kind: 'push',
      payload: request.payload,
      expiresAt: request.expiresAt,
      ...(request.collapseKey !== undefined && { collapseKey: request.collapseKey }),
    });
    this.#logger.info('push sent', {
      route: tag(request.routeId),
      token: tag(request.token),
      platform: request.platform,
      result: result.ok ? 'ok' : result.reason,
      ...(!result.ok && result.detail !== undefined && { detail: result.detail }),
    });
    if (!result.ok && result.reason === 'unregistered') this.#bindings.remove(key);
    this.#upstreamError(result);
    this.#bindings.touch(key, now);
    return 200;
  }

  // ── 签名、平台与转发 ─────────────────────────────────────────────────

  /** 解析签名请求：先验签（路由 ID 就是 Ed25519 公钥），再看时间戳与随机数。 */
  #signed<T extends { routeId: string; timestamp: number; nonce: string }>(
    schema: Parser<T>,
    path: string,
    req: IncomingMessage,
    body: Buffer,
  ): T {
    const request = parse(schema, body);
    const header = req.headers[PUSH_SIGNATURE_HEADER];
    const signature = typeof header === 'string' ? Buffer.from(header, 'base64url') : undefined;
    if (signature?.length !== 64 || !verifySignature(request.routeId, path, body, signature)) {
      throw new RequestError('bad_signature', 'signature does not verify');
    }
    if (Math.abs(this.#now() - request.timestamp) > PUSH_CLOCK_SKEW_MS) {
      throw new RequestError('stale_request', 'timestamp is too far from the gateway clock');
    }
    if (!this.#nonces.add(`${request.routeId}:${request.nonce}`)) {
      throw new RequestError('stale_request', 'nonce was already used');
    }
    return request;
  }

  #requirePlatform(platform: PushPlatform): void {
    const configured = platform === 'fcm' ? this.#fcm : this.#apns;
    if (configured === undefined) {
      throw new RequestError('platform_unavailable', `${platform} is not configured`);
    }
  }

  #deliver(
    platform: PushPlatform,
    token: string,
    message:
      | { kind: 'verify'; code: string; expiresAt: number }
      | { kind: 'push'; payload: string; expiresAt: number; collapseKey?: string },
  ): Promise<UpstreamResult> {
    const ttlSeconds = Math.max(1, Math.ceil((message.expiresAt - this.#now()) / 1000));
    const data: Record<string, string> =
      message.kind === 'verify'
        ? { [PUSH_DATA_KIND_KEY]: 'verify', [PUSH_DATA_CODE_KEY]: message.code }
        : { [PUSH_DATA_KIND_KEY]: 'push', [PUSH_DATA_PAYLOAD_KEY]: message.payload };
    if (platform === 'fcm') {
      return (this.#fcm as FcmSender).send({
        token,
        data,
        ttlSeconds,
        ...(message.kind === 'push' &&
          message.collapseKey !== undefined && { collapseKey: message.collapseKey }),
      });
    }
    const verifying = message.kind === 'verify';
    return (this.#apns as ApnsSender).send({
      token,
      sandbox: platform === 'apns_sandbox',
      pushType: verifying ? 'background' : 'alert',
      priority: verifying ? 5 : 10,
      expiration: Math.floor(message.expiresAt / 1000),
      ...(message.kind === 'push' &&
        message.collapseKey !== undefined && { collapseId: message.collapseKey }),
      payload: {
        aps: verifying
          ? { 'content-available': 1 }
          : {
              alert: {
                'title-loc-key': PUSH_APNS_TITLE_LOC_KEY,
                'loc-key': PUSH_APNS_BODY_LOC_KEY,
              },
              'mutable-content': 1,
              sound: 'default',
            },
        ...data,
      },
    });
  }

  #upstreamError(result: UpstreamResult): void {
    if (result.ok) return;
    if (result.reason === 'unregistered') {
      throw new RequestError('unregistered', 'the push service no longer accepts this token');
    }
    if (result.reason === 'rate_limited') {
      throw new RequestError('rate_limited', 'the push service is throttling this token');
    }
    throw new RequestError('upstream_failed', 'the push service did not accept the push');
  }

  #trimCodes(now: number): void {
    for (const [key, pending] of this.#codes) {
      if (pending.expiresAt > now && this.#codes.size <= MAX_PENDING_CODES) break;
      this.#codes.delete(key);
    }
  }

  #sourceOf(req: IncomingMessage): string {
    if (this.#trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
      const last = value?.split(',').at(-1)?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? '';
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  }
}

export function createPushGateway(options?: PushGatewayOptions): PushGatewayServer {
  return new PushGatewayServer(options);
}

function parse<T>(schema: Parser<T>, body: Buffer): T {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new RequestError('bad_request', 'body is not JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestError('bad_request', 'body does not match the schema');
  return parsed.data;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > PUSH_REQUEST_MAX_BYTES) {
        req.destroy();
        reject(new RequestError('bad_request', 'body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(routeId: string, path: string, body: Buffer, signature: Buffer): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: routeId }, format: 'jwk' });
    return verify(null, pushSignatureMessage(path, body), key, signature);
  } catch {
    return false;
  }
}

/** 日志里用的：哈希的前 12 位十六进制。 */
export function tag(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
