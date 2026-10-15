import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isBlockedAddress, isLocalHostname } from './address.js';
import { htmlToMarkdown } from './markdown.js';

// `web_fetch` 的抓取（docs/architecture/web-tools.md §4）：Host 自己发请求，不需要 Key。只认 http / https，地址在连接时按 DNS
// 的结果检查（每一跳重定向都查，DNS 重绑定也绕不过去），重定向、时间与大小都有上限，HTML 转成正文 Markdown，文本类原样，其余
// （PDF、图片、压缩包）不收。用 node:http 而不是 fetch：只有它能在连接那一刻检查解析出的地址。

export const FETCH_LIMITS = Object.freeze({
  /** 整次抓取（含重定向）的时限。 */
  timeoutMs: 20_000,
  /** 解压后最多读这么多字节，多的不读（内容按截断处理）。 */
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
});

const USER_AGENT =
  'Mozilla/5.0 (compatible; Wevir-Agent/1.0; +https://github.com/marvinli001/wevir)';
const ACCEPT =
  'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5';

export type FetchFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'timeout'
  | 'http_error'
  | 'unsupported_content'
  | 'unreadable'
  | 'network';

export class WebFetchError extends Error {
  readonly reason: FetchFailure;
  readonly status: number | undefined;

  constructor(reason: FetchFailure, message: string, status?: number) {
    super(message);
    this.name = 'WebFetchError';
    this.reason = reason;
    this.status = status;
  }
}

export interface FetchedPage {
  /** 最终的地址（跟随重定向之后）。 */
  url: string;
  status: number;
  contentType: string;
  title?: string;
  /** HTML 是正文 Markdown，文本类是原文。 */
  content: string;
  /** 内容超过 `maxBytes`，只读了前面的部分。 */
  truncated: boolean;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** 测试用：放行这几个 IP 地址（本机的 mock 服务器在 127.0.0.1），其余照常检查。 */
  allowAddresses?: readonly string[];
  /** 测试用：换掉 DNS 解析。 */
  lookup?: typeof dnsLookup;
  signal?: AbortSignal;
}

/** 校验并规范化 URL：只认 http / https，不带用户名密码，主机名不是本机。 */
export function parseFetchUrl(raw: string, blockedAddress = isBlockedAddress): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebFetchError('invalid_url', `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError(
      'invalid_url',
      `Only http and https URLs can be fetched, not ${url.protocol}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebFetchError('invalid_url', 'URLs with a user name or password are not fetched.');
  }
  url.hash = '';
  if (isLocalHostname(url.hostname) || blockedAddress(url.hostname)) {
    throw blocked(url.hostname);
  }
  return url;
}

function blocked(host: string): WebFetchError {
  return new WebFetchError(
    'blocked_address',
    `${host} is a local or private network address; web_fetch only reads public web pages.`,
  );
}

/** 连接前检查 DNS 结果的 lookup：解析出的地址只要有一个在拦截范围里就整次拒绝。 */
function guardedLookup(
  resolve: typeof dnsLookup,
  blockedAddress: (address: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      if (addresses.length === 0 || addresses.some((entry) => blockedAddress(entry.address))) {
        callback(blocked(hostname) as NodeJS.ErrnoException, '', 4);
        return;
      }
      if (options.all) {
        (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
        return;
      }
      const first = addresses[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

/** 抓一个网页。失败抛 `WebFetchError`。 */
export async function fetchPage(raw: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const allowed = new Set(options.allowAddresses ?? []);
  const blockedAddress = (address: string) =>
    !allowed.has(address.replace(/^\[|\]$/g, '')) && isBlockedAddress(address);
  const maxBytes = options.maxBytes ?? FETCH_LIMITS.maxBytes;
  const maxRedirects = options.maxRedirects ?? FETCH_LIMITS.maxRedirects;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_LIMITS.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  const lookup = guardedLookup(options.lookup ?? dnsLookup, blockedAddress);

  let url = parseFetchUrl(raw, blockedAddress);
  for (let redirects = 0; ; redirects += 1) {
    const response = await get(url, signal, lookup);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location !== undefined) {
      response.resume();
      if (redirects >= maxRedirects) {
        throw new WebFetchError('too_many_redirects', `More than ${maxRedirects} redirects.`);
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new WebFetchError('invalid_url', `Redirected to an invalid URL: ${location}`);
      }
      url = parseFetchUrl(next.href, blockedAddress);
      continue;
    }
    if (status >= 400) {
      response.resume();
      throw new WebFetchError('http_error', `The server answered HTTP ${status}.`, status);
    }
    return await readPage(url, response, maxBytes, signal);
  }
}

function get(url: URL, signal: AbortSignal, lookup: LookupFunction) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: 'GET',
        signal,
        lookup,
        headers: {
          'user-agent': USER_AGENT,
          accept: ACCEPT,
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
      resolve,
    );
    request.on('error', (error) => reject(classify(error, signal)));
    request.end();
  });
}

