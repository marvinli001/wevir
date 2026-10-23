import { DurableObject } from 'cloudflare:workers';
import {
  RELAY_CONTROL_MAX_BYTES,
  RELAY_NONCE_BYTES,
  RelayCloseCode,
  type RelayDevicePath,
  RelayHostMessageSchema,
  type RelayServerMessage,
  relayRegistrationMessage,
} from '@wevir/protocol';
import { type Env, limitsOf } from './config.js';
import { closeWs, fromBase64url, log, randomBase64url, resetWhenDone, routeTag } from './util.js';

/** 控制连接的状态，存在 WebSocket 的附件里：休眠醒来后还在，不写存储。 */
interface ControlState {
  nonce: string;
  routeId?: string;
  tag?: string;
  /** 被同一路由 ID 的新注册取代了。 */
  replaced?: boolean;
  /** 这条控制连接上还开着的设备连接的 ID（等 Host 接上的与接通的）。 */
  conns: string[];
}

/** `reserve` 的结果：`offline` 对设备是 404，`busy` 是 503。 */
export type ReserveResult = 'ok' | 'offline' | 'busy';

/**
 * Host 的一条控制连接（`/v1/host`），每条连接一个 Durable Object（`newUniqueId()`）。发挑战、验 Ed25519 签名、在路由 ID 的
 * `Route` 上登记；之后替 Pipe 通知 Host 有设备来连（`incoming`），把 Host 的 `reject` 转给那条 Pipe。用休眠 API 接受 WebSocket：
 * Host 在线但没人来连时不占时长，Host 的 ping 由运行时直接回 pong，不唤醒对象。
 */
export class Control extends DurableObject<Env> {
  #registerTimer: ReturnType<typeof setTimeout> | null = null;

  override async fetch(_request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const state: ControlState = { nonce: randomBase64url(RELAY_NONCE_BYTES), conns: [] };
    server.serializeAttachment(state);
    send(server, { type: 'challenge', nonce: state.nonce });
    this.#registerTimer = setTimeout(() => {
      const ws = this.#socket();
      if (ws !== undefined && this.#state(ws).routeId === undefined) {
        closeWs(ws, RelayCloseCode.REGISTRATION_FAILED, 'registration timed out');
      }
    }, limitsOf(this.env).registerTimeoutMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = this.#state(ws);
    if (state.replaced === true) return;
    const parsed = parseHostMessage(message);
    if (state.routeId === undefined) {
      clearTimeout(this.#registerTimer);
      if (parsed?.type !== 'register' || !(await verifyRegistration(parsed, state.nonce))) {
        log(this.env.WEVIR_RELAY_LOG_LEVEL, 'info', 'host registration failed');
        closeWs(ws, RelayCloseCode.REGISTRATION_FAILED, 'registration failed');
        return;
      }
      state.routeId = parsed.routeId;
      state.tag = await routeTag(parsed.routeId);
      ws.serializeAttachment(state);
      await this.#route(parsed.routeId).register(this.ctx.id.toString());
      if (ws.readyState !== WebSocket.OPEN) {
        // 注册的这一会儿 Host 已经断开了。
        await this.#route(parsed.routeId).unregister(this.ctx.id.toString());
        return;
      }
      log(this.env.WEVIR_RELAY_LOG_LEVEL, 'info', 'host registered', { route: state.tag });
      send(ws, { type: 'registered' });
      return;
    }
    if (parsed?.type === 'reject') {
      if (!state.conns.includes(parsed.id)) return;
      state.conns = state.conns.filter((id) => id !== parsed.id);
      ws.serializeAttachment(state);
      await this.#pipe(parsed.id).end(RelayCloseCode.HOST_REJECTED, 'rejected by the host');
      return;
    }
    closeWs(ws, RelayCloseCode.PROTOCOL_ERROR, 'unexpected control message');
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeWs(ws, code === 1005 || code === 1006 ? undefined : code, reason, true);
    await this.#closed(ws);
    resetWhenDone(this.ctx, ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#closed(ws);
    resetWhenDone(this.ctx, ws);
  }

  /** 一条设备连接要经这台 Host：记下它并通知 Host。 */
  async reserve(id: string, path: RelayDevicePath, source: string): Promise<ReserveResult> {
    const ws = this.#socket();
    if (ws === undefined) return 'offline';
    const state = this.#state(ws);
    if (state.routeId === undefined || state.replaced === true) return 'offline';
    if (state.conns.length >= limitsOf(this.env).maxConnectionsPerRoute) return 'busy';
    state.conns.push(id);
    ws.serializeAttachment(state);
    send(ws, { type: 'incoming', id, path, source });
    return 'ok';
  }

  /** 一条设备连接结束了。 */
  async release(id: string): Promise<void> {
    const ws = this.#socket();
    if (ws === undefined) return;
    const state = this.#state(ws);
    if (!state.conns.includes(id)) return;
    state.conns = state.conns.filter((conn) => conn !== id);
    ws.serializeAttachment(state);
  }

  /** 同一路由 ID 在别处注册成功了（`Route.register`）。 */
  async replaced(): Promise<void> {
    const ws = this.#socket();
    if (ws === undefined) return;
    const state = this.#state(ws);
    state.replaced = true;
    ws.serializeAttachment(state);
    log(this.env.WEVIR_RELAY_LOG_LEVEL, 'info', 'host registration replaced', {
      route: state.tag,
    });
    closeWs(ws, RelayCloseCode.ROUTE_REPLACED, 'route registered again');
  }

  /**
   * 控制连接断了：路由消失，还没接上的设备连接以 `HOST_UNAVAILABLE` 关闭；接通了的各自有数据连接，照常走到断开。被取代的不动
   * 路由，它的设备连接也留给超时，与 apps/relay 相同。
   */
  async #closed(ws: WebSocket): Promise<void> {
    clearTimeout(this.#registerTimer);
    const state = this.#state(ws);
    if (state.routeId === undefined || state.replaced === true) return;
    state.replaced = true;
    ws.serializeAttachment(state);
    log(this.env.WEVIR_RELAY_LOG_LEVEL, 'info', 'host disconnected', { route: state.tag });
    await this.#route(state.routeId).unregister(this.ctx.id.toString());
    await Promise.allSettled(
      state.conns.map((id) =>
        this.#pipe(id).end(RelayCloseCode.HOST_UNAVAILABLE, 'host went offline'),
      ),
    );
  }

  #socket(): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => ws.readyState === WebSocket.OPEN);
  }

  #state(ws: WebSocket): ControlState {
    return ws.deserializeAttachment() as ControlState;
  }

  #route(routeId: string) {
    return this.env.ROUTES.get(this.env.ROUTES.idFromName(routeId));
  }

  #pipe(id: string) {
    return this.env.PIPES.get(this.env.PIPES.idFromName(id));
  }
}

function send(ws: WebSocket, message: RelayServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function parseHostMessage(message: string | ArrayBuffer) {
  // 二进制消息与超长的消息都不是控制消息（apps/relay 的控制连接 maxPayload 是 4096 字节）。
  if (typeof message !== 'string' || message.length > RELAY_CONTROL_MAX_BYTES) return undefined;
  if (new TextEncoder().encode(message).length > RELAY_CONTROL_MAX_BYTES) return undefined;
  try {
    const parsed = RelayHostMessageSchema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 路由 ID 就是 Ed25519 公钥（base64url）；签名对的是这条连接的挑战。 */
async function verifyRegistration(
  message: { routeId: string; signature: string },
  nonce: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: message.routeId },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64url(message.signature),
      relayRegistrationMessage(nonce),
    );
  } catch {
    return false;
  }
}
