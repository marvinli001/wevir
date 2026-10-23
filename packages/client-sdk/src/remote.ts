// 远程连接的加密隧道（0.109.0，ADR-0017 §1–§3，host-api.md §1.1）：不在本机的客户端（CLI、手机）经 Noise 连另一台电脑上的 Host。
// 握手之后照常跑 JSON-RPC，所以对 `WevirClient` 来说这只是又一个 `TransportFactory`。
//
// 分两层：
// - `RemoteRoute` 是到 Host 的一条路，给出一条“一条二进制消息 = 一条 Noise 消息”的管道。直连是 `directRoute`（WebSocket 连 Host
//   监听的地址）；中继是 `relayRoute`（0.110.0，WebSocket 连中继、带路由 ID），帧格式相同，握手与分片照用这里的。
// - 隧道：在某条路上做 `IK`（重连）或 `XXpsk2`（配对）握手，之后用 `@wevir/noise` 的分片收发 JSON-RPC 文本。
//
// 每次连接把已知的路并行发起，第一个完成握手的胜出、其余关掉；直连给 `fallbackDelayMs`（默认 1.5 s）的先手，之后中继也开始。
// 不 import Node 内置模块（ADR-0002 §7），WebSocket 由调用方注入；不用 `fetch` 访问 Host 的任何东西（iOS 的 ATS 会拦 `100.x`）。

import {
  createHandshake,
  derivePairingPsk,
  FrameReader,
  type HandshakeState,
  type KeyPair,
  NoiseError,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
  remotePrologue,
  sealFrame,
  type TransportCiphers,
} from '@wevir/noise';
import {
  type ClientIdentity,
  type DevicePlatform,
  normalizePairingCode,
  PAIRING_WINDOW_MS,
  RELAY_ACCEPT_TIMEOUT_MS,
  RELAY_ROUTE_PARAM,
  REMOTE_HANDSHAKE_TIMEOUT_MS,
  REMOTE_PATHS,
  type RemoteHostPayload,
  RemoteHostPayloadSchema,
  relayEndpoint,
} from '@wevir/protocol';
import { type HostEndpoint, type HostHello, WevirClient } from './client.js';
import {
  RemoteHandshakeError,
  type RemoteRelayFailure,
  RemoteUnreachableError,
  relayCloseFailure,
} from './errors.js';
import type { Transport, TransportCloseInfo, TransportFactory } from './transport.js';

export type RemotePath = (typeof REMOTE_PATHS)[keyof typeof REMOTE_PATHS];

/**
 * 管道关闭的信息；`httpStatus` 是 WebSocket 升级前被拒时的 HTTP 状态码，`certificate` 是升级前 TLS 证书验不过（都要 WebSocket
 * 实现给得出时）。
 */
export interface RemoteLinkCloseInfo extends TransportCloseInfo {
  httpStatus?: number;
  certificate?: boolean;
}

/** 一条到 Host 的二进制管道的回调。`onClose` 恰好调用一次，连不上也是一次。 */
export interface RemoteLinkHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array): void;
  onClose(info: RemoteLinkCloseInfo): void;
}

