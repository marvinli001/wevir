import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MethodParams, WebSettings, WebTestFailure, WebTestResult } from '@wevir/protocol';
import {
  WEB_FETCH_DEFAULT_CHARS,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_DEFAULT_RESULTS,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_TOOL,
  type WebToolEndpoint,
  type WebToolServer,
  type WebToolState,
  webToolScriptPath,
} from '@wevir/runtime-adapter/web-tool';
import type { SecretStore } from '@wevir/storage';
import { HostError } from '../errors.js';
import type { Logger } from '../logger.js';
import { type FetchedPage, type FetchPageOptions, fetchPage, WebFetchError } from './fetch-page.js';
import {
  type Freshness,
  SEARCH_TIMEOUT_MS,
  WebSearchError,
  type WebSearchRequest,
  type WebSearchResult,
} from './search.js';
import { SEARCH_SERVICES, searchService } from './services.js';

// Host 的联网服务（0.34.0，docs/architecture/web-tools.md）：设置（`web.json`）与搜索服务的 Key（密钥存储），`web.*` 方法，以及
// 给 `wevir_web` 桥脚本的本机端点（127.0.0.1 的随机端口，每次启动换新的令牌，只有 `POST /call`）。工具调用在这里按当时的设置
// 检查、执行、写成给模型看的文字。

/** 设置文件里的内容（Key 不在这里）。 */
interface StoredWebSettings {
  enabled: boolean;
  searchService: string;
}

const DEFAULTS: StoredWebSettings = { enabled: true, searchService: 'bocha' };

/** 密钥存储里的引用：`web-search:<服务 ID>`（Provider 的引用是它的 ID，带冒号的不会撞上）。 */
export function webSecretRef(service: string): string {
  return `web-search:${service}`;
}

/** 端点收的请求体上限。 */
const MAX_REQUEST_BYTES = 64 * 1024;

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export interface WebServiceOptions {
  /** 设置文件（`<数据目录>/web.json`）；不给时只在内存里（测试）。 */
  settingsFile?: string;
  /** 桥脚本写在哪个目录（`<数据目录>/mcp`）。 */
  mcpDir: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'addSecret'>;
  /** 搜索请求用的 fetch，默认全局的。 */
  fetch?: typeof fetch;
  /** 测试用：各搜索服务的地址。 */
  endpoints?: Readonly<Record<string, string>>;
  /** 测试用：抓取的选项（放行本机的 mock 服务器、缩短时限）。 */
  fetchPage?: FetchPageOptions;
  /** 运行桥脚本的 Node，默认 `process.execPath`。 */
  node?: string;
}

type WebUpdateParams = MethodParams<'web.update'>;
type WebTestParams = MethodParams<'web.test'>;

export class WebService {
  /** 交给引擎的 MCP 服务描述（`@wevir/runtime-adapter/web-tool`）。 */
  readonly tool: WebToolServer;
  readonly #options: WebServiceOptions;
  readonly #token = randomBytes(32).toString('base64url');
  #settings: StoredWebSettings = { ...DEFAULTS };
  /** 哪些服务存了 Key（`state()` 是同步的，所以记在内存里）。 */
  readonly #hasKey = new Set<string>();
  #secrets: SecretStore | undefined;
  #server: Server | undefined;
  #url: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WebServiceOptions) {
    this.#options = options;
    options.logger?.addSecret(this.#token);
    this.tool = {
      script: webToolScriptPath(options.mcpDir),
      node: options.node ?? process.execPath,
      endpoint: () => this.endpoint(),
      state: () => this.state(),
    };
  }

