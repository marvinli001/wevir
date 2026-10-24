// Codex 的工具搜索（模型的 `supports_search_tool`）在不认它的上游上（compat `toolSearch: dispatch`）：Codex 发来的
// `tool_search` 工具与历史里的 `tool_search_call` / `tool_search_output` 换成普通函数与函数结果，搜到的工具（不在 `tools` 里）
// 经一个固定的分发函数 `call_tool` 调用；响应里再还原成 Codex 认的项。`tools` 整个会话不变，缓存不受影响。三种上游协议共用：
// 在方言修正与 Chat / Messages 转换之前做（upstream.ts）。

import { isObject } from './tools.js';
import type { ResponsesEvent, ResponsesItem, ResponsesRequest, ResponsesTool } from './types.js';

/** Codex 的工具搜索在上游那里的函数名（同 Codex 的 `TOOL_SEARCH_TOOL_NAME`）。 */
export const TOOL_SEARCH_FUNCTION = 'tool_search';
/** 调用搜到的工具的分发函数。 */
export const CALL_TOOL_FUNCTION = 'call_tool';

const CALL_TOOL: ResponsesTool = {
  type: 'function',
  name: CALL_TOOL_FUNCTION,
  description:
    'Call a tool that tool_search returned. Tools found by tool_search are not in your tool list: call them through this function with the full name tool_search gave and their arguments.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Full tool name from a tool_search result, e.g. mcp__wevir_more__browser_click.',
      },
      arguments: {
        type: 'object',
        description: "The tool's arguments, matching its parameters.",
        additionalProperties: true,
      },
    },
    required: ['name', 'arguments'],
    additionalProperties: false,
  },
  strict: false,
};

const SEARCH_NOTE = '\n\nTools it finds are not in your tool list: call them with call_tool.';

/** 搜到的工具：分发时用的全名 → 原来的命名空间与名字。 */
type Found = Map<string, { namespace?: string; name: string }>;

/**
 * 请求里有工具搜索（`tool_search` 工具或历史里的搜索项）时翻译；没有时返回 `undefined`。`rewrite` 把响应里的 `tool_search` 与
 * `call_tool` 函数调用还原成 `tool_search_call` 与对搜到的工具的调用。
 */
export function dispatchToolSearch(
  body: ResponsesRequest,
): { body: ResponsesRequest; rewrite: (event: ResponsesEvent) => ResponsesEvent } | undefined {
  const input = Array.isArray(body.input) ? body.input : [];
  const hasTool = body.tools?.some((tool) => tool.type === 'tool_search') === true;
  if (
    !hasTool &&
    !input.some((item) => item.type === 'tool_search_call' || item.type === 'tool_search_output')
  ) {
    return undefined;
  }
  const direct = directTools(body.tools);
  const found: Found = new Map();
  for (const item of input) {
    if (item.type !== 'tool_search_output' || !Array.isArray(item.tools)) continue;
    for (const tool of item.tools) collectFound(tool, found);
  }
  const tools = body.tools?.flatMap((tool): ResponsesTool[] => {
    if (tool.type !== 'tool_search') return [tool];
    const { type: _type, execution: _execution, ...rest } = tool;
    return [
      {
        ...rest,
        type: 'function',
        name: TOOL_SEARCH_FUNCTION,
        description: `${typeof tool.description === 'string' ? tool.description : ''}${SEARCH_NOTE}`,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
        strict: false,
      },
    ];
  });
  if (hasTool && tools !== undefined && !tools.some((tool) => tool.name === CALL_TOOL_FUNCTION)) {
    tools.push(CALL_TOOL);
  }
  const next: ResponsesRequest = {
    ...body,
    ...(Array.isArray(body.input)
      ? { input: body.input.map((item) => toUpstream(item, direct)) }
      : {}),
    ...(tools === undefined ? {} : { tools }),
  };
  const restore = (item: unknown): unknown => fromUpstream(item, found, direct);
  return {
    body: next,
    rewrite: (event) => {
      // 函数调用开始时（`output_item.added`）还没有参数，Codex 也不靠它执行工具：只改完成的项与终结事件。
      if (event.type === 'response.output_item.done')
        return { ...event, item: restore(event.item) };
      if (isObject(event.response) && Array.isArray(event.response.output)) {
        return {
          ...event,
          response: { ...event.response, output: event.response.output.map(restore) },
        };
      }
      return event;
    },
  };
}

/** 分发用的全名：命名空间里的工具是 `<命名空间>__<名字>`（同网关摊平的写法），顶层的就是名字。 */
function fullName(name: string, namespace?: string): string {
  return namespace === undefined ? name : `${namespace}__${name}`;
}

function key(name: string, namespace?: string): string {
  return `${namespace ?? ''}\u0000${name}`;
}