export interface RemoteLink {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** 到 Host 的一条路。`open` 不得抛出：连不上时以 `onClose` 报告。 */
export interface RemoteRoute {
  /** 直连先试；中继在直连的先手之后才开始。 */
  readonly kind: 'direct' | 'relay';
  /** 去重与显示用，例如 `192.168.1.5:47830`。 */
  readonly key: string;
  open(path: RemotePath, handlers: RemoteLinkHandlers): RemoteLink;
}

/**
 * 连接期间陆续找到的路（例如局域网 mDNS）：找到一条就 `add` 一条，找完或 `signal` 中止时 resolve。不得 reject。
 */
export type RemoteDiscovery = (
  add: (route: RemoteRoute) => void,
  signal: AbortSignal,
) => Promise<void>;

/** Host 的公开身份：配对链接里的 Host 公钥与路由 ID（base64url）。 */
export interface RemoteHostKeys {
  readonly hostPublicKey: string;
  readonly routeId: string;
}

/** 一次握手成功之后：胜出的路与 Host 给的最新候选地址。 */
export interface RemoteConnectedInfo {
  readonly route: RemoteRoute;
  readonly host: RemoteHostPayload;
}

/**
 * 远程连接给 `WevirClient` 的端点：隧道自己知道往哪连，`url` 不用；Host 不查远程连接的令牌（设备身份在握手里），但 `host.hello`
 * 要求非空。
 */
export const REMOTE_ENDPOINT: HostEndpoint = Object.freeze({
  url: 'wevir-remote:',
  token: 'remote',
});

/** 直连给多久的先手，之后中继也开始。 */
export const REMOTE_FALLBACK_DELAY_MS = 1_500;

// ── 直连 ────────────────────────────────────────────────────────────

/**
 * WHATWG WebSocket API 里隧道用到的部分（浏览器、Node ≥ 22 的全局 `WebSocket`、`ws` 包、React Native 都符合）。监听器参数写成
 * `any` 的原因同 `WebSocketLike`。
 */
export interface BinaryWebSocketLike {
  binaryType: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    // biome-ignore lint/suspicious/noExplicitAny: 见上。
    listener: (event: any) => void,
  ): void;
}

export type BinaryWebSocketConstructor = new (url: string) => BinaryWebSocketLike;

/** 直连 Host 监听的一个地址（`ws://`，不带 `Origin` 头：浏览器里的 WebSocket 会带，Host 拒绝）。IPv6 地址不带方括号。 */
export function directRoute(
  WebSocketImpl: BinaryWebSocketConstructor,
  candidate: { readonly host: string; readonly port: number },
): RemoteRoute {
  const authority = `${candidate.host.includes(':') ? `[${candidate.host}]` : candidate.host}:${candidate.port}`;
  return {
    kind: 'direct',
    key: authority,
    open: (path, handlers) =>
      openWebSocketLink(WebSocketImpl, `ws://${authority}${path}`, handlers),
  };
}

/**
 * 经中继连 Host（0.110.0）：设备的三个路径接在中继地址之后、带 `route=<路由 ID>`（`relayEndpoint`，中继地址可以带路径前缀）。
 * 中继地址只用 Host 给的（配对链接的 `relay`、握手负载的 `relayUrl`）。升级前的拒绝（404 / 429 / 503）要靠 WebSocket 实现报出
 * 状态码才分得清：Node 用 `ws` 包（全局 `WebSocket` 不给状态码）。
 */
export function relayRoute(
  WebSocketImpl: BinaryWebSocketConstructor,
  relayUrl: string,
  routeId: string,
): RemoteRoute {
  const url = new URL(relayUrl);
  return {
    kind: 'relay',
    key: `${url.host}${url.pathname.replace(/\/+$/, '')}`,
    open: (path, handlers) =>
      openWebSocketLink(
        WebSocketImpl,
        relayEndpoint(relayUrl, path, { [RELAY_ROUTE_PARAM]: routeId }),
        handlers,
      ),
  };
}

/**
 * 升级前被拒时的 HTTP 状态码。WHATWG 的 `WebSocket` 不给；`ws` 包的错误是 `Unexpected server response: 429`，React Native 在
 * iOS / Android 上的错误文字里也带着状态码。
 */
/** Node 的 TLS 证书错误码（`ws` 把原始错误放在 error 事件的 `error` 上）：`DEPTH_ZERO_SELF_SIGNED_CERT`、`CERT_HAS_EXPIRED` 等。 */
const CERTIFICATE_ERROR_CODE = /CERT|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET_ISSUER)|ISSUER_CERT/;

