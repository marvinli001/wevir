import { z } from 'zod';
import {
  ApprovalIdSchema,
  ClientIdentitySchema,
  IsoTimeSchema,
  ProviderIdSchema,
  SeqCursorSchema,
  SessionIdSchema,
  StreamIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';

// 领域实体的线缆形状，字段含义见 docs/architecture/domain-model.md §3。

// ── Workspace ──────────────────────────────────────────────────────────

export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  /** 目录的 realpath；Host 按它去重。 */
  rootPath: z.string().min(1),
  displayName: z.string(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// ── ProviderProfile ────────────────────────────────────────────────────

export const ProviderKindSchema = z.enum(['deepseek-official', 'openai-compatible']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);
export type ProviderApi = z.infer<typeof ProviderApiSchema>;

/**
 * 推理档位（pi-ai 的 `ModelThinkingLevel`）。`off` 表示不带推理参数，其余原样作为 `reasoning_effort`
 * 发给服务端（docs/architecture/providers.md §2）。
 */
export const ProviderReasoningLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ProviderReasoningLevel = z.infer<typeof ProviderReasoningLevelSchema>;

export const ProviderModelSchema = z.object({
  /** 发给服务端的模型 ID。 */
  id: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.int().min(1).optional(),
  /** 最大输出 token（0.2.0）。省略时用 dsh 目录或路由的默认值。 */
  maxTokens: z.int().min(1).optional(),
  /** 是否接受图片输入（0.2.0）。省略时沿用 dsh 目录，目录里没有的模型只收文本。 */
  supportsImages: z.boolean().optional(),
  /**
   * 可选的推理档位（0.2.0），只对 `openai-compatible` 有意义。省略：沿用 dsh 目录（手填的模型不推理）；
   * 空数组：明确不推理。
   */
  reasoningEfforts: z.array(ProviderReasoningLevelSchema).optional(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/**
 * 请求格式的修正，只对 `openai-compatible` 有意义。前四个原样写进 dsh overlay 的 `compat`，Codex 引擎的模型网关
 * 也读它们（`thinkingFormat` 用于 `anthropic-messages`）；后两个只有模型网关用（0.4.0，model-gateway.md §4.4），
 * dsh 忽略。
 */
export const ProviderCompatSchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  thinkingFormat: z.string().optional(),
  requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
  /**
   * `openai-responses` 上游不支持自定义工具（Codex 的 `apply_patch`）时设 false（0.4.0）：网关把它们摊平成只有一个
   * 字符串参数的函数，响应里再还原。省略即支持。
   */
  supportsCustomTools: z.boolean().optional(),
  /**
   * `openai-completions` 上游怎样收对话中间的 developer / system 消息（0.4.0）：`inline`（默认）原位转 system；
   * `merge` 全部并进开头的一条 system；`user` 开头连续的并成一条 system，之后的转成注明来源的 user 消息。
   * `anthropic-messages` 上默认 `user`，`merge` 并进顶层 `system`。
   */
  systemMessageMode: z.enum(['inline', 'merge', 'user']).optional(),
});
export type ProviderCompat = z.infer<typeof ProviderCompatSchema>;

/** http / https 地址；允许 localhost 与 IP（本机模型服务）。 */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/** Key 不在 Profile 里，线缆上只暴露 `hasSecret`。 */
export const ProviderProfileSchema = z.object({
  id: ProviderIdSchema,
  kind: ProviderKindSchema,
  displayName: z.string(),
  /** `openai-compatible` 必有。 */
  api: ProviderApiSchema.optional(),
  /** `openai-compatible` 必有；`deepseek-official` 可选（覆盖官方地址）。 */
  baseURL: HttpUrlSchema.optional(),
  compat: ProviderCompatSchema.optional(),
  /** `deepseek-official` 可为空，用 dsh 自带目录。 */
  models: z.array(ProviderModelSchema),
  defaultModelId: z.string().min(1),
  hasSecret: z.boolean(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

// ── 错误分类 ───────────────────────────────────────────────────────────

export const EngineErrorCategorySchema = z.enum([
  'missing_credentials',
  'provider',
  'engine_exited',
  'cancel_unconfirmed',
  'session_unavailable',
  'unknown',
]);
export type EngineErrorCategory = z.infer<typeof EngineErrorCategorySchema>;

export const EngineErrorInfoSchema = z.object({
  category: EngineErrorCategorySchema,
  /** 引擎原文，始终保留。 */
  message: z.string(),
});
export type EngineErrorInfo = z.infer<typeof EngineErrorInfoSchema>;

// ── 工具展示、输出、待办 ────────────────────────────────────────────────

export const ToolDisplayKindSchema = z.enum([
  'shell',
  'read',
  'edit',
  'write',
  'search',
  'fetch',
  'plan',
  'sub_agent',
  'unknown',
]);
export type ToolDisplayKind = z.infer<typeof ToolDisplayKindSchema>;

export const ToolDisplaySchema = z.object({
  kind: ToolDisplayKindSchema,
  /** 一行摘要：路径、命令、查询词或 URL。 */
  summary: z.string().optional(),
  /** `rawInput` 原值，可能是相对路径。 */
  paths: z.array(z.string()).optional(),
  command: z.string().optional(),
  query: z.string().optional(),
  url: z.string().optional(),
  /** `mcp__<server>__<tool>` 的 server 部分。 */
  mcpServer: z.string().optional(),
});
export type ToolDisplay = z.infer<typeof ToolDisplaySchema>;

/** 截断规则见 host-api.md「工具输出截断上限」。 */
export const ToolOutputSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  /** 截断前的长度（UTF-16 code unit），只在 `truncated` 时出现。 */
  originalLength: z.int().min(0).optional(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

/**
 * 整个 JSON 值超过上限时的替身（host-api.md「工具输出截断上限」）。出现在 `input`、
 * `engine.raw.params` 这类 `unknown` 字段里；客户端看到 `$truncated: true` 就按它显示。
 */
export const TruncatedJsonSchema = z.object({
  $truncated: z.literal(true),
  /** 原值 `JSON.stringify` 后的长度（UTF-16 code unit）。 */
  originalLength: z.int().min(0),
  /** 原值 JSON 文本的开头。 */
  preview: z.string(),
});
export type TruncatedJson = z.infer<typeof TruncatedJsonSchema>;

export const TodoItemSchema = z.object({
  content: z.string(),
  /** dsh `todo_write` 原值（已见 pending / in_progress / completed），其他值原样保留。 */
  status: z.string(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const UsageSchema = z.object({
  contextUsed: z.int().min(0),
  contextSize: z.int().min(0),
});
export type Usage = z.infer<typeof UsageSchema>;

export const StreamBlockRefSchema = z.object({
  streamId: StreamIdSchema,
  blockIndex: z.int().min(0),
});
export type StreamBlockRef = z.infer<typeof StreamBlockRefSchema>;

// ── 用户消息内容 ────────────────────────────────────────────────────────

/** v0 只有文本；以后加图片等类型时按 `type` 扩展，并按客户端能力门控。 */
export const UserContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
]);
export type UserContentPart = z.infer<typeof UserContentPartSchema>;

// ── ApprovalRequest ───────────────────────────────────────────────────

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'cancelled',
  'expired',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalOptionSchema = z.object({
  /** 引擎原样，`approval.respond` 回传它。 */
  optionId: z.string().min(1),
  /** 引擎原样；界面按 `kind` 本地化，未知 `kind` 才显示它。 */
  label: z.string(),
  /** 引擎原样（ACP：allow_once / allow_always / reject_once / reject_always）。 */
  kind: z.string(),
  /** 由 `kind` 推导：`allow_` 开头为 allow，其余一律 reject。 */
  category: z.enum(['allow', 'reject']),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

export const ApprovalDetailSchema = z.object({
  toolName: z.string(),
  display: ToolDisplaySchema,
  /** `rawInput` 原样（截断后）；引擎没给时省略。 */
  input: z.unknown().optional(),
  justification: z.string().optional(),
  sandboxPermissions: z.string().optional(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;

export const ApprovalResolutionReasonSchema = z.enum([
  'user',
  'turn_cancelled',
  'session_closed',
  'engine_exited',
  'host_shutdown',
  'host_restarted',
]);
export type ApprovalResolutionReason = z.infer<typeof ApprovalResolutionReasonSchema>;

export const ApprovalResolutionSchema = z.object({
  /** `reason` 为 `user` 时必有。 */
  optionId: z.string().min(1).optional(),
  /** `reason` 为 `user` 时必有。 */
  decidedBy: ClientIdentitySchema.optional(),
  reason: ApprovalResolutionReasonSchema,
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export const ResolvedApprovalStatusSchema = ApprovalStatusSchema.exclude(['pending']);
export type ResolvedApprovalStatus = z.infer<typeof ResolvedApprovalStatusSchema>;

export const ApprovalRequestSchema = z.object({
  id: ApprovalIdSchema,
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  toolCallId: z.string(),
  options: z.array(ApprovalOptionSchema).min(1),
  /** 找不到对应 `tool.started` 时为 null。 */
  detail: ApprovalDetailSchema.nullable(),
  status: ApprovalStatusSchema,
  createdAt: IsoTimeSchema,
  resolvedAt: IsoTimeSchema.optional(),
  resolution: ApprovalResolutionSchema.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ── Session ───────────────────────────────────────────────────────────

export const SessionStateSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'cancelling',
  'error',
  'closed',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const ActiveTurnSchema = z.object({
  turnId: TurnIdSchema,
  startedAt: IsoTimeSchema,
  clientMessageId: z.string().optional(),
});
export type ActiveTurn = z.infer<typeof ActiveTurnSchema>;

/**
 * 标题从哪来：`first_prompt` 首条用户消息截断；`user` 用户改的；`generated` 用会话的模型生成（0.5.0，R3，
 * prompts/thread-title.md）。Host 只把 `generated` 发给声明了 `title_source_generated` 能力位的连接，其余连接
 * 看到的是 `first_prompt`（host-api.md §10）。
 */
export const TitleSourceSchema = z.enum(['first_prompt', 'user', 'generated']);
export type TitleSource = z.infer<typeof TitleSourceSchema>;

/**
 * 会话为什么只读（0.3.0，T3.5）：引擎会话恢复不了，历史仍在 Host 的事件库里，可以基于它新建会话。
 * - `engine_session_not_found`：引擎找不到这个会话（dsh 的会话日志被删除，例如引擎数据目录被清理）。
 * - `engine_session_incompatible`：当前引擎读不了它的格式（日志由更新、或没有升级路径的更旧版本写入）。
 * - `engine_session_corrupted`：引擎的会话日志损坏。
 */
export const SessionReadOnlyReasonSchema = z.enum([
  'engine_session_not_found',
  'engine_session_incompatible',
  'engine_session_corrupted',
]);
export type SessionReadOnlyReason = z.infer<typeof SessionReadOnlyReasonSchema>;

export const SessionReadOnlySchema = z.object({
  reason: SessionReadOnlyReasonSchema,
  /** 引擎原文。 */
  message: z.string(),
  /** 标为只读的时间（最近一条 `session.read_only` 的 `ts`）。 */
  since: IsoTimeSchema,
});
export type SessionReadOnly = z.infer<typeof SessionReadOnlySchema>;

// ── 子会话（0.6.0，R4） ─────────────────────────────────────────────────

/**
 * 子会话的状态（domain-model §3.3.1）：由子会话自己的事件推导。`running` 刚派出或回合进行中；回合结束后是
 * `completed` / `cancelled` / `failed`（回合失败或被中断）；父 agent 关掉它是 `closed`。
 */
export const SubagentStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'closed',
  'cancelled',
]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/** 子会话的 `Session.subagent`。 */
export const SubagentInfoSchema = z.object({
  /** 父会话里派出它的工具调用（Codex：`collabAgentToolCall` 的 item ID）。 */
  parentToolCallId: z.string().min(1),
  /** 认出它时父会话进行中的回合；在父会话的回合之外认出的没有。 */
  parentTurnId: TurnIdSchema.optional(),
  status: SubagentStatusSchema,
  /** 子会话 `session.created` 的时间。 */
  startedAt: IsoTimeSchema,
  /** 最近一次离开 `running` 的时间；`running` 时没有。 */
  endedAt: IsoTimeSchema.optional(),
});
export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;

/** 父会话快照的 `subagents` 与 `subagent.*` 事件里的一项：一个子会话的摘要。 */
export const SubagentSummarySchema = z.object({
  /** 子会话。 */
  sessionId: SessionIdSchema,
  parentToolCallId: z.string().min(1),
  parentTurnId: TurnIdSchema.optional(),
  /** 子会话当前的标题。 */
  title: z.string(),
  modelId: z.string().min(1),
  reasoningEffort: z.string().optional(),
  /** 引擎给子 agent 起的名字（Codex 的 `agentNickname`）；晚到，可能没有。 */
  nickname: z.string().optional(),
  /** 引擎的子 agent 类型（Codex 的 `agentRole`）。 */
  role: z.string().optional(),
  status: SubagentStatusSchema,
  startedAt: IsoTimeSchema,
  endedAt: IsoTimeSchema.optional(),
  /** 子会话的未决审批的副本（审批属于子会话，`approval.respond` 照常用它的 `id`）。 */
  pendingApprovals: z.array(ApprovalRequestSchema),
});
export type SubagentSummary = z.infer<typeof SubagentSummarySchema>;

export const SessionSchema = z.object({
  id: SessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** 创建时工作区 `rootPath` 的 realpath，不可变。 */
  cwd: z.string().min(1),
  /** 仅诊断用，客户端不得据此做任何操作。`kind` 是 Host 的引擎（`codex`、`dsh`、`echo`）。 */
  engine: z.object({ kind: z.string(), sessionId: z.string() }),
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  /** dsh 的 reasoning_effort 选项值，原样。 */
  reasoningEffort: z.string().optional(),
  title: z.string(),
  titleSource: TitleSourceSchema,
  state: SessionStateSchema,
  activeTurn: ActiveTurnSchema.optional(),
  lastError: EngineErrorInfoSchema.optional(),
  /**
   * 引擎会话恢复不了时有（0.3.0）：会话不能再发送，`session.resume` 会重试一次引擎，成功即清除。
   * 状态是 `error` 或 `closed`。
   */
  readOnly: SessionReadOnlySchema.optional(),
  /** 子会话的父会话（0.6.0）：引擎派出的子 agent，只读，由父 agent 驱动（domain-model §3.3.1）。 */
  parentSessionId: SessionIdSchema.optional(),
  /** 只有子会话有（0.6.0）。 */
  subagent: SubagentInfoSchema.optional(),
  createdAt: IsoTimeSchema,
  /** 最后一个事件的 `ts`。 */
  updatedAt: IsoTimeSchema,
  /** 会话里最后一个事件的 `seq`；新建会话为 1（`session.created`）。 */
  lastSeq: SeqCursorSchema,
});
export type Session = z.infer<typeof SessionSchema>;

/** `session.get` 的结果：由事件推导的快照（ADR-0002 §3）。 */
export const SessionSnapshotSchema = z.object({
  session: SessionSchema,
  pendingApprovals: z.array(ApprovalRequestSchema),
  /** 最近一次 `todo.updated`。 */
  todos: z.array(TodoItemSchema).optional(),
  /** 最近一次 `usage.updated`。 */
  usage: UsageSchema.optional(),
  /** 这个会话派出的子会话（0.6.0），按 `startedAt`；没有时省略。 */
  subagents: z.array(SubagentSummarySchema).optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
