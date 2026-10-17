import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { FileSecretStore } from '@wevir/storage';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress, isLocalHostname } from './address.js';
import { bochaResults } from './bocha.js';
import { fetchPage, WebFetchError } from './fetch-page.js';
import { formatPage, searchRequest, WebService, webSecretRef } from './service.js';
import { tavilyResults } from './tavily.js';

// 联网服务的单元测试（docs/architecture/web-tools.md）：两家搜索服务的请求与响应映射、错误归类、Key 不外泄（mock HTTP），抓取的
// 地址检查、重定向、大小与时间上限、内容类型与编码（本机的 mock 网页），以及设置、工具调用与端点。

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

interface MockServer {
  url: string;
  requests: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
    body: string;
  }>;
  handle(handler: Handler): void;
  close(): Promise<void>;
}

async function mockServer(): Promise<MockServer> {
  let handler: Handler = (_request, _body, response) => response.end();
  const requests: MockServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      handler(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle: (next) => {
      handler = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

/** 博查文档里的响应示例（节选，字段照抄）。 */
const BOCHA_RESPONSE = {
  code: 200,
  log_id: '0d0eb34abc6eec9d',
  msg: null,
  data: {
    _type: 'SearchResponse',
    queryContext: { originalQuery: '阿里巴巴2024年的esg报告' },
    webPages: {
      webSearchUrl: 'https://bochaai.com/search?q=阿里巴巴2024年的esg报告',
      totalEstimatedMatches: 10000000,
      value: [
        {
          id: null,
          name: '阿里巴巴发布2024年ESG报告，阿里云数据中心清洁能源占比达56.0%',
          url: 'http://tech.cnr.cn/techph/20240722/t20240722_526807992.shtml',
          displayUrl: 'http://tech.cnr.cn/techph/20240722/t20240722_526807992.shtml',
          snippet: '阿里巴巴集团发布《环境、社会和治理报告（2024）》……',
          summary: '阿里巴巴集团发布《环境、社会和治理报告（2024）》（以下简称“ESG报告”）提及……',
          siteName: '央广网',
          siteIcon: 'https://th.bochaai.com/favicon?domain_url=http://tech.cnr.cn/',
          dateLastCrawled: '2024-07-22T17:54:38Z',
          cachedPageUrl: null,
          language: null,
          isFamilyFriendly: null,
          isNavigational: null,
        },
        {
          id: null,
          name: '2024年阿里巴巴环境、社会和治理（ESG）报告-阿里巴巴',
          url: 'https://m.sohu.com/a/796245119_121713887/?pvid=000115_3w_a',
          snippet: '《2024年阿里巴巴环境、社会和治理（ESG）报告》由阿里巴巴集团发布……',
          siteName: '搜狐网',
          datePublished: '2024-07-26T12:33:00+08:00',
        },
        { name: '没有链接的条目' },
      ],
      someResultsRemoved: true,
    },
    images: null,
    videos: null,
  },
};

/** Tavily 文档里的响应形状。 */
const TAVILY_RESPONSE = {
  query: 'Who is Leo Messi?',
  answer: null,
  images: [],
  results: [
    {
      title: 'Lionel Messi Facts | Britannica',
      url: 'https://www.britannica.com/facts/Lionel-Messi',
      content: 'Lionel Messi, an Argentine footballer [...] widely regarded as one of the greatest',
      score: 0.81025416,
      raw_content: null,
      published_date: '2025-08-01',
    },
    {
      title: 'No date',
      url: 'https://example.org/a',
      content: 'x',
      score: 0.5,
      published_date: null,
    },
  ],
  response_time: '1.67',
  request_id: '123e4567-e89b-12d3-a456-426614174111',
};

describe('搜索结果的映射', () => {
  it('博查：标题、链接、网站、日期，摘要优先用 summary，没有链接的丢掉；dateLastCrawled 按北京时间读', () => {
    expect(bochaResults(BOCHA_RESPONSE)).toEqual([
      {
        title: '阿里巴巴发布2024年ESG报告，阿里云数据中心清洁能源占比达56.0%',
        url: 'http://tech.cnr.cn/techph/20240722/t20240722_526807992.shtml',
        snippet: '阿里巴巴集团发布《环境、社会和治理报告（2024）》（以下简称“ESG报告”）提及……',
        siteName: '央广网',
        published: '2024-07-22T17:54:38+08:00',
      },
      {
        title: '2024年阿里巴巴环境、社会和治理（ESG）报告-阿里巴巴',
        url: 'https://m.sohu.com/a/796245119_121713887/?pvid=000115_3w_a',
        snippet: '《2024年阿里巴巴环境、社会和治理（ESG）报告》由阿里巴巴集团发布……',
        siteName: '搜狐网',
        published: '2024-07-26T12:33:00+08:00',
      },
    ]);
  });

  it('博查：HTTP 200 里带错误码按错误归类；没有 data 是格式不对', () => {
    expect(() => bochaResults({ code: 401, message: 'Invalid API KEY' })).toThrow(
      expect.objectContaining({ reason: 'auth' }),
    );
    expect(() => bochaResults({ code: 200 })).toThrow(
      expect.objectContaining({ reason: 'invalid_response' }),
    );
  });

  it('Tavily：content 里的 [...] 换成省略号，published_date 为 null 时不写', () => {
    expect(tavilyResults(TAVILY_RESPONSE)).toEqual([
      {
        title: 'Lionel Messi Facts | Britannica',
        url: 'https://www.britannica.com/facts/Lionel-Messi',
        snippet: 'Lionel Messi, an Argentine footballer … widely regarded as one of the greatest',
        published: '2025-08-01',
      },
      { title: 'No date', url: 'https://example.org/a', snippet: 'x' },
    ]);
    expect(() => tavilyResults({ detail: 'x' })).toThrow(
      expect.objectContaining({ reason: 'invalid_response' }),
    );
  });

  it('工具参数：查询必填，条数夹在 1–10，时间范围只认四种，域名去掉协议与路径', () => {
    expect(searchRequest({})).toBe('web_search needs a non-empty query.');
    expect(
      searchRequest({
        query: ' Codex ',
        count: 99,
        freshness: 'decade',
        domains: ['https://docs.python.org/3/', 7, ''],
      }),
    ).toEqual({ query: 'Codex', count: 10, domains: ['docs.python.org'] });
    expect(searchRequest({ query: 'q', count: 0, freshness: 'week' })).toEqual({
      query: 'q',
      count: 1,
      freshness: 'week',
    });
  });
});

describe('WebService', () => {
  let search: MockServer;
  let page: MockServer;
  let root: string;
  const services: WebService[] = [];

  beforeAll(async () => {
    search = await mockServer();
    page = await mockServer();
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    rmSync(root, { recursive: true, force: true });
    search.requests.length = 0;
    page.requests.length = 0;
  });
  afterAll(async () => {
    await search.close();
    await page.close();
  });

  async function start(options: { keys?: Record<string, string> } = {}) {
    root = mkdtempSync(join(tmpdir(), 'wevir-web-'));
    const secrets = new FileSecretStore(root);
    for (const [service, key] of Object.entries(options.keys ?? {})) {
      await secrets.set(webSecretRef(service), key);
    }
    const logs: string[] = [];
    const service = new WebService({
      settingsFile: join(root, 'web.json'),
      mcpDir: join(root, 'mcp'),
      logger: {
        info: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
        warn: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
        addSecret: () => {},
      },
      endpoints: { bocha: `${search.url}/v1/web-search`, tavily: `${search.url}/search` },
      fetchPage: { allowAddresses: ['127.0.0.1'] },
    });
    services.push(service);
    await service.start(secrets);
    return { service, secrets, logs };
  }

  const text = (result: { content: Array<{ text: string }> }) =>
    result.content.map((part) => part.text).join('\n');

  it('默认：开着、博查、两家都没 Key；state 说搜索不能用', async () => {
    const { service } = await start();
    expect(service.settings()).toEqual({
      enabled: true,
      searchService: 'bocha',
      services: [
        { id: 'bocha', hasKey: false },
        { id: 'tavily', hasKey: false },
      ],
    });
    expect(service.state()).toEqual({ enabled: true, search: false });
  });

  it('博查的请求：地址、Bearer Key、请求体；结果写成带编号、链接与日期的文字', async () => {
    const { service, logs } = await start({ keys: { bocha: 'sk-bocha-secret' } });
    search.handle((_request, _body, response) => json(response, 200, BOCHA_RESPONSE));
    const result = await service.call('web_search', {
      query: '阿里巴巴 ESG',
      count: 3,
      freshness: 'month',
      domains: ['cnr.cn', 'sohu.com'],
    });
    expect(result.isError).toBeUndefined();
    const request = search.requests[0];
    expect(request?.url).toBe('/v1/web-search');
    expect(request?.headers.authorization).toBe('Bearer sk-bocha-secret');
    expect(JSON.parse(request?.body ?? '')).toEqual({
      query: '阿里巴巴 ESG',
      count: 3,
      summary: true,
      freshness: 'oneMonth',
      include: 'cnr.cn|sohu.com',
    });
    expect(text(result)).toBe(
      [
        'Search results for "阿里巴巴 ESG" (Bocha, 2):',
        '',
        '[1] 阿里巴巴发布2024年ESG报告，阿里云数据中心清洁能源占比达56.0%',
        'URL: http://tech.cnr.cn/techph/20240722/t20240722_526807992.shtml',
        'Site: 央广网 · Published: 2024-07-22T17:54:38+08:00',
        '阿里巴巴集团发布《环境、社会和治理报告（2024）》（以下简称“ESG报告”）提及……',
        '',
        '[2] 2024年阿里巴巴环境、社会和治理（ESG）报告-阿里巴巴',
        'URL: https://m.sohu.com/a/796245119_121713887/?pvid=000115_3w_a',
        'Site: 搜狐网 · Published: 2024-07-26T12:33:00+08:00',
        '《2024年阿里巴巴环境、社会和治理（ESG）报告》由阿里巴巴集团发布……',
      ].join('\n'),
    );
    // 日志里没有 Key、查询词。
    expect(logs.join('\n')).not.toContain('sk-bocha-secret');
    expect(logs.join('\n')).not.toContain('阿里巴巴');
  });

  it('切到 Tavily：请求体照 Tavily 的字段', async () => {
    const { service } = await start({ keys: { tavily: 'tvly-secret' } });
    await service.update({ searchService: 'tavily' });
    search.handle((_request, _body, response) => json(response, 200, TAVILY_RESPONSE));
    const result = await service.call('web_search', {
      query: 'Who is Leo Messi?',
      freshness: 'day',
      domains: ['britannica.com'],
    });
    expect(search.requests[0]?.url).toBe('/search');
    expect(search.requests[0]?.headers.authorization).toBe('Bearer tvly-secret');
    expect(JSON.parse(search.requests[0]?.body ?? '')).toEqual({
      query: 'Who is Leo Messi?',
      max_results: 6,
      search_depth: 'basic',
      topic: 'general',
      include_published_date: true,
      time_range: 'day',
      include_domains: ['britannica.com'],
    });
    expect(text(result)).toContain('[1] Lionel Messi Facts | Britannica');
    expect(text(result)).toContain('Published: 2025-08-01');
  });

  it.each([
    ['bocha', 401, { code: '401', message: 'Invalid API KEY' }, 'auth'],
    ['bocha', 400, { code: '400', message: 'The API KEY is missing' }, 'auth'],
    ['bocha', 403, { code: '403', message: 'You do not have enough money' }, 'quota'],
    ['bocha', 429, { code: '429', message: 'You have reached the request limit' }, 'rate_limited'],
    ['bocha', 500, { code: '500', message: 'boom' }, 'server'],
    ['tavily', 401, { detail: { error: 'Unauthorized: missing or invalid API key.' } }, 'auth'],
    ['tavily', 432, { detail: { error: 'This request exceeds your plan.' } }, 'quota'],
    ['tavily', 433, { detail: { error: 'Pay-as-you-go limit.' } }, 'quota'],
    ['tavily', 429, { detail: { error: 'Too many requests' } }, 'rate_limited'],
    ['tavily', 422, { detail: [{ msg: 'bad' }] }, 'unknown'],
  ] as const)('%s 的 HTTP %i 归为 %s（web.test 与工具调用）', async (id, status, body, reason) => {
    const { service } = await start({ keys: { [id]: `key-${id}` } });
    await service.update({ searchService: id });
    search.handle((_request, _body, response) => json(response, status, body));
    const tested = await service.test({});
    expect(tested).toMatchObject({ ok: false, service: id, reason, httpStatus: status });
    const result = await service.call('web_search', { query: 'q' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`, ${reason})`);
  });

  it('服务端把 Key 回显在错误里也不外泄；不是 JSON 的成功响应是 invalid_response', async () => {
    const { service } = await start({ keys: { bocha: 'sk-echoed-secret' } });
    search.handle((request, _body, response) =>
      json(response, 401, { message: `bad header ${request.headers.authorization}` }),
    );
    const tested = await service.test({});
    expect(tested.message).toBe('bad header Bearer ***');
    search.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>gateway</html>');
    });
    expect(await service.test({})).toMatchObject({ ok: false, reason: 'invalid_response' });
  });

  it('web.test：给了 Key 用它测、不存；没有 Key 不发请求；成功时报条数', async () => {
    const { service, secrets } = await start();
    expect(await service.test({ service: 'tavily' })).toEqual({
      ok: false,
      service: 'tavily',
      reason: 'missing_key',
    });
    expect(search.requests).toHaveLength(0);
    search.handle((_request, _body, response) => json(response, 200, TAVILY_RESPONSE));
    const tested = await service.test({ service: 'tavily', apiKey: ' tvly-trial ' });
    expect(tested).toMatchObject({ ok: true, service: 'tavily', results: 2 });
    expect(search.requests[0]?.headers.authorization).toBe('Bearer tvly-trial');
    expect(await secrets.get(webSecretRef('tavily'))).toBeUndefined();
  });

  it('web.update：Key 进密钥存储（去掉首尾空白）、不进 web.json；null 删掉；未知服务 INVALID_PARAMS', async () => {
    const { service, secrets } = await start();
    const updated = await service.update({
      enabled: false,
      searchService: 'tavily',
      key: { service: 'tavily', apiKey: '  tvly-new  ' },
    });
    expect(updated).toMatchObject({ enabled: false, searchService: 'tavily' });
    expect(updated.services).toContainEqual({ id: 'tavily', hasKey: true });
    expect(await secrets.get(webSecretRef('tavily'))).toBe('tvly-new');
    const file = readFileSync(join(root, 'web.json'), 'utf8');
    expect(JSON.parse(file)).toEqual({ enabled: false, searchService: 'tavily' });
    expect(service.state()).toEqual({ enabled: false, search: true });
    await service.update({ key: { service: 'tavily', apiKey: null } });
    expect(await secrets.get(webSecretRef('tavily'))).toBeUndefined();
    expect(service.state().search).toBe(false);
    await expect(service.update({ searchService: 'google' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      service.update({ key: { service: 'bocha', apiKey: '   ' } }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('联网关着：工具调用被拒；没有 Key：web_search 说怎么配，web_fetch 照常', async () => {
    const { service } = await start();
    const missing = await service.call('web_search', { query: 'q' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('Settings → Web search');
    page.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('plain text');
    });
    expect(text(await service.call('web_fetch', { url: `${page.url}/a.txt` }))).toContain(
      'plain text',
    );
    await service.update({ enabled: false });
    const off = await service.call('web_fetch', { url: `${page.url}/a.txt` });
    expect(off.isError).toBe(true);
    expect(text(off)).toContain('turned off');
  });

  it('端点：只认带令牌的 POST /call', async () => {
    const { service } = await start();
    const endpoint = service.endpoint();
    if (endpoint === undefined) throw new Error('no endpoint');
    const call = (headers: Record<string, string>, path = '/call') =>
      fetch(`${endpoint.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'web_fetch', arguments: {} }),
      });
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call({ authorization: `Bearer ${endpoint.token}` }, '/other')).status).toBe(404);
    const ok = await call({ authorization: `Bearer ${endpoint.token}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      content: [{ type: 'text', text: 'web_fetch needs a url.' }],
      isError: true,
    });
  });

  it('网页：HTML 转正文 Markdown、分段读、标题；gzip 与 GBK', async () => {
    const { service } = await start();
    const body = `<html><head><title>文档</title></head><body><nav>菜单</nav><main><h1>标题</h1><p>${'正文'.repeat(800)}</p><a href="/next">下一页</a></main></body></html>`;
    page.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      response.end(gzipSync(Buffer.from(new TextEncoder().encode(body))));
    });
    // 先用 UTF-8 的字节验证 gzip 与 Markdown；GBK 另测。
    const result = text(
      await service.call('web_fetch', { url: `${page.url}/doc`, max_chars: 1000 }),
    );
    expect(result).toContain(`URL: ${page.url}/doc`);
    expect(result).toContain('Title: 文档');
    expect(result).toContain('Continue with start=1000.');
    expect(result).toContain('# 标题');
    expect(result).not.toContain('菜单');
    const rest = text(
      await service.call('web_fetch', { url: `${page.url}/doc`, start: 1000, max_chars: 1000 }),
    );
    expect(rest).toContain(`[下一页](${page.url}/next)`);

    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // “你好”
    page.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=gbk' });
      response.end(gbk);
    });
    expect(text(await service.call('web_fetch', { url: `${page.url}/gbk` }))).toContain('你好');
  });
});

describe('fetchPage 的上限与地址检查', () => {
  let page: MockServer;
  const allow = { allowAddresses: ['127.0.0.1'] };

  beforeAll(async () => {
    page = await mockServer();
  });
  afterAll(async () => {
    await page.close();
  });

  const reason = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof WebFetchError) return error.reason;
      throw error;
    }
    return 'ok';
  };

  it('只认 http / https，不带用户名密码', async () => {
    expect(await reason(fetchPage('ftp://example.com/a'))).toBe('invalid_url');
    expect(await reason(fetchPage('file:///etc/passwd'))).toBe('invalid_url');
    expect(await reason(fetchPage('not a url'))).toBe('invalid_url');
    expect(await reason(fetchPage('https://user:pass@example.com/'))).toBe('invalid_url');
  });

  it('本机、局域网、链路本地的地址拦下，不发请求', async () => {
    for (const url of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://10.0.0.8/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.100/',
      'http://0.0.0.0/',
    ]) {
      expect(await reason(fetchPage(url)), url).toBe('blocked_address');
    }
  });

  it('DNS 解析到内网地址也拦下（连接时检查）；解析到放行的地址照常抓', async () => {
    const lookup = ((
      hostname: string,
      _options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      const address = hostname === 'evil.example' ? '192.168.0.10' : '127.0.0.1';
      callback(null, [{ address, family: 4 }]);
    }) as unknown as typeof import('node:dns').lookup;
    const port = new URL(page.url).port;
    page.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    expect(await reason(fetchPage(`http://evil.example:${port}/`, { ...allow, lookup }))).toBe(
      'blocked_address',
    );
    const fetched = await fetchPage(`http://good.example:${port}/`, { ...allow, lookup });
    expect(fetched.content).toBe('ok');
    expect(page.requests.at(-1)?.headers.host).toBe(`good.example:${port}`);
  });

  it('重定向：跟随、再检查目标（到本机的拦下）、超过 5 次报错', async () => {
    page.handle((request, _body, response) => {
      const step = Number(/\/r(\d+)/.exec(request.url ?? '')?.[1] ?? 0);
      if (request.url === '/to-local') {
        response.writeHead(302, { location: 'http://localhost/admin' });
        return response.end();
      }
      if (request.url === '/to-lan') {
        response.writeHead(301, { location: 'http://10.1.2.3/' });
        return response.end();
      }
      if (step < 10 && request.url?.startsWith('/r')) {
        response.writeHead(302, { location: `/r${step + 1}` });
        return response.end();
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`at ${request.url}`);
    });
    expect(await reason(fetchPage(`${page.url}/to-local`, allow))).toBe('blocked_address');
    expect(await reason(fetchPage(`${page.url}/to-lan`, allow))).toBe('blocked_address');
    expect(await reason(fetchPage(`${page.url}/r0`, allow))).toBe('too_many_redirects');
    expect((await fetchPage(`${page.url}/r6`, allow)).content).toBe('at /r10');
    expect((await fetchPage(`${page.url}/r6`, allow)).url).toBe(`${page.url}/r10`);
  });

  it('超过大小上限只读前面，标成截断；超时；4xx；PDF 不收', async () => {
    page.handle((request, _body, response) => {
      if (request.url === '/big') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        return response.end('a'.repeat(5000));
      }
      if (request.url === '/slow') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('start');
        return; // 不结束
      }
      if (request.url === '/pdf') {
        response.writeHead(200, { 'content-type': 'application/pdf' });
        return response.end('%PDF-1.7');
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('nope');
    });
    const big = await fetchPage(`${page.url}/big`, { ...allow, maxBytes: 1000 });
    expect(big).toMatchObject({ truncated: true });
    expect(big.content).toHaveLength(1000);
    expect(await reason(fetchPage(`${page.url}/slow`, { ...allow, timeoutMs: 200 }))).toBe(
      'timeout',
    );
    expect(await reason(fetchPage(`${page.url}/missing`, allow))).toBe('http_error');
    expect(await reason(fetchPage(`${page.url}/pdf`, allow))).toBe('unsupported_content');
  });

  it('没有 <main> / <article> 的网页转整个 body（domino 找不到时返回 undefined）', async () => {
    page.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang=en><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>Short.</p></div></body></html>',
      );
    });
    const fetched = await fetchPage(`${page.url}/plain`, allow);
    expect(fetched).toMatchObject({
      title: 'Example Domain',
      content: '# Example Domain\n\nShort.',
    });
  });

  it('<main> 里换语言的链接、菜单与 MediaWiki 的框架不算正文', async () => {
    const article =
      'Markdown is a lightweight markup language for creating formatted text. '.repeat(4);
    page.handle((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html><head><title>Markdown</title></head><body><main><h1>Markdown</h1>
<div class="vector-dropdown mw-portlet-lang"><ul><li><a href="https://de.wikipedia.org/wiki/Markdown" hreflang="de">Deutsch</a></li></ul></div>
<ul><li><a href="https://fr.wikipedia.org/wiki/Markdown" hreflang="fr" lang="fr">Français</a></li><li><a href="https://ja.wikipedia.org/wiki/Markdown" hreflang="ja">日本語</a></li></ul>
<div role="toolbar"><a href="/edit">Edit</a></div>
<h2>History<span class="mw-editsection">[<a href="/edit?section=1">edit</a>]</span></h2><p>${article}</p></main></body></html>`,
      );
    });
    const fetched = await fetchPage(`${page.url}/wiki`, allow);
    expect(fetched).toMatchObject({ content: `# Markdown\n\n## History\n\n${article.trim()}` });
  });

  it('formatPage：超出正文的 start、空网页', () => {
    const base = { url: 'https://e.com/', status: 200, contentType: 'text/html', truncated: false };
    expect(formatPage({ ...base, content: 'abc' }, 10, 1000)).toContain('start=10 is past the end');
    expect(formatPage({ ...base, content: '' }, 0, 1000)).toContain('no readable text');
    expect(formatPage({ ...base, content: 'abc' }, 0, 1000)).toBe(
      'URL: https://e.com/\nContent: 3 characters.\n\nabc',
    );
  });
});

describe('地址分类', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.255.0.1', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.3.4', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['198.18.0.1', false],
    ['8.8.8.8', false],
    ['::1', true],
    ['::', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false],
    ['2001:4860:4860::8888', false],
    ['example.com', false],
  ])('%s → %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it('localhost 与 *.localhost', () => {
    expect(isLocalHostname('LOCALHOST.')).toBe(true);
    expect(isLocalHostname('api.localhost')).toBe(true);
    expect(isLocalHostname('localhost.example.com')).toBe(false);
  });
});
