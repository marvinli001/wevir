// Responses 透传的方言修正（docs/architecture/model-gateway.md §3.2）：各家 Responses 实现与 OpenAI 的差异，
// 只在网关里改，不碰 Codex（codex-notes §5.3）。每条修正声明对哪些 Provider 生效，改请求体，必要时再改响应事件。

import {
  CUSTOM_TOOL_PARAMETERS,
  customCallArguments,
  customCallInput,
  customToolDescription,
  isObject,
} from './tools.js';
import type {
  GatewayProvider,
  ResponsesEvent,
  ResponsesItem,
  ResponsesRequest,
  ResponsesTool,
} from './types.js';

export type EventRewrite = (event: ResponsesEvent) => ResponsesEvent;

export interface DialectFix {
  /** 写进文档与测试的名字。 */
  id: string;
  applies(provider: GatewayProvider): boolean;
  /** 改请求体（返回新对象，不改传入的）；要改响应时一并返回改写函数。 */
  apply(body: ResponsesRequest): { body: ResponsesRequest; rewrite?: EventRewrite };
}

/**
 * 没有工具时去掉 `tool_choice`。Codex 的自动压缩发 `tools: []` 加 `tool_choice: "auto"`，xAI 对此报 400
 * （codex-notes §3.4）；没有工具时 `tool_choice` 本来就没有意义，所以对所有 Provider 生效。
 */
export const dropToolChoiceWithoutTools: DialectFix = {
  id: 'drop-tool-choice-without-tools',
  applies: () => true,
  apply(body) {
    if ((Array.isArray(body.tools) && body.tools.length > 0) || !('tool_choice' in body))
      return { body };
    const { tool_choice: _drop, ...rest } = body;
    return { body: rest as ResponsesRequest };
  },
};

/**
 * Provider 声明不支持自定义工具（`compat.supportsCustomTools: false`）时，把 custom 工具（apply_patch）按 Chat 转换的
 * 办法摊平成只有 `input` 参数的函数，历史里的 custom_tool_call / _output 也换成函数调用；响应里同名的
 * function_call 再还原成 custom_tool_call。namespace 不动（Responses 上游认命名空间），里面的 custom 工具同样摊平。
 */
export const flattenCustomTools: DialectFix = {
  id: 'flatten-custom-tools',
  applies: (provider) => provider.compat?.supportsCustomTools === false,
  apply(body) {
    const flattened = new Set<string>();
    const flatten = (tool: ResponsesTool, namespace?: string): ResponsesTool => {
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        return {
          ...tool,
          tools: (tool.tools as ResponsesTool[]).map((inner) => flatten(inner, tool.name)),
        };
      }
      if (tool.type !== 'custom') return tool;
      flattened.add(key(tool.name ?? '', namespace));
      return {
        type: 'function',
        name: tool.name,
        description: customToolDescription(tool),
        parameters: CUSTOM_TOOL_PARAMETERS,
        strict: false,
      };
    };
    const tools = body.tools?.map((tool) => flatten(tool));
    const input = Array.isArray(body.input) ? body.input.map(toFunctionItem) : body.input;
    const choice = body.tool_choice;
    const next: ResponsesRequest = {
      ...body,
      input,
      ...(tools === undefined ? {} : { tools }),
      ...(isObject(choice) && choice.type === 'custom'
        ? { tool_choice: { ...choice, type: 'function' } }
        : {}),
    };
    const restore = (item: unknown): unknown => {
      if (!isObject(item) || item.type !== 'function_call') return item;
      const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
      if (!flattened.has(key(String(item.name ?? ''), namespace))) return item;
      const { arguments: args, ...rest } = item;
      return {
        ...rest,
        type: 'custom_tool_call',
        input: customCallInput(typeof args === 'string' ? args : ''),
      };
    };
    const rewrite: EventRewrite = (event) => {
      if (
        event.type === 'response.output_item.added' ||
        event.type === 'response.output_item.done'
      ) {
        return { ...event, item: restore(event.item) };
      }
      if (isObject(event.response) && Array.isArray(event.response.output)) {
        return {
          ...event,
          response: { ...event.response, output: event.response.output.map(restore) },
        };
      }
      return event;
    };
    return { body: next, rewrite };
  },
};

/** 按顺序检查；新的修正加在这里，并在 model-gateway.md §3.2 的清单里登记。 */
export const RESPONSES_DIALECTS: readonly DialectFix[] = [
  dropToolChoiceWithoutTools,
  flattenCustomTools,
];

/** 对一个 Provider 套用全部适用的修正。`applied` 是生效的修正名（测试用）。 */
export function applyDialects(
  provider: GatewayProvider,
  body: ResponsesRequest,
  fixes: readonly DialectFix[] = RESPONSES_DIALECTS,
): { body: ResponsesRequest; rewrite?: EventRewrite; applied: string[] } {
  let current = body;
  const rewrites: EventRewrite[] = [];
  const applied: string[] = [];
  for (const fix of fixes) {
    if (!fix.applies(provider)) continue;
    const result = fix.apply(current);
    if (result.body !== current || result.rewrite !== undefined) applied.push(fix.id);
    current = result.body;
    if (result.rewrite !== undefined) rewrites.push(result.rewrite);
  }
  const rewrite =
    rewrites.length === 0
      ? undefined
      : (event: ResponsesEvent) => rewrites.reduce((e, fn) => fn(e), event);
  return { body: current, ...(rewrite === undefined ? {} : { rewrite }), applied };
}

function key(name: string, namespace?: string): string {
  return `${namespace ?? ''}\u0000${name}`;
}

/** 历史里的 custom_tool_call / custom_tool_call_output → 函数调用与函数输出。`id` 不带（上游可能按前缀校验）。 */
function toFunctionItem(item: ResponsesItem): ResponsesItem {
  if (item.type === 'custom_tool_call') {
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}),
      arguments: customCallArguments(item.input),
    };
  }
  if (item.type === 'custom_tool_call_output') {
    return { type: 'function_call_output', call_id: item.call_id, output: item.output };
  }
  return item;
}
