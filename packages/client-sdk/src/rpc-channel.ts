import { JSONRPC_VERSION } from '@wevir/protocol';
import {
  ConnectionLostError,
  ProtocolError,
  RequestTimeoutError,
  WevirRpcError,
} from './errors.js';
import type { Transport, TransportFactory } from './transport.js';

/** 一次调用的结果回调。在收到响应的那一帧里同步调用（订阅要在后续事件帧到达前登记好 ID）。 */
export interface CallHandlers {
  onResult(result: unknown): void;
  onError(error: Error): void;
}

/** 连接为什么没了。 */
export type ChannelLoss =
  | { kind: 'closed'; code: number; reason: string }
  | { kind: 'heartbeat_timeout' }
  | { kind: 'abandoned'; reason: string };

export interface RpcChannelOptions {
  transport: TransportFactory;
  url: string;
  onNotification(method: string, params: unknown): void;
  /** 恰好调用一次：在途调用都已以 `ConnectionLostError` 结束之后。 */
  onLost(loss: ChannelLoss): void;
  onWarning(message: string, detail?: Record<string, unknown>): void;
}

interface PendingCall extends CallHandlers {
  method: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface HeartbeatOptions {
  pingIntervalMs: number;
  /** 超过这么久没有收到 Host 的任何一帧，判定连接已死，放弃它。 */
  heartbeatTimeoutMs: number;
}

/**
 * 一条传输连接上的 JSON-RPC：按 `id` 对应请求与响应，转交通知，连接断开时结束全部在途调用。握手由
 * 调用方用 `call('host.hello')` 完成；之后 `startHeartbeat` 每隔 `pingIntervalMs` 发一次 `host.ping`
 * （host-api.md §12），并在静默超过 `heartbeatTimeoutMs` 时放弃连接（不等关闭握手，死连接上它可能
 * 很久都等不到）。
 */
export class RpcChannel {
  readonly #options: RpcChannelOptions;
  readonly #transport: Transport;
  readonly #pending = new Map<number, PendingCall>();
  #nextId = 1;
  #state: 'opening' | 'open' | 'lost' = 'opening';
  #lastFrameAt = performance.now();
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  #resolveOpened!: () => void;
  #rejectOpened!: (error: Error) => void;
  /** 传输层连上时完成；连上之前断开则以 `ConnectionLostError` reject。 */
  readonly opened = new Promise<void>((resolve, reject) => {
    this.#resolveOpened = resolve;
    this.#rejectOpened = reject;
  });

  constructor(options: RpcChannelOptions) {
    this.#options = options;
    // 没人等 opened 时也不要变成未处理的 rejection。
    this.opened.catch(() => {});
    this.#transport = options.transport(options.url, {
      onOpen: () => {
        if (this.#state !== 'opening') return;
        this.#state = 'open';
        this.#lastFrameAt = performance.now();
        this.#resolveOpened();
      },
      onMessage: (text) => this.#onMessage(text),
      onClose: (info) => this.#lose({ kind: 'closed', code: info.code, reason: info.reason }),
    });
  }

  get isOpen(): boolean {
    return this.#state === 'open';
  }

