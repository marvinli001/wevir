// Responses 请求 → Anthropic Messages 请求（ADR-0005 决策 2.3）。映射表见 docs/architecture/model-gateway.md §5.1。
// 工具的摊平与 Chat 转换是同一套规则（tools.ts）。Anthropic 的思考块要原样带上签名才能带回，而 Codex 只会把
// reasoning 项原样放回 input，所以网关在响应里把思考文本与签名一起写进 reasoning 项的 encrypted_content
// （messages/response.ts），请求时从那里还原；没有签名的推理不发（model-gateway.md §5.3）。
// 做法参考 LiteLLM 的 Responses → Anthropic 转换（签名放进 encrypted_content，codex-notes §3.5），代码是自己写的。

import { createHash } from 'node:crypto';
import { SYSTEM_AS_USER_NOTE, textOf } from '../chat/request.js';
import { isAnthropicHost, isAzureHost } from '../providers.js';
import { compatibleToolChoice, isObject, ToolNames, toChatTools, withMcpNotes } from '../tools.js';
import type {
  GatewayProvider,
  JsonObject,
  MessagesBlock,
  MessagesMessage,
  MessagesRequest,
  MessagesTool,
  ResponsesItem,
  ResponsesRequest,
} from '../types.js';

/** 发给上游的 `anthropic-version` 请求头。 */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Provider 的模型没写 `maxTokens`、Codex 也没给 `max_output_tokens` 时的 `max_tokens`（model-gateway.md §5.4）。 */
export const DEFAULT_MAX_TOKENS = 32_000;

/** 网关写进 reasoning 项 `encrypted_content` 的前缀：后面是 ThinkingEnvelope 的 JSON 的 base64。 */
export const THINKING_ENVELOPE_PREFIX = 'wevir-gw:anthropic:v1:';

/** 一个思考块的原样内容，连同产生它的 Provider 与模型（签名只对产生它的模型有效）。 */
export interface ThinkingEnvelope {
  provider: string;
  model: string;
  type: 'thinking' | 'redacted_thinking';
  /** thinking：思考文本（`display: omitted` 时为空串）与签名，上游没给签名时没有 `signature`。 */
  thinking?: string;
  signature?: string;
  /** redacted_thinking：加密的 data。 */
  data?: string;
}

export function encodeThinking(envelope: ThinkingEnvelope): string {
  return (
    THINKING_ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
  );
}

export function decodeThinking(encrypted: unknown): ThinkingEnvelope | undefined {
  if (typeof encrypted !== 'string' || !encrypted.startsWith(THINKING_ENVELOPE_PREFIX)) return;
  try {
    const value = JSON.parse(
      Buffer.from(encrypted.slice(THINKING_ENVELOPE_PREFIX.length), 'base64').toString('utf8'),
    ) as unknown;
    if (!isObject(value) || typeof value.provider !== 'string' || typeof value.model !== 'string')
      return;
    if (value.type !== 'thinking' && value.type !== 'redacted_thinking') return;
    return value as unknown as ThinkingEnvelope;
  } catch {
    return;
  }
}

export interface MessagesTranslation {
  request: MessagesRequest;
  /** 本次请求的工具名登记，响应方向按它还原工具调用。 */
  names: ToolNames;
  /** 没有映射、丢掉的输入项与字段（`<item type>`、`tool:<type>`、`reasoning:unsigned` 等），测试与排查用。 */
  dropped: string[];
}

/** 请求体里网关不转给 Messages 上游的字段（Responses 专有，或 Messages 没有对应）。 */
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

/** `enabled` 思考的 `budget_tokens`：按 Codex 的推理档位取，不超过 `max_tokens - 1`，不低于 Anthropic 的下限 1024。 */
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 4000,
  medium: 10_000,
  high: 16_000,
  xhigh: 31_999,
  max: 31_999,
};
const MIN_THINKING_BUDGET = 1024;

/** Anthropic 的 `tool_use.id` 只能是 `^[a-zA-Z0-9_-]+$`。 */
const VALID_TOOL_USE_ID = /^[A-Za-z0-9_-]+$/;

