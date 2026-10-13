// 脚本化模型的公共部分：场景只描述“模型这一步做什么”（Reply），由 Responses mock 与 Chat mock 各自渲染成线上格式。
// 这样同一个场景既能直连（Codex → Responses mock），也能走网关（Codex → 网关 → Chat mock）。

export interface ModelView {
  /** 第几个请求（从 0 起，每个 mock 各自计数）。 */
  index: number;
  /** 最后一条真正的用户输入（跳过 Codex 注入的 <environment_context> 等）。 */
  lastUserText: string;
  /** 最后一条用户输入之后已经回来的工具输出，按顺序。 */
  toolOutputs: string[];
  /** 请求里的全部文本（找历史里的暗号等）。 */
  allText: string;
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
  /** 只有 Responses mock 用：随推理项一起发的 encrypted_content（模拟 OpenAI）。 */
  encryptedReasoning?: string;
  text?: string[];
  toolCalls?: ToolCall[];
  /** 每个分片之后停多久。 */
  delayMs?: number;
  /** 不发流，直接回 HTTP 错误（模拟上游 4xx / 5xx）。 */
  httpError?: { status: number; message: string };
  /** 只有 Responses mock 用：流里发 response.failed。 */
  failed?: { code: string; message: string };
}

export type Script = (view: ModelView) => Reply;

let callCounter = 0;
export function nextCallId(prefix: string): string {
  callCounter += 1;
  return `${prefix}_${callCounter}`;
}
