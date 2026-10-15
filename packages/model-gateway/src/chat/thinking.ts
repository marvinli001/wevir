// Chat 思考参数、结构化推理回传与 MiniMax 的正文思考标签。参数依据与取舍见 model-gateway.md §4.4。

import { isDeepSeekHost } from '../providers.js';
import { isObject } from '../tools.js';
import type { GatewayProvider, JsonObject } from '../types.js';

export const CHAT_THINKING_FORMATS = [
  'openai',
  'deepseek',
  'qwen',
  'zai',
  'minimax',
  'tencent',
] as const;
export type ChatThinkingFormat = (typeof CHAT_THINKING_FORMATS)[number];

export interface ChatThinkingOrigin {
  provider: string;
  model: string;
  format: ChatThinkingFormat;
}

export interface ChatReplay extends ChatThinkingOrigin {
  reasoning_details?: JsonObject[];
  /** MiniMax 实际返回的原始 content，含标签与前导空白；显示文本另行拆开。 */
  content?: string;
}

const REPLAY_PREFIX = 'wevir-gw:chat:v1:';
const BUDGETS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
};
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 显式格式优先；仅 DeepSeek 保留已有的地址识别，不为其他服务或订阅端点增加默认值。 */
export function chatThinkingFormat(provider: GatewayProvider): ChatThinkingFormat | undefined {
  const declared = provider.compat?.thinkingFormat;
  if (declared !== undefined) {
    return (CHAT_THINKING_FORMATS as readonly string[]).includes(declared)
      ? (declared as ChatThinkingFormat)
      : undefined;
  }
  return isDeepSeekHost(provider.baseURL ?? '') ? 'deepseek' : undefined;
}

export function requiresReasoning(provider: GatewayProvider, model: string): boolean {
  return (
    provider.compat?.requiresReasoningContentOnAssistantMessages ??
    (['deepseek', 'zai', 'minimax', 'tencent'].includes(chatThinkingFormat(provider) ?? '') ||
      isKimi(model) ||
      isDeepSeekHost(provider.baseURL ?? ''))
  );
}

/** 只修改思考参数，工具选择仍由 compat.toolChoice 控制。 */
export function chatThinkingParameters(
  provider: GatewayProvider,
  model: string,
  requested: unknown,
): JsonObject {
  const format = chatThinkingFormat(provider);
  if (provider.kind === 'google-vertex' && provider.compat?.thinkingFormat === undefined) {
    if (typeof requested !== 'string' || requested === '') return {};
    const noMinimal = /^google\/gemini-3\.8-flash(?:$|-)/.test(model);
    const effort =
      requested === 'none'
        ? noMinimal
          ? 'low'
          : 'minimal'
        : requested === 'minimal' && noMinimal
          ? 'low'
          : requested === 'xhigh' || requested === 'max'
            ? 'high'
            : requested;
    return { reasoning_effort: effort };
  }
  const params: JsonObject = format === 'minimax' ? { reasoning_split: true } : {};
  if (typeof requested !== 'string' || requested === '') return params;
  // 未设或尚未实现的格式保持旧行为，已有 Provider 不因新增方言而迁移。
  if (format === undefined) return requested === 'none' ? params : { reasoning_effort: requested };
  const effort = effectiveEffort(provider, model, format, requested);
  const enabled = effort !== 'none';
  const modelId = model.toLowerCase();

  if ((format === 'openai' || format === 'deepseek' || format === 'qwen') && isKimi(model)) {
    if (modelId.startsWith('kimi-k3')) return { reasoning_effort: threeLevels(effort) };
    if (modelId.startsWith('kimi-k2.7-code')) {
      // 官方指南要求不传 thinking；没有 effort，保留式思考也始终开启。
      return {};
    }
    if (format === 'deepseek') {
      return { thinking: enabled ? { type: 'enabled', keep: 'all' } : { type: 'disabled' } };
    }
  }
  switch (format) {
    case 'openai':
      return {
        reasoning_effort: modelId.startsWith('step-') ? stepEffort(modelId, effort) : effort,
      };
    case 'deepseek':
      return {
        thinking: { type: enabled ? 'enabled' : 'disabled' },
        ...(enabled && { reasoning_effort: threeLevels(effort) }),
      };
    case 'qwen':
      return {
        enable_thinking: enabled,
        ...(enabled && {
          preserve_thinking: true,
          thinking_budget: BUDGETS[effort] ?? BUDGETS.high,
        }),
      };
    case 'zai':
      return {
        thinking: enabled ? { type: 'enabled', clear_thinking: false } : { type: 'disabled' },
        ...(enabled && { reasoning_effort: isForcedGlm(model) ? threeLevels(effort) : effort }),
      };
    case 'minimax':
      if (modelId.startsWith('minimax-m2') && requested === 'none') return params;
      return {
        ...params,
        thinking: { type: enabled ? 'adaptive' : 'disabled' },
        ...(modelId.startsWith('minimax-m3.1') && {
          reasoning_effort: effort === 'minimal' ? 'low' : effort,
        }),
      };
    case 'tencent':
      if (modelId.startsWith('kimi-k2.7-code') && requested === 'none') return {};
      return {
        thinking: { type: enabled ? 'enabled' : 'disabled' },
        ...(enabled && {
          reasoning_effort:
            effort === 'minimal' ? 'low' : ['xhigh', 'max'].includes(effort) ? 'high' : effort,
        }),
      };
  }
}

