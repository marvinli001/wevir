// Chat Completions 的流式响应 → Responses 的流事件。改写自 spikes/codex-app-server/src/gateway.ts 的响应部分，
// 补上 Spike 没做的：finish_reason 为 length / content_filter → response.incomplete、上游流里的错误与提前断开 →
// response.failed、并行工具调用的多个 index 交错到达、上游无视 stream 回整个 JSON。
//
// 事件的形状以 Codex 的解析为准（upstream/codex/codex-rs/codex-api/src/sse/responses.rs）：历史与工具调用只取
// response.output_item.done；增量之前要有对应的 output_item.added；response.completed 要有字符串 response.id，
// usage 有就要有 input_tokens / output_tokens / total_tokens。映射表见 docs/architecture/model-gateway.md §4.2。

import { randomBytes } from 'node:crypto';
import { isObject, restoreToolCall, type ToolNames } from '../tools.js';
import type { JsonObject, ResponsesEvent, ResponsesItem } from '../types.js';
import { encodeGeminiSignatures, encodeReasoning } from './request.js';

interface OpenItem {
  id: string;
  outputIndex: number;
  text: string;
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
  /** Gemini 的 thought signature（`extra_content.google.thought_signature`）。 */
  signature?: string;
}

export interface ChatStreamOptions {
  responseId?: string;
  /**
   * Gemini：工具调用带的 thought signature 收进一个 reasoning 项的信封（在这些调用之前提交），Codex 带回时请求方向把它
   * 挂回原来的调用（request.ts，model-gateway.md §4.5）。信封记下 Provider 与模型。
   */
  signatures?: { provider: string; model: string };
}

/** 上游的错误：流里的 `error` 对象，或读流时的异常。 */
export interface UpstreamFailure {
  message: string;
  code?: string;
}

export class ChatStreamTranslator {
  readonly responseId: string;
  readonly #names: ToolNames;
  readonly #signatures: ChatStreamOptions['signatures'];
  #outputIndex = 0;
  #reasoning: OpenItem | undefined;
  #message: OpenItem | undefined;
  /** 按上游的 `index` 记的工具调用，结束时按 index 的顺序提交。 */
  readonly #calls = new Map<number, PendingCall>();
  #lastCallIndex: number | undefined;
  readonly #output: ResponsesItem[] = [];
  #usage: JsonObject | undefined;
  #finishReason: string | undefined;
  #done = false;
  #started = false;
  #ended = false;

  constructor(names: ToolNames, options: ChatStreamOptions = {}) {
    this.#names = names;
    this.#signatures = options.signatures;
    this.responseId = options.responseId ?? `resp_wevir_${randomBytes(12).toString('hex')}`;
  }

