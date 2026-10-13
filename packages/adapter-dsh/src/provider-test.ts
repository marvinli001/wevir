import type {
  ProviderConfig,
  ProviderTestFailure,
  ProviderTestResult,
} from '@wevir/runtime-adapter';
import { effectiveCompat, validateProviderConfig } from './provider-config.js';

// provider.test（T3.4）：按 dsh 发请求的方式，直接向 Provider 发一次最小的流式请求，验证地址、协议、Key 与
// 模型，收到第一条合乎协议的流式数据就断开。不经 dsh 进程：dsh 每个请求都带完整的系统提示词与工具定义，
// 太贵，失败时也只给自由文本（T3.2 补记 3）。请求的拼法跟 dsh 一致：
// - deepseek-official（llm-deepseek）：Anthropic Messages，`<baseURL>/v1/messages`（baseURL 已以 `/v1` 结尾
//   时只加 `/messages`），`x-api-key`；
// - openai-completions（pi-ai，OpenAI SDK）：`<baseURL>/chat/completions`，`Authorization: Bearer`，
//   输出上限字段按生效的 compat（`maxTokensField`）；
// - openai-responses：`<baseURL>/responses`。
// 用流式请求，是因为有的服务只在流式下允许思考（如 DashScope 的 enable_thinking），而 dsh 也总是流式请求。

/** llm-deepseek 的官方根地址（dsh 0.2.1-alpha.2）。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';

/** 整个探测的时限：连接、等响应头与等第一条流式数据共用。 */
export const PROVIDER_TEST_TIMEOUT_MS = 20_000;

/** 错误响应体与流式数据最多读这么多字节，用来提取服务端的错误原文。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 服务端原文最多带这么多字符。 */
const MAX_DETAIL_CHARS = 300;

export interface ProviderTestOptions {
  /** 默认全局 `fetch`；测试注入。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 第一条流式数据（解析后的 JSON）是否合乎该协议。 */
  accepts: (data: unknown) => boolean;
}

/**
 * 对 Provider 的 `modelId` 发一次最小请求。不抛错：失败按原因（`reason`）归类，`error.message` 是给人看的中文
 * 说明加服务端原文，不含 Key。成功时 `latencyMs` 是从发出请求到收到第一条流式数据的时间。
 */