function certificateError(event: unknown): boolean {
  const code = (event as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === 'string' && CERTIFICATE_ERROR_CODE.test(code);
}

function upgradeStatus(event: unknown): number | undefined {
  const e = event as { error?: { message?: unknown }; message?: unknown } | undefined;
  const text = [e?.error?.message, e?.message].find((m): m is string => typeof m === 'string');
  const match = text === undefined ? null : /response\D{0,24}?\b([1-5]\d{2})\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** 用 WebSocket 做二进制管道（直连与中继都用）。Host 只发二进制消息，收到文本消息就断开。 */
export function openWebSocketLink(
  WebSocketImpl: BinaryWebSocketConstructor,
  url: string,
  handlers: RemoteLinkHandlers,
): RemoteLink {
  let closed = false;
  let opened = false;
  let httpStatus: number | undefined;
  let certificate = false;
  let socket: BinaryWebSocketLike;
  try {
    socket = new WebSocketImpl(url);
    socket.binaryType = 'arraybuffer';
  } catch (error) {
    queueMicrotask(() => handlers.onClose({ code: 1006, reason: String(error) }));
    return { send: () => {}, close: () => {} };
  }
  socket.addEventListener('open', () => {
    opened = true;
    if (!closed) handlers.onOpen();
  });
  socket.addEventListener('message', (event: { data: unknown }) => {
    if (closed) return;
    const bytes = toBytes(event.data);
    if (bytes === undefined) socket.close(1000, 'text frames are not part of the remote protocol');
    else handlers.onMessage(bytes);
  });
  socket.addEventListener('close', (event: { code?: unknown; reason?: unknown }) => {
    if (closed) return;
    closed = true;
    handlers.onClose({
      code: typeof event.code === 'number' ? event.code : 1006,
      reason: typeof event.reason === 'string' ? event.reason : '',
      ...(httpStatus !== undefined && { httpStatus }),
      ...(certificate && { certificate }),
    });
  });
  // `ws` 在没有 error 监听器时会把错误当作未捕获异常抛出；后面总跟着一次 close。
  socket.addEventListener('error', (event: unknown) => {
    if (opened) return;
    httpStatus ??= upgradeStatus(event);
    certificate ||= certificateError(event);
  });
  return {
    // Noise 的输出都是新分配的 ArrayBuffer，不会是 SharedArrayBuffer。
    send: (data) => socket.send(data as Uint8Array<ArrayBuffer>),
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        // 还在连或已经在关。
      }
    },
  };
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

// ── 隧道 ────────────────────────────────────────────────────────────

/** 隧道的握手：重连用设备密钥做 `IK`；配对用配对秘密派生的 PSK 做 `XXpsk2`，第三条消息报上设备名称与平台。 */
type HandshakeSpec =
  | { kind: 'connect' }
  | { kind: 'pair'; secret: Uint8Array; name: string; platform: DevicePlatform };

interface TunnelKeys {
  readonly hostKey: Uint8Array;
  readonly routeId: string;
  readonly device: KeyPair;
}

/** 经中继的路关掉时，中继说明的原因（证书、升级前的状态码或中继的关闭码）。直连的 404 等不算：那是 Host 自己的拒绝。 */
function relayFailureOf(
  route: RemoteRoute,
  info: RemoteLinkCloseInfo | undefined,
): RemoteRelayFailure | undefined {
  if (route.kind !== 'relay' || info === undefined) return undefined;
  if (info.certificate === true) return 'certificate';
  switch (info.httpStatus) {
    case 404:
      return 'offline';
    case 429:
      return 'rate_limited';
    case 503:
      return 'busy';
  }
  return relayCloseFailure(info.code);
}

/** 一条中继的路没走通、中继说明了原因。竞速结束时并进 `RemoteUnreachableError.relay`，不外泄。 */
class RelayRouteError extends Error {
  constructor(readonly failure: RemoteRelayFailure) {
    super(`relay: ${failure}`);
  }
}

/** 经中继时握手的时限：中继等 Host 接上最多 `RELAY_ACCEPT_TIMEOUT_MS`，之后才是握手本身。 */
const RELAY_HANDSHAKE_TIMEOUT_MS = RELAY_ACCEPT_TIMEOUT_MS + REMOTE_HANDSHAKE_TIMEOUT_MS;

const encoder = new TextEncoder();

/** 一条路上的一次握手。先 `opened`（管道连上），再 `start` 握手，成功后 `attach` 成 `Transport`。 */
class NoiseTunnel {
  readonly route: RemoteRoute;
  readonly opened: Promise<void>;
  /** 握手成功后 Host 给的负载。 */
  host: RemoteHostPayload | undefined;
  readonly #link: RemoteLink;
  #phase: 'opening' | 'open' | 'handshake' | 'ready' | 'closed' = 'opening';
  #onHandshakeMessage: ((data: Uint8Array) => void) | undefined;
  #onHandshakeClose: ((info: RemoteLinkCloseInfo) => void) | undefined;
  #handlers: { onMessage(text: string): void; onClose(info: TransportCloseInfo): void } | undefined;
  #reader: FrameReader | undefined;
  #ciphers: TransportCiphers | undefined;
  /** 握手完成到 `attach` 之间到达的消息。 */
  readonly #early: Uint8Array[] = [];
  #closeInfo: RemoteLinkCloseInfo | undefined;

  constructor(route: RemoteRoute, path: RemotePath) {
    this.route = route;
    let resolveOpened!: () => void;
    let rejectOpened!: (info: RemoteLinkCloseInfo) => void;
    this.opened = new Promise<void>((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    this.opened.catch(() => {});
    this.#link = route.open(path, {
      onOpen: () => {
        if (this.#phase !== 'opening') return;
        this.#phase = 'open';
        resolveOpened();
      },
      onMessage: (data) => this.#receive(data),
      onClose: (info) => {
        const phase = this.#phase;
        this.#phase = 'closed';
        this.#closeInfo ??= info;
        if (phase === 'opening') rejectOpened(info);
        else if (phase === 'handshake') this.#onHandshakeClose?.(info);
        else if (phase === 'ready') this.#handlers?.onClose(this.#closeInfo);
      },
    });
  }

  /** 握手；成功时给出 Host 的负载。失败时关掉管道并以 `RemoteHandshakeError` reject。 */
  start(keys: TunnelKeys, spec: HandshakeSpec): Promise<RemoteHostPayload> {
    if (this.#phase !== 'open') return Promise.reject(this.#closedBeforeHandshake(this.#closeInfo));
    this.#phase = 'handshake';
    const prologue = remotePrologue({ host: keys.routeId });
    return new Promise<RemoteHostPayload>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new RemoteHandshakeError('timeout', this.route.key)),
        this.route.kind === 'relay' ? RELAY_HANDSHAKE_TIMEOUT_MS : REMOTE_HANDSHAKE_TIMEOUT_MS,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.#onHandshakeMessage = undefined;
        this.#onHandshakeClose = undefined;
        if (this.#phase === 'handshake') {
          this.#phase = 'closed';
          this.#link.close(1000, 'handshake failed');
        }
        reject(error);
      };
      let handshake: HandshakeState;
      try {
        handshake = createHandshake(
          spec.kind === 'connect'
            ? {
                protocol: RECONNECT_PROTOCOL,
                initiator: true,
                prologue,
                staticKeyPair: keys.device,
                remoteStaticKey: keys.hostKey,
              }
            : {
                protocol: PAIRING_PROTOCOL,
                initiator: true,
                prologue,
                staticKeyPair: keys.device,
                remoteStaticKey: keys.hostKey,
                psk: derivePairingPsk(spec.secret, keys.hostKey),
              },
        );
        this.#link.send(handshake.writeMessage());
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // 第一条消息之后对方就断开：不认这台设备（IK），或配对窗口已经不在（XXpsk2）；经中继时也可能是中继说明了原因的关闭。
      this.#onHandshakeClose = (info) => fail(this.#closedBeforeHandshake(info));
      this.#onHandshakeMessage = (data) => {
        let host: RemoteHostPayload;
        try {
          const payload = RemoteHostPayloadSchema.safeParse(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(handshake.readMessage(data)),
            ),
          );
          if (!payload.success) throw new Error('bad host payload');
          host = payload.data;
          if (spec.kind === 'pair') {
            this.#link.send(
              handshake.writeMessage(
                encoder.encode(JSON.stringify({ name: spec.name, platform: spec.platform })),
              ),
            );
          }
          this.#ciphers = handshake.split();
        } catch (error) {
          // 配对时 PSK 在第二条消息里混入：解不开就是短码或配对链接不对。
          const wrongSecret =
            spec.kind === 'pair' && error instanceof NoiseError && error.code === 'decrypt_failed';
          fail(
            new RemoteHandshakeError(
              wrongSecret ? 'wrong_secret' : 'host_mismatch',
              this.route.key,
            ),
          );
          return;
        }
        clearTimeout(timer);
        this.#onHandshakeMessage = undefined;
        this.#onHandshakeClose = undefined;
        this.#phase = 'ready';
        this.#reader = new FrameReader(this.#ciphers.receive);
        this.host = host;
        resolve(host);
      };
    });
  }

  /** 握手之后的 JSON-RPC 通道。之前到达的消息此时补交。 */
  attach(handlers: {
    onMessage(text: string): void;
    onClose(info: TransportCloseInfo): void;
  }): Transport {
    this.#handlers = handlers;
    for (const data of this.#early.splice(0)) this.#deliver(data);
    if (this.#phase === 'closed' && this.#closeInfo !== undefined) {
      const info = this.#closeInfo;
      queueMicrotask(() => handlers.onClose(info));
    }
    const send = (this.#ciphers as TransportCiphers).send;
    return {
      send: (text) => {
        if (this.#phase !== 'ready') return;
        for (const message of sealFrame(send, encoder.encode(text))) this.#link.send(message);
      },
      close: (code, reason) => this.#link.close(code, reason),
    };
  }

  close(code = 1000, reason = ''): void {
    if (this.#phase === 'closed') return;
    this.#link.close(code, reason);
  }

  /** 握手完成之前管道就关了：中继给了原因时是 `RelayRouteError`，否则当作对方拒绝。 */
  #closedBeforeHandshake(info: RemoteLinkCloseInfo | undefined): Error {
    const failure = relayFailureOf(this.route, info);
    return failure !== undefined
      ? new RelayRouteError(failure)
      : new RemoteHandshakeError('rejected', this.route.key);
  }

  #receive(data: Uint8Array): void {
    if (this.#phase === 'handshake') this.#onHandshakeMessage?.(data);
    else if (this.#phase === 'ready') {
      if (this.#handlers === undefined) this.#early.push(data);
      else this.#deliver(data);
    } else if (this.#phase === 'open') {
      // 握手之前对方不该说话。
      this.#phase = 'closed';
      this.#link.close(1000, 'unexpected message');
    }
  }

  #deliver(data: Uint8Array): void {
    if (this.#phase !== 'ready') return;
    let text: string | undefined;
    try {
      const frame = (this.#reader as FrameReader).push(data);
      if (frame === undefined) return;
      text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
    } catch {
      // 一次解密失败就断开，不重同步（ADR-0017 §3）。
      this.#phase = 'closed';
      this.#closeInfo = { code: 1006, reason: 'remote frame failed to decrypt' };
      this.#link.close(1000, 'decrypt failed');
      this.#handlers?.onClose(this.#closeInfo);
      return;
    }
    this.#handlers?.onMessage(text);
  }
}

// ── 并行发起 ────────────────────────────────────────────────────────

interface RaceOptions {
  routes: readonly RemoteRoute[];
  discover?: RemoteDiscovery | undefined;
  path: RemotePath;
  /** 一条路上的尝试：成功时给出隧道（握手完成，或只是连上）。 */
  attempt(tunnel: NoiseTunnel): Promise<void>;
  fallbackDelayMs: number;
  signal: AbortSignal;
}

/**
 * 把路并行发起，第一个 `attempt` 成功的胜出、其余关掉。直连立刻开始，中继在 `fallbackDelayMs` 之后（或直连都已失败、发现也已结束时）
 * 开始；同一个 `key` 只试一次。全部失败时：有握手被拒的报 `RemoteHandshakeError`，否则 `RemoteUnreachableError`（中继说明了原因时
 * 带上它）。
 */
function raceRoutes(options: RaceOptions): Promise<NoiseTunnel> {
  return new Promise<NoiseTunnel>((resolve, reject) => {
    const tried = new Set<string>();
    const tunnels = new Set<NoiseTunnel>();
    const waitingRelays: RemoteRoute[] = [];
    let pending = 0;
    let discovering = options.discover !== undefined;
    let relaysAllowed = false;
    let settled = false;
    let handshakeError: RemoteHandshakeError | undefined;
    let relayFailure: RemoteRelayFailure | undefined;
    const discovery = new AbortController();

    const finish = () => {
      settled = true;
      clearTimeout(fallbackTimer);
      discovery.abort();
      options.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      for (const tunnel of tunnels) tunnel.close(1000, 'cancelled');
      reject(options.signal.reason);
    };
    const maybeFail = () => {
      if (settled || pending > 0 || discovering) return;
      if (!relaysAllowed && waitingRelays.length > 0) {
        startRelays();
        if (pending > 0) return;
      }
      finish();
      reject(handshakeError ?? new RemoteUnreachableError([...tried], relayFailure));
    };
    const start = (route: RemoteRoute) => {
      if (settled) return;
      if (tried.has(route.key)) return;
      tried.add(route.key);
      pending += 1;
      const tunnel = new NoiseTunnel(route, options.path);
      tunnels.add(tunnel);
      options.attempt(tunnel).then(
        () => {
          pending -= 1;
          if (settled) {
            tunnel.close(1000, 'another route won');
            return;
          }
          finish();
          tunnels.delete(tunnel);
          for (const other of tunnels) other.close(1000, 'another route won');
          resolve(tunnel);
        },
        (error: unknown) => {
          pending -= 1;
          tunnels.delete(tunnel);
          if (error instanceof RelayRouteError) relayFailure = error.failure;
          if (error instanceof RemoteHandshakeError) {
            // 公钥不符、秘密不对比“被拒”更能说明问题。
            if (handshakeError === undefined || handshakeError.reason === 'timeout')
              handshakeError = error;
            else if (error.reason !== 'timeout' && error.reason !== 'rejected')
              handshakeError = error;
          }
          maybeFail();
        },
      );
    };
    const startRelays = () => {
      relaysAllowed = true;
      for (const route of waitingRelays.splice(0)) start(route);
    };
    const add = (route: RemoteRoute) => {
      if (settled) return;
      if (route.kind === 'relay' && !relaysAllowed) waitingRelays.push(route);
      else start(route);
    };

    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    const fallbackTimer = setTimeout(() => {
      if (!settled) startRelays();
    }, options.fallbackDelayMs);
    for (const route of options.routes) add(route);
    if (options.discover !== undefined) {
      options.discover(add, discovery.signal).then(
        () => {
          discovering = false;
          maybeFail();
        },
        () => {
          discovering = false;
          maybeFail();
        },
      );
    }
    maybeFail();
  });
}

/**
 * 拿到一次 `opened` 的 reject 原因时，把它变成普通的失败（中继说明了原因时是 `RelayRouteError`）。经中继的路连 WebSocket 都没
 * 连上、又说不出原因时是中继本身连不上（`unreachable`）：提示要说中继地址，而不只是直连的检查项。
 */
async function openedOrFail(tunnel: NoiseTunnel): Promise<void> {
  try {
    await tunnel.opened;
  } catch (info) {
    const failure =
      relayFailureOf(tunnel.route, info as RemoteLinkCloseInfo) ??
      (tunnel.route.kind === 'relay' ? 'unreachable' : undefined);
    throw failure !== undefined
      ? new RelayRouteError(failure)
      : new Error(`could not reach ${tunnel.route.key}`);
  }
}

// ── 重连 ────────────────────────────────────────────────────────────

export interface RemoteTransportOptions {
  host: RemoteHostKeys;
  /** 这台设备给这台电脑的 Noise 静态密钥（配对时生成）。 */
  device: KeyPair;
  /** 每次连接尝试前调用：已知的路（上次成功的、Host 上次给的候选地址、`relayRoute`）。 */
  routes(): readonly RemoteRoute[] | Promise<readonly RemoteRoute[]>;
  /** 连接期间陆续找到的路（局域网 mDNS）。 */
  discover?: RemoteDiscovery;
  /** 默认 `REMOTE_FALLBACK_DELAY_MS`。 */
  fallbackDelayMs?: number;
  /** 每次握手成功后调用：调用方据此记下胜出的路与 Host 给的最新候选地址。 */
  onConnected?(info: RemoteConnectedInfo): void;
}

/**
 * 已配对设备的远程传输：每次连接按 `routes()` 与 `discover` 并行做 `IK` 握手，第一个完成的胜出。连不上、握手被拒时以 `onClose`
 * 报告，`cause` 是 `RemoteUnreachableError` 或 `RemoteHandshakeError`（`WevirClient` 对后者不再重连）。配合 `REMOTE_ENDPOINT` 用。
 */
export function remoteTransport(options: RemoteTransportOptions): TransportFactory {
  const keys = tunnelKeys(options.host, options.device);
  return (_url, handlers) => {
    const abort = new AbortController();
    let transport: Transport | undefined;
    let closed = false;
    const reportClose = (info: TransportCloseInfo) => {
      if (closed) return;
      closed = true;
      handlers.onClose(info);
    };
    void (async () => {
      const routes = await options.routes();
      if (abort.signal.aborted) return;
      const tunnel = await raceRoutes({
        routes,
        discover: options.discover,
        path: REMOTE_PATHS.connect,
        attempt: async (candidate) => {
          await openedOrFail(candidate);
          await candidate.start(keys, { kind: 'connect' });
        },
        fallbackDelayMs: options.fallbackDelayMs ?? REMOTE_FALLBACK_DELAY_MS,
        signal: abort.signal,
      });
      const host = tunnel.host as RemoteHostPayload;
      try {
        options.onConnected?.({ route: tunnel.route, host });
      } catch {
        // 调用方记录失败不影响连接。
      }
      transport = tunnel.attach({
        onMessage: (text) => handlers.onMessage(text),
        onClose: reportClose,
      });
      if (!closed) handlers.onOpen();
    })().catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      reportClose({ code: 1006, reason: cause.message, cause });
    });
    return {
      send: (text) => transport?.send(text),
      close: (code, reason) => {
        if (transport !== undefined) {
          transport.close(code, reason);
          return;
        }
        abort.abort(new Error('closed'));
        reportClose({ code: code ?? 1000, reason: reason ?? '' });
      },
    };
  };
}

// ── 配对 ────────────────────────────────────────────────────────────

/** 配对用的秘密：配对链接里的 `s`（base64url），或手输的短码。 */
export type RemotePairingSecret =
  | { readonly kind: 'uri'; readonly secret: string }
  | { readonly kind: 'code'; readonly code: string };

export interface RemotePairingOptions {
  host: RemoteHostKeys;
  /** 这台设备给这台电脑新生成的 Noise 静态密钥。 */
  device: KeyPair;
  secret: RemotePairingSecret;
  routes: readonly RemoteRoute[];
  discover?: RemoteDiscovery;
  /** 电脑上“某某设备请求配对”里显示的名称与平台。 */
  name: string;
  platform: DevicePlatform;
  /** `host.hello` 里的身份。 */
  identity: ClientIdentity;
  /** 等电脑上点“允许”多久；默认是配对窗口的有效期。 */
  approvalTimeoutMs?: number;
  /** 握手完成、开始等电脑上允许时调用（界面据此提示去电脑上点“允许”）。 */
  onAwaitingApproval?(info: RemoteConnectedInfo): void;
  fallbackDelayMs?: number;
  signal?: AbortSignal;
}

export interface RemotePairingResult {
  readonly route: RemoteRoute;
  /** Host 在握手里给的负载（名称与最新候选地址）。 */
  readonly host: RemoteHostPayload;
  /** 允许之后的 `host.hello` 结果：`permissions` 是这台设备的权限。 */
  readonly hello: HostHello;
}

/**
 * 配对（`XXpsk2`）：先并行连上各条路，只在第一条连上的路上握手（短码一次尝试就作废，配对窗口在握手中途断开就失败，所以不能
 * 在几条路上同时握手），然后发 `host.hello` 等电脑上允许。拒绝时以 `ConnectionLostError`（关闭码 4010）reject；短码或链接不对时
 * 以 `RemoteHandshakeError('wrong_secret')` reject；哪条路都没走通（经中继时含中继说明的原因）时以 `RemoteUnreachableError` reject。
 */
export async function pairRemoteHost(options: RemotePairingOptions): Promise<RemotePairingResult> {
  const keys = tunnelKeys(options.host, options.device);
  let secret: Uint8Array;
  let path: RemotePath;
  if (options.secret.kind === 'uri') {
    secret = base64urlToBytes(options.secret.secret);
    path = REMOTE_PATHS.pair;
  } else {
    const code = normalizePairingCode(options.secret.code);
    if (code === null) throw new RemoteHandshakeError('wrong_secret', 'pairing code');
    secret = encoder.encode(code);
    path = REMOTE_PATHS.pairCode;
  }
  const signal = options.signal ?? new AbortController().signal;
  const tunnel = await raceRoutes({
    routes: options.routes,
    discover: options.discover,
    path,
    attempt: (candidate) => openedOrFail(candidate),
    fallbackDelayMs: options.fallbackDelayMs ?? REMOTE_FALLBACK_DELAY_MS,
    signal,
  });
  let host: RemoteHostPayload;
  try {
    host = await tunnel.start(keys, {
      kind: 'pair',
      secret,
      name: options.name,
      platform: options.platform,
    });
  } catch (error) {
    // 经中继时电脑没开配对窗口是中继的 `HOST_REJECTED`，与直连的“连不上”同类。
    if (error instanceof RelayRouteError)
      throw new RemoteUnreachableError([tunnel.route.key], error.failure);
    throw error;
  }
  try {
    options.onAwaitingApproval?.({ route: tunnel.route, host });
  } catch {
    // 只是提示。
  }
  let used = false;
  const transport: TransportFactory = (_url, handlers) => {
    if (used) {
      const cause = new RemoteUnreachableError([]);
      queueMicrotask(() => handlers.onClose({ code: 1006, reason: cause.message, cause }));
      return { send: () => {}, close: () => {} };
    }
    used = true;
    const attached = tunnel.attach({
      onMessage: (text) => handlers.onMessage(text),
      onClose: (info) => handlers.onClose(info),
    });
    queueMicrotask(() => handlers.onOpen());
    return attached;
  };
  const client = await WevirClient.connect({
    endpoint: REMOTE_ENDPOINT,
    transport,
    identity: options.identity,
    timeouts: { connectMs: options.approvalTimeoutMs ?? PAIRING_WINDOW_MS },
  });
  const hello = client.hello;
  client.close();
  return { route: tunnel.route, host, hello };
}

// ── 工具 ────────────────────────────────────────────────────────────

function tunnelKeys(host: RemoteHostKeys, device: KeyPair): TunnelKeys {
  return { hostKey: base64urlToBytes(host.hostPublicKey), routeId: host.routeId, device };
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url（不带填充）解码；不合法时抛错。手机端（Hermes）也能用，不依赖 Node 与 `atob`。 */
export function base64urlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('invalid base64url');
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    value = ((value << 6) | BASE64URL.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/** base64url（不带填充）编码。 */
export function bytesToBase64url(bytes: Uint8Array): string {
  let text = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      text += BASE64URL[(value >> bits) & 0x3f];
    }
  }
  if (bits > 0) text += BASE64URL[(value << (6 - bits)) & 0x3f];
  return text;
}
