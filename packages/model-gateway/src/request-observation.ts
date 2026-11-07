import type { IncomingHttpHeaders } from 'node:http';
import type { RequestSupply } from './request-stats.js';
import { type SseMessage, SseParser } from './sse.js';
import { isObject } from './tools.js';
import type { ResponsesRequest } from './types.js';

export interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface RequestObservation {
  requestId: string;
  providerId: string;
  model: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  agentName?: string;
  kind: 'agent' | 'compaction' | 'subagent' | 'auxiliary';
  compactionTrigger?: 'manual' | 'auto';
  supply: RequestSupply;
  usage?: GatewayUsage;
  responseId?: string;
  outcome: 'completed' | 'upstream_error' | 'client_closed' | 'network_error' | 'auth_error';
  upstreamStatus?: number;
  durationMs: number;
  firstTokenMs?: number;
}

export function requestSource(
  body: ResponsesRequest,
  headers: IncomingHttpHeaders,
): Pick<
  RequestObservation,
  'threadId' | 'parentThreadId' | 'turnId' | 'agentName' | 'kind' | 'compactionTrigger'
> {
  const metadata = isObject(body.client_metadata) ? body.client_metadata : {};
  const encoded = metadata['x-codex-turn-metadata'] ?? headers['x-codex-turn-metadata'];
  let turn: Record<string, unknown> = {};
  if (typeof encoded === 'string') {
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (isObject(parsed)) turn = parsed;
    } catch {
      /* 非法的可选元数据不影响请求。 */
    }
  }
  const threadId = metadata.thread_id ?? turn.thread_id;
  const turnId = metadata.turn_id ?? turn.turn_id;
  const agentName = turn.agent_name;
  const requestKind = metadata.request_kind ?? turn.request_kind;
  const compaction = isObject(turn.compaction) ? turn.compaction : {};
  return {
    ...(typeof threadId === 'string' && { threadId }),
    ...(typeof turn.parent_thread_id === 'string' && { parentThreadId: turn.parent_thread_id }),
    ...(typeof turnId === 'string' && { turnId }),
    ...(typeof agentName === 'string' && { agentName }),
    kind:
      requestKind === 'compaction'
        ? 'compaction'
        : requestKind === 'auxiliary'
          ? 'auxiliary'
          : (typeof agentName === 'string' && agentName !== '/root') ||
              headers['x-openai-subagent'] !== undefined
            ? 'subagent'
            : requestKind === 'turn' || (body.tools?.length ?? 0) > 0
              ? 'agent'
              : 'auxiliary',
    ...((compaction.trigger === 'manual' || compaction.trigger === 'auto') && {
      compactionTrigger: compaction.trigger,
    }),
  };
}

export class ResponseObservation {
  readonly #parser = new SseParser();
  readonly #started: number;
  #json = '';
  json = false;
  usage: GatewayUsage | undefined;
  responseId: string | undefined;
  firstTokenMs: number | undefined;

  constructor(started: number) {
    this.#started = started;
  }

  push(piece: Uint8Array | string): void {
    if (this.json) {
      this.#json += typeof piece === 'string' ? piece : Buffer.from(piece).toString('utf8');
      return;
    }
    for (const event of this.#parser.push(piece)) this.#readEvent(event);
  }

  end(): void {
    if (this.json) this.#read(this.#json);
    else for (const event of this.#parser.end()) this.#readEvent(event);
  }

  #readEvent(event: SseMessage): void {
    if (event.event === undefined) {
      this.#read(event.data);
      return;
    }
    this.#firstToken(event.event);
    if (event.event === 'response.completed') this.#read(event.data);
  }

  #firstToken(type: unknown): void {
    if (
      typeof type === 'string' &&
      /^response\.(output_text|reasoning_text|function_call_arguments)\.delta$/.test(type)
    )
      this.firstTokenMs ??= Math.round(performance.now() - this.#started);
  }

  #read(data: string): void {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(value)) return;
    this.observe(value);
  }

  observe(value: Record<string, unknown>): void {
    this.#firstToken(value.type);
    const response = isObject(value.response) ? value.response : value;
    if (value.type !== undefined && value.type !== 'response.completed') return;
    const usage = response.usage;
    if (!isObject(usage) || !validCount(usage.input_tokens) || !validCount(usage.output_tokens))
      return;
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
    const cacheRead = Math.min(count(details.cached_tokens), input);
    const cacheWrite = Math.min(count(details.cache_write_tokens), input - cacheRead);
    this.usage = {
      inputTokens: input - cacheRead - cacheWrite,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      reasoningTokens: Math.min(count(outputDetails.reasoning_tokens), output),
    };
    if (typeof response.id === 'string') this.responseId = response.id;
  }
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function count(value: unknown): number {
  return validCount(value) ? value : 0;
}
