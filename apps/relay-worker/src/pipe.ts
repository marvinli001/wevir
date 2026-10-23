import { DurableObject } from 'cloudflare:workers';
import { RELAY_MAX_MESSAGE_BYTES, RelayCloseCode, type RelayDevicePath } from '@wevir/protocol';
import { type Env, limitsOf } from './config.js';
import type { ReserveResult } from './control.js';
import { closeWs, passable, resetWhenDone, status } from './util.js';

type Side = 'device' | 'host';

/** 每条 WebSocket 的附件：哪一侧、哪条设备连接、经哪条控制连接。 */
interface SideState {
  side: Side;
  id: string;
  control: string;
  /** 这条设备连接已经结束（另一侧先关了），关闭事件不再处理。 */
  ended?: boolean;
}

/** Host 接上之前的状态，只在内存里：这段时间有计时器在走，对象不会休眠。 */
interface Waiting {
  /** 还在等 Control 通知 Host（`reserve`）。结果出来之前 Host 的数据连接可能已经到了。 */
  reserved: Promise<boolean>;
  /** Host 的数据连接已经来过（同一个 ID 只能接一次）。 */
  claimed: boolean;
  /** 等的期间这条连接已经被结束（Host 拒绝、Host 离线）：接受设备之后立刻以这个码关闭。 */
  doomed?: { code: number; reason: string };
  queue: ArrayBuffer[];
  queuedBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

/**
 * 一条设备连接，Durable Object 的名字是 16 字节随机的连接 ID（`idFromName`）：设备的 WebSocket 与 Host 为它开的数据连接
 * （`/v1/accept?id=…`）都落在这里，原样互相转发二进制消息。连接 ID 的长度是协议定的，放不下 Durable Object 的 ID，所以数据连接
 * 只能靠名字找到它。
 *
 * 不做离线缓冲：Host 接上之前设备先到的消息排队（条数与字节有上限）；任一侧断开，另一侧以同一关闭码关闭。用休眠 API：两侧都没有
 * 消息时不占时长。
 */
export class Pipe extends DurableObject<Env> {
  #waiting: Waiting | undefined;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? '';
    if (url.pathname === '/device') {
      const control = url.searchParams.get('control') ?? '';
      const path = url.searchParams.get('path') as RelayDevicePath;
      return this.#device(id, control, path, url.searchParams.get('source') ?? '');
    }
    return this.#accept(id);
  }

