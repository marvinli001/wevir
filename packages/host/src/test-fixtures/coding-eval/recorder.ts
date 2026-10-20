// coding 评测记录模型请求的方式：换掉网关向上游发请求用的 `fetch`（ModelGatewayOptions.fetch），不在中间插本地代理。这样
// Provider 的地址仍是真实上游，按主机名生效的方言（DeepSeek 命名空间说明、Kimi 图片等）与产品一致；记录只在内存里，留请求体、
// 状态与从流里取出的用量数字，不留请求头（Key 在请求头里）与响应正文。
//
// 用量为什么单独记“流怎么结束的”：Codex 读到 `response.completed` 就断开连接，网关随即中断上游。基线的转发代理在中断时直接
// 进 catch，不再从已经收到的文本里取用量，所以上游明明报了的用量会丢（真实 DeepSeek 约 1/6 的请求）。这里边收边解析，
// 中断之前收到的用量照记，并记下结束方式、最后一个事件与有没有见到用量事件，缺用量的请求可以逐个查原因。

/** 上游报的一个请求的 token 数（Responses 的 input/cached/output，或 Chat 的 prompt/cache/completion 换算过来）。 */
export interface EvalUsage {
  input: number;
  cachedInput: number;
  output: number;
}

export interface EvalRequest {
  /** 第几个请求（从 0 起，这个记录器里）。 */
  index: number;
  url: string;
  /** `/responses`、`/chat/completions`、`/messages`… */
  path: string;
  /** 请求体（JSON）；不是 JSON 时为空对象。 */
  body: Record<string, unknown>;
  at: number;
  /** HTTP 状态；网络失败时没有。 */
  status?: number;
  /** 网络层失败的说明（不含请求头）。 */
  networkError?: string;
  /** 响应流怎么结束的：读完、被下游（网关 / Codex）中断、出错。 */
  ended?: 'complete' | 'aborted' | 'error';
  /** 流里见过的事件类型与次数（Responses 的 `type`；Chat 的分片记作 `chunk`、`[DONE]`）。 */
  events: Record<string, number>;
  /** 最后一个事件类型。 */
  lastEvent?: string;
  /** 见到的终止事件：`response.completed` / `response.incomplete` / `response.failed` / Chat 的 `finish_reason`。 */
  terminal?: string;
  usage?: EvalUsage;
  durationMs?: number;
  /** 收到的响应字节数。 */
  bytes: number;
}

export interface RecordingFetch {
  fetch: typeof fetch;
  requests: EvalRequest[];
  /** 全部请求的响应流都结束（含被中断）之后再读用量。 */
  settled(): Promise<void>;
}

export interface RecorderHooks {
  /** 转发之前调用（可同步改工作区里的文件：模拟回合中途的外部修改）。 */
  beforeForward?(request: EvalRequest): void;
}

/** 从 SSE 的一行 `data:` 里取用量（Responses 或 Chat）；不是用量时返回 undefined。 */
export function usageFromEvent(value: unknown): EvalUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as {
    usage?: Record<string, unknown> | null;
    response?: { usage?: Record<string, unknown> | null };
  };
  const usage = record.response?.usage ?? record.usage;
  if (usage === null || usage === undefined || typeof usage !== 'object') return undefined;
  const number = (v: unknown) => (typeof v === 'number' ? v : 0);
  if (typeof usage.input_tokens === 'number') {
    const details = usage.input_tokens_details as { cached_tokens?: number } | undefined;
    return {
      input: usage.input_tokens,
      cachedInput: number(details?.cached_tokens),
      output: number(usage.output_tokens),
    };
  }
  if (typeof usage.prompt_tokens === 'number') {
    const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
    return {
      input: usage.prompt_tokens,
      cachedInput: number(details?.cached_tokens ?? usage.prompt_cache_hit_tokens),
      output: number(usage.completion_tokens),
    };
  }
  return undefined;
}

