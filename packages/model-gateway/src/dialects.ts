// Responses 透传的方言修正（docs/architecture/model-gateway.md §3.2）：各家 Responses 实现与 OpenAI 的差异，
// 只在网关里改，不碰 Codex（codex-notes §5.3）。每条修正声明对哪些 Provider 生效，改请求体，必要时再改响应事件。

import { isXaiHost } from './providers.js';
import {
  CUSTOM_TOOL_PARAMETERS,
  customCallArguments,
  customCallInput,
  customToolDescription,
  isObject,
  ToolNames,
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
 * 历史里 reasoning 项的 `content: null` 去掉。Codex 回放上游没给 content 的推理项（xAI 只给 encrypted_content）时写
 * `"content": null`，xAI 报 422（`expected a sequence`），去掉这个键就正常（openai/codex#47733）。Responses 的 schema
 * 里 `content` 是数组，null 本来就不合法，所以对所有 Provider 生效。
 */
export const stripNullReasoningContent: DialectFix = {
  id: 'strip-null-reasoning-content',
  applies: () => true,
  apply(body) {
    if (!Array.isArray(body.input)) return { body };
    if (!body.input.some((item) => item.type === 'reasoning' && item.content === null)) {
      return { body };
    }
    const input = body.input.map((item) => {
      if (item.type !== 'reasoning' || item.content !== null) return item;
      const { content: _drop, ...rest } = item;
      return rest as ResponsesItem;
    });
    return { body: { ...body, input } };
  },
};

/**
 * Provider 不支持自定义工具时，把 custom 工具（apply_patch）按 Chat 转换的办法摊平成只有 `input` 参数的函数，历史里的
 * custom_tool_call / _output 也换成函数调用；响应里同名的 function_call 再还原成 custom_tool_call。namespace 不动，
 * 里面的 custom 工具同样摊平。“不支持”是 `compat.supportsCustomTools: false`；没写时 xAI 的地址按不支持处理（xAI 的
 * Responses 只认函数与托管工具，docs.x.ai 的 OpenAPI），写了 true 就不摊平。
 */
export const flattenCustomTools: DialectFix = {
  id: 'flatten-custom-tools',
  applies: (provider) => {
    const declared = provider.compat?.supportsCustomTools;
    return declared === false || (declared === undefined && isXaiHost(provider.baseURL ?? ''));
  },
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
    return { body: next, rewrite: outputRewrite(restore) };
  },
};

/**
 * xAI 的 namespace 工具摊平：xAI 的 Responses 没有 `namespace` 类型的工具，函数调用也没有 `namespace` 字段（docs.x.ai 的
 * OpenAPI），而 Codex 的子 agent 工具在 `multi_agent_v1` 命名空间里。里面的工具摊平成 `<ns>__<name>`（与 Chat 转换同一
 * 套命名，tools.ts），历史里带 `namespace` 的调用换成摊平的名字；响应里再还原名字与命名空间。排在 custom 工具的摊平之后。
 */
export const flattenNamespaceTools: DialectFix = {
  id: 'flatten-namespace-tools',
  applies: (provider) => isXaiHost(provider.baseURL ?? ''),
  apply(body) {
    const input = Array.isArray(body.input) ? body.input : [];
    if (
      !body.tools?.some((tool) => tool.type === 'namespace') &&
      !input.some((item) => typeof item.namespace === 'string')
    ) {
      return { body };
    }
    const names = new ToolNames();
    const flat = (name: string, namespace: string) =>
      names.flat({ kind: 'function', name, namespace });
    const tools = body.tools?.flatMap((tool): ResponsesTool[] =>
      tool.type === 'namespace' && Array.isArray(tool.tools)
        ? (tool.tools as ResponsesTool[]).map((inner) => ({
            ...inner,
            name: flat(inner.name ?? '', tool.name ?? ''),
          }))
        : [tool],
    );
    const next: ResponsesRequest = {
      ...body,
      ...(Array.isArray(body.input)
        ? {
            input: body.input.map((item) => {
              if (typeof item.namespace !== 'string') return item;
              const { namespace, ...rest } = item;
              return { ...rest, name: flat(String(item.name ?? ''), namespace) } as ResponsesItem;
            }),
          }
        : {}),
      ...(tools === undefined ? {} : { tools }),
    };
    const restore = (item: unknown): unknown => {
      if (!isObject(item) || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) {
        return item;
      }
      const origin = names.origin(String(item.name ?? ''));
      if (origin?.namespace === undefined) return item;
      return { ...item, name: origin.name, namespace: origin.namespace };
    };
    return { body: next, rewrite: outputRewrite(restore) };
  },
};

/** 按顺序检查；新的修正加在这里，并在 model-gateway.md §3.2 的清单里登记。 */
export const RESPONSES_DIALECTS: readonly DialectFix[] = [
  dropToolChoiceWithoutTools,
  stripNullReasoningContent,
  flattenCustomTools,
  flattenNamespaceTools,
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
  // 响应按相反的顺序还原：后摊平的先还原（namespace 还原之后，custom 工具的还原才认得出原名）。
  const rewrite =
    rewrites.length === 0
      ? undefined
      : (event: ResponsesEvent) => rewrites.reduceRight((e, fn) => fn(e), event);
  return { body: current, ...(rewrite === undefined ? {} : { rewrite }), applied };
}

/** 输出项（`output_item.added` / `done` 的 `item`、终结事件的 `response.output`）逐项改写。 */
function outputRewrite(restore: (item: unknown) => unknown): EventRewrite {
  return (event) => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
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
