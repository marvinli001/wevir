import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  RELAY_ACCEPT_PARAM,
  RELAY_CONNECTION_ID_BYTES,
  RELAY_CONTROL_MAX_BYTES,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_NONCE_BYTES,
  RELAY_PATHS,
  RELAY_ROUTE_PARAM,
  REMOTE_PATHS,
  RelayCloseCode,
  type RelayDevicePath,
  RelayHostMessageSchema,
  type RelayServerMessage,
  relayRegistrationMessage,
} from '@wevir/protocol';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_RELAY_LIMITS, type RelayLimits, SourceLimiter, TokenBucket } from './limits.js';
import { type RelayLogger, silentLogger } from './log.js';

/** 主动关闭后等对方回关闭帧的时限。 */
const CLOSE_TIMEOUT_MS = 2000;
/** 暂停读一侧之后，至少隔多久再看一次能不能接着读。 */
const THROTTLE_RECHECK_MS = 20;
/** 健康检查等普通 HTTP 请求的头与整个请求的时限。 */
const HTTP_TIMEOUT_MS = 10_000;

export type RelayDirection = 'device-to-host' | 'host-to-device';

/** 中继转发的一条消息（只给测试看中继到底看到了什么）。 */
export interface RelayTapEvent {
  readonly route: string;
  readonly direction: RelayDirection;
  readonly data: Uint8Array;
}

export interface RelayServerOptions {
  limits?: Partial<RelayLimits>;
  logger?: RelayLogger;
  /**
   * 在反向代理（Caddy、nginx）后面：来源地址取 `X-Forwarded-For` 的最后一项（代理追加的那一项）。直接对外时不要打开，不然谁都能
   * 伪造来源地址绕过限速。
   */
  trustProxy?: boolean;
  /** 直接提供 WSS：PEM 格式的证书链与私钥。省略时是 ws://，由前面的反向代理终结 TLS。 */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** 只给测试：每条转发的消息。 */
  tap?: (event: RelayTapEvent) => void;
  now?: () => number;
}

/** 一个注册了的路由 ID：一台 Host。 */
interface Route {
  readonly routeId: string;
  /** 日志里用的：路由 ID 哈希的前几位。 */
  readonly tag: string;
  control: WebSocket;
  /** 这个路由 ID 上等 Host 接上的与接通的设备连接。 */
  connections: number;
}

/** 一条设备连接，Host 接上数据连接之前是“等着的”。 */
interface Pipe {
  readonly id: string;
  readonly route: Route;
  readonly device: WebSocket;
  host: WebSocket | undefined;
  readonly queue: Buffer[];
  queuedBytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly up: Flow;
  readonly down: Flow;
  readonly openedAt: number;
  closed: boolean;
}

/** 一个方向的转发：限速与背压。 */
interface Flow {
  readonly bucket: TokenBucket;
  bytes: number;
  throttle: ReturnType<typeof setTimeout> | undefined;
}

export interface RelayStats {
  routes: number;
  /** 接通的设备连接。 */
  connections: number;
  /** 等 Host 接上的设备连接。 */
  pending: number;
}

/**
 * Wevir 的中继（ADR-0017 §1–§2，apps/relay/README.md）：给不在同一网络、没有 Tailscale 的设备一条路。
 *
 * - **Host 注册路由 ID**：Host 连上 `/v1/host`，中继发一个随机数，Host 用路由密钥（Ed25519，公钥就是路由 ID）签名回答；签名对了
 *   才注册。同一路由 ID 再次注册成功时取代旧的控制连接（`ROUTE_REPLACED`）。
 * - **设备经路由 ID 连 Host**：设备连 `/v1/connect?route=…`（或两个配对路径），中继在控制连接上告诉 Host 有一条新连接（带随机 ID
 *   与来源的不透明标记），Host 为它另开一条 `/v1/accept?id=…` 的数据连接，中继把两条一对一接起来。Host 没在线时直接 404。
 * - **只转发**：数据连接上一条二进制消息原样转给对端，不解密、不落盘、不记录内容；文本消息断开。Host 接上之前设备先到的消息
 *   短暂排队（条数与字节有上限），**不做离线缓冲**：任一侧断开，另一侧随之关闭，关闭码原样带过去（Host 的 `DEVICE_REVOKED`
 *   等），之后的消息无处可去。Noise 会话随连接结束，补齐靠 JSON-RPC 的 `seq`。
 * - **限制**：路由数、每个路由的连接数、总连接数、每个来源的连接数与发起频率、每条连接每个方向的带宽（令牌桶，超了暂停读那一侧）
 *   与对端发送缓冲的背压。每条连接定时 ping，不回 pong 的断开。
 */
