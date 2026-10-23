export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBase64url(length: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

/** 能原样转给对端的关闭码：正常关闭、离开与应用私有码。1005 / 1006 这类不能发出去。 */
export function passable(code: number): boolean {
  return code === 1000 || code === 1001 || (code >= 3000 && code <= 4999);
}

/**
 * 关闭一条 WebSocket。`code` 为 undefined 时发不带状态码的关闭帧（对方看到 1005）：Workers 没有不发关闭帧直接断开的办法，这是
 * apps/relay 的 `terminate()`（对方看到 1006）在这里最接近的做法。关闭原因最长 123 字节。
 *
 * `reply`：在 `webSocketClose` 里回对方的关闭帧。这时 readyState 已经是 CLOSING，但运行时不替我们回（没开
 * `web_socket_auto_reply_to_close`），不回的话对方等不到关闭帧。
 */
export function closeWs(ws: WebSocket, code?: number, reason = '', reply = false): void {
  if (!reply && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) return;
  try {
    if (code === undefined) ws.close();
    else ws.close(code, truncate(reason, 123));
  } catch {
    // 运行时不让发这个码（1001 等）时退回不带状态码的关闭。
    try {
      ws.close();
    } catch {
      // 已经在关。
    }
  }
}

function truncate(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  // 不切在一个 UTF-8 字符的中间。
  let end = bytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

/** 日志里用的：路由 ID 的 SHA-256 的前 12 位十六进制。 */
export async function routeTag(routeId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(routeId));
  return [...new Uint8Array(digest).subarray(0, 6)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 日志：一行一个 JSON 对象（`wrangler tail` 或 Workers Logs 里看）。只记连接的起止、计数与原因；从不记帧内容、IP 地址或完整的路由
 * ID，与 apps/relay 相同。
 */
export function log(
  level: string | undefined,
  at: LogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const threshold = ORDER[(level ?? 'info') as LogLevel] ?? ORDER.info;
  if (ORDER[at] < threshold) return;
  console.log(JSON.stringify({ level: at, msg: message, ...fields }));
}

/** 升级前的拒绝：与 apps/relay 相同的状态码与纯文本正文，客户端按状态码分类（404 不在线、429 限速、503 满了）。 */
export function status(code: 404 | 429 | 503): Response {
  const text = { 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' }[code];
  return new Response(text, { status: code, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * 这个对象上的 WebSocket 都关完了时重置它（`ctx.abort()`）。workerd 的毛病：休眠 API 接受的 WebSocket 如果客户端一条消息都没发过，
 * 由别的事件（RPC、另一条连接、计时器）发起关闭之后，关闭帧双方都交换了，TCP 连接却不断开，客户端要等自己的超时（`ws` 是 30 s）
 * 才报关闭。重置对象会断开这些连接，客户端立刻按收到的关闭码报关闭。每个对象只服务一条控制连接或一条设备连接，关完了就没有别的
 * 状态要留（Route 不受影响，它没有 WebSocket）。
 */
export function resetWhenDone(ctx: DurableObjectState, closing: WebSocket): void {
  const open = ctx
    .getWebSockets()
    .some((ws) => ws !== closing && ws.readyState !== WebSocket.CLOSED);
  if (open) return;
  try {
    ctx.abort('all connections closed');
  } catch {
    // abort 以抛出的方式结束当前事件。
  }
}