/** 一个 `data:` 负载记进请求：事件类型、终止事件与用量。 */
function observe(request: EvalRequest, data: string): void {
  if (data === '[DONE]') {
    request.events['[DONE]'] = (request.events['[DONE]'] ?? 0) + 1;
    request.lastEvent = '[DONE]';
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as {
    type?: string;
    object?: string;
    choices?: Array<{ finish_reason?: string | null }>;
  };
  const type =
    typeof record.type === 'string'
      ? record.type
      : record.object === 'chat.completion.chunk' || Array.isArray(record.choices)
        ? 'chunk'
        : 'json';
  request.events[type] = (request.events[type] ?? 0) + 1;
  request.lastEvent = type;
  if (
    type === 'response.completed' ||
    type === 'response.incomplete' ||
    type === 'response.failed'
  ) {
    request.terminal = type;
  }
  const finish = record.choices?.find((choice) => typeof choice.finish_reason === 'string');
  if (finish?.finish_reason) request.terminal = `finish:${finish.finish_reason}`;
  // 非流式的 Responses JSON（`object: response`）也有 usage。
  const usage = usageFromEvent(value);
  if (usage !== undefined) request.usage = usage;
}

/** 记录用的 `fetch`：交给 `CodexRuntime({ gateway: { fetch } })`。 */
export function recordingFetch(hooks: RecorderHooks = {}): RecordingFetch {
  const requests: EvalRequest[] = [];
  const pending = new Set<Promise<void>>();
  const wrapped: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // 不是 JSON（例如 Vertex 认证的表单），记成空对象。
      }
    }
    const request: EvalRequest = {
      index: requests.length,
      url: url.replace(/\?.*$/, ''),
      path: pathOf(url),
      body,
      at: Date.now(),
      events: {},
      bytes: 0,
    };
    requests.push(request);
    hooks.beforeForward?.(request);
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      // 网关在响应头到达之前就中断（Codex 取消了输入建议一类的请求）：不是故障。
      if (init?.signal?.aborted === true) request.ended = 'aborted';
      else
        request.networkError = error instanceof Error ? `${error.name}: ${error.message}` : 'error';
      request.durationMs = Date.now() - request.at;
      throw error;
    }
    request.status = response.status;
    if (response.body === null) {
      request.ended = 'complete';
      request.durationMs = Date.now() - request.at;
      return response;
    }
    const [mine, theirs] = response.body.tee();
    const reading = consume(mine, request, init?.signal ?? undefined).finally(() =>
      pending.delete(reading),
    );
    pending.add(reading);
    return new Response(theirs, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch: wrapped,
    requests,
    settled: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

function pathOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const known = /\/(responses|chat\/completions|messages)$/.exec(path);
    return known === null ? path : `/${known[1]}`;
  } catch {
    return url;
  }
}

/** 边收边按行解析 SSE（或整段 JSON）；中断或出错时保留已经解析出来的部分。 */
async function consume(
  stream: ReadableStream<Uint8Array>,
  request: EvalRequest,
  signal: AbortSignal | undefined,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sse = false;
  const line = (text: string) => {
    if (text.startsWith('data:')) {
      sse = true;
      observe(request, text.slice(5).trim());
    }
  };
  try {
    for await (const chunk of stream) {
      request.bytes += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        line(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (sse) line(buffer.trim());
    else if (buffer.trim() !== '') observe(request, buffer.trim());
    request.ended = 'complete';
  } catch {
    if (sse && buffer.trim() !== '') line(buffer.trim());
    request.ended = signal?.aborted === true ? 'aborted' : 'error';
  } finally {
    request.durationMs = Date.now() - request.at;
  }
}

/** 一个请求为什么没有用量（报告里单列，不混进平均数）。 */
export function missingUsageReason(request: EvalRequest): string {
  if (request.networkError !== undefined) return `network error (${request.networkError})`;
  if (request.status === undefined && request.ended === 'aborted')
    return 'cancelled by the gateway before the response started';
  if (request.status !== undefined && request.status >= 400) return `HTTP ${request.status}`;
  if (request.terminal === undefined)
    return `stream ${request.ended ?? 'unknown'} before a terminal event (last event: ${request.lastEvent ?? 'none'})`;
  return `terminal event ${request.terminal} carried no usage (stream ${request.ended ?? 'unknown'})`;
}
