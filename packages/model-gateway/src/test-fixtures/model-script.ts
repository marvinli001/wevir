// 脚本化模型的公共部分。用例只描述“模型这一步做什么”（Reply），由 Responses mock 与 Chat mock 各自渲染成线上格式；另有异常：finish_reason、流中的错误、提前断开。

export interface ModelView {
  /** 第几个请求（从 0 起，每个 mock 各自计数）。 */
  index: number;
  /** 最后一条用户输入的文本。 */
  lastUserText: string;
}

export interface ToolCall {
  kind: 'function' | 'custom';
  name: string;
  /** Responses 的工具命名空间（如 multi_agent_v1）。 */
  namespace?: string;
  /** function：参数对象。 */
  args?: unknown;
  /** custom：自由文本输入（apply_patch 的补丁）。 */
  input?: string;
}

export interface Reply {
  reasoning?: string[];
  text?: string[];
  toolCalls?: ToolCall[];
  /** 每个分片之后停多久。 */
  delayMs?: number;
  /** 不发流，直接回 HTTP 错误；`body` 给了就原样作正文（测试错误正文的整理）。 */
  httpError?: { status: number; message?: string; code?: string; body?: string };
  /** Responses：流里发 response.failed。Chat：流里发 `{error}` 的 chunk。Messages：流里发 error 事件（code 是错误类型）。 */
  failed?: { code: string; message: string };
  /** Chat：finish_reason（默认按有无工具调用取 stop / tool_calls）；Messages：stop_reason（默认 end_turn / tool_use）。 */
  finishReason?: string;
  /** Messages：思考块不发签名（模拟不给签名的兼容服务）。 */
  noSignature?: boolean;
  /** Messages：思考块之后再发这些 redacted_thinking 块的 data。 */
  redacted?: string[];
  /** 发完内容后直接断开连接，不发结束标记。 */
  disconnect?: boolean;
  /** Chat / Messages：不按上面的字段渲染，直接发这些 `data:`（对象会 JSON 编码）。 */
  rawChunks?: unknown[];
}

export type Script = (view: ModelView) => Reply;

let callCounter = 0;
export function nextCallId(prefix: string): string {
  callCounter += 1;
  return `${prefix}_${callCounter}`;
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
