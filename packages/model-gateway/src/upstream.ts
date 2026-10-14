// 一次 Codex 请求到上游：选处理方式、拼请求、把上游 2xx 的响应体变成发给 Codex 的 SSE。
// HTTP 服务（gateway.ts）与 testProvider（provider-test.ts）共用这里，保证探测与正式请求走同一条路。

import packageJson from '../package.json' with { type: 'json' };
import { type ChatTranslation, toChatRequest } from './chat/request.js';
import { ChatStreamTranslator } from './chat/response.js';
import { applyDialects, type EventRewrite } from './dialects.js';
import { routeOf } from './providers.js';
import { SseParser, sseEvent } from './sse.js';
import { isObject } from './tools.js';
import type { GatewayProvider, ResponsesEvent, ResponsesRequest } from './types.js';

export const GATEWAY_VERSION: string = packageJson.version;

/** 发给上游的 User-Agent。Codex 自己的 originator / User-Agent 不转发。 */
export const USER_AGENT = `wevir-gateway/${GATEWAY_VERSION}`;

export type Prepared =
  | {
      ok: true;
      mode: 'responses' | 'chat';
      url: string;
      headers: Record<string, string>;
      payload: unknown;
      /** 上游 2xx 之后：响应体 → 发给 Codex 的字节或 SSE 文本。`signal` 中断时抛出，不当作上游错误。 */
      translate(response: Response, signal: AbortSignal): AsyncIterable<Uint8Array | string>;
      /** 透传且没有改写响应时，原样转回上游的 content-type。 */
      contentType(upstream: string | null): string;
      /** Chat 转换的细节，或生效的方言修正（测试用）。 */
      chat?: ChatTranslation;
      dialects?: string[];
    }
  | { ok: false; status: number; message: string };

export interface PrepareOptions {
  deepseekBaseURL?: string;
}

/** 请求体里不转发给任何上游的字段：Codex 的安装 ID、会话与回合 ID、回合元数据（codex-notes §3.1）。 */
export const STRIPPED_BODY_FIELDS = ['client_metadata'] as const;

export function prepareUpstream(
  provider: GatewayProvider,
  body: ResponsesRequest,
  options: PrepareOptions = {},
): Prepared {
  const route = routeOf(provider, options.deepseekBaseURL);
  if (route.mode === 'unsupported') return { ok: false, status: 400, message: route.message };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': USER_AGENT,
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
  };
  if (route.mode === 'chat') {
    const chat = toChatRequest(body, provider);
    return {
      ok: true,
      mode: 'chat',
      url: route.url,
      headers,
      payload: chat.request,
      chat,
      contentType: () => 'text/event-stream',
      translate: (response, signal) =>
        chatToResponses(response, new ChatStreamTranslator(chat.names), signal),
    };
  }
  const stripped: ResponsesRequest = { ...body };
  for (const field of STRIPPED_BODY_FIELDS) delete stripped[field];
  const dialect = applyDialects(provider, stripped);
  const rewrite = dialect.rewrite;
  return {
    ok: true,
    mode: 'responses',
    url: route.url,
    headers,
    payload: dialect.body,
    dialects: dialect.applied,
    contentType: (upstream) =>
      rewrite === undefined ? (upstream ?? 'text/event-stream') : 'text/event-stream',
    translate: (response, signal) =>
      rewrite === undefined ? rawBody(response, signal) : rewriteEvents(response, rewrite, signal),
  };
}

async function* rawBody(response: Response, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (response.body === null) return;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    yield chunk;
  }
}

/** 透传时按方言修正改写响应事件：逐条解析 SSE，JSON 的事件改写后重新编码，其余原样。 */
async function* rewriteEvents(
  response: Response,
  rewrite: EventRewrite,
  signal: AbortSignal,
): AsyncIterable<string> {
  if (response.body === null) return;
  const parser = new SseParser();
  const encode = (data: string): string => {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return `data: ${data}\n\n`;
    }
    return isObject(event) && typeof event.type === 'string'
      ? sseEvent(rewrite(event as ResponsesEvent))
      : `data: ${data}\n\n`;
  };
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    for (const message of parser.push(chunk)) yield encode(message.data);
  }
  for (const message of parser.end()) yield encode(message.data);
}

/**
 * Chat 上游的响应 → Responses 事件。流读到一半出错（连接被重置等）→ response.failed；`signal` 中断（Codex 断开、
 * 网关关闭）时原样抛出。上游无视 `stream` 回了整个 JSON 时按一个 chunk 处理。
 */
async function* chatToResponses(
  response: Response,
  translator: ChatStreamTranslator,
  signal: AbortSignal,
): AsyncIterable<string> {
  const emit = (events: ResponsesEvent[]) => events.map(sseEvent).join('');
  yield emit(translator.start());
  try {
    if (/json/i.test(response.headers.get('content-type') ?? '')) {
      const text = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        yield emit(translator.fail({ message: `上游返回的不是 JSON：${text.slice(0, 300)}` }));
        return;
      }
      yield emit(translator.chunk(data));
      yield emit(translator.finish());
      return;
    }
    if (response.body !== null) {
      const parser = new SseParser();
      read: for await (const chunk of response.body) {
        signal.throwIfAborted();
        for (const message of parser.push(chunk)) {
          const events = translator.data(message.data);
          if (events.length > 0) yield emit(events);
          if (translator.ended) return;
          if (translator.done) break read;
        }
      }
      if (!translator.done) {
        for (const message of parser.end()) {
          const events = translator.data(message.data);
          if (events.length > 0) yield emit(events);
        }
      }
    }
    yield emit(translator.finish());
  } catch (error) {
    if (signal.aborted) throw error;
    yield emit(
      translator.fail({
        message: `上游的流中断：${errorText(error)}`,
        code: 'upstream_stream_error',
      }),
    );
  }
}

/** 异常的说明，带上 undici 放在 `cause` 里的底层原因（例如 `terminated（other side closed）`）。 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined || cause === error.message
    ? error.message
    : `${error.message}（${cause}）`;
}
