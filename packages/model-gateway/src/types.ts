import type { ProviderCompatConfig, ProviderConfig } from '@wevir/runtime-adapter';

// 线上格式的子集：只写网关读写到的字段，其余字段按 `[key: string]: unknown` 原样保留。
// Responses 的形状以 Codex 的 ResponseItem（upstream/codex/codex-rs/protocol/src/models.rs）与
// 它解析流事件的规则（codex-api/src/sse/responses.rs）为准，Chat Completions 以 OpenAI 的公开 API 为准。

export type JsonObject = Record<string, unknown>;

/** Codex 发来的 `POST /responses` 请求体。 */
export interface ResponsesRequest {
  model: string;
  input: ResponsesItem[] | string;
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/** `input` 与输出里的一项（message、reasoning、function_call 等），按 `type` 区分。 */
export interface ResponsesItem {
  type: string;
  [key: string]: unknown;
}

/** `tools` 里的一项：function、custom（apply_patch）、namespace（multi_agent_v1）或托管工具。 */
export interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/** 一条 Responses 流事件（SSE 的 `data:`）。 */
export interface ResponsesEvent {
  type: string;
  [key: string]: unknown;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** 上游的扩展字段；Gemini 的 thought signature 在 `extra_content.google.thought_signature`（model-gateway.md §4.5）。 */
  extra_content?: JsonObject;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  reasoning_content?: string;
  /** 上游给出的结构化推理与签名，回传时保留（model-gateway.md §4.4）。 */
  reasoning_details?: JsonObject[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

/** 发给 Chat 上游的请求体。 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: ChatTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/** Anthropic Messages 的一个内容块（text、image、thinking、tool_use、tool_result 等），按 `type` 区分。 */
export interface MessagesBlock {
  type: string;
  [key: string]: unknown;
}

export interface MessagesMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessagesBlock[];
}

export interface MessagesTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

/** 发给 Anthropic Messages 上游的请求体。 */
export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: MessagesMessage[];
  stream: true;
  system?: MessagesBlock[];
  tools?: MessagesTool[];
  tool_choice?: unknown;
  thinking?: JsonObject;
  output_config?: JsonObject;
  [key: string]: unknown;
}

/**
 * 网关读的 compat 开关，与 Host 协议的 `ProviderCompat`（0.4.0、0.12.0 的网关开关，ADR-0005 补记 7、12）、
 * `@wevir/runtime-adapter` 的 `ProviderCompatConfig` 同形。这里只补网关对各字段的读法（model-gateway.md §4.4）。
 */
export interface GatewayCompat extends ProviderCompatConfig {
  /** Responses 上游不支持自定义工具（`custom`）时设 false：网关把它们摊平成函数，响应里再还原。默认 true。 */
  supportsCustomTools?: boolean;
  /** Responses 上游不支持 namespace 时设 false；省略时 xAI 地址默认 false，其余 true。 */
  supportsNamespaceTools?: boolean;
  /** 三种处理方式的工具选择限制；auto_only 的 none 只去掉 tool_choice、保留 tools。 */
  toolChoice?: 'any' | 'auto_only';
  /** Chat 工具 Schema 的 Gemini 清洗，省略或 false 关闭；经代理时可显式开启（§4.5）。 */
  geminiToolSchema?: boolean;
  /**
   * Chat 上游怎样收对话中间的 developer / system 消息：`inline`（默认）原位转 system；`merge` 全部并进开头的
   * 一条 system；`user` 开头连续的并成一条 system，之后的转成注明来源的 user 消息。
   * Messages 的当前四款 Claude 支持 `inline`：放在这一段 user 输入之后，官方地址默认开启；旧模型按 user。
   * 显式 `user` 保持注明来源的 user 消息，`merge` 并进顶层 system（model-gateway.md §5.1）。
   */
  systemMessageMode?: 'inline' | 'merge' | 'user';
  /**
   * 协议共用的字段（各家思考开关的写法）。Chat 读 openai / deepseek / qwen / zai / minimax / tencent
   * （model-gateway.md §4.4）；`anthropic-messages` 上：`adaptive` 发
   * `thinking: {type: adaptive}`，`enabled` 发 `thinking: {type: enabled, budget_tokens}`；不设时模型 ID 以
   * `claude-` 开头用 `adaptive`，其余用 `enabled`（model-gateway.md §5.4）。
   */
  thinkingFormat?: string;
  /**
   * Codex 的工具搜索（`tool_search`）：`native` 原样透传（OpenAI 官方 Responses 默认）；`dispatch` 翻译成普通函数、搜到的工具经
   * `call_tool` 分发（其余默认，tool-search.ts）；`off` 时 Codex 不开工具搜索（模型目录不写 `supports_search_tool`）。
   */
  toolSearch?: 'native' | 'dispatch' | 'off';
}

/** 网关接收的 Provider：Host 组装的 `ProviderConfig`（含 Key），compat 可以带网关自己的开关。 */
export interface GatewayProvider extends ProviderConfig {
  compat?: GatewayCompat;
}
