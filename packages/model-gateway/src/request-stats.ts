import { mcpNamespaceNotes } from './tools.js';
import type { ResponsesRequest } from './types.js';

export interface RequestSupply {
  toolCount: number;
  toolBytes: number;
  mcpNoteBytes: number;
  instructionBytes: number;
  requestBytes: number;
  wevirOutputBytes: number;
  wevirOutputBytesNew: number;
}

export function requestStats(
  payload: Record<string, unknown>,
  mode: 'responses' | 'chat' | 'messages',
  serialized: string | Uint8Array,
  source: ResponsesRequest,
  seenOutputs = new Set<string>(),
): RequestSupply {
  const catalog = { responses: responsesCatalog, chat: chatCatalog, messages: messagesCatalog }[
    mode
  ](payload, serialized);
  const input = Array.isArray(source.input) ? source.input : [];
  const calls = new Map(
    input
      .filter((item) => item.type === 'function_call')
      .map((item) => [
        item.call_id,
        typeof item.namespace === 'string' ? `${item.namespace}__${item.name}` : item.name,
      ]),
  );
  const outputs: Array<{ id: string; output: unknown }> = [];
  if (mode === 'responses') {
    for (const item of Array.isArray(payload.input) ? payload.input : []) {
      if (item.type === 'function_call_output' && isWevir(calls.get(item.call_id)))
        outputs.push({ id: item.call_id, output: item.output });
    }
  } else {
    for (const message of (payload.messages ?? []) as Array<Record<string, unknown>>) {
      if (mode === 'chat' && message.role === 'tool' && isWevir(calls.get(message.tool_call_id))) {
        outputs.push({ id: String(message.tool_call_id), output: message.content });
      } else if (mode === 'messages' && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_result' && isWevir(calls.get(block.tool_use_id)))
            outputs.push({ id: block.tool_use_id, output: block.content });
        }
      }
    }
  }
  let wevirOutputBytes = 0;
  let wevirOutputBytesNew = 0;
  for (const { id, output } of outputs) {
    const size = bytes(output);
    wevirOutputBytes += size;
    if (!seenOutputs.has(id)) wevirOutputBytesNew += size;
    seenOutputs.add(id);
  }
  const notes = mcpNamespaceNotes(source.tools);
  const namespaces =
    mode === 'responses' ? ((payload.tools ?? []) as ResponsesRequest['tools']) : [];
  const namespaceBytes =
    namespaces?.reduce(
      (sum, tool) => sum + bytes(tool.name?.startsWith('mcp__') ? (tool.description ?? '') : ''),
      0,
    ) ?? 0;
  const instructionText =
    mode === 'responses'
      ? String(payload.instructions ?? '')
      : mode === 'chat'
        ? ((payload.messages ?? []) as Array<{ role: string; content: unknown }>)
            .filter((item) => ['system', 'developer'].includes(item.role))
            .map((item) => (typeof item.content === 'string' ? item.content : ''))
            .join('\n')
        : ((payload.system ?? []) as Array<{ text?: string }>)
            .map((item) => item.text ?? '')
            .join('\n');
  return {
    toolCount: catalog.tools,
    toolBytes: catalog.toolBytes,
    instructionBytes: catalog.instructionBytes,
    requestBytes: catalog.requestBytes,
    mcpNoteBytes:
      namespaceBytes + (notes !== undefined && instructionText.includes(notes) ? bytes(notes) : 0),
    wevirOutputBytes,
    wevirOutputBytesNew,
  };
}

function isWevir(name: unknown): boolean {
  return typeof name === 'string' && (name.startsWith('mcp__wevir') || name.startsWith('wevir_'));
}

export interface CatalogStats {
  /** 工具的条数（命名空间按里面的工具算）。 */
  tools: number;
  /** 工具名（命名空间里的写成 `<命名空间>__<名字>` 或 `<命名空间>.<名字>`）。 */
  names: string[];
  /** `tools` 序列化后的字节数。 */
  toolBytes: number;
  /** 说明（Responses 的 `instructions`、Chat 的 system 消息、Messages 的 `system`）的字节数。 */
  instructionBytes: number;
  /** 整个请求体的字节数。 */
  requestBytes: number;
}

const bytes = (value: unknown) =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''));

/** Responses 请求（Codex 发给网关、网关透传给上游的形状）。 */
export function responsesCatalog(
  body: Record<string, unknown>,
  serialized?: string | Uint8Array,
): CatalogStats {
  const names: string[] = [];
  for (const tool of (body.tools as Array<Record<string, unknown>> | undefined) ?? []) {
    if (tool.type === 'namespace') {
      // MCP 的命名空间（`mcp__wevir`）照网关摊平的写法接 `__`，Codex 自己的（`multi_agent_v1`）接 `.`。
      const namespace = String(tool.name);
      const join = namespace.startsWith('mcp__') ? '__' : '.';
      for (const inner of (tool.tools as Array<{ name?: string }> | undefined) ?? []) {
        names.push(`${namespace}${join}${inner.name ?? '?'}`);
      }
    } else {
      names.push(String(tool.name ?? tool.type));
    }
  }
  const input = (Array.isArray(body.input) ? body.input : []) as Array<{
    role?: string;
    content?: unknown;
  }>;
  return {
    tools: names.length,
    names,
    toolBytes: bytes(body.tools ?? []),
    instructionBytes:
      bytes(body.instructions ?? '') +
      input
        .filter((item) => item.role === 'system' || item.role === 'developer')
        .reduce((sum, item) => sum + bytes(item.content), 0),
    requestBytes:
      serialized === undefined
        ? bytes(body)
        : typeof serialized === 'string'
          ? bytes(serialized)
          : serialized.byteLength,
  };
}

/** Chat Completions 请求（网关转换之后）。 */
export function chatCatalog(
  body: Record<string, unknown>,
  serialized?: string | Uint8Array,
): CatalogStats {
  const tools = (body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [];
  const messages = (body.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? [];
  return {
    tools: tools.length,
    names: tools.map((tool) => tool.function?.name ?? '?'),
    toolBytes: bytes(tools),
    instructionBytes: messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .reduce((sum, message) => sum + bytes(message.content), 0),
    requestBytes:
      serialized === undefined
        ? bytes(body)
        : typeof serialized === 'string'
          ? bytes(serialized)
          : serialized.byteLength,
  };
}

/** Anthropic Messages 请求（网关转换之后）。 */
export function messagesCatalog(
  body: Record<string, unknown>,
  serialized?: string | Uint8Array,
): CatalogStats {
  const tools = (body.tools as Array<{ name?: string }> | undefined) ?? [];
  return {
    tools: tools.length,
    names: tools.map((tool) => tool.name ?? '?'),
    toolBytes: bytes(tools),
    instructionBytes: bytes(body.system ?? ''),
    requestBytes:
      serialized === undefined
        ? bytes(body)
        : typeof serialized === 'string'
          ? bytes(serialized)
          : serialized.byteLength,
  };
}
