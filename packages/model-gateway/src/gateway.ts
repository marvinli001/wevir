// 模型协议网关的 HTTP 服务（ADR-0005 决策 2，docs/architecture/model-gateway.md）。改写自
// spikes/codex-app-server/src/gateway.ts 的 startGateway：从单个上游改成按 Provider 路由，令牌改为常量时间比较，
// 加上请求体的大小与编码处理、上游错误的整理、日志口径与关闭时的清理。
//
// 在 Host 进程里监听 127.0.0.1 的随机端口，对 Codex 只暴露 POST /v1/p/<providerId>/responses。Codex 只拿到
// 本实例的令牌（每个实例随机生成、只在内存）；上游 Key 只在 setProviders 交来的配置里。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import type { ProviderTestResult } from '@wevir/runtime-adapter';
import { gatewayError, normalizeErrorBody, phalaRoutingError } from './errors.js';
import { type ProviderTestOptions, testProvider } from './provider-test.js';
import { isObject } from './tools.js';
import type { GatewayProvider, ResponsesRequest } from './types.js';
import { errorText, prepareUpstream } from './upstream.js';
import { credentialOf, VertexAuthError, VertexTokenCache } from './vertex-auth.js';

/** 与 Host 的 Logger 兼容的最小接口。 */
export interface GatewayLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface ModelGatewayOptions {
  logger?: GatewayLogger;
  /** `deepseek-official` 的 Responses 地址，默认 DeepSeek 官方（测试指向本地 mock）。 */
  deepseekBaseURL?: string;
  /** testProvider 的时限，默认 20 s。 */
  testTimeoutMs?: number;
  /** 测试注入 HTTP 传输；生产仍只向固定的 Google 地址认证。 */
  fetch?: typeof fetch;
  vertexAuth?: VertexTokenCache;
}

export interface ModelGateway {
  /** 给 Codex 的 `base_url`：`http://127.0.0.1:<port>/v1/p/<providerId>`，Codex 在后面加 `/responses`。 */
  baseURL(providerId: string): string;
  /** Codex 的 `env_key` 要带的令牌（`Authorization: Bearer <token>`）。 */
  readonly token: string;
  /** 换上整套 Provider（含 Key）。之后的请求按新配置走，进行中的请求不受影响。 */
  setProviders(providers: readonly GatewayProvider[]): void;
  /** 按正式请求的处理方式发一次最小的流式请求（provider.test）。 */
  testProvider(provider: GatewayProvider, modelId: string): Promise<ProviderTestResult>;
  /** 停止监听，中断所有进行中的上游请求。 */
  close(): Promise<void>;
}

