import { ed25519 } from '@noble/curves/ed25519.js';
import { MAX_MESSAGE_LENGTH } from '@wevir/noise';
import {
  CloseCode,
  RELAY_ACCEPT_PARAM,
  RELAY_CONTROL_MAX_BYTES,
  RELAY_DEFAULT_URL,
  RELAY_PATHS,
  RelayCloseCode,
  type RelayDevicePath,
  type RelayHostMessage,
  type RelayServerMessage,
  RelayServerMessageSchema,
  type RemoteRelayStatus,
  type RemoteSettings,
  relayEndpoint,
  relayRegistrationMessage,
} from '@wevir/protocol';
import { type RawData, WebSocket } from 'ws';
import type { RemoteIdentity } from './identity.js';

/** 第一次重连前等多久；之后每次翻倍，带随机抖动。 */
export const RELAY_BACKOFF_MS = 1000;
/** 重连间隔的上限。 */
export const RELAY_MAX_BACKOFF_MS = 60_000;
/** 多久 ping 一次中继；上一次的 ping 没回 pong 就断开重连。 */
export const RELAY_PING_MS = 30_000;
/** 连中继（TCP + TLS + WebSocket 升级）的时限。 */
const RELAY_CONNECT_TIMEOUT_MS = 10_000;
/** 主动关闭后等中继回关闭帧的时限。 */
const CLOSE_TIMEOUT_MS = 2000;

/** 远程监听收下一条经中继来的连接：返回 undefined 时拒绝（没开配对窗口、限速）。 */
export interface RelayAdmission {
  /** 数据连接连上了：开始握手。 */
  start(ws: WebSocket): void;
  /** 数据连接没连上。 */
  cancel(): void;
}

export interface RelayClientOptions {
  /** Host 设置的 `remote`。 */
  settings: () => RemoteSettings | undefined;
  identity: Pick<RemoteIdentity, 'ensure'>;
  /** 有设备经中继来连（listener.ts 的 `admitRelayed`）。 */
  admit: (path: RelayDevicePath, source: string) => RelayAdmission | undefined;
  /** 状态变了。 */
  onChange: () => void;
  onError?: (error: unknown) => void;
  backoffMs?: number;
  maxBackoffMs?: number;
  pingMs?: number;
}

/**
 * Host 到中继的出站连接（ADR-0017 §1，host-api.md「中继」）：远程访问与中继都开着时连上中继的 `/v1/host`，用路由密钥（Ed25519）
 * 签名中继的挑战注册路由 ID；之后中继每通知一条设备连接，就为它另开一条 `/v1/accept?id=…` 的数据连接交给远程监听，走与直连相同的
 * 握手与分发。断线按指数退避重连（带抖动，上限一分钟），注册成功后退避清零。关掉中继或换了地址时断开控制连接与经它来的全部连接
 * （`REMOTE_DISABLED`）。中继只见路由 ID、连接的起止、消息的长度与时间。
 */
