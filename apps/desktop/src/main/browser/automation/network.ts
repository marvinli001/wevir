// 网络记录的过滤、详情与响应体（0.48.0，browser_network）。记录本身在 contents.ts 里由 CDP 的 Network 域写下；这里是不碰
// Electron 的纯逻辑：按地址、方法、状态、类型过滤，凭据类的头只给长度，响应体分文本与二进制、按上限截断。

import type { BrowserNetworkEntry } from '@wevir/protocol';

/** 只给长度的请求头与响应头：登录凭据与会话（这个浏览器的登录跨会话保留，domain-model §3.15.1）。 */
const CREDENTIAL_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
]);

export function redactHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    result[name] = CREDENTIAL_HEADERS.has(name.toLowerCase())
      ? `[redacted, ${text.length} characters]`
      : text.length > 2_000
        ? `${text.slice(0, 2_000)}…`
        : text;
  }
  return result;
}

/** 状态过滤的写法：`404`、`4xx`、`400-499`。不认识的写法返回 null。 */
export function parseStatusFilter(value: string): ((status: number | undefined) => boolean) | null {
  const trimmed = value.trim().toLowerCase();
  const exact = /^(\d{3})$/.exec(trimmed);
  if (exact) {
    const code = Number(exact[1]);
    return (status) => status === code;
  }
  const family = /^([1-5])xx$/.exec(trimmed);
  if (family) {
    const base = Number(family[1]) * 100;
    return (status) => status !== undefined && status >= base && status < base + 100;
  }
  const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(trimmed);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low > high) return null;
    return (status) => status !== undefined && status >= low && status <= high;
  }
  return null;
}

export interface NetworkFilter {
  url?: string;
  method?: string;
  status?: string;
  type?: string;
  failedOnly?: boolean;
}

/** 按过滤条件挑出记录（地址片段、方法、类型不分大小写）。状态的写法不对时抛出 `TypeError`。 */
export function filterNetwork<T extends BrowserNetworkEntry>(
  entries: readonly T[],
  filter: NetworkFilter,
): T[] {
  const status = filter.status === undefined ? undefined : parseStatusFilter(filter.status);
  if (status === null) {
    throw new TypeError(`status ${JSON.stringify(filter.status)} is not like 404, 4xx or 400-499`);
  }
  const url = filter.url?.toLowerCase();
  const method = filter.method?.toUpperCase();
  const type = filter.type?.toLowerCase();
  return entries.filter(
    (entry) =>
      (url === undefined || entry.url.toLowerCase().includes(url)) &&
      (method === undefined || (entry.method ?? 'GET').toUpperCase() === method) &&
      (type === undefined || entry.type?.toLowerCase() === type) &&
      (status === undefined || status(entry.status)) &&
      (filter.failedOnly !== true ||
        entry.failed !== undefined ||
        (entry.status !== undefined && entry.status >= 400)),
  );
}

const TEXT_MIME =
  /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|graphql|ld\+json|manifest\+json)|image\/svg\+xml)|[+/](json|xml)(;|$)/i;

export function isTextMime(mimeType: string | undefined): boolean {
  return mimeType !== undefined && TEXT_MIME.test(mimeType);
}

/** `Network.getResponseBody` 的结果换成给 agent 的样子：文本截到 `maxChars`，二进制只给大小。 */
export function responseBody(
  raw: { body?: unknown; base64Encoded?: unknown },
  mimeType: string | undefined,
  maxChars: number,
): { size: number; text?: string; truncated?: boolean; binary?: boolean } {
  const body = typeof raw.body === 'string' ? raw.body : '';
  const bytes =
    raw.base64Encoded === true ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
  const text =
    raw.base64Encoded !== true || isTextMime(mimeType) ? bytes.toString('utf8') : undefined;
  if (text === undefined || (!isTextMime(mimeType) && looksBinary(bytes))) {
    return { size: bytes.length, binary: true };
  }
  return text.length > maxChars
    ? { size: bytes.length, text: text.slice(0, maxChars), truncated: true }
    : { size: bytes.length, text };
}

/** 没有声明类型时看开头有没有 NUL 或大量控制字符。 */
function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 1024);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}
