// provider.test 改由网关实现（ADR-0005 决策 2.5）：用与正式请求相同的处理方式（prepareUpstream：透传加方言修正，
// 或 Chat / Messages 转换）发一次最小的流式请求，收到第一条合乎协议的流式数据就断开。
// 失败归类的口径与 packages/adapter-dsh/src/provider-test.ts 相同（providers.md §6.2），这里复制了它的判断，
// 因为网关不能依赖 adapter-dsh（会把 dsh 带进依赖）。

import type { ProviderTestFailure, ProviderTestResult } from '@wevir/runtime-adapter';
import { normalizeErrorBody, phalaRoutingError } from './errors.js';
import { UPSTREAM_PROTOCOL_ERROR } from './messages/response.js';
import { describeIssues, isOllamaHost, isXaiHost, validateProvider } from './providers.js';
import { SseParser } from './sse.js';
import { isObject } from './tools.js';
import type { GatewayProvider, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';
import { credentialOf, VertexAuthError, VertexTokenCache } from './vertex-auth.js';

/** 整个探测的时限：连接、等响应头与等第一条流式数据共用。 */
export const PROVIDER_TEST_TIMEOUT_MS = 20_000;

/** 错误响应体最多读这么多字节。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 服务端原文最多带这么多字符。 */
const MAX_DETAIL_CHARS = 300;

export interface ProviderTestOptions {
  deepseekBaseURL?: string;
  timeoutMs?: number;
  /** 默认全局 `fetch`；测试注入。 */
  fetch?: typeof fetch;
  vertexAuth?: VertexTokenCache;
}

/**
 * 探测用的 Responses 请求：与 Codex 的请求同形（message 项、流式、不存储），只有一句 `ping`，输出上限 16
 * （OpenAI 要求至少 16；Chat 转换时按 compat 写成 max_tokens 等，Messages 转换时是 max_tokens）。
 */
export function probeRequest(modelId: string): ResponsesRequest {
  return {
    model: modelId,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    stream: true,
    store: false,
    max_output_tokens: 16,
  };
}

/**
 * 对 Provider 的 `modelId` 发一次最小请求。不抛错：失败按原因（`reason`）归类，`error.message` 是给人看的中文
 * 说明加服务端原文，不含 Key。成功时 `latencyMs` 是从发出请求到收到第一条流式数据的时间。
 */
export async function testProvider(
  provider: GatewayProvider,
  modelId: string,
  options: ProviderTestOptions = {},
): Promise<ProviderTestResult> {
  const issues = validateProvider(provider);
  if (issues.length > 0) return failure('unknown', `配置不完整：${describeIssues(issues)}`);
  const apiKey = credentialOf(provider);
  if (apiKey === undefined || apiKey === '') {
    return failure(
      'missing_key',
      provider.kind === 'google-vertex'
        ? '还没有填写服务账号 JSON'
        : '还没有填写 API Key（本机服务不校验 Key 时也要填一个任意值）',
    );
  }
  const prepared = prepareUpstream(provider, probeRequest(modelId), {
    deepseekBaseURL: options.deepseekBaseURL,
  });
  if (!prepared.ok) return failure('unknown', prepared.message);
  let credential = apiKey;
  const redact = (text: string) => text.replaceAll(credential, '***');
  const auth = options.vertexAuth ?? new VertexTokenCache({ fetch: options.fetch });
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProbeTimeout()), timeoutMs);
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    if (provider.kind === 'google-vertex') {
      try {
        credential = await auth.get(apiKey, controller.signal);
        prepared.headers.authorization = `Bearer ${credential}`;
      } catch (error) {
        if (error instanceof VertexAuthError) return failure('auth', error.message);
        return networkFailure(error, prepared.url, controller.signal, timeoutMs, redact);
      }
    }
    let response: Response;
    try {
      response = await doFetch(prepared.url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(prepared.payload),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      return networkFailure(error, prepared.url, controller.signal, timeoutMs, redact);
    }
    const status = response.status;
    if (!response.ok) {
      const body = await readText(response, controller.signal).catch(() => '');
      const normalized = normalizeErrorBody(body, status, credential, provider.baseURL);
      const routingError = phalaRoutingError(normalized, status, provider.baseURL ?? '');
      if (routingError !== undefined) {
        return {
          ok: false,
          reason: 'server',
          httpStatus: status,
          latencyMs: latency(),
          error: {
            category: 'provider',
            code: routingError.error.code,
            message: routingError.error.message.slice(0, MAX_DETAIL_CHARS),
          },
        };
      }
      const result = httpFailure(status, body, modelId, prepared.url, redact);
      if (isXaiHost(provider.baseURL ?? '') && normalized.error.code !== undefined && result.error)
        result.error.code = normalized.error.code;
      if (
        status === 404 &&
        result.reason === 'protocol' &&
        prepared.mode === 'responses' &&
        isOllamaHost(provider.baseURL ?? '')
      ) {
        result.error = {
          category: 'provider',
          code: 'ollama_responses_unavailable',
          message:
            'Ollama Responses endpoint is unavailable; upgrade Ollama or use Chat Completions',
        };
      }
      return { ...result, latencyMs: latency() };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (/html/i.test(contentType)) {
      return {
        ...failure(
          'protocol',
          `${prepared.url} 返回的是网页而不是 API 响应：baseURL 可能少了路径（例如 /v1）`,
        ),
        latencyMs: latency(),
        httpStatus: status,
      };
    }
    let first: FirstEvent;
    try {
      first = await firstEvent(prepared.translate(response, controller.signal), controller.signal);
    } catch (error) {
      return networkFailure(error, prepared.url, controller.signal, timeoutMs, redact);
    }
    if (first.kind === 'error') {
      // 200 但流里是错误（Chat 转换后是 response.failed，透传时是上游的 response.failed / error 事件）。
      return {
        ...classifyMessage(first.message, modelId, status, redact),
        latencyMs: latency(),
        httpStatus: status,
      };
    }
    if (first.kind === 'event') return { ok: true, latencyMs: latency() };
    return {
      ...failure(
        'protocol',
        /^\s*</.test(first.raw)
          ? `${prepared.url} 返回的是网页而不是 API 响应：baseURL 可能少了路径（例如 /v1）`
          : `${prepared.url} 的响应不是所选协议的流式数据，检查协议与 baseURL${detail(first.raw, redact)}`,
      ),
      latencyMs: latency(),
      httpStatus: status,
    };
  } finally {
    clearTimeout(timer);
    if (options.vertexAuth === undefined) auth.close();
    // 成功时也断开：只要第一条数据，不让模型继续生成。
    controller.abort();
  }
}