/** 历史里有工具调用、本次却没有工具时补的占位工具的描述（压缩请求就是这样，样本 `4-compact`）。 */
export const PLACEHOLDER_TOOL_DESCRIPTION =
  'A tool used earlier in this conversation. It is not available in this request.';

/** 开启缓存的块：Anthropic 官方要显式标注才缓存；兼容服务多半忽略这个字段。 */
const CACHE_CONTROL = { type: 'ephemeral' } as const;

/** 只认已核对的当前四款模型（可带日期后缀），不推测新型号的关闭思考与 forced choice 规则。 */
function currentClaude(model: string): 'opus' | 'sonnet' | 'haiku' | 'fable' | undefined {
  const bare = bareClaude(model);
  const match = /^claude-(opus|sonnet|haiku)-5-5(?:$|-)/i.exec(bare);
  if (match !== null) return match[1]?.toLowerCase() as 'opus' | 'sonnet' | 'haiku';
  if (/^claude-fable-5-1(?:$|-)/i.test(bare)) return 'fable';
  return undefined;
}

/** Bedrock 的模型 ID 带 `anthropic.` 前缀（Mantle 的 `anthropic.claude-opus-5-5`）；判断型号前去掉。 */
function bareClaude(model: string): string {
  return model.replace(/^anthropic\./i, '');
}

/** Claude 4.7 起拒收采样参数；非 Claude 模型与旧版本不改。 */
function fixedSampling(model: string): boolean {
  const version = /^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?=$|-))?(?:$|-)/i.exec(bareClaude(model));
  const major = Number(version?.[1] ?? 0);
  const minor = Number(version?.[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7);
}

