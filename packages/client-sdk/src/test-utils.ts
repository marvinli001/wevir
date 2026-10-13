// 测试共用：可编程的假 Host（单元测试用的传输层）与真实 Host 的启动、传输层探针。只被 *.test.ts 引用，
// 不进 index，也不在浏览器入口的类型检查里。

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import {
  type ClientIdentity,
  HOST_FEATURES,
  PERMISSIONS,
  PROTOCOL_VERSION,
  type SessionId,
} from '@wevir/protocol';
import { EchoAdapter, type EchoAdapterOptions } from '@wevir/runtime-adapter/echo';
import { afterEach, beforeEach } from 'vitest';
import type { HostHello } from './client.js';
import type { Transport, TransportFactory, TransportHandlers } from './transport.js';

export const identity: ClientIdentity = {
  clientKind: 'cli',
  deviceId: 'dev-test',
  clientId: 'cli-test',
};

export const HELLO: HostHello = {
  hostId: 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR',
  hostVersion: '0.0.0',
  protocolVersion: PROTOCOL_VERSION,
  minProtocolVersion: '0.1.0',
  features: { ...HOST_FEATURES },
  permissions: [...PERMISSIONS],
};

export const SES: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';

/** 一个最小合法的事件对象。 */
export function event(seq: number, type = 'turn.started', sessionId: SessionId = SES) {
  const payloads: Record<string, unknown> = {
    'turn.started': { turnId: 'trn_1' },
    'session.title_changed': { title: `t${seq}`, source: 'first_prompt' },
  };
  return {
    seq,
    sessionId,
    ts: '2026-10-13T00:00:00.000Z',
    type,
    source: 'host',
    payload: payloads[type] ?? { anything: true },
  };
}

// ── 假 Host ───────────────────────────────────────────────────────────

/** 假 Host 对一个请求的回复：结果、错误，或者不回。 */
export type Reply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | 'no-reply';

// biome-ignore lint/suspicious/noExplicitAny: 测试按需读取任意形状的参数。
export type Handler = (params: any, socket: FakeSocket) => Reply;

// biome-ignore lint/suspicious/noExplicitAny: 同上。
export type SentFrame = { id: number; method: string; params: any };

/** 假 Host 上的一条连接。测试可以替 Host 回复、推送通知、断开。 */
export class FakeSocket implements Transport {
  readonly url: string;
  readonly sent: SentFrame[] = [];
  /** 客户端发起的关闭。 */
  closedByClient: { code?: number; reason?: string } | undefined;
  #handlers: TransportHandlers;
  #host: FakeHost;
  #closed = false;

  constructor(url: string, handlers: TransportHandlers, host: FakeHost) {
    this.url = url;
    this.#handlers = handlers;
    this.#host = host;
  }

  get closed(): boolean {
    return this.#closed;
  }

  open(): void {
    if (!this.#closed) this.#handlers.onOpen();
  }

  send(text: string): void {
    const frame = JSON.parse(text) as SentFrame;
    this.sent.push(frame);
    const handler = this.#host.handlers.get(frame.method);
    const reply = handler ? handler(frame.params, this) : 'no-reply';
    if (reply === 'no-reply') return;
    // 与真实的 WebSocket 一样，回复在之后的任务里到达。
    setTimeout(() => this.reply(frame.id, reply), 0);
  }

  reply(id: number, reply: Exclude<Reply, 'no-reply'>): void {
    this.deliver({ jsonrpc: '2.0', id, ...reply });
  }

  notify(method: string, params: unknown): void {
    this.deliver({ jsonrpc: '2.0', method, params });
  }

  deliver(frame: unknown): void {
    if (!this.#closed) this.#handlers.onMessage(JSON.stringify(frame));
  }

  close(code?: number, reason?: string): void {
    this.closedByClient = { code, reason };
    setTimeout(() => this.drop(code ?? 1000, reason ?? ''), 0);
  }

  /** Host 一侧断开（默认像网络中断一样 1006）。 */
  drop(code = 1006, reason = ''): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.onClose({ code, reason });
  }

  requests(method: string): SentFrame[] {
    return this.sent.filter((frame) => frame.method === method);
  }
}

/** 可编程的假 Host：默认回 hello 与 ping，其余方法按 `handlers` 回复。 */
export class FakeHost {
  readonly sockets: FakeSocket[] = [];
  readonly handlers = new Map<string, Handler>([
    ['host.hello', () => ({ result: HELLO })],
    ['host.ping', () => ({ result: {} })],
  ]);
  /** false 时连接一直停在“正在连接”。 */
  autoOpen = true;

  readonly transport: TransportFactory = (url, handlers) => {
    const socket = new FakeSocket(url, handlers, this);
    this.sockets.push(socket);
    if (this.autoOpen) setTimeout(() => socket.open(), 0);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('还没有连接');
    return socket;
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }
}

// ── 真实 Host ─────────────────────────────────────────────────────────

/** 注册 beforeEach / afterEach：每个用例一个新的临时目录，结束时删除。 */
export function useTempDir(): () => string {
  let dir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wevir-client-sdk-'));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  return () => {
    if (!dir) throw new Error('useTempDir() 只能在用例里取值');
    return dir;
  };
}

/** 在 `home` 上启动一个用 EchoAdapter 的真实 Host（与 `wevir-host --adapter echo` 相同的组装）。 */
export function startEchoHost(home: string, echo: EchoAdapterOptions = {}): Promise<RunningHost> {
  return startHost({
    home,
    adapter: new EchoAdapter({ stepDelayMs: 1, ...echo }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
}

/** 在 `dir` 下建一个工作区目录，返回它的路径。 */
export function workspaceDir(dir: string): string {
  const path = join(dir, 'workspace');
  mkdirSync(path, { recursive: true });
  return path;
}

/** 包一层传输层：记录客户端发出的每一帧。 */
export function spyTransport(inner: TransportFactory, sent: SentFrame[]): TransportFactory {
  return (url, handlers) => {
    const transport = inner(url, handlers);
    return {
      send: (text) => {
        sent.push(JSON.parse(text) as SentFrame);
        transport.send(text);
      },
      close: (code, reason) => transport.close(code, reason),
    };
  };
}

/** 包一层传输层：`drop` 返回 true 的帧不交给客户端（制造丢帧）。 */
export function filterTransport(
  inner: TransportFactory,
  drop: (frame: unknown) => boolean,
): TransportFactory {
  return (url, handlers) =>
    inner(url, {
      ...handlers,
      onMessage: (text) => {
        if (!drop(JSON.parse(text))) handlers.onMessage(text);
      },
    });
}
