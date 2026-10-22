// 远程监听的测试客户端（0.109.0）：扮演手机或远程 CLI，经真实的 WebSocket 与 `@wevir/noise` 跟 Host 握手，握手之后的 JSON-RPC
// 帧交给 `TestRpcClient`。给了 `route` 时 `base` 是中继地址（0.110.0），路径带上路由 ID。只给测试用。

import { EventEmitter } from 'node:events';
import {
  createHandshake,
  derivePairingPsk,
  FrameReader,
  generateKeyPair,
  type HandshakeState,
  type KeyPair,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
  remotePrologue,
  sealFrame,
  type TransportCiphers,
} from '@wevir/noise';
import {
  type DevicePlatform,
  RELAY_ROUTE_PARAM,
  REMOTE_PATHS,
  type RemoteHostPayload,
  RemoteHostPayloadSchema,
} from '@wevir/protocol';
import { type RawData, WebSocket } from 'ws';
import { TestRpcClient } from '../test-utils.js';
import { toBytes } from './noise-socket.js';

const WAIT_MS = 5000;

/** 一台测试设备：Noise 静态密钥与它的 base64url 公钥。 */
export interface TestDevice {
  readonly keys: KeyPair;
  readonly publicKey: string;
}

export function newTestDevice(): TestDevice {
  const keys = generateKeyPair();
  return { keys, publicKey: Buffer.from(keys.publicKey).toString('base64url') };
}

/** 握手完成的远程连接。 */
export interface RemoteTestConnection {
  readonly client: TestRpcClient;
  readonly ws: WebSocket;
  /** Host 在握手里给的负载。 */
  readonly host: RemoteHostPayload;
}

/** Host 的公开身份：二维码里的 Host 公钥与路由 ID（base64url）。 */
export interface TestHostIdentity {
  readonly hostPublicKey: string;
  readonly routeId: string;
}

/** 收着的 WebSocket 消息，按到达顺序一条条取。 */
class Inbox {
  readonly #messages: { data: RawData; isBinary: boolean }[] = [];
  readonly #waiters: (() => void)[] = [];
  closed: { code: number; reason: string } | undefined;

  constructor(ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      this.#messages.push({ data, isBinary });
      this.#wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
      this.#wake();
    });
  }

  async next(): Promise<Uint8Array> {
    const deadline = Date.now() + WAIT_MS;
    while (this.#messages.length === 0) {
      if (this.closed) throw Object.assign(new Error('closed'), this.closed);
      if (Date.now() > deadline) throw new Error('timed out waiting for a message');
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    const { data } = this.#messages.shift() as { data: RawData };
    return toBytes(data);
  }

  drain(): { data: RawData; isBinary: boolean }[] {
    return this.#messages.splice(0);
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

/** 连上远程监听的某个路径（不带 Origin 头，像原生客户端那样）。 */
export function openRemoteSocket(
  base: string,
  path: string,
  options: { origin?: string } = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`${base}${path}`, options.origin ? { origin: options.origin } : {});
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })),
    );
  });
}

/**
 * 配对：`XXpsk2`，PSK 从二维码里的配对秘密（或短码的 UTF-8）与 Host 公钥派生；第三条消息带名称与平台。握手完成后 Host 等桌面允许
 * 才处理 hello，所以这里只返回通道，hello 由调用方发。
 */
export async function pairRemote(options: {
  base: string;
  host: TestHostIdentity;
  /** 配对秘密的字节（二维码 `s` 参数解码），或短码的 UTF-8。 */
  secret: Uint8Array;
  code?: boolean;
  device: TestDevice;
  name?: string;
  platform?: DevicePlatform;
  /** 经中继：Host 的路由 ID。 */
  route?: string;
}): Promise<RemoteTestConnection> {
  const ws = await openRemoteSocket(
    options.base,
    withRoute(options.code === true ? REMOTE_PATHS.pairCode : REMOTE_PATHS.pair, options.route),
  );
  try {
    return await pairOver(ws, options);
  } catch (error) {
    // 像真的客户端那样：握手失败就断开。
    ws.terminate();
    throw error;
  }
}