export function toMessagesRequest(
  original: ResponsesRequest,
  provider: GatewayProvider,
): MessagesTranslation {
  const body = withMcpNotes(original);
  const compat = provider.compat ?? {};
  const azure = isAzureHost(provider.baseURL ?? '');
  const official =
    provider.kind === 'google-vertex' || isAnthropicHost(provider.baseURL ?? '') || azure;
  // Foundry 的 model 可以是任意部署别名；未显式指定格式时按当前 Claude 用 adaptive（§3.5）。
  const thinkingFormat = compat.thinkingFormat ?? (azure ? 'adaptive' : undefined);
  // 代理用显式 adaptive 开启 Claude 方言；不把其他 Messages 服务当作 Anthropic。
  const claudeDialect = official || compat.thinkingFormat === 'adaptive';
  const model = currentClaude(body.model);
  const names = new ToolNames();
  const dropped: string[] = [];
  const tools: MessagesTool[] = toChatTools(body.tools, names, dropped).map(({ function: fn }) => ({
    name: fn.name,
    ...(fn.description === undefined ? {} : { description: fn.description }),
    input_schema: fn.parameters,
  }));
  const { system, messages, toolNamesInHistory } = toMessages(body, {
    names,
    dropped,
    systemMode: compat.systemMessageMode ?? (official && model !== undefined ? 'inline' : 'user'),
    inlineSystem: model !== undefined,
    provider: provider.id,
    model: body.model,
  });
  const maxTokens =
    typeof body.max_output_tokens === 'number'
      ? body.max_output_tokens
      : (provider.models.find((m) => m.id === body.model)?.maxTokens ?? DEFAULT_MAX_TOKENS);
  const request: MessagesRequest = {
    model: body.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  if (system.length > 0) {
    request.system = system.map((text) => ({ type: 'text', text }));
    markCache(request.system);
  }
  if (tools.length > 0) {
    request.tools = tools;
    let toolChoice = body.tool_choice;
    if (compat.toolChoice !== undefined) {
      toolChoice = compatibleToolChoice(toolChoice, compat.toolChoice);
    } else if (claudeDialect && model !== undefined && model !== 'haiku') {
      if (toolChoice === 'required' || isObject(toolChoice)) toolChoice = 'auto';
    }
    const choice = toMessagesToolChoice(toolChoice, body.parallel_tool_calls, names);
    if (choice !== undefined) request.tool_choice = choice;
  } else if (toolNamesInHistory.size > 0) {
    // Anthropic 要求历史里有 tool_use / tool_result 时请求必须定义工具：补上同名的占位工具，并禁止调用。
    request.tools = [...toolNamesInHistory].map((name) => ({
      name,
      description: PLACEHOLDER_TOOL_DESCRIPTION,
      input_schema: { type: 'object', properties: {} },
    }));
    request.tool_choice = { type: 'none' };
  }
  const last = messages.at(-1);
  if (last !== undefined) markCache(last.content);
  Object.assign(request, thinkingParams(body, thinkingFormat, maxTokens, claudeDialect));
  for (const key of ['temperature', 'top_p'] as const) {
    if (typeof body[key] !== 'number') continue;
    if (claudeDialect && fixedSampling(body.model)) dropped.push(`field:${key}`);
    else request[key] = body[key];
  }
  const format = isObject(body.text) ? body.text.format : undefined;
  if (isObject(format) && format.type === 'json_schema') {
    request.output_config = {
      ...request.output_config,
      format: { type: 'json_schema', schema: format.schema },
    };
  }
  for (const key of DROPPED_FIELDS) if (body[key] !== undefined) dropped.push(`field:${key}`);
  return { request, names, dropped };
}

/**
 * `reasoning.effort` → 思考开关：当前 Claude 的默认与 none 按型号处理（§5.4）；其他模型没有档位不发、none 关思考。
 * 其余按 `thinkingFormat` 发
 * `adaptive`（Claude 4.6 起）或 `enabled` + `budget_tokens`（更早的 Claude、DeepSeek 等兼容服务；`max_tokens` 不够
 * 1025 时不开），档位放进 `output_config.effort`（`minimal` 写成 `low`）。
 */
function thinkingParams(
  body: ResponsesRequest,
  thinkingFormat: string | undefined,
  maxTokens: number,
  claudeDialect: boolean,
): Pick<MessagesRequest, 'thinking' | 'output_config'> {
  const reasoning = isObject(body.reasoning) ? body.reasoning : {};
  const model = claudeDialect ? currentClaude(body.model) : undefined;
  const requested = reasoning.effort;
  if (typeof requested !== 'string' || requested === '') {
    if (model === undefined) return {};
    return { output_config: { effort: model === 'opus' || model === 'haiku' ? 'medium' : 'high' } };
  }
  let effort = requested;
  if (effort === 'none') {
    if (model === undefined) return { thinking: { type: 'disabled' } };
    const output_config = { effort: 'low' };
    if (model === 'sonnet') return { thinking: { type: 'between_tools' }, output_config };
    if (model === 'haiku') return { thinking: { type: 'disabled' }, output_config };
    effort = 'low';
  }
  const output_config = { effort: effort === 'minimal' ? 'low' : effort };
  const format =
    thinkingFormat ?? (/^claude-/i.test(bareClaude(body.model)) ? 'adaptive' : 'enabled');
  if (format === 'adaptive') {
    const summary = reasoning.summary;
    const display =
      typeof summary === 'string' && summary !== 'none' ? { display: 'summarized' } : {};
    return { thinking: { type: 'adaptive', ...display }, output_config };
  }
  if (maxTokens <= MIN_THINKING_BUDGET) return { output_config };
  const budget = Math.max(
    MIN_THINKING_BUDGET,
    Math.min(THINKING_BUDGETS[effort] ?? THINKING_BUDGETS.high ?? 16_000, maxTokens - 1),
  );
  return { thinking: { type: 'enabled', budget_tokens: budget }, output_config };
}

function toMessagesToolChoice(
  choice: unknown,
  parallel: unknown,
  names: ToolNames,
): JsonObject | undefined {
  const single = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any', ...single };
  if (isObject(choice) && (choice.type === 'function' || choice.type === 'custom')) {
    const name = names.flat({
      kind: choice.type,
      name: String(choice.name ?? ''),
      namespace: typeof choice.namespace === 'string' ? choice.namespace : undefined,
    });
    return { type: 'tool', name, ...single };
  }
  return parallel === false ? { type: 'auto', ...single } : undefined;
}

function markCache(blocks: MessagesBlock[]): void {
  const last = blocks.at(-1);
  if (last !== undefined && last.type !== 'thinking' && last.type !== 'redacted_thinking') {
    last.cache_control = CACHE_CONTROL;
  }
}

interface MessageContext {
  names: ToolNames;
  dropped: string[];
  systemMode: 'inline' | 'merge' | 'user';
  inlineSystem: boolean;
  provider: string;
  model: string;
}

function toMessages(
  body: ResponsesRequest,
  ctx: MessageContext,
): { system: string[]; messages: MessagesMessage[]; toolNamesInHistory: Set<string> } {
  const system: string[] = [];
  const messages: MessagesMessage[] = [];
  const toolNamesInHistory = new Set<string>();
  // 推理之后、assistant 输出之前的思考块：等到有文本或工具调用时挂到同一条 assistant 消息的开头。
  let pendingThinking: MessagesBlock[] = [];
  let pendingSystem: MessagesBlock[] = [];

  const push = (role: MessagesMessage['role'], blocks: MessagesBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    // 相邻的同角色消息合并成一条（不是每家兼容服务都会自己合并）。
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const user = (blocks: MessagesBlock[]) => {
    if (pendingThinking.length > 0) {
      // 推理之后没有任何输出就换了说话人（回合被中断）：没有可挂的 assistant 消息，丢掉。
      ctx.dropped.push('reasoning:orphan');
      pendingThinking = [];
    }
    push('user', blocks);
  };
  const assistant = (blocks: MessagesBlock[]) => {
    if (blocks.length === 0) return;
    flushSystem();
    push('assistant', [...pendingThinking, ...blocks]);
    pendingThinking = [];
  };
  const developer = (text: string) => {
    if (text === '') return;
    // inline 要等这一段 user 输入（包括全部 tool_result）到齐，避免夹在 tool_use 与结果之间或紧邻下一个 user。
    if (ctx.systemMode === 'merge' || messages.length === 0) system.push(text);
    else if (ctx.systemMode === 'inline' && ctx.inlineSystem)
      pendingSystem.push({ type: 'text', text });
    else user([{ type: 'text', text: `${SYSTEM_AS_USER_NOTE}\n${text}` }]);
  };
  const flushSystem = () => {
    if (pendingSystem.length === 0) return;
    if (messages.at(-1)?.role === 'user') push('system', pendingSystem);
    else {
      // 没有后续 user 输入时不能追加 system；用原有的注明来源的 user 形式。
      user(pendingSystem.map((b) => ({ type: 'text', text: `${SYSTEM_AS_USER_NOTE}\n${b.text}` })));
    }
    pendingSystem = [];
  };

  if (typeof body.instructions === 'string') developer(body.instructions);
  const input: ResponsesItem[] =
    typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }]
      : body.input;

  for (const item of input) {
    switch (item.type) {
      case 'message': {
        if (item.role === 'assistant') {
          const text = textOf(item.content);
          assistant(text === '' ? [] : [{ type: 'text', text }]);
        } else if (item.role === 'developer' || item.role === 'system') {
          developer(textOf(item.content));
        } else {
          user(userBlocks(item.content, ctx.dropped));
        }
        break;
      }
      case 'reasoning': {
        const block = thinkingBlock(item, ctx);
        if (block !== undefined) pendingThinking.push(block);
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const custom = item.type === 'custom_tool_call';
        const name = ctx.names.flat({
          kind: custom ? 'custom' : 'function',
          name: String(item.name ?? ''),
          namespace: typeof item.namespace === 'string' ? item.namespace : undefined,
        });
        toolNamesInHistory.add(name);
        assistant([
          {
            type: 'tool_use',
            id: toolUseId(item.call_id),
            name,
            input: custom
              ? { input: typeof item.input === 'string' ? item.input : '' }
              : toolInput(item.arguments, ctx.dropped),
          },
        ]);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        user([
          {
            type: 'tool_result',
            tool_use_id: toolUseId(item.call_id),
            ...toolResultContent(item.output, ctx.dropped),
          },
        ]);
        break;
      default:
        ctx.dropped.push(item.type);
    }
  }
  flushSystem();
  if (pendingThinking.length > 0) ctx.dropped.push('reasoning:orphan');
  // 同一条 user 消息里 tool_result 必须在最前面（Anthropic 的规则；文本只能跟在后面）。
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const results = message.content.filter((b) => b.type === 'tool_result');
    if (results.length === 0) continue;
    message.content = [...results, ...message.content.filter((b) => b.type !== 'tool_result')];
  }
  return { system, messages, toolNamesInHistory };
}

