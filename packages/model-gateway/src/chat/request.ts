// Responses 请求 → Chat Completions 请求。改写自 spikes/codex-app-server/src/gateway.ts（mapInput 等），
// 映射表见 docs/architecture/model-gateway.md §4.1（codex-notes §5.1 的表加上 Spike 没做的部分）。

import { effectiveCompat, isDeepSeekHost, isGeminiHost, isOpenAIOfficial } from '../providers.js';
import {
  compatibleToolChoice,
  customCallArguments,
  isObject,
  ToolNames,
  toChatTools,
} from '../tools.js';
import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  GatewayProvider,
  JsonObject,
  ResponsesItem,
  ResponsesRequest,
} from '../types.js';

/** 网关自己写进 reasoning 项 `encrypted_content` 的前缀：后面是推理全文的 base64（§4.2）。 */
export const ENCRYPTED_REASONING_PREFIX = 'wevir-gw:v1:';

/**
 * Gemini 的 thought signature 信封（model-gateway.md §4.5）：网关在工具调用之前提交的 reasoning 项的
 * `encrypted_content`，后面是 `{provider, model, signatures: {<call_id>: <签名>}}` 的 base64。
 */
export const GEMINI_SIGNATURE_PREFIX = 'wevir-gw:gemini:v1:';

/**
 * 缺签名时填的占位值：Gemini 文档给的“跳过校验”值（ai.google.dev 的 thought-signatures 页，2026-10-13）。当前回合里
 * 每一步的第一个函数调用必须带签名，否则 400；签名来自别的 Provider、模型或网关之外的历史时只能用它。
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export interface GeminiSignatureEnvelope {
  provider: string;
  model: string;
  signatures: Record<string, string>;
}

export function encodeGeminiSignatures(envelope: GeminiSignatureEnvelope): string {
  return GEMINI_SIGNATURE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

export function decodeGeminiSignatures(encrypted: unknown): GeminiSignatureEnvelope | undefined {
  if (typeof encrypted !== 'string' || !encrypted.startsWith(GEMINI_SIGNATURE_PREFIX)) return;
  try {
    const value = JSON.parse(
      Buffer.from(encrypted.slice(GEMINI_SIGNATURE_PREFIX.length), 'base64').toString('utf8'),
    ) as unknown;
    if (
      !isObject(value) ||
      typeof value.provider !== 'string' ||
      typeof value.model !== 'string' ||
      !isObject(value.signatures)
    ) {
      return;
    }
    const signatures: Record<string, string> = {};
    for (const [id, signature] of Object.entries(value.signatures)) {
      if (typeof signature === 'string') signatures[id] = signature;
    }
    return { provider: value.provider, model: value.model, signatures };
  } catch {
    return;
  }
}

/** `systemMessageMode: 'user'` 时，对话中间的 developer 消息转成 user 消息的开头一行。 */
export const SYSTEM_AS_USER_NOTE =
  '[Developer instruction from the application, not written by the user]';

/** 工具输出里有图片时，tool 消息之后补一条带图的 user 消息，开头是这句说明。 */
export const TOOL_IMAGE_NOTE = '[Images returned by the preceding tool call]';

export interface ChatTranslation {
  request: ChatRequest;
  /** 本次请求的工具名登记，响应方向按它还原工具调用。 */
  names: ToolNames;
  /** 没有映射、丢掉的输入项与工具（`<item type>`、`tool:<type>`、`input_image:file_id` 等），测试与排查用。 */
  dropped: string[];
  /** Gemini 上游：响应方向把 thought signature 收进信封（Provider 与本次的模型）。 */
  signatures?: { provider: string; model: string };
}

/** 请求体里网关不转给 Chat 上游的字段（Responses 专有，或 Chat 没有对应）。 */
const DROPPED_FIELDS = [
  'store',
  'include',
  'prompt_cache_key',
  'client_metadata',
  'service_tier',
  'parallel_tool_calls',
  'stream_options',
  'truncation',
  'previous_response_id',
  'metadata',
  'user',
] as const;