/** 请求体上限（解压前后都按它）：长对话带图片也在这个量级以内。 */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/** 上游错误正文最多读这么多字节。 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const ROUTE = /^\/v1\/p\/([^/?#]+)\/responses(?:\?.*)?$/;

export async function startModelGateway(options: ModelGatewayOptions = {}): Promise<ModelGateway> {
  const logger = options.logger;
  const auth = options.vertexAuth ?? new VertexTokenCache({ fetch: options.fetch });
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  let providers = new Map<string, GatewayProvider>();
  const inflight = new Set<AbortController>();
  let closing = false;

  const server = createServer((req, res) => {
    res.on('error', () => {});
    void handle(req, res).catch((error: unknown) => {
      logger?.warn('gateway internal error', { error: errorText(error) });
      if (!res.headersSent) send(res, 500, gatewayError('内部错误'));
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const method = req.method ?? '';
    if (!authorized(req.headers.authorization, tokenHash)) {
      logger?.warn('gateway request rejected', { method, status: 401 });
      send(res, 401, gatewayError('令牌不对', 'invalid_api_key'));
      req.resume();
      return;
    }
    const match = ROUTE.exec(req.url ?? '');
    if (match === null) {
      send(res, 404, gatewayError(`不支持 ${method} 这个路径`));
      req.resume();
      return;
    }
    let providerId: string;
    try {
      providerId = decodeURIComponent(match[1] ?? '');
    } catch {
      send(res, 404, gatewayError('Provider ID 不合法'));
      req.resume();
      return;
    }
    const log = (outcome: string, fields: Record<string, unknown>) =>
      logger?.info('gateway request', {
        method,
        providerId,
        outcome,
        ...fields,
        durationMs: Math.round(performance.now() - started),
      });
    const reject = (status: number, message: string, code?: string) => {
      send(res, status, gatewayError(message, code));
      req.resume();
      log('rejected', { status });
    };
    if (method !== 'POST') return reject(405, `${method} 不支持，只接受 POST`);
    // 取请求开始时的配置：之后的 setProviders 不影响这个请求。
    const provider = providers.get(providerId);
    if (provider === undefined)
      return reject(404, `没有 Provider ${providerId}`, 'model_not_found');
    if (!credentialOf(provider))
      return reject(
        401,
        `Provider ${providerId} 没有${provider.kind === 'google-vertex' ? '服务账号 JSON' : ' API Key'}`,
        'invalid_api_key',
      );

    let body: ResponsesRequest;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (!isObject(parsed) || typeof parsed.model !== 'string' || parsed.input === undefined) {
        return reject(400, '请求体不是 Responses 请求（缺 model 或 input）');
      }
      body = parsed as ResponsesRequest;
    } catch (error) {
      if (error instanceof BodyError) return reject(error.status, error.message);
      return reject(400, `请求体不是合法的 JSON：${errorText(error)}`);
    }

    const prepared = prepareUpstream(provider, body, { deepseekBaseURL: options.deepseekBaseURL });
    if (!prepared.ok) return reject(prepared.status, prepared.message);

    const abort = new AbortController();
    inflight.add(abort);
    // Codex 断开（读到 response.completed、取消回合）或网关关闭：中断上游，按正常结束处理。
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    let upstreamStatus: number | undefined;
    try {
      let upstreamKey = provider.apiKey;
      if (provider.kind === 'google-vertex') {
        try {
          upstreamKey = await auth.get(provider.serviceAccountJson ?? '', abort.signal);
          prepared.headers.authorization = `Bearer ${upstreamKey}`;
        } catch (error) {
          if (abort.signal.aborted) return log('client_closed', {});
          if (!(error instanceof VertexAuthError)) throw error;
          send(res, 401, gatewayError(error.message, 'invalid_api_key'));
          return log('auth_error', { status: 401 });
        }
      }
      const redact = (value: string) =>
        upstreamKey ? value.replaceAll(upstreamKey, '***') : value;
      let upstream: Response;
      try {
        upstream = await (options.fetch ?? fetch)(prepared.url, {
          method: 'POST',
          headers: prepared.headers,
          body: JSON.stringify(prepared.payload),
          signal: abort.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (abort.signal.aborted) return log('client_closed', {});
        // 连不上上游：5xx 让 Codex 按自己的策略重试。
        send(
          res,
          502,
          gatewayError(
            `连不上上游：${provider.kind === 'google-vertex' ? 'Google Cloud 网络请求失败' : errorText(error)}`,
          ),
        );
        return log('network_error', { status: 502, error: networkCode(error) });
      }
      upstreamStatus = upstream.status;
      if (!upstream.ok) {
        // 状态码原样转给 Codex（429 / 5xx 由 Codex 自己的重试策略处理），正文整理成 {"error": {"message"}}。
        const text = await readLimited(upstream, abort.signal).catch(() => '');
        const normalized =
          provider.kind === 'google-vertex'
            ? normalizeErrorBody(redact(text), upstream.status)
            : normalizeErrorBody(text, upstream.status, provider.apiKey, provider.baseURL);
        send(
          res,
          upstream.status,
          JSON.stringify(
            phalaRoutingError(normalized, upstream.status, provider.baseURL ?? '') ?? normalized,
          ),
        );
        return log('upstream_error', { upstreamStatus });
      }
      res.writeHead(200, {
        'content-type': prepared.contentType(upstream.headers.get('content-type')),
        'cache-control': 'no-cache',
      });
      for await (const piece of prepared.translate(upstream, abort.signal)) {
        await write(
          res,
          provider.kind === 'google-vertex' && typeof piece === 'string' ? redact(piece) : piece,
        );
        if (res.destroyed) break;
      }
      if (res.destroyed) return log('client_closed', { upstreamStatus });
      res.end();
      log('completed', { upstreamStatus });
    } catch (error) {
      if (abort.signal.aborted)
        return log('client_closed', {
          ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
        });
      throw error;
    } finally {
      inflight.delete(abort);
      abort.abort();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    token,
    baseURL: (providerId) => `http://127.0.0.1:${port}/v1/p/${encodeURIComponent(providerId)}`,
    setProviders(next) {
      providers = new Map(next.map((provider) => [provider.id, structuredClone(provider)]));
      auth.retain(next);
    },
    testProvider(provider, modelId) {
      const testOptions: ProviderTestOptions = {
        deepseekBaseURL: options.deepseekBaseURL,
        timeoutMs: options.testTimeoutMs,
        fetch: options.fetch,
        vertexAuth: auth,
      };
      return testProvider(provider, modelId, testOptions);
    },
    async close() {
      if (closing) return;
      closing = true;
      auth.close();
      for (const abort of inflight) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** `Authorization: Bearer <token>`，比较两边的 SHA-256（长度固定）以免泄露时间差。 */
export function authorized(header: string | undefined, tokenHash: Buffer): boolean {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  const equal = timingSafeEqual(sha256(match?.[1] ?? ''), tokenHash);
  return match !== null && equal;
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function write(res: ServerResponse, chunk: Uint8Array | string): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 读完请求体，按 `content-encoding` 解压（Codex 目前只对 OpenAI 官方压缩，留着以防万一）。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_REQUEST_BYTES) throw new BodyError(413, `请求体超过 ${MAX_REQUEST_BYTES} 字节`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const limit = { maxOutputLength: MAX_REQUEST_BYTES };
  try {
    switch (encoding) {
      case '':
      case 'identity':
        return raw;
      case 'gzip':
        return gunzipSync(raw, limit);
      case 'deflate':
        return inflateSync(raw, limit);
      case 'br':
        return brotliDecompressSync(raw, limit);
      case 'zstd':
        return zstdDecompressSync(raw, limit);
      default:
        throw new BodyError(415, `不支持的 content-encoding：${encoding}`);
    }
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError(400, `请求体解压失败（${encoding}）：${errorText(error)}`);
  }
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** 网络错误只记错误码（ECONNREFUSED 等），不记带地址的原文。 */
function networkCode(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
}
