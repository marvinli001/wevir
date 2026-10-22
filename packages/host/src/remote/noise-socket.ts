import { EventEmitter } from 'node:events';
import { FrameReader, MAX_FRAME_LENGTH, sealFrame, type TransportCiphers } from '@wevir/noise';
import { ErrorCode } from '@wevir/protocol';
import type { RawData, WebSocket } from 'ws';
import type { RpcSocket } from '../rpc-connection.js';

/**
 * 握手完成的远程连接上的 JSON-RPC 帧（ADR-0017 §2）：一条 WebSocket 二进制消息是一条 Noise 传输消息，一个 JSON-RPC 对象按
 * `@wevir/noise` 的分片切成一条或几条。交给 `RpcConnection` 的是解密、拼好的文本帧。
 *
 * - 任何一条解密失败、分片标志不对、帧超过 4 MiB，或收到文本消息，都立即断开，不重同步。
 * - 发出的帧超过 4 MiB 时（对端的 FrameReader 也会拒收）：响应换成一条 `INTERNAL_ERROR`，别的帧丢掉并报给 `onError`。
 * - 关闭码与 WebSocket 的 ping / pong 在 Noise 之外（ws 协议层），只有码，没有内容。
 */
export class NoiseRpcSocket extends EventEmitter implements RpcSocket {
  readonly #ws: WebSocket;
  readonly #send: TransportCiphers['send'];
  readonly #reader: FrameReader;
  readonly #onError: (error: unknown) => void;
  #failed = false;

  constructor(ws: WebSocket, ciphers: TransportCiphers, onError: (error: unknown) => void) {
    super();
    this.#ws = ws;
    this.#send = ciphers.send;
    this.#reader = new FrameReader(ciphers.receive);
    this.#onError = onError;
    ws.on('ping', () => this.emit('ping'));
    ws.on('pong', () => this.emit('pong'));
    ws.on('error', (error) => this.emit('error', error));
    ws.on('close', () => this.emit('close'));
  }

  get bufferedAmount(): number {
    return this.#ws.bufferedAmount;
  }

  /**
   * 收一条 WebSocket 消息。握手阶段之后的第一条起都经这里，包括配对时等桌面允许期间先到、排着队的那几条。
   */
  receive(data: RawData, isBinary: boolean): void {
    if (this.#failed) return;
    if (!isBinary) {
      this.#fail();
      return;
    }
    let frame: Uint8Array | undefined;
    try {
      frame = this.#reader.push(toBytes(data));
    } catch {
      this.#fail();
      return;
    }
    if (frame !== undefined) this.emit('message', Buffer.from(frame), false);
  }

  send(data: string, cb?: (error?: Error) => void): void {
    if (this.#failed) {
      cb?.(new Error('connection failed'));
      return;
    }
    let bytes: Uint8Array = Buffer.from(data, 'utf8');
    if (bytes.length > MAX_FRAME_LENGTH) {
      const replacement = oversizedResponse(data);
      this.#onError(new Error(`a ${bytes.length}-byte frame exceeds the remote frame limit`));
      if (replacement === undefined) {
        cb?.();
        return;
      }
      bytes = Buffer.from(replacement, 'utf8');
    }
    const messages = sealFrame(this.#send, bytes);
    messages.forEach((message, index) => {
      this.#ws.send(message, { binary: true }, index === messages.length - 1 ? cb : undefined);
    });
  }

  close(code: number, reason: string): void {
    this.#ws.close(code, reason);
  }

  terminate(): void {
    this.#ws.terminate();
  }

  #fail(): void {
    this.#failed = true;
    this.#ws.terminate();
  }
}

/** 太大的响应换成同一个 `id` 的错误；不是响应（通知、事件）时 undefined。 */
function oversizedResponse(text: string): string | undefined {
  let id: unknown;
  try {
    const frame = JSON.parse(text) as { id?: unknown; result?: unknown; error?: unknown };
    if (!('id' in frame) || (frame.result === undefined && frame.error === undefined)) {
      return undefined;
    }
    id = frame.id;
  } catch {
    return undefined;
  }
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: ErrorCode.INTERNAL_ERROR, message: 'result exceeds the remote frame limit' },
  });
}

export function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}