export class RelayServer {
  readonly #limits: RelayLimits;
  readonly #logger: RelayLogger;
  readonly #trustProxy: boolean;
  readonly #tap: RelayServerOptions['tap'];
  readonly #now: () => number;
  readonly #server: Server;
  readonly #sources: SourceLimiter;
  /** 来源地址的标记用的盐：每个进程随机，Host 拿到的标记不能反推地址，也不能跨中继重启关联。 */
  readonly #salt = randomBytes(32);
  readonly #controlWss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: RELAY_CONTROL_MAX_BYTES,
  });
  readonly #dataWss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: RELAY_MAX_MESSAGE_BYTES,
  });
  readonly #routes = new Map<string, Route>();
  /** 等 Host 接上的设备连接，按连接 ID。 */
  readonly #pending = new Map<string, Pipe>();
  readonly #pipes = new Set<Pipe>();
  /** 所有升级了的 WebSocket 与上一次 ping 之后有没有回音。 */
  readonly #alive = new Map<WebSocket, boolean>();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #startedAt: number;
  #closed = false;

  constructor(options: RelayServerOptions = {}) {
    this.#limits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
    this.#logger = options.logger ?? silentLogger;
    this.#trustProxy = options.trustProxy === true;
    this.#tap = options.tap;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#sources = new SourceLimiter(this.#limits, this.#now);
    const handler = (req: IncomingMessage, res: ServerResponse) => this.#http(req, res);
    this.#server =
      options.tls === undefined
        ? createHttpServer(handler)
        : createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler);
    this.#server.headersTimeout = HTTP_TIMEOUT_MS;
    this.#server.requestTimeout = HTTP_TIMEOUT_MS;
    this.#server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    this.#server.on('clientError', (_error, socket) => socket.destroy());
    this.#heartbeat = setInterval(() => this.#ping(), this.#limits.pingIntervalMs);
    this.#heartbeat.unref?.();
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

  stats(): RelayStats {
    return {
      routes: this.#routes.size,
      connections: [...this.#pipes].filter((pipe) => pipe.host !== undefined).length,
      pending: this.#pending.size,
    };
  }

  /** 停止接受新连接，以 1001 关闭全部连接。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    for (const ws of [...this.#alive.keys()]) closeWs(ws, 1001, 'relay shutting down');
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    for (const ws of [...this.#alive.keys()]) ws.terminate();
  }

  // ── HTTP 与升级 ─────────────────────────────────────────────────────

  #http(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?', 1)[0];
    if (path === RELAY_PATHS.health && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = JSON.stringify({
        status: 'ok',
        ...this.stats(),
        uptimeSeconds: Math.floor((this.#now() - this.#startedAt) / 1000),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(404, { Connection: 'close', 'Content-Length': 0 });
    res.end();
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    if (this.#closed) {
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relay');
    } catch {
      rejectUpgrade(socket, 404);
      return;
    }
    if (this.#alive.size >= this.#limits.maxConnections) {
      rejectUpgrade(socket, 503);
      return;
    }
    const source = this.#sourceOf(req);
    const release = this.#sources.begin(source);
    if (release === undefined) {
      this.#logger.debug('connection rate limited', { source: this.#sourceTag(source) });
      rejectUpgrade(socket, 429);
      return;
    }
    socket.once('close', release);
    const path = url.pathname;
    if (path === RELAY_PATHS.host) {
      this.#controlWss.handleUpgrade(req, socket, head, (ws) => this.#control(ws));
      return;
    }
    if (path === RELAY_PATHS.accept) {
      const pipe = this.#pending.get(url.searchParams.get(RELAY_ACCEPT_PARAM) ?? '');
      if (pipe === undefined) {
        rejectUpgrade(socket, 404);
        return;
      }
      // 先占住：同一个 ID 只能接一次。
      this.#pending.delete(pipe.id);
      this.#dataWss.handleUpgrade(req, socket, head, (ws) => this.#accept(pipe, ws));
      return;
    }
    if (isDevicePath(path)) {
      const route = this.#routes.get(url.searchParams.get(RELAY_ROUTE_PARAM) ?? '');
      if (route === undefined) {
        rejectUpgrade(socket, 404);
        return;
      }
      if (route.connections >= this.#limits.maxConnectionsPerRoute) {
        rejectUpgrade(socket, 503);
        return;
      }
      this.#dataWss.handleUpgrade(req, socket, head, (ws) =>
        this.#incoming(route, ws, path, source),
      );
      return;
    }
    rejectUpgrade(socket, 404);
  }

  // ── Host 的控制连接 ─────────────────────────────────────────────────

  #control(ws: WebSocket): void {
    this.#track(ws);
    const nonce = randomBytes(RELAY_NONCE_BYTES).toString('base64url');
    let route: Route | undefined;
    const timer = setTimeout(
      () => closeWs(ws, RelayCloseCode.REGISTRATION_FAILED, 'registration timed out'),
      this.#limits.registerTimeoutMs,
    );
    timer.unref?.();
    sendJson(ws, { type: 'challenge', nonce });

    ws.on('message', (data, isBinary) => {
      const parsed = isBinary ? undefined : parseHostMessage(data);
      if (route === undefined) {
        if (parsed?.type !== 'register' || !verifyRegistration(parsed, nonce)) {
          clearTimeout(timer);
          this.#logger.info('host registration failed');
          closeWs(ws, RelayCloseCode.REGISTRATION_FAILED, 'registration failed');
          return;
        }
        clearTimeout(timer);
        const existing = this.#routes.get(parsed.routeId);
        if (existing === undefined && this.#routes.size >= this.#limits.maxRoutes) {
          this.#logger.warn('route limit reached');
          closeWs(ws, RelayCloseCode.LIMIT_EXCEEDED, 'too many routes');
          return;
        }
        if (existing !== undefined) {
          const previous = existing.control;
          existing.control = ws;
          route = existing;
          closeWs(previous, RelayCloseCode.ROUTE_REPLACED, 'route registered again');
          this.#logger.info('host registration replaced', { route: existing.tag });
        } else {
          route = {
            routeId: parsed.routeId,
            tag: routeTag(parsed.routeId),
            control: ws,
            connections: 0,
          };
          this.#routes.set(parsed.routeId, route);
          this.#logger.info('host registered', { route: route.tag });
        }
        sendJson(ws, { type: 'registered' });
        return;
      }
      if (parsed?.type === 'reject') {
        const pipe = this.#pending.get(parsed.id);
        if (pipe === undefined || pipe.route !== route) return;
        this.#pending.delete(pipe.id);
        this.#closePipe(pipe, 'device', RelayCloseCode.HOST_REJECTED, 'rejected by the host');
        return;
      }
      closeWs(ws, RelayCloseCode.PROTOCOL_ERROR, 'unexpected control message');
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (route === undefined || route.control !== ws) return;
      this.#routes.delete(route.routeId);
      this.#logger.info('host disconnected', { route: route.tag });
      // 还没接上的设备连接无处可去；接通了的各自有数据连接，照常走到断开。
      for (const pipe of [...this.#pending.values()]) {
        if (pipe.route !== route) continue;
        this.#pending.delete(pipe.id);
        this.#closePipe(pipe, 'device', RelayCloseCode.HOST_UNAVAILABLE, 'host went offline');
      }
    });
  }

  // ── 设备连接与数据连接 ──────────────────────────────────────────────

  #incoming(route: Route, device: WebSocket, path: RelayDevicePath, source: string): void {
    this.#track(device);
    const id = randomBytes(RELAY_CONNECTION_ID_BYTES).toString('base64url');
    const flow = (): Flow => ({
      bucket: new TokenBucket(this.#limits.bytesPerSecond, this.#limits.burstBytes, this.#now),
      bytes: 0,
      throttle: undefined,
    });
    const pipe: Pipe = {
      id,
      route,
      device,
      host: undefined,
      queue: [],
      queuedBytes: 0,
      timer: undefined,
      up: flow(),
      down: flow(),
      openedAt: this.#now(),
      closed: false,
    };
    route.connections += 1;
    this.#pending.set(id, pipe);
    this.#pipes.add(pipe);
    pipe.timer = setTimeout(() => {
      // 数据连接的升级没成功时它已经不在 #pending 里了，照样到时关闭。
      if (pipe.host !== undefined) return;
      this.#pending.delete(id);
      this.#closePipe(pipe, 'device', RelayCloseCode.HOST_UNAVAILABLE, 'host did not answer');
    }, this.#limits.acceptTimeoutMs);
    pipe.timer.unref?.();

    device.on('message', (data, isBinary) => {
      if (pipe.closed) return;
      if (!isBinary) {
        this.#closePipe(pipe, 'both', RelayCloseCode.PROTOCOL_ERROR, 'binary messages only');
        return;
      }
      const bytes = toBuffer(data);
      if (pipe.host === undefined) {
        pipe.queue.push(bytes);
        pipe.queuedBytes += bytes.length;
        if (
          pipe.queue.length > this.#limits.maxQueuedMessages ||
          pipe.queuedBytes > this.#limits.maxQueuedBytes
        ) {
          this.#pending.delete(pipe.id);
          this.#closePipe(pipe, 'device', RelayCloseCode.LIMIT_EXCEEDED, 'too much queued');
        }
        return;
      }
      this.#forward(pipe, 'device-to-host', bytes);
    });
    device.on('close', (code, reason) => {
      if (this.#pending.get(pipe.id) === pipe) this.#pending.delete(pipe.id);
      // 设备异常断开（1006）时 Host 那侧也直接断开，与直连时看到的一样。
      this.#closePipe(pipe, 'host', passable(code) ? code : undefined, reason);
    });
    sendJson(route.control, {
      type: 'incoming',
      id,
      path,
      source: this.#sourceTag(source),
    });
  }

  #accept(pipe: Pipe, host: WebSocket): void {
    this.#track(host);
    if (pipe.closed) {
      host.terminate();
      return;
    }
    clearTimeout(pipe.timer);
    pipe.host = host;
    host.on('message', (data, isBinary) => {
      if (pipe.closed) return;
      if (!isBinary) {
        this.#closePipe(pipe, 'both', RelayCloseCode.PROTOCOL_ERROR, 'binary messages only');
        return;
      }
      this.#forward(pipe, 'host-to-device', toBuffer(data));
    });
    host.on('close', (code, reason) => {
      // Host 的关闭码（DEVICE_REVOKED 等）原样带给设备。Host 不发关闭帧直接断开时（握手失败、进程退出）设备那侧也直接断开，与
      // 直连时看到的一样。
      this.#closePipe(pipe, 'device', passable(code) ? code : undefined, reason);
    });
    this.#logger.debug('connection opened', { route: pipe.route.tag });
    for (const bytes of pipe.queue.splice(0)) this.#forward(pipe, 'device-to-host', bytes);
    pipe.queuedBytes = 0;
  }

  #forward(pipe: Pipe, direction: RelayDirection, bytes: Buffer): void {
    const toHost = direction === 'device-to-host';
    const from = toHost ? pipe.device : (pipe.host as WebSocket);
    const to = toHost ? (pipe.host as WebSocket) : pipe.device;
    const flow = toHost ? pipe.up : pipe.down;
    this.#tap?.({ route: pipe.route.routeId, direction, data: bytes });
    to.send(bytes, { binary: true });
    flow.bytes += bytes.length;
    flow.bucket.take(bytes.length);
    this.#throttle(pipe, flow, from, to);
  }

  /** 超了带宽或对端发不出去时暂停读 `from`，过一会儿再看。 */
  #throttle(pipe: Pipe, flow: Flow, from: WebSocket, to: WebSocket): void {
    if (flow.throttle !== undefined || pipe.closed) return;
    const wait = flow.bucket.waitMs();
    if (wait === 0 && to.bufferedAmount <= this.#limits.highWaterBytes) return;
    from.pause();
    flow.throttle = setTimeout(
      () => {
        flow.throttle = undefined;
        if (pipe.closed) return;
        from.resume();
        this.#throttle(pipe, flow, from, to);
      },
      Math.max(wait, THROTTLE_RECHECK_MS),
    );
    flow.throttle.unref?.();
  }

  /**
   * 结束一条设备连接：以 `code` 关掉指定的一侧（另一侧已经关了或正要关）；`code` 为 undefined 时直接断开，不发关闭帧。只做一次。
   */
  #closePipe(
    pipe: Pipe,
    side: 'device' | 'host' | 'both',
    code: number | undefined,
    reason: Buffer | string,
  ): void {
    if (pipe.closed) return;
    pipe.closed = true;
    clearTimeout(pipe.timer);
    clearTimeout(pipe.up.throttle);
    clearTimeout(pipe.down.throttle);
    this.#pipes.delete(pipe);
    pipe.route.connections -= 1;
    const text = String(reason);
    const end = (ws: WebSocket) => (code === undefined ? ws.terminate() : closeWs(ws, code, text));
    if (side !== 'host') end(pipe.device);
    // 只关设备一侧时 Host 那侧多半已经关了；还开着的话（中继自己结束的）告诉它设备走了。
    if (pipe.host !== undefined) {
      if (side === 'device') closeWs(pipe.host, 1001, '');
      else end(pipe.host);
    }
    if (pipe.host !== undefined) {
      this.#logger.debug('connection closed', {
        route: pipe.route.tag,
        code,
        seconds: Math.round((this.#now() - pipe.openedAt) / 1000),
        bytesUp: pipe.up.bytes,
        bytesDown: pipe.down.bytes,
      });
    }
  }

  // ── 心跳与来源 ──────────────────────────────────────────────────────

  #track(ws: WebSocket): void {
    this.#alive.set(ws, true);
    const alive = () => this.#alive.has(ws) && this.#alive.set(ws, true);
    ws.on('pong', alive);
    ws.on('ping', alive);
    ws.on('message', alive);
    ws.on('error', () => {});
    ws.on('close', () => this.#alive.delete(ws));
  }

  #ping(): void {
    for (const [ws, alive] of this.#alive) {
      if (!alive) {
        ws.terminate();
        continue;
      }
      this.#alive.set(ws, false);
      ws.ping();
    }
  }

  #sourceOf(req: IncomingMessage): string {
    if (this.#trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
      const last = value?.split(',').at(-1)?.trim();
      if (last !== undefined && last !== '') return last;
    }
    return req.socket.remoteAddress ?? '';
  }

  /** 来源地址的不透明标记：HMAC 的前 12 字节。 */
  #sourceTag(source: string): string {
    return createHmac('sha256', this.#salt)
      .update(source)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  return new RelayServer(options);
}