export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #onError: (error: unknown) => void;
  /** 当前要连的中继地址；关着时 undefined。 */
  #url: string | undefined;
  #control: WebSocket | undefined;
  #state: RemoteRelayStatus['state'] = 'connecting';
  #error: RemoteRelayStatus['error'];
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  /** 经这个中继开的数据连接（握手中的与握手完成的）。 */
  readonly #sockets = new Set<WebSocket>();
  /** 每次换地址或关掉加一，旧连接的回调据此作废。 */
  #generation = 0;
  #closed = false;

  constructor(options: RelayClientOptions) {
    this.#options = options;
    this.#onError = options.onError ?? (() => {});
  }

  /** 按当前设置连上、换地址或断开。设置变了时调用。 */
  refresh(): void {
    if (this.#closed) return;
    const settings = this.#options.settings();
    const url =
      settings?.enabled === true && settings.relay.enabled
        ? (settings.relay.url ?? RELAY_DEFAULT_URL)
        : undefined;
    if (url === this.#url) return;
    this.#stop();
    this.#url = url;
    this.#attempt = 0;
    this.#error = undefined;
    this.#state = 'connecting';
    if (url !== undefined) this.#connect();
    this.#options.onChange();
  }

  /** 开着中继时的地址（二维码与握手负载）。 */
  get url(): string | undefined {
    return this.#url;
  }

  /** `remote.status` 的 `relay`；中继关着时 undefined。`connections` 由远程监听填。 */
  status(connections: number): RemoteRelayStatus | undefined {
    if (this.#url === undefined) return undefined;
    return {
      state: this.#state,
      url: this.#url,
      connections,
      ...(this.#error !== undefined && { error: this.#error }),
    };
  }

  /** 经中继开的数据连接（Host 退出时由远程监听断开还没交给 JSON-RPC 的）。 */
  get sockets(): ReadonlySet<WebSocket> {
    return this.#sockets;
  }

  /** Host 退出：关掉控制连接，不再重连。数据连接由远程监听与 RPC 服务关闭。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    clearTimeout(this.#retry);
    clearInterval(this.#ping);
    if (this.#control !== undefined) closeWs(this.#control, 1001, 'host shutting down');
    this.#control = undefined;
  }

  // ── 控制连接 ────────────────────────────────────────────────────────

  /** 断开控制连接与经它来的全部连接。 */
  #stop(): void {
    this.#generation += 1;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    clearInterval(this.#ping);
    this.#ping = undefined;
    if (this.#control !== undefined) closeWs(this.#control, 1000, 'relay turned off');
    this.#control = undefined;
    for (const ws of [...this.#sockets]) closeWs(ws, CloseCode.REMOTE_DISABLED, 'relay turned off');
    this.#sockets.clear();
  }

  #connect(): void {
    const url = this.#url;
    if (url === undefined || this.#closed) return;
    const generation = this.#generation;
    void this.#options.identity.ensure().then(
      (keys) => {
        if (generation !== this.#generation) return;
        this.#open(url, generation, keys.route.secretKey, keys.routeId);
      },
      (error: unknown) => {
        if (generation !== this.#generation) return;
        this.#onError(error);
        this.#failed(generation, 'unreachable', 'remote keys are unavailable');
      },
    );
  }

  #open(url: string, generation: number, secretKey: Uint8Array, routeId: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayEndpoint(url, RELAY_PATHS.host), {
        maxPayload: RELAY_CONTROL_MAX_BYTES,
        handshakeTimeout: RELAY_CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      this.#failed(generation, 'unreachable', (error as Error).message);
      return;
    }
    this.#control = ws;
    let registered = false;
    let failure: { reason: 'unreachable' | 'rejected' | 'replaced'; message: string } = {
      reason: 'unreachable',
      message: 'relay closed the connection',
    };
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('ping', () => {
      alive = true;
    });
    ws.on('error', (error) => {
      failure = { reason: 'unreachable', message: error.message };
    });
    ws.on('unexpected-response', (_req, res) => {
      failure = { reason: 'rejected', message: `relay answered HTTP ${res.statusCode}` };
      ws.terminate();
    });
    ws.on('message', (data, isBinary) => {
      alive = true;
      if (generation !== this.#generation) return;
      const message = isBinary ? undefined : parseServerMessage(data);
      if (message === undefined) {
        closeWs(ws, RelayCloseCode.PROTOCOL_ERROR, 'unexpected relay message');
        return;
      }
      if (message.type === 'challenge') {
        const signature = ed25519.sign(relayRegistrationMessage(message.nonce), secretKey);
        sendJson(ws, {
          type: 'register',
          routeId,
          signature: Buffer.from(signature).toString('base64url'),
        });
        return;
      }
      if (message.type === 'registered') {
        registered = true;
        this.#attempt = 0;
        this.#error = undefined;
        this.#state = 'connected';
        this.#options.onChange();
        return;
      }
      if (registered) this.#incoming(url, generation, message);
    });
    ws.on('close', (code, reason) => {
      if (generation !== this.#generation || this.#control !== ws) return;
      this.#control = undefined;
      clearInterval(this.#ping);
      this.#ping = undefined;
      if (code === RelayCloseCode.ROUTE_REPLACED) {
        failure = { reason: 'replaced', message: 'route registered from elsewhere' };
      } else if (
        code === RelayCloseCode.REGISTRATION_FAILED ||
        code === RelayCloseCode.LIMIT_EXCEEDED
      ) {
        failure = { reason: 'rejected', message: String(reason) || `relay closed with ${code}` };
      }
      // 经这条控制连接接通了的数据连接各自走到断开；中继那头注册没了，新的设备连不上，直到重新注册。
      this.#failed(generation, failure.reason, failure.message);
    });
    clearInterval(this.#ping);
    this.#ping = setInterval(() => {
      if (!alive) {
        failure = { reason: 'unreachable', message: 'relay stopped answering' };
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, this.#options.pingMs ?? RELAY_PING_MS);
    this.#ping.unref?.();
  }

  /** 控制连接断了或没连上：记下原因，退避后重连。 */
  #failed(
    generation: number,
    reason: 'unreachable' | 'rejected' | 'replaced',
    message: string,
  ): void {
    if (generation !== this.#generation || this.#closed) return;
    this.#state = 'connecting';
    this.#error = { reason, message };
    this.#options.onChange();
    const base = this.#options.backoffMs ?? RELAY_BACKOFF_MS;
    const max = this.#options.maxBackoffMs ?? RELAY_MAX_BACKOFF_MS;
    const delay = Math.min(max, base * 2 ** this.#attempt) * (0.5 + Math.random() / 2);
    this.#attempt = Math.min(this.#attempt + 1, 30);
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (generation === this.#generation) this.#connect();
    }, delay);
    this.#retry.unref?.();
  }

  // ── 数据连接 ────────────────────────────────────────────────────────

  #incoming(
    url: string,
    generation: number,
    message: Extract<RelayServerMessage, { type: 'incoming' }>,
  ): void {
    const admission = this.#options.admit(message.path, message.source);
    if (admission === undefined) {
      if (this.#control !== undefined) sendJson(this.#control, { type: 'reject', id: message.id });
      return;
    }
    const ws = new WebSocket(
      relayEndpoint(url, RELAY_PATHS.accept, { [RELAY_ACCEPT_PARAM]: message.id }),
      {
        maxPayload: MAX_MESSAGE_LENGTH,
        handshakeTimeout: RELAY_CONNECT_TIMEOUT_MS,
      },
    );
    this.#sockets.add(ws);
    let started = false;
    ws.on('error', () => {});
    ws.once('open', () => {
      if (generation !== this.#generation) {
        ws.terminate();
        return;
      }
      started = true;
      admission.start(ws);
    });
    ws.once('close', () => {
      this.#sockets.delete(ws);
      if (!started) admission.cancel();
    });
  }
}

function parseServerMessage(data: RawData): RelayServerMessage | undefined {
  try {
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8');
    const parsed = RelayServerMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(ws: WebSocket, message: RelayHostMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function closeWs(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) return;
  if (ws.readyState === ws.CONNECTING) {
    ws.terminate();
    return;
  }
  ws.close(code, reason);
  const timer = setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MS);
  timer.unref?.();
  ws.once('close', () => clearTimeout(timer));
}