  /**
   * 发出一个请求。超时、连接断开都经 `onError` 报告；连接已经不可用时同步调用 `onError`。
   * `timeoutError` 定制超时时报的错误（请求排过队时，要报调用方给的原始时限）。
   */
  call(
    method: string,
    params: object,
    timeoutMs: number,
    handlers: CallHandlers,
    timeoutError?: () => Error,
  ): void {
    if (this.#state !== 'open') {
      handlers.onError(new ConnectionLostError(method, undefined));
      return;
    }
    const id = this.#nextId++;
    const pending: PendingCall = { method, ...handlers, timer: undefined };
    pending.timer = setTimeout(
      () => {
        if (!this.#pending.delete(id)) return;
        handlers.onError(timeoutError?.() ?? new RequestTimeoutError(method, timeoutMs, true));
      },
      Math.max(0, timeoutMs),
    );
    this.#pending.set(id, pending);
    try {
      this.#transport.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params }));
    } catch (error) {
      // 传输层已经不能发送：连接实际上已经没了。
      this.abandon(`send failed: ${String(error)}`);
    }
  }

  /** `call` 的 Promise 形式。 */
  request(method: string, params: object, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) =>
      this.call(method, params, timeoutMs, { onResult: resolve, onError: reject }),
    );
  }

  startHeartbeat({ pingIntervalMs, heartbeatTimeoutMs }: HeartbeatOptions): void {
    if (this.#state !== 'open' || this.#pingTimer) return;
    const ignore = { onResult: () => {}, onError: () => {} };
    this.#pingTimer = setInterval(
      () => this.call('host.ping', {}, heartbeatTimeoutMs, ignore),
      pingIntervalMs,
    );
    this.#armWatchdog(heartbeatTimeoutMs, heartbeatTimeoutMs);
  }

  /** 本端放弃连接：发起关闭但不等关闭握手，立即结束在途调用并报告 `onLost`。可重复调用。 */
  abandon(reason: string): void {
    this.#closeTransport(reason);
    this.#lose({ kind: 'abandoned', reason });
  }

  #armWatchdog(timeoutMs: number, delayMs: number): void {
    this.#watchdogTimer = setTimeout(() => {
      const silentMs = performance.now() - this.#lastFrameAt;
      if (silentMs < timeoutMs) {
        this.#armWatchdog(timeoutMs, timeoutMs - silentMs);
        return;
      }
      this.#closeTransport('heartbeat timeout');
      this.#lose({ kind: 'heartbeat_timeout' });
    }, delayMs);
  }

  #closeTransport(reason: string): void {
    if (this.#state === 'lost') return;
    try {
      this.#transport.close(1000, reason);
    } catch {
      // 已经在关了。
    }
  }

  #lose(loss: ChannelLoss): void {
    if (this.#state === 'lost') return;
    const wasOpening = this.#state === 'opening';
    this.#state = 'lost';
    clearInterval(this.#pingTimer);
    clearTimeout(this.#watchdogTimer);
    const code = loss.kind === 'closed' ? loss.code : undefined;
    const reason =
      loss.kind === 'closed'
        ? loss.reason
        : loss.kind === 'abandoned'
          ? loss.reason
          : 'heartbeat timeout';
    if (wasOpening) this.#rejectOpened(new ConnectionLostError(undefined, code, reason));
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) {
      clearTimeout(call.timer);
      call.onError(new ConnectionLostError(call.method, code, reason));
    }
    this.#options.onLost(loss);
  }

  #onMessage(text: string): void {
    if (this.#state !== 'open') return;
    this.#lastFrameAt = performance.now();
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#options.onWarning('ignored a frame that is not valid JSON', {
        frame: text.slice(0, 200),
      });
      return;
    }
    if (!isRecord(frame) || frame.jsonrpc !== JSONRPC_VERSION) {
      this.#options.onWarning('ignored a frame that is not a JSON-RPC 2.0 object', {
        frame: text.slice(0, 200),
      });
      return;
    }
    if (typeof frame.method === 'string' && frame.id === undefined) {
      this.#options.onNotification(frame.method, frame.params);
      return;
    }
    if (typeof frame.id === 'number') {
      const call = this.#pending.get(frame.id);
      // 已超时的请求，响应来晚了。
      if (!call) return;
      this.#pending.delete(frame.id);
      clearTimeout(call.timer);
      if ('error' in frame) {
        const error = frame.error;
        if (isRecord(error) && Number.isInteger(error.code) && typeof error.message === 'string') {
          call.onError(
            new WevirRpcError(call.method, {
              code: error.code as number,
              message: error.message,
              data: error.data,
            }),
          );
        } else {
          call.onError(new ProtocolError(`malformed error response to ${call.method}`, error));
        }
      } else if ('result' in frame) {
        call.onResult(frame.result);
      } else {
        call.onError(new ProtocolError(`response to ${call.method} has neither result nor error`));
      }
      return;
    }
    if (frame.id === null && 'error' in frame) {
      // Host 认不出是哪个请求（帧不合法）：说明本端发了不合协议的东西。
      this.#options.onWarning('the host rejected a frame it could not parse', {
        error: frame.error,
      });
      return;
    }
    this.#options.onWarning('ignored an unexpected frame', { frame: text.slice(0, 200) });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