const DEVICE_PATHS = new Set<string>(Object.values(REMOTE_PATHS));

function isDevicePath(path: string): path is RelayDevicePath {
  return DEVICE_PATHS.has(path);
}

function parseHostMessage(data: RawData) {
  try {
    const parsed = RelayHostMessageSchema.safeParse(JSON.parse(toBuffer(data).toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function verifyRegistration(
  message: { routeId: string; signature: string },
  nonce: string,
): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: message.routeId },
      format: 'jwk',
    });
    return verify(
      null,
      relayRegistrationMessage(nonce),
      key,
      Buffer.from(message.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function routeTag(routeId: string): string {
  return createHash('sha256').update(routeId).digest('hex').slice(0, 12);
}

/** 能原样转给对端的关闭码：正常关闭、离开与应用私有码。1005 / 1006 这类不能发出去。 */
function passable(code: number): boolean {
  return code === 1000 || code === 1001 || (code >= 3000 && code <= 4999);
}

function sendJson(ws: WebSocket, message: RelayServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** 以关闭码关闭，对方不回关闭帧时直接断开。关闭原因最长 123 字节。 */
function closeWs(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) return;
  ws.close(code, Buffer.from(reason).subarray(0, 123).toString());
  const timer = setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MS);
  timer.unref?.();
  ws.once('close', () => clearTimeout(timer));
}

/** 升级前拒绝：最小的 HTTP 响应，然后关闭。 */
function rejectUpgrade(socket: Duplex, status: 404 | 429 | 503): void {
  const body = STATUS_CODES[status] ?? '';
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
