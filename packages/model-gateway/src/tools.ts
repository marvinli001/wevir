// 改写自 spikes/codex-app-server/src/gateway.ts（mapTools 与工具调用的还原）。
//
// 只支持函数工具的上游（Chat Completions，以及声明不支持自定义工具的 Responses 上游）看不到 Codex 的两类工具：
// - custom（apply_patch，Lark 语法）：摊平成只有一个字符串参数 `input` 的函数，语法全文写进描述；
// - namespace（multi_agent_v1）：Chat 没有命名空间，里面的工具摊平成 `<ns>__<name>`。
// 摊平后的名字要符合 OpenAI 函数名的规则（`^[A-Za-z0-9_-]{1,64}$`），超长或含非法字符时改成截断加哈希，
// 并在每个请求的 `ToolNames` 里登记，响应里按它还原成原来的工具类型、名字与命名空间。

import { createHash } from 'node:crypto';
import type { ChatTool, JsonObject, ResponsesItem, ResponsesTool } from './types.js';

export const NAMESPACE_SEPARATOR = '__';

/** OpenAI 函数名的规则；多数 Chat 兼容服务沿用。 */
const VALID_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FUNCTION_NAME = 64;
const HASH_LENGTH = 8;

export interface ToolOrigin {
  kind: 'function' | 'custom';
  name: string;
  namespace?: string;
}

/** 一个请求里“原工具 ↔ 发给上游的函数名”的双向登记。 */
export class ToolNames {
  readonly #byFlat = new Map<string, ToolOrigin>();
  readonly #byOrigin = new Map<string, string>();

  /** 原工具 → 上游的函数名。同一个原工具总得到同一个名字；不同的原工具不会撞名。 */
  flat(origin: ToolOrigin): string {
    const key = originKey(origin);
    const known = this.#byOrigin.get(key);
    if (known !== undefined) return known;
    let flat = flatToolName(origin.name, origin.namespace);
    if (this.#byFlat.has(flat)) flat = hashedName(joinName(origin.name, origin.namespace), key);
    for (let n = 2; this.#byFlat.has(flat); n += 1) {
      flat = hashedName(joinName(origin.name, origin.namespace), `${key}\u0000${n}`);
    }
    this.#byFlat.set(flat, { ...origin });
    this.#byOrigin.set(key, flat);
    return flat;
  }

  /** 上游的函数名 → 原工具；模型编了一个不存在的名字时为 undefined。 */
  origin(flat: string): ToolOrigin | undefined {
    return this.#byFlat.get(flat);
  }

  get size(): number {
    return this.#byFlat.size;
  }
}

function originKey(origin: ToolOrigin): string {
  return `${origin.namespace ?? ''}\u0000${origin.name}`;
}

function joinName(name: string, namespace?: string): string {
  return namespace === undefined ? name : `${namespace}${NAMESPACE_SEPARATOR}${name}`;
}

/**
 * 摊平后的函数名：合法就用 `<ns>__<name>`（或原名）；否则非法字符换成 `_`，截到 55 个字符，再接 `_` 与
 * 原名的 8 位哈希，总长不超过 64。确定性的：同一个原名每次都得到同一个结果，历史里的调用与本次的工具定义对得上。
 */
export function flatToolName(name: string, namespace?: string): string {
  const joined = joinName(name, namespace);
  if (VALID_FUNCTION_NAME.test(joined)) return joined;
  return hashedName(joined, joined);
}

function hashedName(joined: string, seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, HASH_LENGTH);
  const prefix = joined
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, MAX_FUNCTION_NAME - HASH_LENGTH - 1);
  return `${prefix}_${hash}`;
}

/** custom 工具摊平成函数后的参数：只有一个字符串 `input`。 */
export const CUSTOM_TOOL_PARAMETERS = {
  type: 'object',
  properties: { input: { type: 'string', description: 'Raw freeform input for the tool.' } },
  required: ['input'],
  additionalProperties: false,
} as const;

/** custom 工具摊平后的描述：原描述加输入格式；有语法时把语法全文写进去（模型按它写 apply_patch）。 */
export function customToolDescription(tool: ResponsesTool): string {
  const format = tool.format as { type?: string; syntax?: string; definition?: string } | undefined;
  const base = tool.description ?? '';
  const how =
    format?.type === 'grammar' && typeof format.definition === 'string'
      ? `Put the raw tool input in the \`input\` string. It must match this ${format.syntax ?? ''} grammar:\n${format.definition}`
      : 'Put the raw tool input in the `input` string.';
  return base === '' ? how : `${base}\n\n${how}`;
}

/**
 * Responses 的工具 → Chat 的函数工具。托管工具（web_search、image_generation 等）Chat 上游没有，丢掉并记进
 * `dropped`（`tool:<type>`）。
 */
export function toChatTools(
  tools: readonly ResponsesTool[] | undefined,
  names: ToolNames,
  dropped: string[],
): ChatTool[] {
  const out: ChatTool[] = [];
  const add = (tool: ResponsesTool, namespace?: string) => {
    const name = tool.name ?? '';
    if (tool.type === 'function') {
      out.push({
        type: 'function',
        function: {
          name: names.flat({ kind: 'function', name, namespace }),
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      });
    } else if (tool.type === 'custom') {
      out.push({
        type: 'function',
        function: {
          name: names.flat({ kind: 'custom', name, namespace }),
          description: customToolDescription(tool),
          parameters: CUSTOM_TOOL_PARAMETERS,
        },
      });
    } else {
      dropped.push(`tool:${tool.type}`);
    }
  };
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      for (const inner of (tool.tools as ResponsesTool[] | undefined) ?? []) add(inner, tool.name);
    } else {
      add(tool);
    }
  }
  return out;
}

/** 摊平的 custom 工具调用的参数：`{"input": …}`。 */
export function customCallArguments(input: unknown): string {
  return JSON.stringify({ input: typeof input === 'string' ? input : '' });
}

/** 从摊平的参数里取回 custom 工具的输入；模型没按 `{input}` 回时原样交给 Codex，由工具自己报错。 */
export function customCallInput(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (isObject(parsed) && typeof parsed.input === 'string') return parsed.input;
  } catch {
    // 不是 JSON：按自由文本处理。
  }
  return args;
}

/** 上游的一次函数调用 → Codex 认的输出项：按登记还原成 function_call（带 namespace）或 custom_tool_call。 */
export function restoreToolCall(
  names: ToolNames,
  call: { callId: string; name: string; arguments: string },
): ResponsesItem {
  const origin = names.origin(call.name);
  if (origin?.kind === 'custom') {
    return {
      type: 'custom_tool_call',
      call_id: call.callId,
      name: origin.name,
      ...(origin.namespace === undefined ? {} : { namespace: origin.namespace }),
      input: customCallInput(call.arguments),
    };
  }
  return {
    type: 'function_call',
    call_id: call.callId,
    name: origin?.name ?? call.name,
    ...(origin?.namespace === undefined ? {} : { namespace: origin.namespace }),
    arguments: call.arguments,
  };
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