export function toChatRequest(body: ResponsesRequest, provider: GatewayProvider): ChatTranslation {
  const compat = effectiveCompat(provider);
  const baseURL = provider.baseURL ?? '';
  const names = new ToolNames();
  const dropped: string[] = [];
  const tools = toChatTools(body.tools, names, dropped);
  const signatures = isGeminiHost(baseURL)
    ? { provider: provider.id, model: body.model }
    : undefined;
  const messages = toChatMessages(body, {
    names,
    dropped,
    mode: compat.systemMessageMode ?? 'inline',
    developerRole: compat.supportsDeveloperRole === true,
    requireReasoning: compat.requiresReasoningContentOnAssistantMessages ?? isDeepSeekHost(baseURL),
    ...(signatures !== undefined && { signatures }),
  });
  const request: ChatRequest = {
    model: body.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) {
    request.tools = tools;
    const choice = compatibleToolChoice(
      toChatToolChoice(body.tool_choice, names),
      compat.toolChoice,
    );
    if (choice !== undefined) request.tool_choice = choice;
  }
  if (typeof body.max_output_tokens === 'number') {
    const field =
      compat.maxTokensField ?? (isOpenAIOfficial(baseURL) ? 'max_completion_tokens' : 'max_tokens');
    request[field] = body.max_output_tokens;
  }
  const effort = isObject(body.reasoning) ? body.reasoning.effort : undefined;
  if (typeof effort === 'string' && effort !== 'none') request.reasoning_effort = effort;
  for (const key of ['temperature', 'top_p'] as const) {
    if (typeof body[key] === 'number') request[key] = body[key];
  }
  const format = isObject(body.text) ? body.text.format : undefined;
  if (isObject(format) && format.type === 'json_schema') {
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: typeof format.name === 'string' ? format.name : 'output',
        schema: format.schema,
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
      },
    };
  }
  for (const key of DROPPED_FIELDS) if (body[key] !== undefined) dropped.push(`field:${key}`);
  return { request, names, dropped, ...(signatures !== undefined && { signatures }) };
}

interface MessageContext {
  names: ToolNames;
  dropped: string[];
  mode: 'inline' | 'merge' | 'user';
  developerRole: boolean;
  requireReasoning: boolean;
  /** Gemini：带回 thought signature，只认同一个 Provider 与模型的信封。 */
  signatures?: { provider: string; model: string };
}

function toChatMessages(body: ResponsesRequest, ctx: MessageContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const merged: string[] = [];
  let pendingReasoning = '';
  /** 信封里还没挂到工具调用上的签名，按 call_id。 */
  const signatures = new Map<string, string>();
  let toolImages: ChatContentPart[] = [];
  // 当前可以继续追加内容与工具调用的 assistant 消息：直到出现工具输出、用户或系统消息为止。
  let open: ChatMessage | undefined;

  const flushToolImages = () => {
    if (toolImages.length === 0) return;
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_IMAGE_NOTE }, ...toolImages],
    });
    toolImages = [];
  };
  const assistant = (): ChatMessage => {
    flushToolImages();
    if (open === undefined) {
      open = { role: 'assistant', content: null };
      messages.push(open);
    }
    if (pendingReasoning !== '') {
      open.reasoning_content = (open.reasoning_content ?? '') + pendingReasoning;
      pendingReasoning = '';
    }
    return open;
  };
  const closeAssistant = () => {
    open = undefined;
    // 推理之后没有任何输出就换了说话人（回合被中断）：没有可挂的 assistant 消息，丢掉。
    if (pendingReasoning !== '') {
      ctx.dropped.push('reasoning:orphan');
      pendingReasoning = '';
    }
  };
  const system = (text: string, role: 'system' | 'developer') => {
    flushToolImages();
    closeAssistant();
    const leading = messages.every((m) => m.role === 'system' || m.role === 'developer');
    if (ctx.mode === 'merge' || (ctx.mode === 'user' && leading)) {
      merged.push(text);
    } else if (ctx.mode === 'user') {
      messages.push({ role: 'user', content: `${SYSTEM_AS_USER_NOTE}\n${text}` });
    } else {
      messages.push({
        role: role === 'developer' && ctx.developerRole ? 'developer' : 'system',
        content: text,
      });
    }
  };

  if (typeof body.instructions === 'string' && body.instructions !== '')
    system(body.instructions, 'system');
  const input: ResponsesItem[] =
    typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : body.input;

  for (const item of input) {
    switch (item.type) {
      case 'message': {
        const role = item.role;
        if (role === 'assistant') {
          const msg = assistant();
          msg.content = `${(msg.content as string | null) ?? ''}${textOf(item.content)}`;
        } else if (role === 'developer' || role === 'system') {
          system(textOf(item.content), role);
        } else {
          flushToolImages();
          closeAssistant();
          messages.push({ role: 'user', content: userContent(item.content, ctx.dropped) });
        }
        break;
      }
      case 'reasoning': {
        const envelope =
          ctx.signatures === undefined ? undefined : decodeGeminiSignatures(item.encrypted_content);
        if (envelope !== undefined) {
          // 签名只对产生它的模型有效；别的 Provider 或模型的信封不带回，由下面的占位值兜底。
          if (
            envelope.provider === ctx.signatures?.provider &&
            envelope.model === ctx.signatures.model
          ) {
            for (const [id, signature] of Object.entries(envelope.signatures)) {
              signatures.set(id, signature);
            }
          } else {
            ctx.dropped.push('reasoning:foreign_signature');
          }
          break;
        }
        pendingReasoning += decodeReasoning(item);
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const msg = assistant();
        const custom = item.type === 'custom_tool_call';
        const name = ctx.names.flat({
          kind: custom ? 'custom' : 'function',
          name: String(item.name ?? ''),
          namespace: typeof item.namespace === 'string' ? item.namespace : undefined,
        });
        const id = String(item.call_id ?? '');
        const signature = signatures.get(id);
        msg.tool_calls = [
          ...(msg.tool_calls ?? []),
          {
            id,
            type: 'function',
            function: {
              name,
              arguments: custom ? customCallArguments(item.input) : String(item.arguments ?? ''),
            },
            ...(signature !== undefined && {
              extra_content: { google: { thought_signature: signature } },
            }),
          },
        ];
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        // 工具输出之后不能再往同一条 assistant 消息上加 tool_calls。
        closeAssistant();
        const { text, images } = toolOutput(item.output, ctx.dropped);
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? ''),
          content: text === '' && images.length > 0 ? TOOL_IMAGE_NOTE : text,
        });
        toolImages.push(...images);
        break;
      }
      default:
        ctx.dropped.push(item.type);
    }
  }
  flushToolImages();
  closeAssistant();
  if (merged.length > 0) messages.unshift({ role: 'system', content: merged.join('\n\n') });
  if (ctx.requireReasoning) {
    for (const m of messages) if (m.role === 'assistant') m.reasoning_content ??= '';
  }
  if (ctx.signatures !== undefined) {
    // 每一步（一条带工具调用的 assistant 消息）的第一个调用必须带签名；并行调用只有第一个带（Gemini 的规则）。
    for (const m of messages) {
      const first = m.tool_calls?.[0];
      if (first !== undefined && first.extra_content === undefined) {
        first.extra_content = { google: { thought_signature: SKIP_THOUGHT_SIGNATURE } };
        ctx.dropped.push('signature:placeholder');
      }
    }
  }
  return messages;
}