function effectiveEffort(
  provider: GatewayProvider,
  model: string,
  format: ChatThinkingFormat,
  effort: string,
): string {
  if (effort !== 'none') return effort;
  const id = model.toLowerCase();
  if (
    ((format === 'zai' || format === 'tencent') && isForcedGlm(model)) ||
    ((format === 'openai' || format === 'deepseek' || format === 'qwen' || format === 'tencent') &&
      id.startsWith('kimi-k3')) ||
    (format === 'minimax' && id.startsWith('minimax-m3.1')) ||
    (format === 'openai' && id.startsWith('step-'))
  )
    return 'low';
  const levels = provider.models.find((entry) => entry.id === model)?.reasoningEfforts;
  if (levels !== undefined && levels.length > 0 && !levels.includes('off')) {
    return LEVELS.find((level) => levels.includes(level)) ?? effort;
  }
  return effort;
}

function isKimi(model: string): boolean {
  return /^kimi-k(?:3(?:$|[-.])|2\.(?:6|7)(?:$|[-.]))/i.test(model);
}

function isForcedGlm(model: string): boolean {
  return /^glm-5\.3(?:$|-)/i.test(model);
}

function threeLevels(effort: string): string {
  if (effort === 'minimal') return 'low';
  return effort === 'medium' || effort === 'xhigh' ? 'high' : effort;
}

function stepEffort(model: string, effort: string): string {
  if (effort === 'minimal') return 'low';
  if (
    effort === 'xhigh' ||
    effort === 'max' ||
    (model === 'step-3.5-flash-2603' && effort === 'medium')
  )
    return 'high';
  return effort;
}

/** 同一个 chunk 的字段是别名，不重复相加；签名 / 加密块只用于回传，不当文本显示。 */
export function reasoningText(delta: JsonObject): string {
  for (const value of [delta.reasoning_content, delta.reasoning]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  if (!Array.isArray(delta.reasoning_details)) return '';
  return delta.reasoning_details
    .map((detail: unknown) => {
      if (!isObject(detail)) return '';
      return typeof detail.text === 'string'
        ? detail.text
        : typeof detail.summary === 'string'
          ? detail.summary
          : '';
    })
    .join('');
}

/** 文本 / summary 的连续分片并成逻辑块；签名等不透明块保持原样，未知字段保留。 */
export function appendReasoningDetails(target: JsonObject[], details: unknown): void {
  if (!Array.isArray(details)) return;
  for (const detail of details as unknown[]) {
    if (!isObject(detail)) continue;
    const last = target.at(-1);
    const field =
      typeof detail.text === 'string'
        ? 'text'
        : typeof detail.summary === 'string'
          ? 'summary'
          : undefined;
    if (
      field !== undefined &&
      last !== undefined &&
      typeof last[field] === 'string' &&
      ['type', 'id', 'index', 'format'].every((key) => last[key] === detail[key])
    ) {
      const text = String(last[field]) + String(detail[field]);
      Object.assign(last, structuredClone(detail), { [field]: text });
    } else target.push(structuredClone(detail));
  }
}

export function encodeChatReplay(replay: ChatReplay): string {
  return REPLAY_PREFIX + Buffer.from(JSON.stringify(replay), 'utf8').toString('base64');
}

export function decodeChatReplay(value: unknown): ChatReplay | undefined {
  if (typeof value !== 'string' || !value.startsWith(REPLAY_PREFIX)) return;
  try {
    const replay: unknown = JSON.parse(
      Buffer.from(value.slice(REPLAY_PREFIX.length), 'base64').toString('utf8'),
    );
    if (
      !isObject(replay) ||
      typeof replay.provider !== 'string' ||
      typeof replay.model !== 'string' ||
      !(CHAT_THINKING_FORMATS as readonly unknown[]).includes(replay.format) ||
      (replay.content !== undefined && typeof replay.content !== 'string') ||
      (replay.reasoning_details !== undefined &&
        (!Array.isArray(replay.reasoning_details) || !replay.reasoning_details.every(isObject)))
    )
      return;
    return replay as unknown as ChatReplay;
  } catch {
    return;
  }
}

export interface ThinkingPart {
  kind: 'reasoning' | 'text';
  text: string;
}

/** 只拆 MiniMax 返回的前缀思考块；回答里提到的字面标签保持原样。 */
export class ThinkPrefixParser {
  #state: 'prefix' | 'reasoning' | 'text' = 'prefix';
  #pending = '';
  raw = '';
  tagged = false;

  push(text: string): ThinkingPart[] {
    this.raw += text;
    this.#pending += text;
    const parts: ThinkingPart[] = [];
    if (this.#state === 'prefix') {
      const start = this.#pending.trimStart();
      if (start === '' || ('<think>'.startsWith(start) && start !== '<think>')) return parts;
      if (start.startsWith('<think>')) {
        this.#pending = start.slice('<think>'.length);
        this.#state = 'reasoning';
        this.tagged = true;
      } else this.#state = 'text';
    }
    if (this.#state === 'reasoning') {
      const end = this.#pending.indexOf('</think>');
      if (end >= 0) {
        parts.push({ kind: 'reasoning', text: this.#pending.slice(0, end) });
        this.#pending = this.#pending.slice(end + '</think>'.length);
        this.#state = 'text';
      } else {
        let held = 0;
        for (let size = 1; size < '</think>'.length; size += 1) {
          if (this.#pending.endsWith('</think>'.slice(0, size))) held = size;
        }
        const emit = this.#pending.length - held;
        parts.push({ kind: 'reasoning', text: this.#pending.slice(0, emit) });
        this.#pending = this.#pending.slice(emit);
      }
    }
    if (this.#state === 'text') {
      parts.push({ kind: 'text', text: this.#pending });
      this.#pending = '';
    }
    return parts.filter((part) => part.text !== '');
  }

  finish(): ThinkingPart[] {
    const text = this.#pending;
    this.#pending = '';
    return text === '' ? [] : [{ kind: this.#state === 'reasoning' ? 'reasoning' : 'text', text }];
  }
}
