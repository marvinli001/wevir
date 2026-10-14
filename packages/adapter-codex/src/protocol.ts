// codex-app-server 协议里本包用到的子集，手写（不整批拷贝生成的类型）。每个类型注明它对应的生成文件，路径相对
// upstream/codex/codex-rs/app-server-protocol/schema/typescript/（锁定 rust-v0.162.1 = 092d3ac）。只写本包读写的
// 字段，其余字段按 `[key: string]: unknown` 不管；收到的消息不做 schema 校验，读之前自己检查要用的字段（mapping.ts）。
// 只用稳定面（`experimentalApi: false`，ADR-0005 决策 5）。升级时与新版本的 schema diff（ADR-0005 决策 7）。
//
// 线上格式：stdio 上逐行 JSON，形状是 JSON-RPC 2.0 但不带 "jsonrpc" 字段（app-server-protocol/src/rpc.rs:1-2）。

/** RequestId.ts */
export type RequestId = string | number;

/** 客户端发出的请求（JSONRPCRequest，没有 "jsonrpc"）。 */
export interface RpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

/** 服务端回复（JSONRPCResponse / JSONRPCError）。 */
export interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: RpcErrorBody;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** 通知（JSONRPCNotification）：没有 id。 */
export interface RpcNotification {
  method: string;
  params?: unknown;
}

// ── 握手 ─────────────────────────────────────────────────────────────────────────────

/** ClientInfo.ts */
export interface ClientInfo {
  /** 会成为发给模型服务的 `originator` 请求头与 User-Agent 前缀；OpenAI 要求写应用自己的名字（codex-notes §2.1）。 */
  name: string;
  title: string | null;
  version: string;
}

/** InitializeCapabilities.ts（只写本包设的两个必填字段，其余可选字段不发）。 */
export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
}

/** InitializeParams.ts */
export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

/** InitializeResponse.ts */
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ── Thread 与 Turn（v2/）────────────────────────────────────────────────────────────

/** v2/SandboxMode.ts */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** v2/AskForApproval.ts（只用字符串形式；`granular` 对象形式有实验字段）。 */
export type AskForApproval = 'untrusted' | 'on-request' | 'never';

/**
 * v2/ThreadStartParams.ts 的稳定字段里本包用到的。`config` 是按点分路径写的配置覆盖（与 `-c key=value` 相同），
 * 值是 JSON，Codex 转成 TOML 合并进这个 thread 的配置。
 */
export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
}

/** v2/Thread.ts（只读 id）。 */
export interface Thread {
  id: string;
  [key: string]: unknown;
}

/** v2/ThreadStartResponse.ts */
export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  reasoningEffort: string | null;
  [key: string]: unknown;
}

/** v2/UserInput.ts 的 `text` 变体（v0 只有文本）。 */
export interface TextUserInput {
  type: 'text';
  text: string;
  /** v2/TextElement.ts：界面定义的文本片段；Wevir 不用，发空数组。 */
  text_elements: never[];
}

/** v2/TurnStartParams.ts（只发必填字段）。 */
export interface TurnStartParams {
  threadId: string;
  input: TextUserInput[];
}

/** v2/TurnStatus.ts */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

/** v2/TurnError.ts。`codexErrorInfo` 是 v2/CodexErrorInfo.ts 的字符串或对象，原样保留。 */
export interface TurnError {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
  [key: string]: unknown;
}

/** v2/Turn.ts */
export interface Turn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  [key: string]: unknown;
}

/** v2/TurnStartResponse.ts */
export interface TurnStartResponse {
  turn: Turn;
}

/** v2/TurnInterruptParams.ts（响应 v2/TurnInterruptResponse.ts 是空对象）。 */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/** v2/ThreadUnsubscribeParams.ts */
export interface ThreadUnsubscribeParams {
  threadId: string;
}

/** v2/ThreadUnsubscribeStatus.ts */
export type ThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed';

/** v2/ThreadUnsubscribeResponse.ts */
export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
}

// ── Item（v2/ThreadItem.ts 的变体，只写映射用到的字段）────────────────────────────────

/** v2/CommandAction.ts */
export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string };

/** v2/CommandExecutionStatus.ts、v2/PatchApplyStatus.ts（另有 McpToolCallStatus 等没有 declined 的）。 */
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted';

