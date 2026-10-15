import type { WebTestFailure } from '@wevir/protocol';

// 搜索服务（docs/architecture/web-tools.md §3）：每家一个实现，把 `web_search` 的参数换成它的请求、把它的响应换成同一种结果，
// 失败归到 `WebTestFailure` 的一类。以后加一家只要再写一个实现、登记进 services.ts 的 `SEARCH_SERVICES`。

export type Freshness = 'day' | 'week' | 'month' | 'year';

export interface WebSearchRequest {
  query: string;
  count: number;
  freshness?: Freshness;
  /** 只要这些域名的结果。 */
  domains?: readonly string[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  /** 摘要或片段。 */
  snippet?: string;
  siteName?: string;
  /** 发布日期，ISO 8601（服务给的原样，换算见各实现）。 */
  published?: string;
}

export class WebSearchError extends Error {
  readonly reason: WebTestFailure;
  readonly httpStatus: number | undefined;

  constructor(reason: WebTestFailure, message: string, httpStatus?: number) {
    super(message);
    this.name = 'WebSearchError';
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export interface SearchCallOptions {
  fetch: typeof fetch;
  signal: AbortSignal;
  /** 测试用：换掉服务的地址。 */
  endpoint?: string;
}

export interface WebSearchService {
  readonly id: string;
  search(
    request: WebSearchRequest,
    apiKey: string,
    options: SearchCallOptions,
  ): Promise<WebSearchResult[]>;
}

/** 一次搜索的时限。 */
export const SEARCH_TIMEOUT_MS = 20_000;

/**
 * 发请求、读 JSON，把传输层的失败归类。HTTP 状态码不是 2xx 时交给 `onError` 归类（各家的错误码不同）。`apiKey` 只用来从错误原文
 * 里抹掉它。
 */
export async function postJson(
  url: string,
  body: unknown,
  apiKey: string,
  options: SearchCallOptions,
  onError: (status: number, message: string) => WebSearchError,
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw new WebSearchError('timeout', 'The search service did not answer in time.');
    }
    throw new WebSearchError('network', scrub(describe(error), apiKey));
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (options.signal.aborted) {
      throw new WebSearchError('timeout', 'The search service did not answer in time.');
    }
    throw new WebSearchError('network', scrub(describe(error), apiKey), response.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    throw onError(response.status, scrub(errorMessage(json) ?? text.slice(0, 300), apiKey));
  }
  if (json === undefined) {
    throw new WebSearchError(
      'invalid_response',
      'The search service did not answer with JSON.',
      response.status,
    );
  }
  return json;
}

/** 常见的错误体里的说明：`message`、`msg`、`error`、`detail`（字符串或带 `error` 的对象）。 */
export function errorMessage(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  for (const key of ['message', 'msg', 'error', 'detail']) {
    const value = json[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (isRecord(value)) {
      const inner = errorMessage(value);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code !== undefined) return `${cause.code}: ${cause.message ?? ''}`.trim();
  return (error as Error).message ?? String(error);
}

/** 错误原文里不能带 Key（服务端有时把请求头回显出来）。 */
export function scrub(message: string, apiKey: string): string {
  return apiKey === '' ? message : message.split(apiKey).join('***');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 摘要最多留这么多字符：搜索结果是为了挑出要读的网页，正文用 `web_fetch` 读。 */
export const SNIPPET_MAX_CHARS = 600;

export function clip(value: string | undefined, max = SNIPPET_MAX_CHARS): string | undefined {
  if (value === undefined) return undefined;
  const chars = Array.from(value.replace(/\s+/g, ' '));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}