  /** 上游回了 2xx：先发 response.created。 */
  start(): ResponsesEvent[] {
    if (this.#started) return [];
    this.#started = true;
    return [
      {
        type: 'response.created',
        response: { id: this.responseId, object: 'response', status: 'in_progress', output: [] },
      },
    ];
  }

  /** 是否已经收到上游的结束标记（`[DONE]`）。 */
  get done(): boolean {
    return this.#done;
  }

  /** 是否已经发出终结事件（completed / incomplete / failed）。 */
  get ended(): boolean {
    return this.#ended;
  }

  /** 一条 SSE `data:`。返回要发给 Codex 的事件（可能为空）。 */
  data(data: string): ResponsesEvent[] {
    if (this.#ended) return [];
    const trimmed = data.trim();
    if (trimmed === '') return [];
    if (trimmed === '[DONE]') {
      this.#done = true;
      return [];
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      return this.fail({ message: `上游的流里有不是 JSON 的数据：${trimmed.slice(0, 300)}` });
    }
    return this.chunk(chunk);
  }

  /** 一个已解析的 chunk（`chat.completion.chunk`，或上游无视 stream 时的整个 `chat.completion`）。 */
  chunk(chunk: unknown): ResponsesEvent[] {
    if (this.#ended || !isObject(chunk)) return [];
    const events = this.start();
    const error = streamError(chunk);
    if (error !== undefined) return [...events, ...this.fail(error)];
    if (isObject(chunk.usage)) this.#usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isObject(choice)) return events;
    // 流式是 delta，整个响应是 message；两者字段相同。
    const delta = isObject(choice.delta)
      ? choice.delta
      : isObject(choice.message)
        ? choice.message
        : {};
    const reasoning = textField(delta.reasoning_content) ?? textField(delta.reasoning);
    if (reasoning !== undefined) events.push(...this.#reasoningDelta(reasoning));
    const content = textField(delta.content);
    if (content !== undefined) events.push(...this.#textDelta(content));
    if (Array.isArray(delta.tool_calls)) {
      events.push(...this.#closeReasoning(), ...this.#closeMessage());
      for (const part of delta.tool_calls as unknown[])
        if (isObject(part)) this.#toolCallDelta(part);
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      this.#finishReason = choice.finish_reason;
    }
    return events;
  }

  /** 上游无视 stream 回了整个 `chat.completion`：字段与 chunk 相同，按一个 chunk 处理。 */
  whole(body: unknown): ResponsesEvent[] {
    return this.chunk(body);
  }

  /**
   * 上游的流结束了（`[DONE]` 或连接正常关闭）。收到过 finish_reason 或 `[DONE]` 时按 finish_reason 收尾；
   * 两者都没有就是提前断开，按 response.failed 处理。
   */
  finish(): ResponsesEvent[] {
    if (this.#ended) return [];
    if (this.#finishReason === undefined && !this.#done) {
      return this.fail({ message: '上游的流在结束前断开（没有 finish_reason，也没有 [DONE]）' });
    }
    const events = [...this.start(), ...this.#closeReasoning(), ...this.#closeMessage()];
    const reason = this.#finishReason;
    if (reason === 'length' || reason === 'content_filter') {
      // 截断的工具调用参数多半不完整，不交给 Codex 执行；已经出来的文本与推理照常提交。
      this.#ended = true;
      events.push({
        type: 'response.incomplete',
        response: {
          ...this.#responseBody('incomplete'),
          incomplete_details: {
            reason: reason === 'length' ? 'max_output_tokens' : 'content_filter',
          },
        },
      });
      return events;
    }
    const calls = [...this.#calls]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        ...call,
        id: call.id === '' ? `call_${randomBytes(8).toString('hex')}` : call.id,
      }));
    const signed = calls.filter((call) => call.signature !== undefined);
    if (this.#signatures !== undefined && signed.length > 0) {
      events.push(
        this.#itemDone({
          type: 'reasoning',
          id: `rs_${this.responseId}_${this.#outputIndex}`,
          summary: [],
          encrypted_content: encodeGeminiSignatures({
            ...this.#signatures,
            signatures: Object.fromEntries(signed.map((call) => [call.id, call.signature ?? ''])),
          }),
        }),
      );
    }
    for (const call of calls) {
      const item = restoreToolCall(this.#names, {
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      events.push(this.#itemDone(item));
    }
    this.#ended = true;
    events.push({ type: 'response.completed', response: this.#responseBody('completed') });
    return events;
  }

  /** 上游出错：发 response.failed，带上游原文。已经开了的项不再提交（Codex 会按自己的策略重试或失败）。 */
  fail(error: UpstreamFailure): ResponsesEvent[] {
    if (this.#ended) return [];
    this.#ended = true;
    return [
      ...this.start(),
      {
        type: 'response.failed',
        response: {
          id: this.responseId,
          object: 'response',
          status: 'failed',
          error: { code: error.code ?? 'upstream_error', message: error.message },
        },
      },
    ];
  }

  #reasoningDelta(delta: string): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];
    if (this.#reasoning === undefined) {
      events.push(...this.#closeMessage());
      this.#reasoning = {
        id: `rs_${this.responseId}_${this.#outputIndex}`,
        outputIndex: this.#outputIndex,
        text: '',
      };
      this.#outputIndex += 1;
      events.push({
        type: 'response.output_item.added',
        output_index: this.#reasoning.outputIndex,
        item: { type: 'reasoning', id: this.#reasoning.id, summary: [] },
      });
    }
    this.#reasoning.text += delta;
    events.push({
      type: 'response.reasoning_text.delta',
      item_id: this.#reasoning.id,
      output_index: this.#reasoning.outputIndex,
      content_index: 0,
      delta,
    });
    return events;
  }

  #textDelta(delta: string): ResponsesEvent[] {
    const events = this.#closeReasoning();
    if (this.#message === undefined) {
      this.#message = {
        id: `msg_${this.responseId}_${this.#outputIndex}`,
        outputIndex: this.#outputIndex,
        text: '',
      };
      this.#outputIndex += 1;
      events.push({
        type: 'response.output_item.added',
        output_index: this.#message.outputIndex,
        item: { type: 'message', role: 'assistant', id: this.#message.id, content: [] },
      });
    }
    this.#message.text += delta;
    events.push({
      type: 'response.output_text.delta',
      item_id: this.#message.id,
      output_index: this.#message.outputIndex,
      content_index: 0,
      delta,
    });
    return events;
  }

  /**
   * 工具调用的一个分片。名字通常只在第一片，有的上游每片都重复，所以相同的名字不重复拼接。
   */
  #toolCallDelta(part: JsonObject): void {
    const id = typeof part.id === 'string' && part.id !== '' ? part.id : undefined;
    const index = this.#slotFor(part, id);
    const call = this.#calls.get(index) ?? { id: '', name: '', arguments: '' };
    if (id !== undefined && call.id === '') call.id = id;
    const fn = isObject(part.function) ? part.function : {};
    if (typeof fn.name === 'string' && fn.name !== '' && fn.name !== call.name)
      call.name += fn.name;
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
    else if (isObject(fn.arguments)) call.arguments += JSON.stringify(fn.arguments);
    const google = isObject(part.extra_content) ? part.extra_content.google : undefined;
    if (isObject(google) && typeof google.thought_signature === 'string') {
      call.signature = google.thought_signature;
    }
    this.#calls.set(index, call);
    this.#lastCallIndex = index;
  }

  /**
   * 分片归哪个调用：按 `index`（并行调用的分片可以交错到达）。带 `id` 的先按 `id` 找；同一个 `index` 来了另一个
   * `id`（有的上游每个调用都用 index 0）就另开一个。既没有 `index` 也没有 `id` 的接到上一个调用上。
   */
  #slotFor(part: JsonObject, id: string | undefined): number {
    const given = typeof part.index === 'number' ? part.index : undefined;
    if (id !== undefined) {
      for (const [index, call] of this.#calls) if (call.id === id) return index;
      if (given !== undefined) {
        const existing = this.#calls.get(given);
        if (existing === undefined || existing.id === '') return given;
      }
      return this.#nextIndex();
    }
    return given ?? this.#lastCallIndex ?? this.#nextIndex();
  }

  #nextIndex(): number {
    return this.#calls.size === 0 ? 0 : Math.max(...this.#calls.keys()) + 1;
  }

  #closeReasoning(): ResponsesEvent[] {
    const open = this.#reasoning;
    if (open === undefined) return [];
    this.#reasoning = undefined;
    return [
      this.#itemDone(
        {
          type: 'reasoning',
          id: open.id,
          summary: [],
          content: [{ type: 'reasoning_text', text: open.text }],
          // Codex 带回 reasoning 项时 content 与 encrypted_content 都可能只剩一个，两处都放全文。
          encrypted_content: encodeReasoning(open.text),
        },
        open.outputIndex,
      ),
    ];
  }

  #closeMessage(): ResponsesEvent[] {
    const open = this.#message;
    if (open === undefined) return [];
    this.#message = undefined;
    return [
      this.#itemDone(
        {
          type: 'message',
          role: 'assistant',
          id: open.id,
          content: [{ type: 'output_text', text: open.text }],
        },
        open.outputIndex,
      ),
    ];
  }

  #itemDone(item: ResponsesItem, outputIndex?: number): ResponsesEvent {
    let index = outputIndex;
    if (index === undefined) {
      index = this.#outputIndex;
      this.#outputIndex += 1;
    }
    this.#output.push(item);
    return { type: 'response.output_item.done', output_index: index, item };
  }

  #responseBody(status: 'completed' | 'incomplete'): JsonObject {
    const usage = toResponsesUsage(this.#usage);
    return {
      id: this.responseId,
      object: 'response',
      status,
      output: this.#output,
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

/** Chat 的 usage → Responses 的 usage；缓存命中取 `prompt_tokens_details.cached_tokens`，没有时取 DeepSeek 的 `prompt_cache_hit_tokens`。 */
export function toResponsesUsage(usage: JsonObject | undefined): JsonObject | undefined {
  if (usage === undefined) return undefined;
  const input = numberOf(usage.prompt_tokens);
  const output = numberOf(usage.completion_tokens);
  const prompt = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completion = isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: numberOf(prompt.cached_tokens ?? usage.prompt_cache_hit_tokens),
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: numberOf(completion.reasoning_tokens) },
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output,
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 流里的错误：OpenAI 风格 `{error: {message, code}}`，或 `{error: "…"}`。 */
function streamError(chunk: JsonObject): UpstreamFailure | undefined {
  const error = chunk.error;
  if (typeof error === 'string') return { message: error };
  if (!isObject(error)) return undefined;
  const message =
    typeof error.message === 'string' && error.message !== ''
      ? error.message
      : JSON.stringify(error);
  const code =
    typeof error.code === 'string'
      ? error.code
      : typeof error.type === 'string'
        ? error.type
        : undefined;
  return { message, ...(code === undefined ? {} : { code }) };
}
