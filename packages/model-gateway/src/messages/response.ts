// Anthropic Messages 的流式响应 → Responses 的流事件。映射表见 docs/architecture/model-gateway.md §5.2。
//
// Messages 的流按内容块组织：message_start → 每块 content_block_start / delta / stop → message_delta（stop_reason、
// 累计的 usage）→ message_stop，中间可能有 ping 与 error（Anthropic 的流式文档）。事件的形状以 Codex 的解析为准
// （upstream/codex/codex-rs/codex-api/src/sse/responses.rs），与 Chat 转换相同：历史与工具调用只取
// output_item.done；增量之前要有同一 item_id 的 output_item.added；response.completed 要有字符串 response.id。

import { randomBytes } from 'node:crypto';
import type { UpstreamFailure } from '../chat/response.js';
import { isObject, restoreToolCall, type ToolNames } from '../tools.js';
import type { JsonObject, ResponsesEvent, ResponsesItem } from '../types.js';
import { encodeThinking, type ThinkingEnvelope } from './request.js';

/** 上游的流不是 Messages 的格式（多半是协议选错了）：testProvider 据此归为 protocol。 */
export const UPSTREAM_PROTOCOL_ERROR = 'upstream_protocol_error';

interface OpenItem {
  id: string;
  outputIndex: number;
  text: string;
}

type Block =
  | { kind: 'text' }
  | { kind: 'thinking'; item: OpenItem; signature: string; closed: boolean }
  | { kind: 'redacted'; data: string; closed: boolean }
  | { kind: 'tool'; call: PendingCall }
  | { kind: 'other' };

interface PendingCall {
  id: string;
  name: string;
  /** input_json_delta 拼起来的参数；一片都没有时用 content_block_start 里的 input。 */
  json: string;
  input: unknown;
}

/** 产生思考块的 Provider 与模型，写进 encrypted_content，下次请求据此决定能不能带回签名。 */
export interface ThinkingOrigin {
  provider: string;
  model: string;
}

export class MessagesStreamTranslator {
  readonly responseId: string;
  readonly #names: ToolNames;
  readonly #origin: ThinkingOrigin;
  #outputIndex = 0;
  readonly #blocks = new Map<number, Block>();
  /** 当前开着的 message 项：相邻的 text 块（例如带引用时被拆开的）并进同一项。 */
  #message: OpenItem | undefined;
  readonly #calls: PendingCall[] = [];
  readonly #output: ResponsesItem[] = [];
  #usage: JsonObject | undefined;
  #stopReason: string | undefined;
  #done = false;
  #started = false;
  #ended = false;