type FirstEvent =
  | { kind: 'event'; type: string }
  | { kind: 'error'; message: string }
  | { kind: 'none'; raw: string };

/**
 * 读处理后的流，直到第一条有意义的 Responses 事件。response.created / in_progress 不算：Chat 转换时它是网关自己在
 * 收到 2xx 时发的；透传时上游也是先发它，之后才可能是 response.failed。
 */
async function firstEvent(
  stream: AsyncIterable<Uint8Array | string>,
  signal: AbortSignal,
): Promise<FirstEvent> {
  const parser = new SseParser();
  let raw = '';
  const judge = (data: string): FirstEvent | undefined => {
    if (data.trim() === '' || data.trim() === '[DONE]') return undefined;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return { kind: 'none', raw: data };
    }
    if (!isObject(event) || typeof event.type !== 'string') {
      const message = errorOf(event);
      return message === undefined ? { kind: 'none', raw: data } : { kind: 'error', message };
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      const response = isObject(event.response) ? event.response : {};
      const error = isObject(response.error) ? response.error : {};
      // Messages 转换发现上游的流不是 Messages 格式：与“不是所选协议的流”同样归为 protocol。
      if (error.code === UPSTREAM_PROTOCOL_ERROR)
        return { kind: 'none', raw: String(error.message) };
      return { kind: 'error', message: errorOf(response) ?? errorOf(event) ?? data };
    }
    if (event.type === 'response.created' || event.type === 'response.in_progress')
      return undefined;
    return event.type.startsWith('response.')
      ? { kind: 'event', type: event.type }
      : { kind: 'none', raw: data };
  };
  for await (const chunk of stream) {
    signal.throwIfAborted();
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    if (raw.length < MAX_BODY_BYTES) raw += text;
    for (const message of parser.push(text)) {
      const verdict = judge(message.data);
      if (verdict !== undefined) return verdict;
    }
    if (raw.length >= MAX_BODY_BYTES) return { kind: 'none', raw };
  }
  for (const message of parser.end()) {
    const verdict = judge(message.data);
    if (verdict !== undefined) return verdict;
  }
  return { kind: 'none', raw };
}

