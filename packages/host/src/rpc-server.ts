import { createServer, type IncomingMessage, type Server, STATUS_CODES } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  type ClientIdentity,
  CONNECTION_LEASE_MS,
  HELLO_TIMEOUT_MS,
  type HostId,
  SEND_BUFFER_LIMIT_BYTES,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { WebSocketServer } from 'ws';
import type { EventStore } from './event-store.js';
import type { HostMethods } from './host-methods.js';
import {
  type ConnectionHost,
  type ConnectionLimits,
  RpcConnection,
  tokenDigest,
} from './rpc-connection.js';

/** Host 只监听 loopback（ADR-0002 §1）。 */
export const RPC_LISTEN_HOST = '127.0.0.1';

/** `close()` 等在途请求结束的默认上限。 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

/** 主动关闭连接后等对方回关闭帧的时限。 */
export const CLOSE_HANDSHAKE_TIMEOUT_MS = 2000;

/** 补发时每批读取的事件数。 */
export const REPLAY_BATCH_SIZE = 256;

export interface HostRpcServerOptions {
  /** 本次启动的令牌（ADR-0002 §2）。只在内存里比较摘要，不写日志。 */
  token: string;
  hostId: HostId;
  /** Host 软件版本，写进 hello 结果与 `METHOD_NOT_FOUND` / `INCOMPATIBLE_PROTOCOL` 的 `data`。 */
  hostVersion: string;
  storage: Storage;
  events: EventStore;
  /** 业务方法的实现，通常由 `createHostMethods` 构造。 */
  methods: HostMethods;
  /** 默认 0：由系统分配，`listen()` 之后从 `url` / `port` 读取。 */
  port?: number;
  /**
   * 带 `Origin` 头的升级请求只放行这些 origin（精确匹配）；不带 `Origin` 的（CLI、测试）一律放行。
   * 桌面渲染进程的 origin 由 T5.1 补充。
   */
  allowedOrigins?: readonly string[];
  /**
   * 方法返回值不合注册表时：`strict` 改回 `INTERNAL_ERROR`，`warn` 照发原值；两者都交给 `onError`。
   * 默认 `NODE_ENV === 'production'` 时 `warn`，否则 `strict`。
   */
  resultValidation?: 'strict' | 'warn';
  /** 默认 `HELLO_TIMEOUT_MS`。 */
  helloTimeoutMs?: number;
  /** 默认 `CONNECTION_LEASE_MS`。 */
  leaseMs?: number;
  /** 默认 `SEND_BUFFER_LIMIT_BYTES`。 */
  sendBufferLimitBytes?: number;
  /** 默认 `CLOSE_HANDSHAKE_TIMEOUT_MS`。 */
  closeTimeoutMs?: number;
  /** 默认 `REPLAY_BATCH_SIZE`。 */
  replayBatchSize?: number;
  /**
   * 收到 `host.shutdown` 并已回 `{}` 之后调用，由进程入口按 ADR-0002 §6 的顺序优雅退出（T2.5）。
   * 不给时只关闭本服务（`close()`）。
   */
  onShutdownRequest?: (client: ClientIdentity) => void;
  /** Host 自己的错误：方法抛出的非 `HostError`、返回值不合 schema 等。默认打到 stderr。 */
  onError?: (error: unknown) => void;
}

/**
 * Host 的 WebSocket JSON-RPC 服务（ADR-0002 §1–§5，host-api.md）。
 *
 * - 只监听 `127.0.0.1`，端口默认由系统分配。
 * - WebSocket 升级前校验 `Host` 头（只允许 `127.0.0.1:<port>` 与 `localhost:<port>`，缺失也拒绝）与
 *   `Origin` 白名单，不通过一律 403，不会走到 JSON-RPC 层。非升级的 HTTP 请求回 426。
 * - 每条连接的协议细节见 `RpcConnection`。
 * - `close()`：停止接受新连接，新请求回 `HOST_SHUTTING_DOWN`，等在途请求结束（有上限），再以
 *   `GOING_AWAY` 关闭所有连接。
 */
export class HostRpcServer {
  readonly #options: HostRpcServerOptions;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #connectionHost: ConnectionHost;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<RpcConnection>();
  #http: Server | undefined;
  #port: number | undefined;
  #shuttingDown = false;
  #closing: Promise<void> | undefined;