  async #device(
    id: string,
    control: string,
    path: RelayDevicePath,
    source: string,
  ): Promise<Response> {
    if (this.#waiting !== undefined || this.ctx.getWebSockets().length > 0) return status(404);
    let settle!: (ok: boolean) => void;
    const waiting: Waiting = {
      reserved: new Promise((resolve) => {
        settle = resolve;
      }),
      claimed: false,
      queue: [],
      queuedBytes: 0,
      timer: null,
      done: false,
    };
    this.#waiting = waiting;
    let result: ReserveResult;
    try {
      result = await this.#control(control).reserve(id, path, source);
    } catch {
      result = 'offline';
    }
    if (result !== 'ok') {
      waiting.done = true;
      this.#waiting = undefined;
      settle(false);
      return status(result === 'busy' ? 503 : 404);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['device']);
    server.serializeAttachment({ side: 'device', id, control } satisfies SideState);
    settle(true);
    if (waiting.doomed !== undefined) {
      this.#endWaiting(server, waiting.doomed.code, waiting.doomed.reason);
    } else if (!waiting.done) {
      waiting.timer = setTimeout(
        () => this.#endWaiting(server, RelayCloseCode.HOST_UNAVAILABLE, 'host did not answer'),
        limitsOf(this.env).acceptTimeoutMs,
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async #accept(id: string): Promise<Response> {
    const waiting = this.#waiting;
    if (waiting === undefined || waiting.claimed || waiting.done) return status(404);
    // 先占住：同一个 ID 只能接一次。
    waiting.claimed = true;
    if (!(await waiting.reserved) || waiting.done) return status(404);
    const device = this.#side('device');
    if (device === undefined) return status(404);
    const { control } = device.deserializeAttachment() as SideState;
    waiting.done = true;
    clearTimeout(waiting.timer);
    this.#waiting = undefined;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['host']);
    server.serializeAttachment({ side: 'host', id, control } satisfies SideState);
    for (const bytes of waiting.queue) server.send(bytes);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Control 结束一条还没接上的连接（Host 拒绝、Host 离线）。已经接通的不动。 */
  async end(code: number, reason: string): Promise<void> {
    const waiting = this.#waiting;
    if (waiting === undefined || waiting.done) return;
    const device = this.#side('device');
    if (device === undefined) {
      // 还在等 `reserve` 的结果：接受设备之后立刻关闭（apps/relay 里设备那时已经升级完了）。
      waiting.doomed = { code, reason };
      return;
    }
    this.#endWaiting(device, code, reason);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SideState;
    if (state.ended === true) return;
    if (typeof message === 'string' || message.byteLength > RELAY_MAX_MESSAGE_BYTES) {
      await this.#endBoth(
        RelayCloseCode.PROTOCOL_ERROR,
        typeof message === 'string' ? 'binary messages only' : 'message too large',
      );
      return;
    }
    const peer = this.#side(state.side === 'device' ? 'host' : 'device');
    if (peer !== undefined) {
      peer.send(message);
      return;
    }
    const waiting = this.#waiting;
    if (state.side !== 'device') return;
    if (waiting === undefined || waiting.done) {
      // 等 Host 的状态没了（对象在等的期间被驱逐）：Host 再也接不上这条连接。
      this.#endWaiting(ws, RelayCloseCode.HOST_UNAVAILABLE, 'host did not answer');
      return;
    }
    waiting.queue.push(message);
    waiting.queuedBytes += message.byteLength;
    const limits = limitsOf(this.env);
    if (
      waiting.queue.length > limits.maxQueuedMessages ||
      waiting.queuedBytes > limits.maxQueuedBytes
    ) {
      this.#endWaiting(ws, RelayCloseCode.LIMIT_EXCEEDED, 'too much queued');
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.#closed(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#closed(ws, 1006, '');
  }

  /**
   * 一侧关了：另一侧以同一关闭码关闭（Host 的 `DEVICE_REVOKED` 等原样带给设备）。异常断开（1005 / 1006）时另一侧收到不带状态码的
   * 关闭帧，与 apps/relay 的直接断开一样不带原因。
   */
  async #closed(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = ws.deserializeAttachment() as SideState;
    const pass = passable(code) ? code : undefined;
    closeWs(ws, pass, reason, true);
    if (state.ended === true) {
      resetWhenDone(this.ctx, ws);
      return;
    }
    this.#markEnded(ws);
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      waiting.done = true;
      clearTimeout(waiting.timer);
      this.#waiting = undefined;
    }
    const peer = this.#side(state.side === 'device' ? 'host' : 'device');
    if (peer !== undefined) {
      this.#markEnded(peer);
      closeWs(peer, pass, reason);
    }
    await this.#release(state);
    resetWhenDone(this.ctx, ws);
  }

  /** 结束一条还没接上的连接：以 `code` 关闭设备。 */
  #endWaiting(device: WebSocket, code: number, reason: string): void {
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      waiting.done = true;
      clearTimeout(waiting.timer);
      this.#waiting = undefined;
    }
    const state = device.deserializeAttachment() as SideState;
    if (state.ended === true) return;
    this.#markEnded(device);
    closeWs(device, code, reason);
    this.ctx.waitUntil(this.#release(state));
  }

  /** 中继自己结束接通的连接（协议错误）：两侧都以 `code` 关闭。 */
  async #endBoth(code: number, reason: string): Promise<void> {
    let state: SideState | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      const sideState = ws.deserializeAttachment() as SideState;
      if (sideState.ended === true) continue;
      state ??= sideState;
      this.#markEnded(ws);
      closeWs(ws, code, reason);
    }
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      waiting.done = true;
      clearTimeout(waiting.timer);
      this.#waiting = undefined;
    }
    if (state !== undefined) await this.#release(state);
  }

  #markEnded(ws: WebSocket): void {
    const state = ws.deserializeAttachment() as SideState;
    ws.serializeAttachment({ ...state, ended: true });
  }

  async #release(state: SideState): Promise<void> {
    try {
      await this.#control(state.control).release(state.id);
    } catch {
      // 控制连接已经不在了。
    }
  }

  /** 这一侧还开着的 WebSocket。 */
  #side(side: Side): WebSocket | undefined {
    return this.ctx.getWebSockets(side).find((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      return (ws.deserializeAttachment() as SideState).ended !== true;
    });
  }

  #control(control: string) {
    return this.env.CONTROLS.get(this.env.CONTROLS.idFromString(control));
  }
}
