// Responses 透传的方言修正（docs/architecture/model-gateway.md §3.2）：各家 Responses 实现与 OpenAI 的差异，
// 只在网关里改，不碰 Codex（codex-notes §5.3）。每条修正声明对哪些 Provider 生效，改请求体，必要时再改响应事件。

import {
  effectiveCompat,
  isAzureHost,
  isDeepSeekHost,
  isKimiHost,
  isMinimaxHost,
  isXaiHost,
} from './providers.js';
import {
  CUSTOM_TOOL_PARAMETERS,
  compatibleToolChoice,
  customCallArguments,
  customCallInput,
  customToolDescription,
  isObject,
  mcpNamespaceNote,
  ToolNames,
  withMcpNotes,
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

/** Codex 的 Option<String> 没有 skip-serialize：没有加密推理时会回放 null，所有 Provider 都去掉这个键。 */
export const stripNullReasoningEncryptedContent: DialectFix = {
  id: 'strip-null-reasoning-encrypted-content',
  applies: () => true,
  apply(body) {
    if (
      !Array.isArray(body.input) ||
      !body.input.some((item) => item.type === 'reasoning' && item.encrypted_content === null)
    ) {
      return { body };
    }
    const input = body.input.map((item) => {
      if (item.type !== 'reasoning' || item.encrypted_content !== null) return item;
      const { encrypted_content: _drop, ...rest } = item;
      return rest as ResponsesItem;
    });
    return { body: { ...body, input } };
  },
};

/** SpaceXAI 不能关闭推理：只按 x.ai Responses 地址归一化旧配置或外部请求的档位（§3.2）。 */
export const xaiReasoningEffort: DialectFix = {
  id: 'xai-reasoning-effort',
  applies: (provider) =>
    provider.kind === 'openai-compatible' &&
    provider.api === 'openai-responses' &&
    isXaiHost(provider.baseURL ?? ''),
  apply(body) {
    if (!isObject(body.reasoning)) return { body };
    const effort = body.reasoning.effort;
    const mapped =
      effort === 'none' || effort === 'minimal' ? 'low' : effort === 'max' ? 'xhigh' : effort;
    return mapped === effort
      ? { body }
      : { body: { ...body, reasoning: { ...body.reasoning, effort: mapped } } };
  },
};

/**
 * MiniMax Responses（§3.12）：reasoning 只有 effort，去掉 summary（官方 Codex 目录设 default_reasoning_summary: none，
 * 厂商测过的请求不带它）；M3.1 总在思考，none 报 400，none / minimal 改 low。M3 的 none 关思考、M2.x 忽略，原样发送。
 */
export const minimaxReasoning: DialectFix = {
  id: 'minimax-reasoning',
  applies: (provider) =>
    provider.kind === 'openai-compatible' &&
    provider.api === 'openai-responses' &&
    isMinimaxHost(provider.baseURL ?? ''),
  apply(body) {
    if (!isObject(body.reasoning)) return { body };
    const { summary, ...reasoning } = body.reasoning;
    const effort = reasoning.effort;
    const alwaysThinks = /^minimax-m3\.1(?:$|-)/i.test(String(body.model));
    if (alwaysThinks && (effort === 'none' || effort === 'minimal')) reasoning.effort = 'low';
    return summary === undefined && reasoning.effort === effort
      ? { body }
      : { body: { ...body, reasoning } };
  },
};

/** MCP 命名空间的说明接到 `instructions` 后面，并从这些命名空间上去掉；没有说明时原样返回。 */
function moveMcpNotes(body: ResponsesRequest): ResponsesRequest {
  if (!body.tools?.some((tool) => mcpNamespaceNote(tool) !== undefined)) return body;
  const tools = body.tools.map((tool) => {
    if (mcpNamespaceNote(tool) === undefined) return tool;
    const { description: _moved, ...rest } = tool;
    return rest as ResponsesTool;
  });
  return { ...withMcpNotes(body), tools };
}

/**
 * DeepSeek 的 Responses 把命名空间的描述在其中每个工具上各算一遍（2026-10-19 实测 deepseek-flash：约 385 token 的描述，10 个
 * 工具多算 3,840 token，20 个多算 7,680）。Codex 把 MCP 服务的说明写在它的命名空间描述里，Wevir 的应用级工具一个命名空间
 * 62 个，每个请求因此多出约 9 万 token：额度多花几倍，按 128k 登记窗口时 Codex 每个请求后都自动压缩。把这些说明接到
 * `instructions` 后面（同 Chat / Messages 转换），只算一次；这些命名空间去掉描述（DeepSeek 接受没有描述的命名空间）。
 * 别的命名空间与工具不动。
 */
export const deepseekNamespaceDescription: DialectFix = {
  id: 'deepseek-namespace-description',
  applies: (provider) =>
    provider.kind === 'deepseek-official' ||
    (provider.kind === 'openai-compatible' &&
      provider.api === 'openai-responses' &&
      isDeepSeekHost(provider.baseURL ?? '')),
  apply: (body) => ({ body: moveMcpNotes(body) }),
};

/** 只收 auto 的上游：required / 具名改 auto，none 只去掉 tool_choice、保留 tools。 */
export const autoOnlyToolChoice: DialectFix = {
  id: 'auto-only-tool-choice',
  applies: (provider) => effectiveCompat(provider).toolChoice === 'auto_only',
  apply(body) {
    const choice = compatibleToolChoice(body.tool_choice, 'auto_only');
    if (choice === body.tool_choice) return { body };
    if (choice === undefined) {
      const { tool_choice: _drop, ...rest } = body;
      return { body: rest as ResponsesRequest };
    }
    return { body: { ...body, tool_choice: choice } };
  },
};

/**
 * 摊平 namespace 的上游（生效的 supportsNamespaceTools 为 false）：命名空间连同描述会被摊掉，而 Codex 把 MCP 服务的说明
 * 写在这个描述里（Wevir 的应用级工具说明与记忆索引就在其中）。摊平前把说明接到 `instructions` 后面（同 Chat / Messages
 * 转换），并去掉这些命名空间的描述：排在 Azure 补描述与 DeepSeek 搬描述之前，说明只出现一次。显式支持 namespace 时不改。
 */
export const flattenMcpInstructions: DialectFix = {
  id: 'flatten-mcp-instructions',
  applies: (provider) => effectiveCompat(provider).supportsNamespaceTools === false,
  apply: (body) => ({ body: moveMcpNotes(body) }),
};

const azureResponses = (provider: GatewayProvider): boolean =>
  provider.kind === 'openai-compatible' &&
  provider.api === 'openai-responses' &&
  isAzureHost(provider.baseURL ?? '');

/** Azure 拒收缺失或空的 namespace 描述；只补描述，不改工具或命名空间（model-gateway.md §3.5）。 */
export const azureNamespaceDescription: DialectFix = {
  id: 'azure-namespace-description',
  applies: azureResponses,
  apply(body) {
    const tools = body.tools?.map((tool) =>
      tool.type === 'namespace' &&
      (typeof tool.description !== 'string' || tool.description.trim() === '')
        ? { ...tool, description: 'Tools in this namespace.' }
        : tool,
    );
    return tools?.some((tool, index) => tool !== body.tools?.[index])
      ? { body: { ...body, tools } }
      : { body };
  },
};

/** Azure 无状态请求显式索取加密推理，连接探测同样使用（model-gateway.md §3.5）。 */
export const azureEncryptedReasoning: DialectFix = {
  id: 'azure-encrypted-reasoning',
  applies: azureResponses,
  apply(body) {
    const include = Array.isArray(body.include) ? body.include : [];
    if (body.store !== false || include.includes('reasoning.encrypted_content')) return { body };
    return { body: { ...body, include: [...include, 'reasoning.encrypted_content'] } };
  },
};

/** Kimi Responses 只收 data URL：过滤用户消息和工具结果中的其他图片，不下载外部资源（§3.8）。 */
export const kimiDataImagesOnly: DialectFix = {
  id: 'kimi-data-images-only',
  applies: (provider) =>
    provider.kind === 'openai-compatible' &&
    provider.api === 'openai-responses' &&
    isKimiHost(provider.baseURL ?? ''),
  apply(body) {
    if (!Array.isArray(body.input)) return { body };
    const input = body.input.map((item) => {
      const field =
        item.type === 'message'
          ? 'content'
          : item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
            ? 'output'
            : undefined;
      const parts = field === undefined ? undefined : item[field];
      if (field === undefined || !Array.isArray(parts)) return item;
      const filtered = parts.filter(
        (part) =>
          !isObject(part) ||
          part.type !== 'input_image' ||
          (typeof part.image_url === 'string' && part.image_url.startsWith('data:')),
      );
      return filtered.length === parts.length ? item : { ...item, [field]: filtered };
    });
    return input.some((item, index) => item !== body.input[index])
      ? { body: { ...body, input } }
      : { body };
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
  applies: (provider) => effectiveCompat(provider).supportsCustomTools === false,
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
 * 不支持 namespace 的上游（显式 false，没写时 xAI 地址默认 false）：里面的工具摊平成 `<ns>__<name>`（与 Chat
 * 转换同一套命名，tools.ts），历史与具名 tool_choice 用同一份登记；响应里还原名字与命名空间。排在 custom 摊平之后。
 */
export const flattenNamespaceTools: DialectFix = {
  id: 'flatten-namespace-tools',
  applies: (provider) => effectiveCompat(provider).supportsNamespaceTools === false,
  apply(body) {
    const input = Array.isArray(body.input) ? body.input : [];
    if (
      !body.tools?.some((tool) => tool.type === 'namespace') &&
      !input.some((item) => typeof item.namespace === 'string')
    ) {
      return { body };
    }
    const names = new ToolNames();
    const flat = (name: string, namespace?: string, kind: 'function' | 'custom' = 'function') =>
      names.flat({ kind, name, namespace });
    const flatten = (tool: ResponsesTool, namespace?: string): ResponsesTool => {
      if (tool.type !== 'function' && tool.type !== 'custom') return tool;
      return { ...tool, name: flat(tool.name ?? '', namespace, tool.type) };
    };
    const tools = body.tools?.flatMap((tool): ResponsesTool[] =>
      tool.type === 'namespace' && Array.isArray(tool.tools)
        ? (tool.tools as ResponsesTool[]).map((inner) => flatten(inner, tool.name ?? ''))
        : [flatten(tool)],
    );
    const choice = body.tool_choice;
    let namedChoice = choice;
    if (isObject(choice) && (choice.type === 'function' || choice.type === 'custom')) {
      const { namespace, ...rest } = choice;
      namedChoice = {
        ...rest,
        name: flat(
          String(choice.name ?? ''),
          typeof namespace === 'string' ? namespace : undefined,
          choice.type,
        ),
      };
    }
    const next: ResponsesRequest = {
      ...body,
      ...(Array.isArray(body.input)
        ? {
            input: body.input.map((item) => {
              if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
              const { namespace, ...rest } = item;
              return {
                ...rest,
                name: flat(
                  String(item.name ?? ''),
                  typeof namespace === 'string' ? namespace : undefined,
                  item.type === 'custom_tool_call' ? 'custom' : 'function',
                ),
              } as ResponsesItem;
            }),
          }
        : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(namedChoice === undefined ? {} : { tool_choice: namedChoice }),
    };
    const restore = (item: unknown): unknown => {
      if (!isObject(item) || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) {
        return item;
      }
      const origin = names.origin(String(item.name ?? ''));
      if (origin === undefined) return item;
      return {
        ...item,
        name: origin.name,
        ...(origin.namespace === undefined ? {} : { namespace: origin.namespace }),
      };
    };
    return { body: next, rewrite: outputRewrite(restore) };
  },
};

/** 按顺序检查；新的修正加在这里，并在 model-gateway.md §3.2 的清单里登记。 */
export const RESPONSES_DIALECTS: readonly DialectFix[] = [
  dropToolChoiceWithoutTools,
  stripNullReasoningContent,
  stripNullReasoningEncryptedContent,
  xaiReasoningEffort,
  flattenMcpInstructions,
  azureNamespaceDescription,
  azureEncryptedReasoning,
  kimiDataImagesOnly,
  minimaxReasoning,
  deepseekNamespaceDescription,
  autoOnlyToolChoice,
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
