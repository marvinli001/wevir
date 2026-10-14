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
  /** 不写 rollout、不进 `thread/list`：生成标题的临时 thread 用（终端界面 app/thread_title.rs 的做法）。 */
  ephemeral?: boolean | null;
}

/**
 * v2/ThreadResumeParams.ts 的稳定字段里本包用到的。按 `threadId` 从磁盘上的 rollout 恢复；thread 仍加载在进程里
 * 时重新订阅它（覆盖与当前设置不同的只在它空闲、没有订阅者时生效）。`excludeTurns`：不回放历史（Host 自己有）。
 */
export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  excludeTurns?: boolean;
}

/** v2/ThreadResumeResponse.ts（与 ThreadStartResponse 同样只读这几项）。 */
export type ThreadResumeResponse = ThreadStartResponse;

/**
 * v2/Thread.ts（只读这几项；都是稳定字段，`canAcceptDirectInput` 等实验字段不读）。子 agent 的 thread 有
 * `parentThreadId`、`agentNickname`、`agentRole`（R4，codex-notes §2.4）。
 */
export interface Thread {
  id: string;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  /** 界面给的 thread 名称（`thread/name/set`）。 */
  name?: string | null;
  [key: string]: unknown;
}

/** v2/ThreadReadParams.ts（`includeTurns` 不发：只要元数据）。 */
export interface ThreadReadParams {
  threadId: string;
}

/** v2/ThreadReadResponse.ts */
export interface ThreadReadResponse {
  thread: Thread;
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

/** v2/TurnStartParams.ts 的稳定字段里本包用到的。 */
export interface TurnStartParams {
  threadId: string;
  input: TextUserInput[];
  /** 这个回合及之后的模型（会话中换模型，0.9.0）。 */
  model?: string | null;
  /** 这个回合及之后的推理强度（ReasoningEffort.ts）。 */
  effort?: string | null;
  /** 约束最终助手消息的 JSON Schema（生成标题用）。 */
  outputSchema?: unknown;
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
  /** 这串工作的第一个回合（子 agent 的回合指向派出它的父回合，codex-notes §2.4）。旧记录里可能为 null。 */
  rootTurnId?: string | null;
  status: TurnStatus;
  error: TurnError | null;
  [key: string]: unknown;
}

/** v2/TurnStartResponse.ts */
export interface TurnStartResponse {
  turn: Turn;
}

/**
 * v2/TurnSteerParams.ts 的稳定字段（R11，codex-event-mapping.md §4.5）。`responsesapiClientMetadata`、`additionalContext`
 * 是实验字段，不用。
 */
export interface TurnSteerParams {
  threadId: string;
  input: TextUserInput[];
  /** 必须是进行中的回合，否则 app-server 拒绝。 */
  expectedTurnId: string;
  /** 回填到这次输入的 userMessage item 的 `clientId`，据此认出插话进了回合。 */
  clientUserMessageId?: string | null;
}

/** v2/TurnSteerResponse.ts */
export interface TurnSteerResponse {
  turnId: string;
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

/**
 * v2/CollabAgentStatus.ts：`pendingInit`、`running`、`interrupted`、`completed`、`errored`、`shutdown`、`notFound`
 * （等待或关闭一个不存在的子 agent 时）。
 */
export type CollabAgentStatus = string;

/** v2/CollabAgentState.ts */
export interface CollabAgentState {
  status: CollabAgentStatus;
  message: string | null;
}

/**
 * ThreadItem `collabAgentToolCall`（v2/CollabAgentTool.ts：`spawnAgent`、`sendInput`、`resumeAgent`、`wait`、`closeAgent`
 * 等；v2/CollabAgentToolCallStatus.ts）。`receiverThreadIds` 是子 agent 的 thread（spawn 时就是新派出的那个）。
 */
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
  agentsStates: Record<string, CollabAgentState | undefined>;
}

/** ThreadItem `userMessage`（v2/UserInput.ts）：只读文本。 */
export interface UserMessageItem {
  type: 'userMessage';
  id: string;
  /** `turn/start` / `turn/steer` 的 `clientUserMessageId`（R11 用插话的）；没给时为 null。 */
  clientId?: string | null;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
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

/** v2/ThreadNameUpdatedNotification.ts */
export interface ThreadNameUpdatedNotification {
  threadId: string;
  threadName?: string;
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

/** v2/TurnPlanStepStatus.ts */
export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

/** v2/TurnPlanStep.ts */
export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

/** v2/TurnPlanUpdatedNotification.ts：模型调 `update_plan` 时发，没有对应的 item。 */
export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
}

/**
 * v2/ServerRequestResolvedNotification.ts：一个服务端请求结束了。客户端回复之后紧接着到；回合在审批未决时被中断，
 * 它在 `turn/completed` 之后才到（codex-notes §2.3）。
 */
export interface ServerRequestResolvedNotification {
  threadId: string;
  requestId: RequestId;
}

// ── 服务端请求（ServerRequest.ts）──────────────────────────────────────────────────────

/**
 * 审批类服务端请求（codex-event-mapping.md §6.6）。`item/permissions/requestApproval` 只来自 `request_permissions`
 * 工具（`features.request_permissions_tool`，UnderDevelopment、默认关，Wevir 不开），不在这里。
 */
export const APPROVAL_REQUESTS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
] as const);