/** v2/PatchChangeKind.ts */
export type PatchChangeKind =
  | { type: 'add' }
  | { type: 'delete' }
  | { type: 'update'; move_path: string | null };

/** v2/FileUpdateChange.ts */
export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

/** ThreadItem `agentMessage` */
export interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
}

/** ThreadItem `reasoning`：`summary` 与 `content`（原始推理）都是字符串数组。 */
export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  content: string[];
}

/** ThreadItem `commandExecution` */
export interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  status: ItemStatus;
  commandActions: CommandAction[];
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

/** ThreadItem `fileChange` */
export interface FileChangeItem {
  type: 'fileChange';
  id: string;
  changes: FileUpdateChange[];
  status: ItemStatus;
}

/** ThreadItem `mcpToolCall`（`result`、`error` 是 v2/McpToolCallResult.ts、v2/McpToolCallError.ts，原样保留）。 */
export interface McpToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  status: ItemStatus;
  arguments: unknown;
  result: unknown;
  error: { message?: string } | null;
}

/** ThreadItem `dynamicToolCall`（`contentItems` 是 v2/DynamicToolCallOutputContentItem.ts）。 */
export interface DynamicToolCallItem {
  type: 'dynamicToolCall';
  id: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
  status: ItemStatus;
  contentItems: Array<{ type: string; text?: string }> | null;
  success: boolean | null;
}

/** ThreadItem `collabAgentToolCall`（v2/CollabAgentTool.ts、v2/CollabAgentToolCallStatus.ts）。 */
export interface CollabAgentToolCallItem {
  type: 'collabAgentToolCall';
  id: string;
  tool: string;
  status: ItemStatus;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentsStates: Record<string, unknown>;
}

/** ThreadItem `webSearch`（WebSearchItem.ts）。 */
export interface WebSearchToolItem {
  type: 'webSearch';
  id: string;
  query: string;
}

/** ThreadItem `imageView` */
export interface ImageViewItem {
  type: 'imageView';
  id: string;
  path: string;
}

/** 映射成工具调用的 item（mapping.ts）。 */
export type ToolItem =
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
  | WebSearchToolItem
  | ImageViewItem;

/** 其余 item（userMessage、plan、contextCompaction 等）只看 `type` 与 `id`。 */
export interface OtherItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

// ── 通知的参数 ─────────────────────────────────────────────────────────────────────────

/** v2/ItemStartedNotification.ts、v2/ItemCompletedNotification.ts */
export interface ItemNotification {
  item: { type: string; id: string; [key: string]: unknown };
  threadId: string;
  turnId: string;
}

/**
 * v2/AgentMessageDeltaNotification.ts、v2/ReasoningTextDeltaNotification.ts（`contentIndex`）、
 * v2/ReasoningSummaryTextDeltaNotification.ts（`summaryIndex`）、v2/CommandExecutionOutputDeltaNotification.ts。
 */
export interface DeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex?: number;
  summaryIndex?: number;
}

/** v2/FileChangePatchUpdatedNotification.ts */
export interface PatchUpdatedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileUpdateChange[];
}

/** v2/McpToolCallProgressNotification.ts */
export interface McpProgressNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  message: string;
}

/** v2/TurnStartedNotification.ts、v2/TurnCompletedNotification.ts */
export interface TurnNotification {
  threadId: string;
  turn: Turn;
}

/** v2/TokenUsageBreakdown.ts */
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** v2/ThreadTokenUsageUpdatedNotification.ts（`tokenUsage` 是 v2/ThreadTokenUsage.ts）。 */
export interface TokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
}

/** v2/ErrorNotification.ts */
export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

// ── 服务端请求（ServerRequest.ts）──────────────────────────────────────────────────────

/** 审批类服务端请求（R3 处理；R2 一律拒绝，codex-adapter.ts）。 */
export const APPROVAL_REQUESTS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
] as const);

/**
 * 审批的回复：v2/CommandExecutionRequestApprovalResponse.ts 与 v2/FileChangeRequestApprovalResponse.ts 的
 * 字符串决定（v2/CommandExecutionApprovalDecision.ts、v2/FileChangeApprovalDecision.ts 的公共部分）。
 */
export interface ApprovalResponse {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}
