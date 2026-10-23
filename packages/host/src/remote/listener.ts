import { createServer, type IncomingMessage, type Server, STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import { networkInterfaces as osNetworkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import {
  createHandshake,
  derivePairingPsk,
  type HandshakeState,
  MAX_MESSAGE_LENGTH,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
  remotePrologue,
} from '@wevir/noise';
import {
  CloseCode,
  type CloseCodeName,
  type DeviceId,
  type PairingCandidate,
  PROTOCOL_VERSION,
  REMOTE_DEFAULT_PORT,
  REMOTE_HANDSHAKE_TIMEOUT_MS,
  REMOTE_NATIVE_ORIGIN,
  REMOTE_PATHS,
  type RelayDevicePath,
  RemoteDevicePayloadSchema,
  type RemoteHostPayload,
  type RemoteSettings,
  type RemoteStatus,
} from '@wevir/protocol';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { KeepAwake } from '../keep-awake.js';
import type { ConnectionGrant } from '../permissions.js';
import type { RemoteOrigin, RpcSocket } from '../rpc-connection.js';
import type { DeviceService } from './devices.js';
import { base64url, type RemoteIdentity, type RemoteKeys } from './identity.js';
import { type MdnsAdvertiser, mdnsAnnouncement } from './mdns.js';
import {
  type classifyAddress,
  describeInterfaces,
  isSelected,
  lookupMagicDnsName,
  type NetworkInterfaces,
  type RemoteAddress,
  remoteAddresses,
} from './network.js';
import { NoiseRpcSocket, toBytes } from './noise-socket.js';
import type { PairingAttempt, PairingSecretKind, PairingService } from './pairing.js';
import { HandshakeLimiter } from './rate-limit.js';
import { type RelayAdmission, RelayClient, type RelayClientOptions } from './relay-client.js';

/** 多久看一次网卡（Node 没有网卡变化的事件）。 */
export const INTERFACE_POLL_MS = 5000;
/** 连着的设备多久记一次最近在线。 */
const TOUCH_INTERVAL_MS = 60_000;
/** 配对时等桌面允许期间，先到的消息最多排几条。 */
const MAX_QUEUED_BEFORE_APPROVAL = 16;
/** 主动关闭远程连接后等对方回关闭帧的时限。 */
const CLOSE_TIMEOUT_MS = 2000;

type HandshakeKind = PairingSecretKind | 'connect';

interface ServerEntry {
  readonly address: RemoteAddress;
  readonly port: number;
  readonly server: Server;
  listening: boolean;
  /** 在这个地址上升级的 WebSocket（握手中与握手完成的）。 */
  readonly sockets: Set<WebSocket>;
}

interface Connection {
  readonly deviceId: string;
  readonly ws: WebSocket;
  /** 直连时是它所在的监听；经中继来的是 undefined。 */
  readonly entry: ServerEntry | undefined;
}

export interface RemoteListenerOptions {
  /** Host 设置的 `remote`。 */
  settings: () => RemoteSettings | undefined;
  identity: Pick<RemoteIdentity, 'ensure'>;
  devices: Pick<
    DeviceService,
    'findActive' | 'get' | 'touch' | 'onRevoked' | 'onPermissionsChanged'
  >;
  pairing: Pick<PairingService, 'pairingId' | 'beginAttempt' | 'requestApproval' | 'failAttempt'>;
  /** 把握手完成的连接交给 JSON-RPC 分发（`HostRpcServer.attach`）；返回 undefined 时 Host 正在退出。 */
  attach: (socket: RpcSocket, origin: RemoteOrigin) => unknown;
  /** 握手负载里的电脑名称。 */
  hostName?: string;
  /** 防休眠：有远程设备连着时保持（ADR-0017 §5）。 */
  keepAwake?: Pick<KeepAwake, 'hold'>;
  networkInterfaces?: () => NetworkInterfaces;
  /** 只给测试：把回环地址也认作局域网 / Tailscale。 */
  classifyAddress?: typeof classifyAddress;
  lookupMagicDnsName?: (address: string) => Promise<string | undefined>;
  advertiser?: MdnsAdvertiser;
  limiter?: HandshakeLimiter;
  pollMs?: number;
  handshakeTimeoutMs?: number;
  /** 只给测试：中继的重连退避与心跳间隔。 */
  relay?: Pick<RelayClientOptions, 'backoffMs' | 'maxBackoffMs' | 'pingMs'>;
  onError?: (error: unknown) => void;
}

/**
 * 直连的远程监听（ADR-0017 §1–§4，security.md 的“远程访问”，host-api.md 的“远程监听”）。
 *
 * - **只在勾选的地址上监听**：远程开着时，对每个选中的局域网 / Tailscale 地址各 `listen(port, address)` 一次（IPv4 与 IPv6 分开），
 *   从不监听 `0.0.0.0` / `::`、回环、链路本地或公网地址，不做 UPnP。每 `pollMs` 看一次网卡：新地址补开，消失或取消勾选的关掉
 *   （连在上面的连接一起断开）；地址暂时不在（`EADDRNOTAVAIL`）下一轮重试。
 * - **只说 Noise**：只接受 WebSocket 升级，普通 HTTP 一律 404；带网页 `Origin` 头的升级（浏览器里的网页）一律 403，
 *   只放行原生应用的固定值 `REMOTE_NATIVE_ORIGIN`（React Native 的 WebSocket 去不掉 `Origin`）。路径区分配对
 *   （`XXpsk2`，只在配对窗口里）与重连（`IK`，只认 active 的设备公钥）。握手完成前任何字节都不交给 JSON-RPC；握手失败直接断开，
 *   不回任何内容。按来源地址限速。
 * - **接进分发**：握手完成的连接交给与本机连接相同的 `RpcConnection`，身份是那台设备，权限在 hello 时从设备记录取。设备被移除
 *   （`DEVICE_REVOKED`）或权限改了（`PERMISSIONS_CHANGED`，让它重连后按新权限工作）时立即断开它的全部连接。
 * - 局域网有监听时用 mDNS 广播 `_wevir._tcp`（只带路由 ID）。
 * - **中继**（relay-client.ts）：开了中继时向中继发起出站连接；经中继来的每条连接是一条单独的 WebSocket，交给同一个握手与分发，
 *   限速按中继给的来源标记（`relay:<标记>`）。关掉中继时断开经它来的连接（`REMOTE_DISABLED`）。
 */
export class RemoteListener {
  readonly #options: RemoteListenerOptions;
  readonly #interfaces: () => NetworkInterfaces;
  readonly #lookupMagicDnsName: (address: string) => Promise<string | undefined>;
  readonly #limiter: HandshakeLimiter;
  readonly #onError: (error: unknown) => void;
  readonly #wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: MAX_MESSAGE_LENGTH,
  });
  readonly #servers = new Map<string, ServerEntry>();
  readonly #connections = new Set<Connection>();
  readonly #listeners = new Set<(status: RemoteStatus) => void>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #relay: RelayClient;
  #keys: RemoteKeys | undefined;
  #loadingKeys = false;
  #addresses: RemoteAddress[] = [];
  #port = REMOTE_DEFAULT_PORT;
  #error: RemoteStatus['error'];
  #magicDns: { address: string; name: string | undefined } | undefined;
  #advertising = false;
  #poll: ReturnType<typeof setInterval> | undefined;
  #lastStatus = '';
  #closed = false;

  constructor(options: RemoteListenerOptions) {
    this.#options = options;
    this.#interfaces = options.networkInterfaces ?? osNetworkInterfaces;
    this.#lookupMagicDnsName = options.lookupMagicDnsName ?? lookupMagicDnsName;
    this.#limiter = options.limiter ?? new HandshakeLimiter();
    this.#onError = options.onError ?? (() => {});
    this.#relay = new RelayClient({
      settings: options.settings,
      identity: options.identity,
      admit: (path, source) => this.admitRelayed(path, source),
      onChange: () => this.#changed(),
      onError: this.#onError,
      ...options.relay,
    });
    this.#unsubscribe.push(
      options.devices.onRevoked((deviceId) => this.#dropDevice(deviceId, 'DEVICE_REVOKED')),
      options.devices.onPermissionsChanged((deviceId) =>
        this.#dropDevice(deviceId, 'PERMISSIONS_CHANGED'),
      ),
    );
  }

  /** 按当前设置与网卡开、关监听。设置变了时调用；之后远程开着期间自己轮询网卡。 */
  refresh(): void {
    if (this.#closed) return;
    this.#relay.refresh();
    const settings = this.#options.settings();
    const enabled = settings?.enabled === true;
    if (enabled && this.#keys === undefined) {
      this.#loadKeys();
      return;
    }
    const port = settings?.port ?? REMOTE_DEFAULT_PORT;
    if (port !== this.#port) {
      for (const entry of [...this.#servers.values()]) this.#closeServer(entry, 'REMOTE_DISABLED');
      this.#port = port;
      this.#error = undefined;
    }
    if (!enabled) this.#error = undefined;
    this.#addresses = remoteAddresses(this.#interfaces(), this.#options.classifyAddress);
    const wanted = new Map(
      (enabled ? this.#addresses.filter((address) => isSelected(address, settings)) : []).map(
        (address) => [keyOf(address), address],
      ),
    );
    for (const [key, entry] of [...this.#servers]) {
      if (!wanted.has(key)) this.#closeServer(entry, 'REMOTE_DISABLED');
    }
    for (const [key, address] of wanted) {
      if (!this.#servers.has(key)) this.#bind(address, port);
    }
    if (!enabled) {
      // 还没交给 JSON-RPC 的、不在任何监听上的连接（理论上没有）也一起断开。
      for (const connection of [...this.#connections]) this.#drop(connection, 'REMOTE_DISABLED');
    }
    this.#setPolling(enabled);
    this.#updateMagicDns();
    this.#updateAdvertising();
    this.#changed();
  }

  /** 当前状态（`remote.status`）。 */
  status(): RemoteStatus {
    const listening = new Set(
      [...this.#servers.values()].filter((entry) => entry.listening).map((e) => e.address.address),
    );
    const settings = this.#options.settings();
    const magicDnsName = this.#magicDns?.name;
    const relay = this.#relay.status(
      [...this.#connections].filter((connection) => connection.entry === undefined).length,
    );
    return {
      listening: listening.size > 0,
      port: this.#port,
      interfaces: describeInterfaces(this.#addresses, settings, listening),
      ...(magicDnsName !== undefined && { magicDnsName }),
      advertising: this.#advertising,
      connections: this.#connections.size,
      ...(this.#error !== undefined && { error: this.#error }),
      ...(relay !== undefined && { relay }),
    };
  }

  /**
   * 中继通知有设备来连（relay-client.ts）：路径不认识、配对路径但没开配对窗口、或这个来源被限速时返回 undefined，中继以
   * `HOST_REJECTED` 关闭它。否则占一个握手名额，数据连接连上后走与直连相同的握手。
   */
  admitRelayed(path: RelayDevicePath, source: string): RelayAdmission | undefined {
    if (this.#closed || this.#keys === undefined) return undefined;
    const kind = handshakeKind(path);
    if (kind === undefined || (kind !== 'connect' && this.#options.pairing.pairingId === undefined))
      return undefined;
    const from = `relay:${source}`;
    const release = this.#limiter.begin(from);
    if (release === undefined) return undefined;
    return {
      start: (ws) => {
        ws.on('close', release);
        this.#handshake(undefined, ws, kind, from, release);
      },
      cancel: release,
    };
  }

  /** 直连的候选地址（二维码与握手负载）：局域网地址、Tailscale 地址、MagicDNS 名，都带端口。 */
  candidates(): PairingCandidate[] {
    const listening = [...this.#servers.values()].filter((entry) => entry.listening);
    const candidates: PairingCandidate[] = [];
    for (const kind of ['lan', 'tailscale'] as const) {
      for (const entry of listening) {
        if (entry.address.kind === kind) {
          candidates.push({ kind, host: entry.address.address, port: entry.port });
        }
      }
    }
    const magicDnsName = this.#magicDns?.name;
    if (magicDnsName !== undefined && listening.some((e) => e.address.kind === 'tailscale')) {
      candidates.push({ kind: 'tailscale', host: magicDnsName, port: this.#port });
    }
    return candidates;
  }

  /** 状态变了时调用 `listener`（`remote.changed`）。返回退订函数。 */
  watch(listener: (status: RemoteStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 握手完成的远程连接数。 */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /**
   * Host 退出：关掉全部监听与握手中的连接、停掉 mDNS 广播（发告别包）。已经交给 JSON-RPC 的连接留给 `HostRpcServer.close()`
   * 以 `GOING_AWAY` 关闭。
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#setPolling(false);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#relay.close();
    const attached = new Set([...this.#connections].map((connection) => connection.ws));
    for (const ws of this.#relay.sockets) if (!attached.has(ws)) ws.terminate();
    for (const entry of this.#servers.values()) {
      entry.server.close();
      for (const ws of entry.sockets) if (!attached.has(ws)) ws.terminate();
    }
    this.#servers.clear();
    this.#listeners.clear();
    await this.#options.advertiser?.shutdown();
  }

  // ── 监听 ────────────────────────────────────────────────────────────

  #loadKeys(): void {
    if (this.#loadingKeys) return;
    this.#loadingKeys = true;
    this.#options.identity.ensure().then(
      (keys) => {
        this.#loadingKeys = false;
        this.#keys = keys;
        this.refresh();
      },
      (error: unknown) => {
        this.#loadingKeys = false;
        this.#onError(error);
      },
    );
  }

  #bind(address: RemoteAddress, port: number): void {
    const server = createServer((_req, res) => {
      res.writeHead(404, { Connection: 'close', 'Content-Length': 0 });
      res.end();
    });
    server.headersTimeout = REMOTE_HANDSHAKE_TIMEOUT_MS;
    server.requestTimeout = REMOTE_HANDSHAKE_TIMEOUT_MS;
    const entry: ServerEntry = { address, port, server, listening: false, sockets: new Set() };
    this.#servers.set(keyOf(address), entry);
    server.on('upgrade', (req, socket, head) => this.#upgrade(entry, req, socket, head));
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (this.#servers.get(keyOf(address)) === entry) this.#servers.delete(keyOf(address));
      server.close();
      // 地址暂时不在（Tailscale 刚停、换了网络）：下一轮再试，不算错误。
      if (error.code === 'EADDRNOTAVAIL') return;
      this.#error =
        error.code === 'EADDRINUSE'
          ? { reason: 'port_in_use', message: `port ${port} is in use` }
          : { reason: 'bind_failed', message: error.message };
      this.#onError(error);
      this.#changed();
    });
    server.listen({ host: address.address, port, ipv6Only: address.family === 'IPv6' }, () => {
      if (this.#servers.get(keyOf(address)) !== entry) {
        server.close();
        return;
      }
      entry.listening = true;
      if (this.#error?.reason === 'port_in_use') this.#error = undefined;
      this.#updateMagicDns();
      this.#updateAdvertising();
      this.#changed();
    });
  }

  #closeServer(entry: ServerEntry, code: CloseCodeName): void {
    if (this.#servers.get(keyOf(entry.address)) === entry)
      this.#servers.delete(keyOf(entry.address));
    entry.server.close();
    const attached = new Set<WebSocket>();
    for (const connection of [...this.#connections]) {
      if (connection.entry !== entry) continue;
      attached.add(connection.ws);
      this.#drop(connection, code);
    }
    for (const ws of entry.sockets) if (!attached.has(ws)) ws.terminate();
  }

  #setPolling(enabled: boolean): void {
    if (enabled && this.#poll === undefined) {
      this.#poll = setInterval(() => this.refresh(), this.#options.pollMs ?? INTERFACE_POLL_MS);
      this.#poll.unref?.();
    } else if (!enabled && this.#poll !== undefined) {
      clearInterval(this.#poll);
      this.#poll = undefined;
    }
  }

  #updateMagicDns(): void {
    const tailscale = [...this.#servers.values()].find(
      (entry) =>
        entry.listening && entry.address.kind === 'tailscale' && entry.address.family === 'IPv4',
    )?.address.address;
    if (tailscale === undefined) {
      this.#magicDns = undefined;
      return;
    }
    if (this.#magicDns?.address === tailscale) return;
    const lookup = { address: tailscale, name: undefined as string | undefined };
    this.#magicDns = lookup;
    void this.#lookupMagicDnsName(tailscale).then(
      (name) => {
        if (this.#magicDns !== lookup || name === undefined) return;
        lookup.name = name;
        this.#changed();
      },
      () => {},
    );
  }

  #updateAdvertising(): void {
    const advertiser = this.#options.advertiser;
    if (advertiser === undefined) return;
    const listening = [...this.#servers.values()]
      .filter((entry) => entry.listening)
      .map((entry) => entry.address);
    const announcement =
      this.#keys === undefined ? undefined : mdnsAnnouncement(this.#keys, this.#port, listening);
    this.#advertising = announcement !== undefined;
    advertiser.update(announcement);
  }

  #changed(): void {
    if (this.#listeners.size === 0) return;
    const status = this.status();
    const text = JSON.stringify(status);
    if (text === this.#lastStatus) return;
    this.#lastStatus = text;
    for (const listener of [...this.#listeners]) listener(status);
  }

  // ── 升级与握手 ──────────────────────────────────────────────────────

  #upgrade(entry: ServerEntry, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    if (this.#closed || this.#servers.get(keyOf(entry.address)) !== entry) {
      socket.destroy();
      return;
    }
    // 浏览器总会发 Origin，局域网里的网页不能来连。原生客户端不发，或（React Native 去不掉 Origin）发原生应用的固定值。
    const origin = req.headers.origin ?? req.headers['sec-websocket-origin'];
    if (origin !== undefined && origin !== REMOTE_NATIVE_ORIGIN) {
      rejectUpgrade(socket, 403);
      return;
    }
    const kind = handshakeKind(req.url);
    if (
      kind === undefined ||
      (kind !== 'connect' && this.#options.pairing.pairingId === undefined)
    ) {
      rejectUpgrade(socket, 404);
      return;
    }
    const from = (socket as Socket).remoteAddress ?? '';
    const release = this.#limiter.begin(from);
    if (release === undefined) {
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      entry.sockets.add(ws);
      ws.on('close', () => {
        entry.sockets.delete(ws);
        release();
      });
      this.#handshake(entry, ws, kind, from, release);
    });
  }

  #handshake(
    entry: ServerEntry | undefined,
    ws: WebSocket,
    kind: HandshakeKind,
    from: string,
    release: () => void,
  ): void {
    const keys = this.#keys;
    if (keys === undefined) {
      ws.terminate();
      return;
    }
    const prologue = remotePrologue({ host: keys.routeId });
    let phase: 'first' | 'third' | 'approval' | 'open' | 'done' = 'first';
    let handshake: HandshakeState | undefined;
    let attempt: PairingAttempt | undefined;
    let socket: NoiseRpcSocket | undefined;
    const queued: [RawData, boolean][] = [];

    const timer = setTimeout(
      () => fail(),
      this.#options.handshakeTimeoutMs ?? REMOTE_HANDSHAKE_TIMEOUT_MS,
    );
    timer.unref?.();
    const fail = () => {
      if (phase === 'done' || phase === 'open') return;
      const pending = attempt;
      phase = 'done';
      clearTimeout(timer);
      this.#limiter.fail(from);
      if (pending !== undefined) this.#options.pairing.failAttempt(pending);
      ws.terminate();
    };
    const open = (deviceId: string, noise: NoiseRpcSocket) => {
      phase = 'open';
      clearTimeout(timer);
      release();
      this.#open(entry, ws, deviceId, noise);
      for (const [data, isBinary] of queued.splice(0)) noise.receive(data, isBinary);
    };

    ws.on('close', () => {
      clearTimeout(timer);
      // 握手中或等允许时断开：配对窗口以 failed 结束。
      if (
        (phase === 'first' || phase === 'third' || phase === 'approval') &&
        attempt !== undefined
      ) {
        this.#options.pairing.failAttempt(attempt);
      }
      if (phase !== 'open') phase = 'done';
    });
    ws.on('message', (data, isBinary) => {
      if (phase === 'open') {
        socket?.receive(data, isBinary);
        return;
      }
      if (phase === 'approval') {
        if (queued.length >= MAX_QUEUED_BEFORE_APPROVAL) fail();
        else queued.push([data, isBinary]);
        return;
      }
      if (phase === 'done') return;
      if (!isBinary) {
        fail();
        return;
      }
      try {
        const message = toBytes(data);
        if (phase === 'first' && kind === 'connect') {
          handshake = createHandshake({
            protocol: RECONNECT_PROTOCOL,
            initiator: false,
            prologue,
            staticKeyPair: keys.noise,
            acceptRemoteStaticKey: (key) =>
              this.#options.devices.findActive(base64url(key)) !== undefined,
          });
          handshake.readMessage(message);
          ws.send(handshake.writeMessage(this.#hostPayload()), { binary: true });
          const device = this.#options.devices.findActive(
            base64url(handshake.remoteStaticKey ?? new Uint8Array()),
          );
          if (device === undefined) throw new Error('device removed during the handshake');
          socket = new NoiseRpcSocket(ws, handshake.split(), this.#onError);
          open(device.id, socket);
          return;
        }
        if (phase === 'first') {
          attempt = this.#options.pairing.beginAttempt(kind as PairingSecretKind);
          if (attempt === undefined) throw new Error('no pairing window');
          handshake = createHandshake({
            protocol: PAIRING_PROTOCOL,
            initiator: false,
            prologue: remotePrologue({ host: attempt.keys.routeId }),
            staticKeyPair: attempt.keys.noise,
            psk: derivePairingPsk(attempt.secret, attempt.keys.noise.publicKey),
          });
          handshake.readMessage(message);
          ws.send(handshake.writeMessage(this.#hostPayload()), { binary: true });
          phase = 'third';
          return;
        }
        // 第三条消息：设备的静态公钥与名称、平台。
        const current = handshake as HandshakeState;
        const payload = RemoteDevicePayloadSchema.parse(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(current.readMessage(message)),
          ),
        );
        const publicKey = base64url(current.remoteStaticKey ?? new Uint8Array());
        const pending = attempt as PairingAttempt;
        const noise = new NoiseRpcSocket(ws, current.split(), this.#onError);
        socket = noise;
        phase = 'approval';
        clearTimeout(timer);
        void this.#options.pairing
          .requestApproval(pending, { name: payload.name, platform: payload.platform, publicKey })
          .then((device) => {
            if (phase !== 'approval') return;
            if (device === undefined) {
              phase = 'done';
              closeWs(ws, 'PAIRING_DENIED', 'pairing denied');
              return;
            }
            open(device.id, noise);
          });
      } catch {
        fail();
      }
    });
  }

  #open(
    entry: ServerEntry | undefined,
    ws: WebSocket,
    deviceId: string,
    socket: NoiseRpcSocket,
  ): void {
    const devices = this.#options.devices;
    const origin: RemoteOrigin = {
      deviceId,
      grant: (): ConnectionGrant | undefined => {
        const device = devices.get(deviceId as DeviceId);
        if (device?.status !== 'active') return undefined;
        return {
          principal: { kind: 'device', deviceId },
          permissions: device.permissions as ConnectionGrant['permissions'],
        };
      },
    };
    if (this.#options.attach(socket, origin) === undefined) return;
    const connection: Connection = { deviceId, ws, entry };
    this.#connections.add(connection);
    devices.touch(deviceId as DeviceId);
    const touch = setInterval(() => devices.touch(deviceId as DeviceId), TOUCH_INTERVAL_MS);
    touch.unref?.();
    const release = this.#options.keepAwake?.hold(`remote device ${deviceId}`);
    ws.on('close', () => {
      clearInterval(touch);
      release?.();
      if (!this.#connections.delete(connection)) return;
      // Host 退出时连接的关闭可能晚于存储关闭（经中继的连接常这样）：这时不再记最后在线时间。
      if (this.#closed) return;
      if (devices.get(deviceId as DeviceId)?.status === 'active')
        devices.touch(deviceId as DeviceId);
      this.#changed();
    });
    this.#changed();
  }

  #dropDevice(deviceId: string, code: CloseCodeName): void {
    for (const connection of [...this.#connections]) {
      if (connection.deviceId === deviceId) this.#drop(connection, code);
    }
  }

  #drop(connection: Connection, code: CloseCodeName): void {
    closeWs(connection.ws, code, closeReason(code));
  }

  #hostPayload(): Uint8Array {
    const relayUrl = this.#relay.url;
    const payload: RemoteHostPayload = {
      protocolVersion: PROTOCOL_VERSION,
      ...(this.#options.hostName !== undefined && { hostName: this.#options.hostName }),
      candidates: this.candidates(),
      ...(relayUrl !== undefined && { relayUrl }),
    };
    return new TextEncoder().encode(JSON.stringify(payload));
  }
}

function keyOf(address: RemoteAddress): string {
  return `${address.kind}|${address.address}`;
}

function handshakeKind(url: string | undefined): HandshakeKind | undefined {
  const path = (url ?? '').split('?', 1)[0];
  if (path === REMOTE_PATHS.pair) return 'secret';
  if (path === REMOTE_PATHS.pairCode) return 'code';
  if (path === REMOTE_PATHS.connect) return 'connect';
  return undefined;
}

function closeReason(code: CloseCodeName): string {
  switch (code) {
    case 'DEVICE_REVOKED':
      return 'device removed';
    case 'PERMISSIONS_CHANGED':
      return 'device permissions changed';
    case 'REMOTE_DISABLED':
      return 'remote access is off';
    default:
      return code.toLowerCase();
  }
}

/** 以关闭码关闭，对方不回关闭帧时直接断开。 */
function closeWs(ws: WebSocket, code: CloseCodeName, reason: string): void {
  if (ws.readyState === ws.CLOSED) return;
  ws.close(CloseCode[code], reason);
  const timer = setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MS);
  timer.unref?.();
  ws.once('close', () => clearTimeout(timer));
}

/** 升级前拒绝：最小的 HTTP 响应，然后关闭。 */
function rejectUpgrade(socket: Duplex, status: 403 | 404): void {
  const body = STATUS_CODES[status] ?? '';
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