function toChatToolChoice(choice: unknown, names: ToolNames): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isObject(choice) && (choice.type === 'function' || choice.type === 'custom')) {
    const name = names.flat({ kind: choice.type, name: String(choice.name ?? '') });
    return { type: 'function', function: { name } };
  }
  return 'auto';
}

/** message 的 content（字符串，或 input_text / output_text 等部件）里的文本。 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : '')).join('');
}

/** user 消息：纯文本拼成字符串；有图片时用 parts（input_image → image_url）。 */
function userContent(content: unknown, dropped: string[]): string | ChatContentPart[] {
  if (!Array.isArray(content)) return textOf(content);
  const parts: ChatContentPart[] = [];
  for (const c of content as unknown[]) {
    if (!isObject(c)) continue;
    if (typeof c.text === 'string') parts.push({ type: 'text', text: c.text });
    else if (c.type === 'input_image') {
      const image = imagePart(c);
      if (image === undefined) dropped.push('input_image:file_id');
      else parts.push(image);
    } else dropped.push(String(c.type));
  }
  if (parts.every((p) => p.type === 'text'))
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return parts;
}

function imagePart(c: JsonObject): ChatContentPart | undefined {
  if (typeof c.image_url !== 'string') return undefined;
  const detail =
    c.detail === 'low' || c.detail === 'high' || c.detail === 'auto' ? c.detail : undefined;
  return {
    type: 'image_url',
    image_url: { url: c.image_url, ...(detail === undefined ? {} : { detail }) },
  };
}

/** 工具输出：字符串，或 input_text / input_image 部件的数组（view_image 等）。Chat 的 tool 消息只收文本。 */
function toolOutput(
  output: unknown,
  dropped: string[],
): { text: string; images: ChatContentPart[] } {
  if (typeof output === 'string') return { text: output, images: [] };
  if (!Array.isArray(output))
    return { text: output === undefined ? '' : JSON.stringify(output), images: [] };
  const texts: string[] = [];
  const images: ChatContentPart[] = [];
  for (const c of output as unknown[]) {
    if (!isObject(c)) continue;
    if (typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'input_image') {
      const image = imagePart(c);
      if (image === undefined) dropped.push('input_image:file_id');
      else images.push(image);
    } else dropped.push(`output:${String(c.type)}`);
  }
  return { text: texts.join('\n'), images };
}

/** reasoning 项的推理文本：先取 `content`（Codex 原样带回），没有时解网关自己写的 `encrypted_content`。 */
export function decodeReasoning(item: ResponsesItem): string {
  const content = item.content;
  if (Array.isArray(content) && content.length > 0) return textOf(content);
  const encrypted = item.encrypted_content;
  if (typeof encrypted === 'string' && encrypted.startsWith(ENCRYPTED_REASONING_PREFIX)) {
    return Buffer.from(encrypted.slice(ENCRYPTED_REASONING_PREFIX.length), 'base64').toString(
      'utf8',
    );
  }
  return '';
}

export function encodeReasoning(text: string): string {
  return ENCRYPTED_REASONING_PREFIX + Buffer.from(text, 'utf8').toString('base64');
}
