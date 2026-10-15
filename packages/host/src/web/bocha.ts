import {
  clip,
  type Freshness,
  isRecord,
  postJson,
  text,
  WebSearchError,
  type WebSearchResult,
  type WebSearchService,
} from './search.js';

// 博查 Web Search API（2026-10-15 查的官方文档：博查 AI 开放平台 → 开发文档 → Web Search API，飞书文档
// https://bocha-ai.feishu.cn/wiki/RXEOw02rFiwzGSkd9mUcqoeAnNK，“4 月 1 日修改”版）。
// - `POST https://api.bocha.cn/v1/web-search`，`Authorization: Bearer <API KEY>`，JSON 请求体：`query`（必填）、`freshness`
//   （`noLimit` 默认 / `oneDay` / `oneWeek` / `oneMonth` / `oneYear` / 日期范围）、`summary`（布尔，默认 false）、`include` /
//   `exclude`（域名用 `|` 或 `,` 分隔，最多 100 个）、`count`（1–50，默认 10）。
// - 响应 `{ code, log_id, msg, data }`，`data` 兼容 Bing：`data.webPages.value[]` 每条 `name`、`url`、`displayUrl`、`snippet`、
//   `summary`（请求带 `summary: true` 时有）、`siteName`、`siteIcon`、`datePublished`（UTC+8，带时区）、`dateLastCrawled`（其实是
//   发布时间，写成 `Z` 但表示北京时间，文档要求按 +08:00 读）。
// - 异常：403 余额不足（"You do not have enough money"）、400 缺参数或缺 API KEY、401 API KEY 无效、429 频率限制、500 其他，
//   响应体 `{ code, message, log_id }`。

export const BOCHA_ENDPOINT = 'https://api.bocha.cn/v1/web-search';

const FRESHNESS: Readonly<Record<Freshness, string>> = {
  day: 'oneDay',
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
};

export const bochaService: WebSearchService = {
  id: 'bocha',
  async search(request, apiKey, options) {
    const body = {
      query: request.query,
      count: request.count,
      summary: true,
      ...(request.freshness !== undefined && { freshness: FRESHNESS[request.freshness] }),
      ...(request.domains !== undefined &&
        request.domains.length > 0 && { include: request.domains.join('|') }),
    };
    const json = await postJson(
      options.endpoint ?? BOCHA_ENDPOINT,
      body,
      apiKey,
      options,
      bochaError,
    );
    return bochaResults(json);
  },
};

/** HTTP 状态码与博查的说明 → 失败类别。 */
export function bochaError(status: number, message: string): WebSearchError {
  if (status === 401 || (status === 400 && /api\s*key/i.test(message))) {
    return new WebSearchError('auth', message, status);
  }
  if (status === 403) return new WebSearchError('quota', message, status);
  if (status === 429) return new WebSearchError('rate_limited', message, status);
  if (status >= 500) return new WebSearchError('server', message, status);
  return new WebSearchError('unknown', message, status);
}

/** 博查的响应 → 搜索结果。`code` 不是 200 的按错误处理（HTTP 200 里也可能带错误码）。 */
export function bochaResults(json: unknown): WebSearchResult[] {
  if (!isRecord(json))
    throw new WebSearchError('invalid_response', 'Unexpected response from Bocha.');
  const code = Number(json.code ?? 200);
  if (code !== 200) {
    throw bochaError(code, text(json.message) ?? text(json.msg) ?? `Bocha answered code ${code}.`);
  }
  const data = json.data;
  if (!isRecord(data)) throw new WebSearchError('invalid_response', 'Bocha answered without data.');
  const pages = isRecord(data.webPages) ? data.webPages.value : [];
  if (!Array.isArray(pages))
    throw new WebSearchError('invalid_response', 'Bocha answered without results.');
  return pages.flatMap((page: unknown) => {
    if (!isRecord(page)) return [];
    const url = text(page.url);
    if (url === undefined) return [];
    const snippet = clip(text(page.summary) ?? text(page.snippet));
    const siteName = text(page.siteName);
    const published = publishedOf(page);
    return [
      {
        title: text(page.name) ?? url,
        url,
        ...(snippet !== undefined && { snippet }),
        ...(siteName !== undefined && { siteName }),
        ...(published !== undefined && { published }),
      },
    ];
  });
}

/** `datePublished` 带时区，直接用；只有 `dateLastCrawled` 时把结尾的 `Z` 换成 `+08:00`（文档说明它其实是北京时间）。 */
function publishedOf(page: Record<string, unknown>): string | undefined {
  const published = text(page.datePublished);
  if (published !== undefined) return published;
  const crawled = text(page.dateLastCrawled);
  return crawled?.replace(/Z$/, '+08:00');
}