function classify(error: unknown, signal: AbortSignal): WebFetchError {
  if (error instanceof WebFetchError) return error;
  if (signal.aborted) return new WebFetchError('timeout', 'The page did not load in time.');
  const code = (error as NodeJS.ErrnoException).code;
  const message = (error as Error).message ?? String(error);
  return new WebFetchError('network', code === undefined ? message : `${code}: ${message}`);
}

async function readPage(
  url: URL,
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<FetchedPage> {
  const contentType = (response.headers['content-type'] ?? '').toLowerCase();
  const mime = contentType.split(';')[0]?.trim() ?? '';
  const kind = contentKind(mime);
  if (kind === undefined) {
    response.resume();
    throw new WebFetchError(
      'unsupported_content',
      `web_fetch reads web pages and text, not ${mime === '' ? 'this content' : mime}.`,
    );
  }
  const { bytes, truncated } = await readBody(decoded(response), maxBytes, signal);
  const text = decodeText(
    bytes,
    charsetOf(contentType) ?? (kind === 'html' ? sniffCharset(bytes) : undefined),
  );
  const status = response.statusCode ?? 200;
  if (kind === 'html') {
    let page: ReturnType<typeof htmlToMarkdown>;
    try {
      page = htmlToMarkdown(text, url.href);
    } catch (error) {
      throw new WebFetchError(
        'unreadable',
        `Could not turn the page into text: ${(error as Error).message ?? String(error)}`,
      );
    }
    return {
      url: url.href,
      status,
      contentType: mime,
      ...(page.title !== undefined && { title: page.title }),
      content: page.markdown,
      truncated,
    };
  }
  return { url: url.href, status, contentType: mime, content: text.trim(), truncated };
}

/** 认得的内容：HTML 转 Markdown，文本类原样；其余返回 undefined。没写类型的按 HTML 试。 */
function contentKind(mime: string): 'html' | 'text' | undefined {
  if (mime === '' || mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime.startsWith('text/')) return 'text';
  if (
    /^application\/(?:json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|toml|x-ndjson)$/.test(
      mime,
    )
  ) {
    return 'text';
  }
  if (/\+(?:json|xml)$/.test(mime)) return 'text';
  return undefined;
}

function decoded(response: IncomingMessage): Readable {
  switch ((response.headers['content-encoding'] ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return response.pipe(createGunzip());
    case 'deflate':
      return response.pipe(createInflate());
    case 'br':
      return response.pipe(createBrotliDecompress());
    default:
      return response;
  }
}

async function readBody(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      if (size + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
  } catch (error) {
    throw classify(error, signal);
  } finally {
    stream.destroy();
  }
  return { bytes: Buffer.concat(chunks, size), truncated };
}

function charsetOf(contentType: string): string | undefined {
  return /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
}

/** HTML 没在响应头里写编码时看前 4 KB 的 `<meta charset>`（国内不少站点还是 GBK）。 */
function sniffCharset(bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 4096).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
}

function decodeText(bytes: Buffer, charset: string | undefined): string {
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // 不认得的编码名按 UTF-8。
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