  constructor(
    names: ToolNames,
    origin: ThinkingOrigin,
    responseId = `resp_wevir_${randomBytes(12).toString('hex')}`,
  ) {
    this.#names = names;
    this.#origin = origin;
    this.responseId = responseId;
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

  /** 是否已经收到 message_stop。 */
  get done(): boolean {
    return this.#done;
  }

  /** 是否已经发出终结事件（completed / incomplete / failed）。 */
  get ended(): boolean {
    return this.#ended;
  }

  /** 一条 SSE `data:`（事件名与 data 里的 `type` 相同，只看后者）。返回要发给 Codex 的事件（可能为空）。 */
  data(data: string): ResponsesEvent[] {
    if (this.#ended) return [];
    const trimmed = data.trim();
    if (trimmed === '') return [];
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return this.fail({ message: `上游的流里有不是 JSON 的数据：${trimmed.slice(0, 300)}` });
    }
    return this.event(event);
  }

  /** 一个已解析的流事件。 */
  event(event: unknown): ResponsesEvent[] {
    if (this.#ended) return [];
    const events = this.start();
    if (!isObject(event) || typeof event.type !== 'string') {
      return [
        ...events,
        ...this.fail({
          code: UPSTREAM_PROTOCOL_ERROR,
          message: `上游的流不是 Anthropic Messages 的格式：${JSON.stringify(event).slice(0, 300)}`,
        }),
      ];
    }
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start':
        if (isObject(event.message)) this.#addUsage(event.message.usage);
        break;
      case 'content_block_start':
        if (isObject(event.content_block))
          events.push(...this.#blockStart(index, event.content_block));
        break;
      case 'content_block_delta':
        if (isObject(event.delta)) events.push(...this.#blockDelta(index, event.delta));
        break;
      case 'content_block_stop':
        events.push(...this.#blockStop(index));
        break;
      case 'message_delta':
        if (isObject(event.delta) && typeof event.delta.stop_reason === 'string') {
          this.#stopReason = event.delta.stop_reason;
        }
        this.#addUsage(event.usage);
        break;
      case 'message_stop':
        this.#done = true;
        break;
      case 'error':
        return [...events, ...this.fail(streamError(event))];
      default:
        // ping，以及 Anthropic 以后新加的事件（版本策略要求客户端忽略不认识的事件）。
        break;
    }
    return events;
  }

  /** 上游无视 `stream` 回了整个 Message（或错误对象）：拆成与流相同的事件再处理。 */
  whole(message: unknown): ResponsesEvent[] {
    if (!isObject(message) || message.type === 'error' || isObject(message.error)) {
      return [...this.start(), ...this.fail(streamError(isObject(message) ? message : {}))];
    }
    const events = this.event({
      type: 'message_start',
      message: { ...message, content: [] },
    });
    const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    content.forEach((block, index) => {
      if (!isObject(block)) return;
      const empty =
        block.type === 'text'
          ? { ...block, text: '' }
          : block.type === 'thinking'
            ? { ...block, thinking: '', signature: '' }
            : block.type === 'tool_use'
              ? { ...block, input: {} }
              : block;
      events.push(...this.event({ type: 'content_block_start', index, content_block: empty }));
      const delta =
        block.type === 'text'
          ? [{ type: 'text_delta', text: block.text }]
          : block.type === 'thinking'
            ? [
                { type: 'thinking_delta', thinking: block.thinking },
                { type: 'signature_delta', signature: block.signature },
              ]
            : block.type === 'tool_use'
              ? [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }]
              : [];
      for (const d of delta)
        events.push(...this.event({ type: 'content_block_delta', index, delta: d }));
      events.push(...this.event({ type: 'content_block_stop', index }));
    });
    events.push(
      ...this.event({
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason },
        usage: message.usage,
      }),
      ...this.event({ type: 'message_stop' }),
    );
    return events;
  }

  /**
   * 上游的流结束了。收到过 message_stop 或 stop_reason 时按 stop_reason 收尾；两者都没有就是提前断开，按
   * response.failed 处理。
   */
  finish(): ResponsesEvent[] {
    if (this.#ended) return [];
    if (!this.#done && this.#stopReason === undefined) {
      return this.fail({ message: '上游的流在结束前断开（没有 message_stop）' });
    }
    const events = [...this.start(), ...this.#closeMessage()];
    for (const index of [...this.#blocks.keys()].sort((a, b) => a - b)) {
      events.push(...this.#blockStop(index));
    }
    const reason = this.#stopReason;
    if (reason === 'max_tokens' || reason === 'refusal') {
      // 截断的工具调用参数多半不完整，不交给 Codex 执行；已经出来的文本与思考照常提交。
      this.#ended = true;
      events.push({
        type: 'response.incomplete',
        response: {
          ...this.#responseBody('incomplete'),
          incomplete_details: {
            reason: reason === 'max_tokens' ? 'max_output_tokens' : 'content_filter',
          },
        },
      });
      return events;
    }
    if (reason === 'model_context_window_exceeded') {
      // Codex 认 context_length_exceeded（ContextWindowExceeded，不重试）。
      return [
        ...events,
        ...this.fail({ code: 'context_length_exceeded', message: '上游报告上下文窗口已满' }),
      ];
    }
    for (const call of this.#calls) {
      events.push(
        this.#itemDone(
          restoreToolCall(this.#names, {
            callId: call.id === '' ? `call_${randomBytes(8).toString('hex')}` : call.id,
            name: call.name,
            arguments: call.json === '' ? JSON.stringify(call.input ?? {}) : call.json,
          }),
        ),
      );
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

  #blockStart(index: number, block: JsonObject): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];
    if (block.type !== 'text') events.push(...this.#closeMessage());
    switch (block.type) {
      case 'text': {
        this.#blocks.set(index, { kind: 'text' });
        if (typeof block.text === 'string' && block.text !== '')
          events.push(...this.#textDelta(block.text));
        break;
      }
      case 'thinking': {
        const item = {
          id: `rs_${this.responseId}_${this.#outputIndex}`,
          outputIndex: this.#outputIndex,
          text: '',
        };
        this.#outputIndex += 1;
        this.#blocks.set(index, {
          kind: 'thinking',
          item,
          signature: typeof block.signature === 'string' ? block.signature : '',
          closed: false,
        });
        events.push({
          type: 'response.output_item.added',
          output_index: item.outputIndex,
          item: { type: 'reasoning', id: item.id, summary: [] },
        });
        if (typeof block.thinking === 'string' && block.thinking !== '')
          events.push(...this.#thinkingDelta(index, block.thinking));
        break;
      }
      case 'redacted_thinking':
        this.#blocks.set(index, {
          kind: 'redacted',
          data: typeof block.data === 'string' ? block.data : '',
          closed: false,
        });
        break;
      case 'tool_use': {
        const call: PendingCall = {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          json: '',
          input: block.input,
        };
        this.#calls.push(call);
        this.#blocks.set(index, { kind: 'tool', call });
        break;
      }
      default:
        // server_tool_use 等：网关不声明服务端工具，正常不会出现，忽略。
        this.#blocks.set(index, { kind: 'other' });
    }
    return events;
  }

  #blockDelta(index: number, delta: JsonObject): ResponsesEvent[] {
    const block = this.#blocks.get(index);
    if (block === undefined) return [];
    if (delta.type === 'text_delta' && block.kind === 'text') {
      return typeof delta.text === 'string' && delta.text !== '' ? this.#textDelta(delta.text) : [];
    }
    if (delta.type === 'thinking_delta' && block.kind === 'thinking') {
      return typeof delta.thinking === 'string' && delta.thinking !== ''
        ? this.#thinkingDelta(index, delta.thinking)
        : [];
    }
    if (delta.type === 'signature_delta' && block.kind === 'thinking') {
      if (typeof delta.signature === 'string') block.signature += delta.signature;
    } else if (delta.type === 'input_json_delta' && block.kind === 'tool') {
      if (typeof delta.partial_json === 'string') block.call.json += delta.partial_json;
    }
    // citations_delta 等不影响 Codex 看到的内容。
    return [];
  }

  #blockStop(index: number): ResponsesEvent[] {
    const block = this.#blocks.get(index);
    if (block === undefined) return [];
    if (block.kind === 'thinking' && !block.closed) {
      block.closed = true;
      const { item } = block;
      const envelope: ThinkingEnvelope = {
        ...this.#origin,
        type: 'thinking',
        thinking: item.text,
        ...(block.signature === '' ? {} : { signature: block.signature }),
      };
      return [
        this.#itemDone(
          {
            type: 'reasoning',
            id: item.id,
            summary: [],
            ...(item.text === '' ? {} : { content: [{ type: 'reasoning_text', text: item.text }] }),
            // 思考文本与签名原样存在这里，Codex 带回时网关据此还原思考块（request.ts）。
            encrypted_content: encodeThinking(envelope),
          },
          item.outputIndex,
        ),
      ];
    }
    if (block.kind === 'redacted' && !block.closed) {
      block.closed = true;
      return [
        this.#itemDone({
          type: 'reasoning',
          id: `rs_${this.responseId}_${this.#outputIndex}`,
          summary: [],
          encrypted_content: encodeThinking({
            ...this.#origin,
            type: 'redacted_thinking',
            data: block.data,
          }),
        }),
      ];
    }
    return [];
  }

  #thinkingDelta(index: number, delta: string): ResponsesEvent[] {
    const block = this.#blocks.get(index);
    if (block?.kind !== 'thinking') return [];
    block.item.text += delta;
    return [
      {
        type: 'response.reasoning_text.delta',
        item_id: block.item.id,
        output_index: block.item.outputIndex,
        content_index: 0,
        delta,
      },
    ];
  }

  #textDelta(delta: string): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];
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

  /** message_start 与 message_delta 的 usage：后者是累计值，按字段覆盖前者。 */
  #addUsage(usage: unknown): void {
    if (!isObject(usage)) return;
    this.#usage = { ...this.#usage, ...usage };
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