  constructor(options: HostRpcServerOptions) {
    if (options.token === '') throw new Error('token 不能为空');
    this.#options = options;
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    const onError =
      options.onError ?? ((error: unknown) => console.error('[wevir-host] rpc:', error));
    const limits: ConnectionLimits = {
      helloTimeoutMs: options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
      leaseMs: options.leaseMs ?? CONNECTION_LEASE_MS,
      sendBufferLimitBytes: options.sendBufferLimitBytes ?? SEND_BUFFER_LIMIT_BYTES,
      closeTimeoutMs: options.closeTimeoutMs ?? CLOSE_HANDSHAKE_TIMEOUT_MS,
      replayBatchSize: options.replayBatchSize ?? REPLAY_BATCH_SIZE,
    };
    const server = this;
    this.#connectionHost = {
      hostId: options.hostId,
      hostVersion: options.hostVersion,
      tokenDigest: tokenDigest(options.token),
      storage: options.storage,
      events: options.events,
      methods: options.methods,
      limits,
      resultValidation:
        options.resultValidation ?? (process.env.NODE_ENV === 'production' ? 'warn' : 'strict'),
      get shuttingDown() {
        return server.#shuttingDown;
      },
      requestShutdown: (client) => {
        if (options.onShutdownRequest) options.onShutdownRequest(client);
        else void this.close();
      },
      onError,
    };
    this.#wss = new WebSocketServer({ noServer: true, clientTracking: false });
  }

  /** 开始监听，返回端点 URL。 */
  async listen(): Promise<string> {
    if (this.#http) throw new Error('已经在监听');
    const http = createServer();
    http.on('request', (_req, res) => {
      res.writeHead(426, { Connection: 'close', 'Content-Type': 'text/plain' });
      res.end(STATUS_CODES[426]);
    });
    http.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    http.on('clientError', (_error, socket) => socket.destroy());
    this.#http = http;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen({ host: RPC_LISTEN_HOST, port: this.#options.port ?? 0 }, () => {
        http.off('error', reject);
        resolve();
      });
    });
    this.#port = (http.address() as AddressInfo).port;
    return this.url;
  }

  /** 完整端点 URL，写进 `run/host.json`（T2.5），客户端照用。 */
  get url(): string {
    return `ws://${RPC_LISTEN_HOST}:${this.port}/`;
  }

  get port(): number {
    if (this.#port === undefined) throw new Error('尚未监听');
    return this.#port;
  }

  /** 当前打开的连接数（含尚未 hello 的）。 */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** 所有连接上的订阅数之和。 */
  get subscriptionCount(): number {
    let count = 0;
    for (const connection of this.#connections) count += connection.subscriptionCount;
    return count;
  }

  /**
   * 优雅关闭：停止接受新连接，之后到达的请求回 `HOST_SHUTTING_DOWN`；尚未 hello 的连接立即关闭；
   * 等在途请求结束（最多 `drainTimeoutMs`），再以 `GOING_AWAY` 关闭所有连接，对方迟迟不回关闭帧的
   * 直接断开。可重复调用，返回同一个 Promise。
   */
  close(options: { drainTimeoutMs?: number } = {}): Promise<void> {
    this.#closing ??= this.#shutdown(options.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS);
    return this.#closing;
  }

  async #shutdown(drainTimeoutMs: number): Promise<void> {
    this.#shuttingDown = true;
    const http = this.#http;
    const stopped = new Promise<void>((resolve) => {
      if (!http?.listening) resolve();
      else http.close(() => resolve());
    });
    for (const connection of this.#connections) if (!connection.client) connection.goAway();
    await withTimeout(
      Promise.all([...this.#connections].map((connection) => connection.settle())),
      drainTimeoutMs,
    );
    for (const connection of this.#connections) connection.goAway();
    const closeTimeout = this.#connectionHost.limits.closeTimeoutMs;
    await withTimeout(
      Promise.all([...this.#connections].map((connection) => connection.closed)),
      closeTimeout,
    );
    for (const connection of this.#connections) connection.terminate();
    await Promise.all([...this.#connections].map((connection) => connection.closed));
    // 还没发出升级请求的 TCP 连接也不等它超时。
    http?.closeAllConnections();
    await stopped;
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    if (this.#shuttingDown) {
      rejectUpgrade(socket, 503);
      return;
    }
    if (!this.#isAllowedHost(req.headers.host)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const origin = req.headers.origin ?? req.headers['sec-websocket-origin'];
    if (origin !== undefined && !this.#allowedOrigins.has(String(origin))) {
      rejectUpgrade(socket, 403);
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      if (this.#shuttingDown) {
        ws.terminate();
        return;
      }
      const connection = new RpcConnection(ws, this.#connectionHost);
      this.#connections.add(connection);
      void connection.closed.then(() => this.#connections.delete(connection));
    });
  }

  /** 只允许 `127.0.0.1:<port>` 与 `localhost:<port>`（主机名不分大小写）；缺失也拒绝。 */
  #isAllowedHost(host: string | undefined): boolean {
    if (host === undefined) return false;
    const value = host.toLowerCase();
    return value === `${RPC_LISTEN_HOST}:${this.#port}` || value === `localhost:${this.#port}`;
  }
}

/** 在升级前拒绝：写一个最小的 HTTP 响应并关闭套接字。 */
function rejectUpgrade(socket: Duplex, status: 403 | 503): void {
  const body = STATUS_CODES[status] ?? '';
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
