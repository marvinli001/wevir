// iOS 模拟器的画面流（0.122.0）：`simulator.attach` 给出的 `streamUrl`（Host 的 RPC 端口上的 `/simulator/stream?token=…`）是只发
// 二进制帧的 WebSocket，一条消息一帧：`u8 kind | u64 ptsMicros | u32 length | bytes`，大端（`SIMULATOR_FRAME_*`）。这里只解帧，
// 解码（WebCodecs `VideoDecoder`，`avc1`，`description` 用配置帧）由调用方做。浏览器与 Node 共用：WebSocket 由调用方注入。

import {
  SIMULATOR_FRAME_HEADER_BYTES,
  SIMULATOR_FRAME_KIND,
  type SimulatorFrameSize,
  SimulatorFrameSizeSchema,
} from '@wevir/protocol';
import type { BinaryWebSocketConstructor, BinaryWebSocketLike } from './remote.js';

export type SimulatorFrame =
  | { kind: 'config'; ptsMicros: number; data: Uint8Array }
  | { kind: 'key'; ptsMicros: number; data: Uint8Array }
  | { kind: 'delta'; ptsMicros: number; data: Uint8Array }
  | { kind: 'size'; ptsMicros: number; data: Uint8Array; size: SimulatorFrameSize };

const KINDS = {
  [SIMULATOR_FRAME_KIND.config]: 'config',
  [SIMULATOR_FRAME_KIND.key]: 'key',
  [SIMULATOR_FRAME_KIND.delta]: 'delta',
  [SIMULATOR_FRAME_KIND.size]: 'size',
} as const;

/** 解一帧；长度不对、种类不认识或尺寸帧的 JSON 不对时返回 undefined（调用方忽略这一帧）。`data` 与输入共用内存。 */
export function parseSimulatorFrame(
  message: ArrayBuffer | ArrayBufferView,
): SimulatorFrame | undefined {
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (bytes.byteLength < SIMULATOR_FRAME_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = KINDS[view.getUint8(0) as keyof typeof KINDS];
  const length = view.getUint32(9);
  if (kind === undefined || bytes.byteLength !== SIMULATOR_FRAME_HEADER_BYTES + length) {
    return undefined;
  }
  const ptsMicros = Number(view.getBigUint64(1));
  const data = bytes.subarray(SIMULATOR_FRAME_HEADER_BYTES);
  if (kind !== 'size') return { kind, ptsMicros, data };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return undefined;
  }
  const size = SimulatorFrameSizeSchema.safeParse(json);
  return size.success ? { kind, ptsMicros, data, size: size.data } : undefined;
}

export interface SimulatorStreamHandlers {
  onFrame(frame: SimulatorFrame): void;
  /** 流结束（Host 断开、令牌无效、`close()`）。恰好一次。 */
  onClose?(info: { code: number; reason: string }): void;
}

/** 一路画面流；`close()` 断开。 */
export interface SimulatorStream {
  close(): void;
}

/** 连上 `streamUrl`，每收到一帧调一次 `onFrame`。WebSocket 同远程连接的（浏览器、Node ≥ 22 的全局 `WebSocket` 与 `ws` 包都行）。 */
export function openSimulatorStream(
  WebSocketImpl: BinaryWebSocketConstructor,
  streamUrl: string,
  handlers: SimulatorStreamHandlers,
): SimulatorStream {
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose?.({ code, reason });
  };
  let socket: BinaryWebSocketLike;
  try {
    socket = new WebSocketImpl(streamUrl);
  } catch (error) {
    queueMicrotask(() => finish(1006, String(error)));
    return { close: () => {} };
  }
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event: { data: unknown }) => {
    if (closed) return;
    const data = event.data;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
    const frame = parseSimulatorFrame(data);
    if (frame !== undefined) handlers.onFrame(frame);
  });
  socket.addEventListener('close', (event: { code?: unknown; reason?: unknown }) => {
    finish(
      typeof event.code === 'number' ? event.code : 1006,
      typeof event.reason === 'string' ? event.reason : '',
    );
  });
  return {
    close: () => {
      socket.close(1000, 'closed');
      finish(1000, 'closed');
    },
  };
}

/**
 * 同 `openSimulatorStream`，以异步迭代的方式读帧：流结束或 `signal` 中止时迭代结束。消费得比收得慢时帧在内存里排队（Host 那边已经
 * 按积压丢帧，这里不再丢）。
 */
export async function* simulatorFrames(
  WebSocketImpl: BinaryWebSocketConstructor,
  streamUrl: string,
  signal?: AbortSignal,
): AsyncGenerator<SimulatorFrame, void, undefined> {
  const queue: SimulatorFrame[] = [];
  let done = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const stream = openSimulatorStream(WebSocketImpl, streamUrl, {
    onFrame: (frame) => {
      queue.push(frame);
      notify();
    },
    onClose: () => {
      done = true;
      notify();
    },
  });
  const abort = () => stream.close();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    while (true) {
      const frame = queue.shift();
      if (frame !== undefined) {
        yield frame;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    stream.close();
  }
}