export type ApprovalRequestMethod = (typeof APPROVAL_REQUESTS)[number];

/** v2/CommandExecutionApprovalKind.ts：执行命令，或往已有终端写 stdin。 */
export type CommandExecutionApprovalKind = 'command' | 'writeStdin';

/**
 * v2/CommandExecutionRequestApprovalParams.ts 的稳定字段里本包读的。`approvalId` 只在 zsh 子命令与 stdin 的审批
 * 里有（同一个 item 可能有多次审批）；`availableDecisions` 是实验字段，拿不到（codex-notes §2.7）。
 */
export interface CommandExecutionRequestApprovalParams {
  kind?: CommandExecutionApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  /** “以后以这个前缀开头的命令不再问”的提议（R3 不做，codex-event-mapping.md §6.6）。 */
  proposedExecpolicyAmendment?: unknown;
}

/** v2/FileChangeRequestApprovalParams.ts。补丁内容不在请求里，在同一 itemId 的 fileChange item。 */
export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

/** v2/ToolRequestUserInputQuestion.ts（实验字段，0.10.0 的提问）。Codex 的问题都要有选项，`isOther` 恒为 true。 */
export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options: Array<{ label: string; description: string }> | null;
}

/** v2/ToolRequestUserInputParams.ts：`item/tool/requestUserInput` 的参数。 */
export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
  isBlocking?: boolean;
}

/** v2/ToolRequestUserInputResponse.ts：按问题 ID 的回答。 */
export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export const REQUEST_USER_INPUT = 'item/tool/requestUserInput';

/**
 * 审批的回复：v2/CommandExecutionRequestApprovalResponse.ts 与 v2/FileChangeRequestApprovalResponse.ts 的
 * 字符串决定（v2/CommandExecutionApprovalDecision.ts、v2/FileChangeApprovalDecision.ts 的公共部分；带 execpolicy
 * 或网络策略修订的对象形式不用）。
 */
export type ApprovalDecisionValue = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalResponse {
  decision: ApprovalDecisionValue;
}

// ── 账号（R6，ChatGPT 进程） ──────────────────────────────────────────────────────────────

/** v2/LoginAccountParams.ts 里 Wevir 用的两种：浏览器（`chatgpt`）与设备码（`chatgptDeviceCode`）。 */
export type LoginAccountParams = { type: 'chatgpt' } | { type: 'chatgptDeviceCode' };

/** v2/LoginAccountResponse.ts 里对应的两种。 */
export type LoginAccountResponse =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }
  | { type: string; [key: string]: unknown };

/** v2/CancelLoginAccountParams.ts / v2/CancelLoginAccountResponse.ts。 */
export interface CancelLoginAccountParams {
  loginId: string;
}
export interface CancelLoginAccountResponse {
  status: 'canceled' | 'notFound';
}

/** v2/AccountLoginCompletedNotification.ts（`account/login/completed`）。 */
export interface AccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

/** v2/AccountUpdatedNotification.ts（`account/updated`）：`authMode` 是 AuthMode.ts，`planType` 是 PlanType.ts。 */
export interface AccountUpdatedNotification {
  authMode: string | null;
  planType: string | null;
}

/** v2/Account.ts：Wevir 只认 `chatgpt`，其余（`apiKey`、`amazonBedrock`）按没有 ChatGPT 登录处理。 */
export type CodexAccount =
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: string; [key: string]: unknown };

/** v2/GetAccountParams.ts / v2/GetAccountResponse.ts（`account/read`）。 */
export interface GetAccountParams {
  refreshToken?: boolean;
}
export interface GetAccountResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

/** v2/RateLimitWindow.ts：`resetsAt` 是 Unix 秒。 */
export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/** v2/RateLimitSnapshot.ts 里本包读的。 */
export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
}

/** v2/GetAccountRateLimitsResponse.ts（`account/rateLimits/read`）里本包读的。 */
export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
}

/** v2/AccountRateLimitsUpdatedNotification.ts（`account/rateLimits/updated`，稀疏更新）。 */
export interface AccountRateLimitsUpdatedNotification {
  rateLimits: Partial<RateLimitSnapshot>;
}

/** v2/ModelListParams.ts / v2/ModelListResponse.ts（`model/list`）。 */
export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}
export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

/** v2/Model.ts 里本包读的；`supportedReasoningEfforts` 是 v2/ReasoningEffortOption.ts。 */
export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: string[];
  isDefault: boolean;
}