/**
 * reasoning 项 → 思考块：只认网关自己写的 encrypted_content，而且必须是同一个 Provider 与模型产生的、带签名的
 * （redacted_thinking 带 data）。没有签名（来自 Chat、Responses 上游或别的 Provider / 模型）就不发：Anthropic
 * 会拒绝没有签名的思考块，签名换了模型也无效。
 */
function thinkingBlock(item: ResponsesItem, ctx: MessageContext): MessagesBlock | undefined {
  const envelope = decodeThinking(item.encrypted_content);
  if (envelope === undefined) {
    ctx.dropped.push('reasoning:unsigned');
    return;
  }
  if (envelope.provider !== ctx.provider || envelope.model !== ctx.model) {
    ctx.dropped.push('reasoning:other_model');
    return;
  }
  if (envelope.type === 'redacted_thinking' && typeof envelope.data === 'string') {
    return { type: 'redacted_thinking', data: envelope.data };
  }
  if (typeof envelope.signature !== 'string' || envelope.signature === '') {
    ctx.dropped.push('reasoning:unsigned');
    return;
  }
  return { type: 'thinking', thinking: envelope.thinking ?? '', signature: envelope.signature };
}

/** Codex 的 call_id → Anthropic 的 tool_use id。不合规则的（来自别的上游）换成确定性的哈希，调用与结果对得上。 */
export function toolUseId(callId: unknown): string {
  const id = typeof callId === 'string' ? callId : '';
  if (VALID_TOOL_USE_ID.test(id)) return id;
  return `toolu_wevir_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}

/** function_call 的参数（JSON 字符串）→ tool_use 的 input（对象）。不是 JSON 对象时用空对象（与 dsh 相同）。 */
function toolInput(args: unknown, dropped: string[]): JsonObject {
  try {
    const value = JSON.parse(String(args ?? '')) as unknown;
    if (isObject(value)) return value;
  } catch {
    // 落到下面。
  }
  dropped.push('arguments:not_object');
  return {};
}

/** user 消息的内容：input_text → text（空文本不发，Anthropic 拒收空文本块），input_image → image。 */
function userBlocks(content: unknown, dropped: string[]): MessagesBlock[] {
  if (!Array.isArray(content)) {
    const text = textOf(content);
    return text === '' ? [] : [{ type: 'text', text }];
  }
  const blocks: MessagesBlock[] = [];
  for (const c of content as unknown[]) {
    if (!isObject(c)) continue;
    if (typeof c.text === 'string') {
      if (c.text !== '') blocks.push({ type: 'text', text: c.text });
    } else if (c.type === 'input_image') {
      const image = imageBlock(c, dropped);
      if (image !== undefined) blocks.push(image);
    } else dropped.push(String(c.type));
  }
  return blocks;
}

/** input_image → image：base64 的 data URL 拆成 media_type 与 data，网址用 url 来源；`file_id` 与其他 data URL 没法转。 */
function imageBlock(c: JsonObject, dropped: string[]): MessagesBlock | undefined {
  const url = c.image_url;
  if (typeof url !== 'string') {
    dropped.push('input_image:file_id');
    return;
  }
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data !== null) {
    return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  dropped.push('input_image:unsupported_url');
  return;
}

/** 工具输出：字符串原样；部件数组里的文本与图片都放进 tool_result（Messages 的 tool_result 收图片）。 */
function toolResultContent(output: unknown, dropped: string[]): { content?: unknown } {
  if (typeof output === 'string') return output === '' ? {} : { content: output };
  if (!Array.isArray(output))
    return output === undefined ? {} : { content: JSON.stringify(output) };
  const blocks: MessagesBlock[] = [];
  for (const c of output as unknown[]) {
    if (!isObject(c)) continue;
    if (typeof c.text === 'string') {
      if (c.text !== '') blocks.push({ type: 'text', text: c.text });
    } else if (c.type === 'input_image') {
      const image = imageBlock(c, dropped);
      if (image !== undefined) blocks.push(image);
    } else dropped.push(`output:${String(c.type)}`);
  }
  return blocks.length === 0 ? {} : { content: blocks };
}