export async function testProvider(
  provider: ProviderConfig,
  modelId: string,
  options: ProviderTestOptions = {},
): Promise<ProviderTestResult> {
  const issues = validateProviderConfig(provider);
  if (issues.length > 0) {
    return failure(
      'unknown',
      `配置不完整：${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`,
    );
  }
  const apiKey = provider.apiKey;
  if (apiKey === undefined || apiKey === '') {
    return failure('missing_key', '还没有填写 API Key（本机服务不校验 Key 时也要填一个任意值）');
  }
  const probe = probeRequest(provider, modelId, apiKey);
  const redact = (text: string) => text.replaceAll(apiKey, '***');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProbeTimeout()), timeoutMs);
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    let response: Response;
    try {
      response = await doFetch(probe.url, {
        method: 'POST',
        headers: probe.headers,
        body: JSON.stringify(probe.body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      return networkFailure(error, probe.url, controller.signal, timeoutMs, redact);
    }
    const status = response.status;
    if (!response.ok) {
      const body = await readText(response, controller.signal).catch(() => '');
      return { ...httpFailure(status, body, modelId, probe.url, redact), latencyMs: latency() };
    }
    const contentType = response.headers.get('content-type') ?? '';
    let first: { data: unknown } | { raw: string } | undefined;
    try {
      first = /json/i.test(contentType)
        ? parseJson(await readText(response, controller.signal))
        : await firstSseData(response, controller.signal);
    } catch (error) {
      return networkFailure(error, probe.url, controller.signal, timeoutMs, redact);
    }
    if (first !== undefined && 'data' in first) {
      const streamed = errorOf(first.data);
      if (streamed !== undefined) {
        // 有的网关以 200 加流里的 error 报错。
        return {
          ...classifyMessage(streamed, modelId, status, redact),
          latencyMs: latency(),
          httpStatus: status,
        };
      }
      if (probe.accepts(first.data)) return { ok: true, latencyMs: latency() };
    }
    const sample =
      first === undefined ? '' : 'raw' in first ? first.raw : JSON.stringify(first.data);
    return {
      ...failure(
        'protocol',
        /html/i.test(contentType) || /^\s*</.test(sample)
          ? `${probe.url} 返回的是网页而不是 API 响应：baseURL 可能少了路径（例如 /v1）`
          : `${probe.url} 的响应不是所选协议的流式数据，检查协议与 baseURL${detail(sample, redact)}`,
      ),
      latencyMs: latency(),
      httpStatus: status,
    };
  } finally {
    clearTimeout(timer);
    // 成功时也断开：只要第一条数据，不让模型继续生成。
    controller.abort();
  }
}

function probeRequest(provider: ProviderConfig, modelId: string, apiKey: string): ProbeRequest {
  const messages = [{ role: 'user', content: 'ping' }];
  if (provider.kind === 'deepseek-official') {
    return {
      url: deepseekMessagesUrl(provider.baseURL ?? DEEPSEEK_DEFAULT_BASE_URL),
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // 与 dsh 的 off 档位相同：关掉思考，1 个 token 就够判断。
      body: {
        model: modelId,
        max_tokens: 1,
        stream: true,
        thinking: { type: 'disabled' },
        messages,
      },
      accepts: (data) => isRecord(data) && typeof data.type === 'string',
    };
  }
  const base = trimSlash(provider.baseURL ?? '');
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${apiKey}`,
  };
  if (provider.api === 'openai-responses') {
    return {
      url: `${base}/responses`,
      headers,
      // OpenAI 要求 max_output_tokens 至少 16。
      body: { model: modelId, input: 'ping', stream: true, max_output_tokens: 16 },
      accepts: (data) =>
        isRecord(data) && typeof data.type === 'string' && data.type.startsWith('response.'),
    };
  }
  const maxTokensField = effectiveCompat(provider).maxTokensField ?? 'max_completion_tokens';
  return {
    url: `${base}/chat/completions`,
    headers,
    body: { model: modelId, messages, stream: true, [maxTokensField]: 1 },
    accepts: (data) => isRecord(data) && Array.isArray(data.choices),
  };
}

/** llm-deepseek 的拼法：去掉末尾斜线；以 `/v1` 结尾时复用它，否则补 `/v1`。 */
export function deepseekMessagesUrl(baseURL: string): string {
  const base = trimSlash(baseURL);
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function httpFailure(
  status: number,
  body: string,
  modelId: string,
  url: string,
  redact: (text: string) => string,
): ProviderTestResult {
  const message = errorOf(parseJson(body)?.data) ?? body;
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

/**
 * 读第一条非空的 SSE `data:`。遇到不是 SSE 的行（网页、纯文本）、流结束或读满上限时，返回读到的原文。
 */
async function firstSseData(
  response: Response,
  signal: AbortSignal,
): Promise<{ data: unknown } | { raw: string } | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let newline = text.indexOf('\n');
      while (newline >= 0) {
        const line = text.slice(0, newline).trim();
        if (line.startsWith('data:')) {
          const payload = line.slice('data:'.length).trim();
          if (payload !== '' && payload !== '[DONE]') return parseJson(payload) ?? { raw: payload };
        } else if (line !== '' && !/^(event|id|retry):|^:/.test(line)) {
          return { raw: text };
        }
        text = text.slice(newline + 1);
        newline = text.indexOf('\n');
      }
      if (text.length > MAX_BODY_BYTES) return { raw: text };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text.trim() === '' ? undefined : { raw: text };
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
  if (!isRecord(data)) return undefined;
  const error = data.error;
  if (typeof error === 'string') return error;
  if (isRecord(error)) {
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

function parseJson(text: string): { data: unknown } | undefined {
  try {
    return { data: JSON.parse(text) };
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

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ProbeTimeout extends Error {
  override readonly name = 'ProbeTimeout';
}