  /** 读设置与 Key 的有无，开始监听。Host 启动时调用一次。 */
  async start(secrets: SecretStore): Promise<void> {
    this.#secrets = secrets;
    this.#settings = await this.#load();
    for (const service of SEARCH_SERVICES) {
      if ((await secrets.get(webSecretRef(service.id))) !== undefined) this.#hasKey.add(service.id);
    }
    const server = createServer((request, response) => void this.#handle(request, response));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    this.#url = `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#url = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  endpoint(): WebToolEndpoint | undefined {
    return this.#url === undefined ? undefined : { url: this.#url, token: this.#token };
  }

  state(): WebToolState {
    return {
      enabled: this.#settings.enabled,
      search: this.#hasKey.has(this.#settings.searchService),
    };
  }

  /** `web.get` 的结果。 */
  settings(): WebSettings {
    return {
      enabled: this.#settings.enabled,
      searchService: this.#settings.searchService,
      services: SEARCH_SERVICES.map((service) => ({
        id: service.id,
        hasKey: this.#hasKey.has(service.id),
      })),
    };
  }

  /** `web.update`：改开关、选服务、存或删 Key。串行执行。 */
  update(params: WebUpdateParams): Promise<WebSettings> {
    const result = this.#queue.then(async () => {
      if (params.searchService !== undefined) knownService(params.searchService, ['searchService']);
      if (params.key !== undefined) {
        knownService(params.key.service, ['key', 'service']);
        const secrets = this.#requireSecrets();
        const ref = webSecretRef(params.key.service);
        if (params.key.apiKey === null) {
          await secrets.delete(ref);
          this.#hasKey.delete(params.key.service);
        } else {
          const apiKey = params.key.apiKey.trim();
          if (apiKey === '') {
            throw new HostError('INVALID_PARAMS', 'apiKey is empty', {
              issues: [{ path: ['key', 'apiKey'], message: 'apiKey is empty' }],
            });
          }
          await secrets.set(ref, apiKey);
          this.#hasKey.add(params.key.service);
        }
      }
      const next: StoredWebSettings = {
        enabled: params.enabled ?? this.#settings.enabled,
        searchService: params.searchService ?? this.#settings.searchService,
      };
      if (
        next.enabled !== this.#settings.enabled ||
        next.searchService !== this.#settings.searchService
      ) {
        await this.#save(next);
        this.#settings = next;
      }
      return this.settings();
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  /** `web.test`：用一次真实的搜索测服务与 Key（给了 `apiKey` 就用它，不存）。 */
  async test(params: WebTestParams): Promise<WebTestResult> {
    const id = params.service ?? this.#settings.searchService;
    const service = knownService(id, ['service']);
    const apiKey = params.apiKey?.trim() || (await this.#apiKey(id));
    if (apiKey === undefined) return { ok: false, service: id, reason: 'missing_key' };
    const started = Date.now();
    try {
      const results = await service.search(
        { query: 'Wevir', count: 1 },
        apiKey,
        this.#callOptions(id),
      );
      const latencyMs = Date.now() - started;
      this.#options.logger?.info('web search test', { service: id, outcome: 'ok', latencyMs });
      return { ok: true, service: id, latencyMs, results: results.length };
    } catch (error) {
      const failure = searchFailure(error);
      const latencyMs = Date.now() - started;
      this.#options.logger?.info('web search test', {
        service: id,
        outcome: failure.reason,
        latencyMs,
        ...(failure.httpStatus !== undefined && { httpStatus: failure.httpStatus }),
      });
      return {
        ok: false,
        service: id,
        latencyMs,
        reason: failure.reason,
        ...(failure.httpStatus !== undefined && { httpStatus: failure.httpStatus }),
        message: failure.message,
      };
    }
  }

  /** 一次工具调用（桥脚本经端点转来的 `tools/call`）。 */
  async call(name: string, args: unknown): Promise<ToolResult> {
    if (!this.#settings.enabled) {
      return toolError('Web access is turned off in Wevir settings (Settings → Web search).');
    }
    const input =
      typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    const started = Date.now();
    const log = (outcome: string, fields: Record<string, unknown> = {}) =>
      this.#options.logger?.info('web tool call', {
        tool: name,
        outcome,
        latencyMs: Date.now() - started,
        ...fields,
      });
    if (name === WEB_SEARCH_TOOL) {
      const request = searchRequest(input);
      if (typeof request === 'string') return toolError(request);
      const id = this.#settings.searchService;
      const service = searchService(id);
      const apiKey = await this.#apiKey(id);
      if (service === undefined || apiKey === undefined) {
        log('missing_key', { service: id });
        return toolError(
          `web_search is not set up: there is no API key for the search service (${serviceName(id)}). ` +
            'Ask the user to add one in Wevir (Settings → Web search). web_fetch still works.',
        );
      }
      try {
        const results = await service.search(request, apiKey, this.#callOptions(id));
        log('ok', { service: id, results: results.length });
        return toolText(formatSearch(request, serviceName(id), results));
      } catch (error) {
        const failure = searchFailure(error);
        log(failure.reason, {
          service: id,
          ...(failure.httpStatus !== undefined && { httpStatus: failure.httpStatus }),
        });
        return toolError(
          `web_search failed (${serviceName(id)}, ${failure.reason}): ${failure.message}`,
        );
      }
    }
    if (name === WEB_FETCH_TOOL) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (url.trim() === '') return toolError('web_fetch needs a url.');
      const start = integer(input.start, 0, 0, Number.MAX_SAFE_INTEGER);
      const max = integer(input.max_chars, WEB_FETCH_DEFAULT_CHARS, 1000, WEB_FETCH_MAX_CHARS);
      try {
        const page = await fetchPage(url, this.#options.fetchPage);
        log('ok', { status: page.status, contentType: page.contentType });
        return toolText(formatPage(page, start, max));
      } catch (error) {
        const failure =
          error instanceof WebFetchError
            ? error
            : new WebFetchError('network', (error as Error).message ?? String(error));
        log(failure.reason, failure.status === undefined ? {} : { httpStatus: failure.status });
        return toolError(`web_fetch failed (${failure.reason}): ${failure.message}`);
      }
    }
    return toolError(`Unknown tool: ${name}`);
  }

