// 传输层（ADR-0002 §7，Paseo A21）：client-sdk 只认 `TransportFactory`，不 import 任何 WebSocket 实现。
// 调用方注入：浏览器与 Electron 渲染进程传全局 `WebSocket`，Node 传全局 `WebSocket`（Node ≥ 22）或
// `ws` 包；将来经中继的加密传输也实现这个接口。

/** 连接关闭的信息。`code` 是 WebSocket 关闭码（host-api.md §8）；连接异常断开时为 1006。 */
export interface TransportCloseInfo {
  code: number;
  reason: string;
}

/**
 * 传输层回调。`onClose` 恰好调用一次，之后不再有任何回调；连不上也是一次 `onClose`。回调可以在
 * `TransportFactory` 返回之前同步发生。
 */
export interface TransportHandlers {
  onOpen(): void;
  /** 一帧文本，即一个 JSON-RPC 对象（host-api.md §1）。 */
  onMessage(text: string): void;
  onClose(info: TransportCloseInfo): void;
}

/** 一条连接。 */
export interface Transport {
  send(text: string): void;
  /** 发起关闭；之后照常收到一次 `onClose`。`code` 只能是 1000 或 3000–4999（WebSocket API 的限制）。 */
  close(code?: number, reason?: string): void;
}

/** 以 `url` 建立一条连接。不得抛出：连不上时以 `onClose` 报告。 */
export type TransportFactory = (url: string, handlers: TransportHandlers) => Transport;

/**
 * WHATWG WebSocket API 里本包用到的部分。浏览器的 `WebSocket`、Node ≥ 22 的全局 `WebSocket` 与
 * `ws` 包的 `WebSocket` 都符合。监听器参数写成 `any`，是为了让各家带具体事件类型的 `addEventListener`
 * 都能赋给它；读取时按下面 `webSocketTransport` 里的形状逐项检查。
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    // biome-ignore lint/suspicious/noExplicitAny: 见上。
    listener: (event: any) => void,
  ): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * 用 WHATWG WebSocket 构造函数做传输层。Host 只发文本帧；收到二进制帧说明对端不是 Wevir Host，按协议
 * 错误关闭连接。`error` 事件不单独上报：它后面总跟着一次 `close`。
 */
export function webSocketTransport(WebSocketImpl: WebSocketConstructor): TransportFactory {
  return (url, handlers) => {
    let closed = false;
    let socket: WebSocketLike;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      // URL 不合法等同步失败：照“连不上”处理，异步报告，保证调用方先拿到返回值。
      queueMicrotask(() => handlers.onClose({ code: 1006, reason: String(error) }));
      return { send: () => {}, close: () => {} };
    }
    socket.addEventListener('open', () => {
      if (!closed) handlers.onOpen();
    });
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (closed) return;
      if (typeof event.data === 'string') handlers.onMessage(event.data);
      else socket.close(1000, 'binary frames are not part of the Wevir protocol');
    });
    socket.addEventListener('close', (event: { code?: unknown; reason?: unknown }) => {
      if (closed) return;
      closed = true;
      handlers.onClose({
        code: typeof event.code === 'number' ? event.code : 1006,
        reason: typeof event.reason === 'string' ? event.reason : '',
      });
    });
    // `ws` 在没有 error 监听器时会把错误当作未捕获异常抛出；浏览器里这只是个空操作。
    socket.addEventListener('error', () => {});
    return {
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    };
  };
}
