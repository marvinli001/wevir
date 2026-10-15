import {
  clip,
  isRecord,
  postJson,
  text,
  WebSearchError,
  type WebSearchResult,
  type WebSearchService,
} from './search.js';

// Tavily Search API（2026-10-15 查的官方文档 https://docs.tavily.com/documentation/api-reference/endpoint/search）。
// - `POST https://api.tavily.com/search`，`Authorization: Bearer tvly-…`，JSON 请求体只有 `query` 必填；用到的：`max_results`
//   （0–20，默认 10）、`search_depth`（`basic` 一次 1 个额度）、`topic`（`general`）、`time_range`（`day` / `week` / `month` /
//   `year`）、`include_domains`（最多 300 个）、`include_published_date`（结果带 `published_date`，Beta）。
// - 响应 `{ query, answer, results[], images, response_time, request_id? }`，`results[]` 每条 `title`、`url`、`content`（片段，
//   用 `[...]` 连接）、`score`、`published_date`（要了才有，认不出是 null）。
// - 错误：400 请求不对、401 Key 缺失或无效、422 参数校验失败（`detail` 数组）、429 太频繁（看 `Retry-After`）、432 Key 或套餐
//   额度用完、433 按量付费的上限、500 服务端错误。

export const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

export const tavilyService: WebSearchService = {
  id: 'tavily',
  async search(request, apiKey, options) {
    const body = {
      query: request.query,
      max_results: request.count,
      search_depth: 'basic',
      topic: 'general',
      include_published_date: true,
      ...(request.freshness !== undefined && { time_range: request.freshness }),
      ...(request.domains !== undefined &&
        request.domains.length > 0 && { include_domains: [...request.domains] }),
    };
    const json = await postJson(
      options.endpoint ?? TAVILY_ENDPOINT,
      body,
      apiKey,
      options,
      tavilyError,
    );
    return tavilyResults(json);
  },
};

export function tavilyError(status: number, message: string): WebSearchError {
  if (status === 401 || status === 403) return new WebSearchError('auth', message, status);
  if (status === 432 || status === 433) return new WebSearchError('quota', message, status);
  if (status === 429) return new WebSearchError('rate_limited', message, status);
  if (status >= 500) return new WebSearchError('server', message, status);
  return new WebSearchError('unknown', message, status);
}

export function tavilyResults(json: unknown): WebSearchResult[] {
  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new WebSearchError('invalid_response', 'Unexpected response from Tavily.');
  }
  return json.results.flatMap((result: unknown) => {
    if (!isRecord(result)) return [];
    const url = text(result.url);
    if (url === undefined) return [];
    const snippet = clip(text(result.content)?.replaceAll('[...]', '…'));
    const published = text(result.published_date);
    return [
      {
        title: text(result.title) ?? url,
        url,
        ...(snippet !== undefined && { snippet }),
        ...(published !== undefined && { published }),
      },
    ];
  });
}