  #callOptions(id: string) {
    return {
      fetch: this.#options.fetch ?? globalThis.fetch,
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      ...(this.#options.endpoints?.[id] !== undefined && { endpoint: this.#options.endpoints[id] }),
    };
  }

  async #apiKey(id: string): Promise<string | undefined> {
    const value = await this.#secrets?.get(webSecretRef(id));
    return value === undefined || value === '' ? undefined : value;
  }

  #requireSecrets(): SecretStore {
    if (this.#secrets === undefined) throw new Error('web service has not started');
    return this.#secrets;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || request.url !== '/call') {
      request.resume();
      return reply(404, { error: 'not found' });
    }
    if (!this.#authorized(request.headers.authorization)) {
      request.resume();
      return reply(401, { error: 'unauthorized' });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readRequest(request));
    } catch {
      return reply(400, { error: 'bad request' });
    }
    const { name, arguments: args } = (body ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string') return reply(400, { error: 'bad request' });
    try {
      reply(200, await this.call(name, args));
    } catch (error) {
      this.#options.logger?.warn('web tool call failed', { tool: name, error });
      reply(200, toolError('Wevir could not run this web tool call.'));
    }
  }

  #authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.#token}`);
    const actual = Buffer.from(header ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async #load(): Promise<StoredWebSettings> {
    const path = this.#options.settingsFile;
    if (path === undefined) return { ...DEFAULTS };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#options.logger?.warn('web.json is not readable; using defaults', { path });
      }
      return { ...DEFAULTS };
    }
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULTS.enabled,
      searchService:
        typeof record.searchService === 'string' &&
        searchService(record.searchService) !== undefined
          ? record.searchService
          : DEFAULTS.searchService,
    };
  }

  async #save(settings: StoredWebSettings): Promise<void> {
    const path = this.#options.settingsFile;
    if (path === undefined) return;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