function httpFailure(
  status: number,
  body: string,
  modelId: string,
  url: string,
  redact: (text: string) => string,
): ProviderTestResult {
  const message = errorOf(parseJson(body)) ?? body;
  const withStatus = (reason: ProviderTestFailure, text: string): ProviderTestResult => ({
    ...failure(reason, `${text}（HTTP ${status}）${detail(message, redact)}`),
    httpStatus: status,
  });
  if (status === 401 || status === 403) return withStatus('auth', 'API Key 无效或没有权限');
  if (status === 429) return withStatus('rate_limited', 'Key 有效，但被限流或额度已用完');
  if (status >= 500) return withStatus('server', '服务端出错，稍后再试');
  if (mentionsMissingModel(message)) {
    return withStatus('model_not_found', `服务端没有模型 ${modelId}，检查模型 ID`);
  }
  if (status === 404 || status === 405) {
    return withStatus('protocol', `${url} 不存在：baseURL 或协议不对`);
  }
  if (status === 400 || status === 422) {
    return withStatus('protocol', '服务端不接受请求格式：检查协议，或调整 compat');
  }
  return withStatus('unknown', '请求失败');
}

/** 200 但流里是错误：按原文归类，没有状态码可依据。 */
function classifyMessage(
  message: string,
  modelId: string,
  status: number,
  redact: (text: string) => string,
): ProviderTestResult {
  if (mentionsMissingModel(message)) {
    return failure(
      'model_not_found',
      `服务端没有模型 ${modelId}，检查模型 ID${detail(message, redact)}`,
    );
  }
  if (/api[ _-]?key|unauthori[sz]ed|authenticat|invalid[ _]token|permission/i.test(message)) {
    return failure('auth', `API Key 无效或没有权限${detail(message, redact)}`);
  }
  return failure('unknown', `服务端返回错误（HTTP ${status}）${detail(message, redact)}`);
}

function mentionsMissingModel(message: string): boolean {
  return /model[_ ]not[_ ]found|unknown model|invalid model|no such model|model.*(not exist|does not exist|not found|not supported|unavailable)|模型.*(不存在|未找到|不支持)/i.test(
    message,
  );
}

function networkFailure(
  error: unknown,
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  redact: (text: string) => string,
): ProviderTestResult {
  if (signal.reason instanceof ProbeTimeout) {
    return failure('timeout', `${timeoutMs / 1000} 秒内没有收到 ${url} 的响应`);
  }
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const code = String((cause as { code?: unknown } | null)?.code ?? '');
  const host = hostOf(url);
  const text = redact(cause instanceof Error ? cause.message : String(cause));
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return failure('network', `找不到主机 ${host}（${code}），检查 baseURL 与网络`);
  }
  if (code === 'ECONNREFUSED')
    return failure('network', `${host} 拒绝连接（${code}），服务是否在运行？`);
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return failure('timeout', `连接 ${host} 超时（${code}），检查网络或代理`);
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return failure('network', `${host} 的 TLS 证书校验失败（${code}）`);
  }
  if (code !== '') return failure('network', `连不上 ${host}（${code}）：${text}`);
  return failure('network', `请求 ${url} 失败：${text}`);
}

function failure(reason: ProviderTestFailure, message: string): ProviderTestResult {
  return {
    ok: false,
    error: {
      category:
        reason === 'missing_key'
          ? 'missing_credentials'
          : reason === 'unknown'
            ? 'unknown'
            : 'provider',
      message,
    },
    reason,
  };
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BODY_BYTES) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_BODY_BYTES);
}

/** 服务端错误体里的原文：OpenAI 风格 `{error: {message}}`、Anthropic 风格 `{type: 'error', error: {message}}`，或 `{message}`。 */
function errorOf(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  const error = data.error;
  if (typeof error === 'string') return error;
  if (isObject(error)) {
    const parts = [error.message, error.code, error.type].filter(
      (part) => typeof part === 'string',
    );
    if (parts.length > 0) return parts.join(' · ');
  }
  if (data.type === 'error' && typeof data.message === 'string') return data.message;
  if (typeof data.message === 'string' && data.choices === undefined && data.type === undefined) {
    return data.message;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function detail(text: string, redact: (text: string) => string): string {
  const trimmed = redact(text.replace(/\s+/g, ' ').trim());
  if (trimmed === '') return '';
  return `：${trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

class ProbeTimeout extends Error {
  override readonly name = 'ProbeTimeout';
}