/**
 * Messages 的 usage → Responses 的 usage。Anthropic 的 `input_tokens` 不含缓存命中与写入，Codex 的 `input_tokens`
 * 是全部输入（它用 `input_tokens - cached_tokens` 算未命中的部分），所以三者相加；缓存写入放进 Codex 认的
 * `input_tokens_details.cache_write_tokens`；思考的 token 取 `output_tokens_details.thinking_tokens`（有才有）。
 */
export function toResponsesUsage(usage: JsonObject | undefined): JsonObject | undefined {
  if (usage === undefined) return undefined;
  const read = numberOf(usage.cache_read_input_tokens);
  const write = numberOf(usage.cache_creation_input_tokens);
  const input = numberOf(usage.input_tokens) + read + write;
  const output = numberOf(usage.output_tokens);
  const details = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: numberOf(details.thinking_tokens) },
    total_tokens: input + output,
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 流里的 `{"type": "error", "error": {"type", "message"}}`：code 用 Anthropic 的错误类型（overloaded_error 等）。 */
function streamError(event: JsonObject): UpstreamFailure {
  const error = isObject(event.error) ? event.error : {};
  const message =
    typeof error.message === 'string' && error.message !== ''
      ? error.message
      : JSON.stringify(event).slice(0, 300);
  return { message, ...(typeof error.type === 'string' ? { code: error.type } : {}) };
}