async function pairOver(
  ws: WebSocket,
  options: Parameters<typeof pairRemote>[0],
): Promise<RemoteTestConnection> {
  const hostKey = new Uint8Array(Buffer.from(options.host.hostPublicKey, 'base64url'));
  const inbox = new Inbox(ws);
  const handshake = createHandshake({
    protocol: PAIRING_PROTOCOL,
    initiator: true,
    prologue: remotePrologue({ host: options.host.routeId }),
    staticKeyPair: options.device.keys,
    remoteStaticKey: hostKey,
    psk: derivePairingPsk(options.secret, hostKey),
  });
  ws.send(handshake.writeMessage());
  const host = readHostPayload(handshake, await inbox.next());
  ws.send(
    handshake.writeMessage(
      new TextEncoder().encode(
        JSON.stringify({ name: options.name ?? 'Test phone', platform: options.platform ?? 'ios' }),
      ),
    ),
  );
  return { client: wrap(ws, inbox, handshake.split()), ws, host };
}

/** 重连：`IK`，设备事先知道 Host 公钥。 */
export async function connectRemote(options: {
  base: string;
  host: TestHostIdentity;
  device: TestDevice;
  /** 经中继：Host 的路由 ID。 */
  route?: string;
}): Promise<RemoteTestConnection> {
  const ws = await openRemoteSocket(options.base, withRoute(REMOTE_PATHS.connect, options.route));
  try {
    return await connectOver(ws, options);
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

async function connectOver(
  ws: WebSocket,
  options: Parameters<typeof connectRemote>[0],
): Promise<RemoteTestConnection> {
  const inbox = new Inbox(ws);
  const handshake = createHandshake({
    protocol: RECONNECT_PROTOCOL,
    initiator: true,
    prologue: remotePrologue({ host: options.host.routeId }),
    staticKeyPair: options.device.keys,
    remoteStaticKey: new Uint8Array(Buffer.from(options.host.hostPublicKey, 'base64url')),
  });
  ws.send(handshake.writeMessage());
  const host = readHostPayload(handshake, await inbox.next());
  return { client: wrap(ws, inbox, handshake.split()), ws, host };
}

/** 经中继时路径带上路由 ID。 */
export function withRoute(path: string, route: string | undefined): string {
  return route === undefined ? path : `${path}?${RELAY_ROUTE_PARAM}=${encodeURIComponent(route)}`;
}

function readHostPayload(handshake: HandshakeState, message: Uint8Array): RemoteHostPayload {
  return RemoteHostPayloadSchema.parse(
    JSON.parse(new TextDecoder().decode(handshake.readMessage(message))),
  );
}

/** 握手之后的通道：发出的帧加密分片，收到的解密拼好，交给 `TestRpcClient`。 */
function wrap(ws: WebSocket, inbox: Inbox, ciphers: TransportCiphers): TestRpcClient {
  const reader = new FrameReader(ciphers.receive);
  const socket = new EventEmitter() as EventEmitter & {
    send(text: string): void;
    readonly readyState: number;
    close(code?: number, reason?: string): void;
    terminate(): void;
  };
  const receive = (data: RawData) => {
    const frame = reader.push(toBytes(data));
    if (frame !== undefined) socket.emit('message', Buffer.from(frame), false);
  };
  Object.defineProperty(socket, 'readyState', { get: () => ws.readyState });
  socket.send = (text) => {
    for (const message of sealFrame(ciphers.send, Buffer.from(text, 'utf8'))) ws.send(message);
  };
  socket.close = (code, reason) => ws.close(code, reason);
  socket.terminate = () => ws.terminate();
  ws.removeAllListeners('message');
  ws.on('message', receive);
  ws.on('close', (code, reason) => socket.emit('close', code, reason));
  const client = TestRpcClient.wrap(socket as unknown as WebSocket);
  for (const { data } of inbox.drain()) receive(data);
  if (inbox.closed)
    queueMicrotask(() => socket.emit('close', inbox.closed?.code, inbox.closed?.reason));
  return client;
}