/** `tools` 里直接列出的工具（顶层的与命名空间里的）。 */
function directTools(tools: readonly ResponsesTool[] | undefined): Map<string, string> {
  const direct = new Map<string, string>();
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const inner of tool.tools as ResponsesTool[]) {
        if (typeof inner.name === 'string' && typeof tool.name === 'string') {
          direct.set(key(inner.name, tool.name), fullName(inner.name, tool.name));
        }
      }
    } else if (typeof tool.name === 'string') {
      direct.set(key(tool.name), tool.name);
    }
  }
  return direct;
}

function collectFound(tool: unknown, found: Found, namespace?: string): void {
  if (!isObject(tool) || typeof tool.name !== 'string') return;
  if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
    for (const inner of tool.tools) collectFound(inner, found, tool.name);
    return;
  }
  found.set(fullName(tool.name, namespace), {
    ...(namespace === undefined ? {} : { namespace }),
    name: tool.name,
  });
}

/** 历史里的一项 → 发给上游的写法。 */
function toUpstream(item: ResponsesItem, direct: Map<string, string>): ResponsesItem {
  if (item.type === 'tool_search_call') {
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: TOOL_SEARCH_FUNCTION,
      arguments: JSON.stringify(isObject(item.arguments) ? item.arguments : {}),
    };
  }
  if (item.type === 'tool_search_output') {
    return {
      type: 'function_call_output',
      call_id: item.call_id,
      output: foundText(Array.isArray(item.tools) ? item.tools : []),
    };
  }
  if (item.type !== 'function_call' || typeof item.name !== 'string') return item;
  const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
  if (direct.has(key(item.name, namespace))) return item;
  // 不在 `tools` 里：是搜到之后调用的，按分发函数的写法还给上游。
  return {
    type: 'function_call',
    call_id: item.call_id,
    name: CALL_TOOL_FUNCTION,
    arguments: JSON.stringify({
      name: fullName(item.name, namespace),
      arguments: parseObject(item.arguments),
    }),
  };
}

/** 响应里的一项 → Codex 认的项。 */
function fromUpstream(item: unknown, found: Found, direct: Map<string, string>): unknown {
  if (!isObject(item) || item.type !== 'function_call' || item.namespace !== undefined) return item;
  const { name: _name, arguments: args, ...rest } = item;
  if (item.name === TOOL_SEARCH_FUNCTION) {
    return {
      ...rest,
      type: 'tool_search_call',
      execution: 'client',
      arguments: parseObject(args),
    };
  }
  if (item.name !== CALL_TOOL_FUNCTION) return item;
  const call = parseObject(args);
  const wanted = typeof call.name === 'string' ? call.name : '';
  const target = found.get(wanted) ?? directTarget(wanted, direct) ?? splitName(wanted);
  return {
    ...rest,
    type: 'function_call',
    name: target.name,
    ...(target.namespace === undefined ? {} : { namespace: target.namespace }),
    arguments: JSON.stringify(isObject(call.arguments) ? call.arguments : {}),
  };
}

/** 模型经分发调了一个直接列出的工具：照原样调它。 */
function directTarget(
  wanted: string,
  direct: Map<string, string>,
): { namespace?: string; name: string } | undefined {
  for (const [entry, full] of direct) {
    if (full !== wanted) continue;
    const [namespace, name] = entry.split('\u0000') as [string, string];
    return namespace === '' ? { name } : { namespace, name };
  }
  return undefined;
}

/** 认不出的全名：按最后一个 `__` 拆成命名空间与名字（Codex 会回“没有这个工具”），没有时当作顶层的名字。 */
function splitName(wanted: string): { namespace?: string; name: string } {
  const at = wanted.lastIndexOf('__');
  return at > 0 ? { namespace: wanted.slice(0, at), name: wanted.slice(at + 2) } : { name: wanted };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `tool_search_output` 的工具 → 给模型的紧凑文本：每个工具的全名、描述与参数 schema，按全名排序。 */
function foundText(tools: readonly unknown[]): string {
  const entries: Array<{ name: string; description?: string; parameters?: unknown }> = [];
  const add = (tool: unknown, namespace?: string) => {
    if (!isObject(tool) || typeof tool.name !== 'string') return;
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) add(inner, tool.name);
      return;
    }
    entries.push({
      name: fullName(tool.name, namespace),
      ...(typeof tool.description === 'string' && { description: tool.description }),
      ...(tool.parameters !== undefined && { parameters: tool.parameters }),
    });
  };
  for (const tool of tools) add(tool);
  if (entries.length === 0) return 'No matching tools.';
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    'Found tools. Call them with call_tool({"name": <name>, "arguments": {...}}):',
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join('\n');
}