function knownService(id: string, path: string[]) {
  const service = searchService(id);
  if (service === undefined) {
    throw new HostError('INVALID_PARAMS', `unknown search service: ${id}`, {
      issues: [{ path, message: `unknown search service: ${id}` }],
    });
  }
  return service;
}

const SERVICE_NAMES: Readonly<Record<string, string>> = { bocha: 'Bocha', tavily: 'Tavily' };

function serviceName(id: string): string {
  return SERVICE_NAMES[id] ?? id;
}

function searchFailure(error: unknown): {
  reason: WebTestFailure;
  message: string;
  httpStatus?: number;
} {
  if (error instanceof WebSearchError) {
    return {
      reason: error.reason,
      message: error.message,
      ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    };
  }
  return { reason: 'unknown', message: (error as Error).message ?? String(error) };
}

const FRESHNESS = new Set<Freshness>(['day', 'week', 'month', 'year']);

/** 工具参数 → 搜索请求；不合法时返回给模型的说明。 */
export function searchRequest(input: Record<string, unknown>): WebSearchRequest | string {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query === '') return 'web_search needs a non-empty query.';
  const freshness = input.freshness;
  const domains = Array.isArray(input.domains)
    ? input.domains
        .filter((domain): domain is string => typeof domain === 'string')
        .map((domain) =>
          domain
            .trim()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, ''),
        )
        .filter((domain) => domain !== '')
        .slice(0, 20)
    : [];
  return {
    query,
    count: integer(input.count, WEB_SEARCH_DEFAULT_RESULTS, 1, WEB_SEARCH_MAX_RESULTS),
    ...(typeof freshness === 'string' &&
      FRESHNESS.has(freshness as Freshness) && { freshness: freshness as Freshness }),
    ...(domains.length > 0 && { domains }),
  };
}

/** 搜索结果 → 给模型看的文字：编号、标题、链接、网站与日期、摘要。 */
export function formatSearch(
  request: WebSearchRequest,
  service: string,
  results: readonly WebSearchResult[],
): string {
  if (results.length === 0) return `No results for "${request.query}" (${service}).`;
  const lines = [`Search results for "${request.query}" (${service}, ${results.length}):`];
  results.forEach((result, index) => {
    lines.push('', `[${index + 1}] ${result.title}`, `URL: ${result.url}`);
    const meta = [
      ...(result.siteName === undefined ? [] : [`Site: ${result.siteName}`]),
      ...(result.published === undefined ? [] : [`Published: ${result.published}`]),
    ];
    if (meta.length > 0) lines.push(meta.join(' · '));
    if (result.snippet !== undefined) lines.push(result.snippet);
  });
  return lines.join('\n');
}

/** 抓到的网页 → 给模型看的文字：地址、标题、这一段在全文里的位置与下一段的 `start`，然后是正文。 */
export function formatPage(page: FetchedPage, start: number, maxChars: number): string {
  const total = page.content.length;
  const from = safeBoundary(page.content, Math.min(start, total));
  const to = safeBoundary(page.content, Math.min(total, from + maxChars));
  const header = [`URL: ${page.url}`];
  if (page.title !== undefined) header.push(`Title: ${page.title}`);
  if (total === 0) {
    header.push('The page has no readable text content.');
    return header.join('\n');
  }
  if (from >= total) {
    header.push(`start=${start} is past the end of the content (${total} characters).`);
    return header.join('\n');
  }
  header.push(
    from === 0 && to === total
      ? `Content: ${total} characters.`
      : `Content: characters ${from}–${to} of ${total}.${to < total ? ` Continue with start=${to}.` : ''}`,
  );
  if (page.truncated)
    header.push('The page was larger than the download limit; only its beginning was read.');
  return `${header.join('\n')}\n\n${page.content.slice(from, to)}`;
}

/** 不在代理对中间切开。 */
function safeBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return index > 0 && index < text.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function toolText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        request.destroy();
        reject(new Error('request too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
