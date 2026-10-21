import { z } from 'zod';
import {
  ApprovalIdSchema,
  ClientIdentitySchema,
  IsoTimeSchema,
  PendingMessageIdSchema,
  ProviderIdSchema,
  QuestionIdSchema,
  SeqSchema,
  SessionIdSchema,
  StreamIdSchema,
  TaskIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import {
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  BoardTaskSchema,
  CHAPTER_SUMMARY_MAX_LENGTH,
  CHAPTER_TITLE_MAX_LENGTH,
  CollaborationModeSchema,
  CompactionTriggerSchema,
  EngineErrorCategorySchema,
  FilesRestoreSchema,
  HandoffHashSchema,
  HandoffNoteRefSchema,
  HandoffOmittedRangeSchema,
  HandoffStrategySchema,
  MessageFromSchema,
  PendingMessageSchema,
  PermissionModeSchema,
  PromptSuggestionSchema,
  QuestionRequestSchema,
  QuestionResolutionSchema,
  ResolvedApprovalStatusSchema,
  SecondOpinionSchema,
  SessionEnvironmentFields,
  SessionGoalSchema,
  SessionInsightSchema,
  SessionMoveSchema,
  SessionOpenedBySchema,
  SessionOpinionOfSchema,
  SessionReadOnlyReasonSchema,
  SessionRulesSchema,
  SessionSideFields,
  SessionStateSchema,
  SHARED_FILES_MAX,
  SharedFileSchema,
  StreamBlockRefSchema,
  SubagentSummarySchema,
  SuggestedTaskSchema,
  TitleSourceSchema,
  TodoItemSchema,
  ToolDisplaySchema,
  ToolOutputSchema,
  ToolPresetSchema,
  TurnCommandSchema,
  TurnOutcomeSchema,
  TurnTriggerSchema,
  UiShowTargetSchema,
  UsageBreakdownSchema,
  UserContentPartSchema,
} from './entities.js';
import { GuardrailBlockedSchema } from './guardrails.js';
import {
  REVIEW_FINDINGS_MAX,
  REVIEW_SUMMARY_MAX_LENGTH,
  ReviewFindingSchema,
  ReviewFindingsOriginSchema,
} from './review.js';
import {
  RepairChainSchema,
  SessionAcceptanceSchema,
  VerificationRunSchema,
} from './verification.js';

// 会话事件目录 v0，含义与来源见 docs/architecture/domain-model.md §6。

export const EventSourceSchema = z.enum(['host', 'engine']);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const StateChangeReasonSchema = z.enum([
  'turn_started',
  'approval_requested',
  'approvals_settled',
  'cancel_requested',
  'turn_finished',
  'cancel_unconfirmed',
  'engine_exited',
  'resume_failed',
  'resumed',
  'closed',
  'host_restarted',
]);
export type StateChangeReason = z.infer<typeof StateChangeReasonSchema>;

export const ToolFinishStatusSchema = z.enum(['completed', 'failed', 'cancelled', 'unknown']);
export type ToolFinishStatus = z.infer<typeof ToolFinishStatusSchema>;

/** 每种事件的 payload。键就是事件的 `type`。 */
export const EventPayloadSchemas = {
  'session.created': z.object({
    workspaceId: WorkspaceIdSchema,
    cwd: z.string().min(1),
    providerId: ProviderIdSchema,
    modelId: z.string().min(1),
    reasoningEffort: z.string().optional(),
    /** 权限模式（0.11.0）；省略表示 `on_request`。 */
    permissionMode: PermissionModeSchema.optional(),
    /** 建立引擎会话的引擎版本（0.3.0；dsh：`@deepseek-ai/dsh` 的包版本）。适配器不报时省略。 */
    engineVersion: z.string().optional(),
    /** 环境会话（0.15.0，domain-model §3.10）。 */
    ...SessionEnvironmentFields,
    /** 支线会话（0.17.0，domain-model §3.12）。 */
    ...SessionSideFields,
    /** 由另一个会话里的 agent 开出来的（0.30.0）。 */
    openedBy: SessionOpenedBySchema.optional(),
    /** 给另一个会话第二意见的会话（0.75.0）。 */
    opinionOf: SessionOpinionOfSchema.optional(),
    /** 工具预设（0.61.0）；没选时省略，等同 `full`。 */
    toolPreset: ToolPresetSchema.optional(),
    /** 只有子会话有（0.6.0，domain-model §3.3.1）：父会话与派出它的工具调用。 */
    parent: z
      .object({
        sessionId: SessionIdSchema,
        /** 父会话里派出它的工具调用。 */
        toolCallId: z.string().min(1),
        /** 认出它时父会话进行中的回合。 */
        turnId: TurnIdSchema.optional(),
      })
      .optional(),
  }),
  /**
   * 引擎会话重新挂上（0.3.0）：`session.resume`，或 send 前的自动 resume。引擎不回放历史，这条事件之前的
   * 历史都来自事件库。
   */
  'session.resumed': z.object({
    /** 恢复引擎会话的引擎版本，与 `session.created` 的对比可看出是否跨了版本。适配器不报时省略。 */
    engineVersion: z.string().optional(),
  }),
  /** 引擎会话恢复不了，会话只读（0.3.0）。之后的 `session.resumed` 解除。 */
  'session.read_only': z.object({
    reason: SessionReadOnlyReasonSchema,
    /** 引擎原文。 */
    message: z.string(),
  }),
  'session.title_changed': z.object({
    title: z.string(),
    source: TitleSourceSchema,
    /** 模型生成标题时一并给出的检索摘要（0.5.0）；留给以后的会话搜索。 */
    description: z.string().optional(),
  }),
  /**
   * 会话的目标变了（0.35.0，domain-model §3.16）：设置、状态或用量变化时带完整的目标，清除时 `goal` 为 `null`。来自引擎（Codex 的
   * `thread/goal/updated` / `thread/goal/cleared`），回合之内或之间都可能。
   */
  'session.goal_changed': z.object({
    goal: SessionGoalSchema.nullable(),
  }),
  /**
   * 会话的模型、推理档位或权限模式改了（0.9.0，`session.configure`），带改后的全部值；从下一个回合起生效。没有
   * `reasoningEffort` 表示用模型的默认档位；没有 `permissionMode`（0.11.0 之前的 Host）表示 `on_request`。
   */
  'session.configured': z.object({
    modelId: z.string().min(1),
    reasoningEffort: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
  }),
  /**
   * 会话换到了别的来源（0.25.0，`session.configure` 带别的 `providerId`，domain-model §3.14）：之后的回合交给 `to` 的引擎会话，
   * `providerId`、模型、推理档位与权限模式都换成这里的值。`context` 是交给新引擎的历史摘要，随下一条消息的开头交过去；没有要补的
   * 历史时省略。会话原来是 `error` 或 `closed` 时，同一事务里接着写转 `idle`（`resumed`），只读随之解除。
   */
  'session.handoff': z.object({
    from: z.object({
      providerId: ProviderIdSchema,
      modelId: z.string().min(1),
      engineSessionId: z.string().min(1),
    }),
    to: z.object({
      providerId: ProviderIdSchema,
      modelId: z.string().min(1),
      engineSessionId: z.string().min(1),
    }),
    reasoningEffort: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    /** true：接着用这个来源以前的引擎会话（只补它错过的）；false：新建的引擎会话。 */
    resumed: z.boolean(),
    strategy: HandoffStrategySchema,
    /** 摘要覆盖的事件（含两端）；没有要补的时省略。 */
    covered: z.object({ fromSeq: SeqSchema, toSeq: SeqSchema }).optional(),
    /** 摘要里的条目数，与因长度预算省掉的条目数。 */
    items: z.int().min(0),
    omittedItems: z.int().min(0),
    context: z.string().min(1).optional(),
    /** 建立或恢复 `to` 的引擎版本。适配器不报时省略。 */
    engineVersion: z.string().optional(),
    /**
     * 递交记录（0.59.0，有 `context` 时才有）：材料的 UTF-8 字节数、预算与散列，省掉的历史条目是哪几段，新来源能不能用读历史的工具，
     * 用户标为必须携带的约束有几条（正文在 `context` 里），选入了哪几条笔记、各是哪一版。0.59.0 之前的 Host 不写。
     */
    bytes: z.int().min(1).optional(),
    budgetBytes: z.int().min(1).optional(),
    hash: HandoffHashSchema.optional(),
    omitted: z.array(HandoffOmittedRangeSchema).optional(),
    historyTool: z.boolean().optional(),
    constraints: z.int().min(1).optional(),
    notes: z.array(HandoffNoteRefSchema).min(1).optional(),
  }),
  /**
   * 会话当前的来源加载了哪些规则文件（0.68.0，Host 功能 `rule_files`，domain-model §3.27）：建会话、接力之后，以及恢复引擎会话时
   * 列表变了才写。`engineSessionId` 是这份规则给的引擎会话。`channel` 是 `message` 时 `context` 是补给的正文，随下一条消息的开头交
   * 给引擎（同接力摘要，回合结束后算交过）；`instructions` 方式的正文每次建立或恢复引擎会话时由 Host 重新读文件，不记在事件里。
   */
  'session.rules': SessionRulesSchema.extend({
    engineSessionId: z.string().min(1),
    context: z.string().min(1).optional(),
  }),
  /**
   * 会话换了目录（0.81.0，`session.move`，Host 功能 `session_move`，domain-model §3.36）：之后的回合在 `cwd` 里跑，`Session.cwd` 与
   * `worktrees` 已经改过。`engine` 是 `handoff` 时紧接着写同一来源的 `session.handoff`；会话原来是 `error` 或 `closed` 时接着转
   * `idle`（`resumed`）。
   */
  'session.moved': SessionMoveSchema,
  'session.state_changed': z.object({
    from: SessionStateSchema,
    to: SessionStateSchema,
    reason: StateChangeReasonSchema,
  }),
  'user.message': z.object({
    turnId: TurnIdSchema,
    clientMessageId: z.string().optional(),
    content: z.array(UserContentPartSchema).min(1),
    sentBy: ClientIdentitySchema,
    /** 这个回合由一条排队的待发消息开始（0.8.0，domain-model §4.6）。 */
    pendingId: PendingMessageIdSchema.optional(),
    /** 别的会话发来的（0.30.0，应用级工具）。 */
    from: MessageFromSchema.optional(),
    /** 这个回合的协作模式（0.36.0）；省略表示 `default`。 */
    collaborationMode: CollaborationModeSchema.optional(),
  }),
  'turn.started': z.object({
    turnId: TurnIdSchema,
    /**
     * 子会话（0.6.0）：回合由引擎开始，这是父 agent 给它的输入（任务描述，或 `send_input` 发来的消息）。普通会话的
     * 输入在同一回合的 `user.message`。
     */
    input: z.array(UserContentPartSchema).min(1).optional(),
    /** 回合由命令开始（0.24.0，`session.compact` / `session.review`），没有 `user.message`。 */
    command: TurnCommandSchema.optional(),
    /** 回合怎么开始的（0.35.0）：`goal` 为会话目标工作；引擎自己开的目标回合没有 `user.message`。 */
    trigger: TurnTriggerSchema.optional(),
  }),
  'turn.finished': z.object({
    turnId: TurnIdSchema,
    outcome: TurnOutcomeSchema,
    /** 引擎原值。 */
    engineStopReason: z.string().optional(),
    durationMs: z.int().min(0),
  }),
  /**
   * 回合被撤回（0.38.0，`session.rewind`）：这个回合（会话最后一个完成的回合）的用户消息与回答从消息记录里去掉，引擎的上下文也回到
   * 它之前。事件本身还在事件流里。
   */
  'turn.rewound': z.object({
    turnId: TurnIdSchema,
  }),
  /**
   * 回合被撤销（0.51.0，`session.undo`，domain-model §3.22）：这个回合（会话最后一个看得见的回合）从消息记录里隐藏，会话目录里的文件
   * 回到回合开始前（`files` 说文件怎么样了）。引擎的上下文不变，Host 往里补了一条说明；回合还能 `session.redo`，直到会话开始新的回合。
   */
  'turn.undone': z.object({
    turnId: TurnIdSchema,
    files: FilesRestoreSchema.optional(),
  }),
  /** 撤销的回合被重做（0.51.0，`session.redo`）：它回到消息记录里，文件回到撤销之前的样子。 */
  'turn.redone': z.object({
    turnId: TurnIdSchema,
    files: FilesRestoreSchema.optional(),
  }),
  'assistant.delta': z.object({
    turnId: TurnIdSchema,
    streamId: StreamIdSchema,
    blockIndex: z.int().min(0),
    kind: z.enum(['text', 'reasoning']),
    /** Host 按 60 ms 合并后的片段。 */
    text: z.string(),
  }),
  'assistant.stream_ended': z.object({
    turnId: TurnIdSchema,
    streamId: StreamIdSchema,
    outcome: z.enum(['committed', 'abandoned']),
  }),
  'assistant.message': z.object({
    turnId: TurnIdSchema,
    /** 引擎原值。 */
    messageId: z.string(),
    text: z.string(),
    /** 本条替换的增量块；没有旁路或对不上时为空。 */
    replaces: z.array(StreamBlockRefSchema),
  }),
  'assistant.thought': z.object({
    turnId: TurnIdSchema,
    messageId: z.string(),
    text: z.string(),
    replaces: z.array(StreamBlockRefSchema),
  }),
  'tool.started': z.object({
    turnId: TurnIdSchema,
    toolCallId: z.string(),
    /** ACP `tool_call.title`，dsh 里就是工具名。 */
    toolName: z.string(),
    display: ToolDisplaySchema,
    /** `rawInput` 原样（截断后）；引擎没给时省略。 */
    input: z.unknown().optional(),
  }),
  'tool.updated': z.object({
    turnId: TurnIdSchema,
    toolCallId: z.string(),
    display: ToolDisplaySchema.optional(),
    input: z.unknown().optional(),
    output: ToolOutputSchema.optional(),
  }),
  'tool.finished': z.object({
    turnId: TurnIdSchema,
    toolCallId: z.string(),
    status: ToolFinishStatusSchema,
    /** Host 收尾补写（`unknown`）时没有。 */
    output: ToolOutputSchema.optional(),
  }),
  'todo.updated': z.object({
    turnId: TurnIdSchema,
    /** 来源 `todo_write` 调用。 */
    toolCallId: z.string(),
    items: z.array(TodoItemSchema),
  }),
  /**
   * Agent 给出了一份计划（0.36.0，domain-model §3.17）：计划模式的回合里（Codex 的 `<proposed_plan>`，Claude 与 Grok 的
   * ExitPlanMode），整份 Markdown。同一回合同一 `planId` 再来一次是替换；之后的计划替换之前的（客户端以最近的为准）。计划不会
   * 自己执行：用户让 Agent 实施时另发一条默认模式的消息。
   */
  'plan.proposed': z.object({
    turnId: TurnIdSchema,
    /** 引擎给的 ID（Codex 的 item ID、Claude 的工具调用 ID），只在会话内唯一。 */
    planId: z.string().min(1),
    /** Markdown。 */
    text: z.string().min(1),
  }),
  /**
   * 计划的流式预览（0.37.0，domain-model §3.17）：引擎写计划时的增量，Host 按 60 ms 合并。只是预览，同一 `planId` 的
   * `plan.proposed` 以全文替换它；回合结束时还没等到 `plan.proposed` 的是没写完的计划。只有 Codex 有（Claude 与 Grok 一次给全文）。
   */
  'plan.delta': z.object({
    turnId: TurnIdSchema,
    /** 同 `plan.proposed` 的 `planId`。 */
    planId: z.string().min(1),
    /** Host 按 60 ms 合并后的片段。 */
    text: z.string().min(1),
    /**
     * 引擎从头重写这份计划（Codex 重试请求、同一回合再写一次）：丢掉同一 `planId` 此前的预览与计划，从这一段重新开始。
     */
    restart: z.literal(true).optional(),
  }),
  'approval.requested': z.object({
    /** `status` 恒为 `pending`。 */
    approval: ApprovalRequestSchema,
  }),
  'approval.resolved': z.object({
    approvalId: ApprovalIdSchema,
    status: ResolvedApprovalStatusSchema,
    resolution: ApprovalResolutionSchema,
  }),
  /** 引擎向用户提了一组问题（0.10.0），回合等回答。`status` 恒为 `pending`。 */
  'question.requested': z.object({
    question: QuestionRequestSchema,
  }),
  /** 这组问题结束了（0.10.0）：用户回答了，或随回合、会话等取消。 */
  'question.resolved': z.object({
    questionId: QuestionIdSchema,
    status: z.enum(['answered', 'cancelled']),
    resolution: QuestionResolutionSchema,
  }),
  'usage.updated': z.object({
    /** ACP `usage_update.used`。 */
    contextUsed: z.int().min(0),
    /** ACP `usage_update.size`（模型未声明 contextWindow 时是猜测值）。 */
    contextSize: z.int().min(0),
    /** 这个会话累计用掉的 token（0.14.0，Codex 的 `tokenUsage.total.totalTokens`）；引擎不报时省略。 */
    totalTokens: z.int().min(0).optional(),
    /**
     * 已用量（`contextUsed`）到这个数时引擎自己压缩上下文（0.29.0；Codex 是模型上下文大小的 90%）；引擎不自动压缩或不说
     * 阈值时省略。
     */
    autoCompactAt: z.int().min(0).optional(),
    /** 上下文的分布（0.50.0）；引擎不报或这次没算时省略。 */
    breakdown: UsageBreakdownSchema.optional(),
  }),
  /**
   * 引擎开始压缩上下文（0.24.0）：`session.compact` 的回合里，或引擎在上下文快满时自己压缩（`auto`，在普通回合中间）。之后同一
   * `compactionId` 的 `context.compacted` 表示完成；回合结束时还没完成就是没压缩成。
   */
  'context.compacting': z.object({
    turnId: TurnIdSchema,
    compactionId: z.string().min(1),
    trigger: CompactionTriggerSchema,
  }),
  /** 上下文压缩完成（0.24.0）：之后模型看到的是摘要，不是之前的完整历史。没有 `context.compacting` 在先时同样算一次压缩。 */
  'context.compacted': z.object({
    turnId: TurnIdSchema,
    compactionId: z.string().min(1),
    trigger: CompactionTriggerSchema,
  }),
  'engine.error': z.object({
    category: EngineErrorCategorySchema,
    /** 引擎原文，始终保留。 */
    message: z.string(),
    /** JSON-RPC 错误码。 */
    code: z.int().optional(),
    turnId: TurnIdSchema.optional(),
    /** true：会话因此进入 `error`。 */
    fatal: z.boolean(),
  }),
  'engine.raw': z.object({
    /**
     * 引擎协议：`acp`（dsh 等），`codex-app-server`（0.5.0 起；之前只有 `acp`）。只是调试信息，开放的字符串，
     * 旧客户端的 schema 只认 `acp`，按 host-api.md §4 跳过它认不出的那几条。
     */
    protocol: z.string().min(1),
    /** 如 `session/update`、`turn/diff/updated`。 */
    method: z.string(),
    /** ACP：`session/update` 的 `sessionUpdate` 值；Codex：item 的类型等。 */
    kind: z.string().optional(),
    /** 原样（截断后）。 */
    params: z.unknown().optional(),
  }),
  /** 父会话派出了一个子 agent（0.6.0，domain-model §3.3.1），写在父会话的事件流。 */
  'subagent.started': z.object({
    subagent: SubagentSummarySchema,
  }),
  /** 子会话的摘要变了（0.6.0）：标题、状态、未决审批、昵称或角色。完整摘要，替换同一 `sessionId` 的上一份。 */
  'subagent.updated': z.object({
    subagent: SubagentSummarySchema,
  }),
  /** Agent 建议了后续任务（0.16.0，domain-model §3.11）；`status` 都是 `suggested`。 */
  'tasks.suggested': z.object({
    /** 提出建议的工具调用。 */
    toolCallId: z.string().min(1),
    turnId: TurnIdSchema.optional(),
    tasks: z.array(SuggestedTaskSchema).min(1),
  }),
  /**
   * 共享任务清单变了（0.52.0，domain-model §3.15）：写在会话树的根会话里（清单属于根，树里的会话共用）。完整的清单，替换上一份；
   * 每项的备注只带最近 5 条。清单由 agent 用 `wevir_task_*` 工具改，用户在界面上只读。
   */
  'tasks.board_updated': z.object({
    tasks: z.array(BoardTaskSchema),
  }),
  /**
   * 输入建议（0.53.0，domain-model §3.23）：回合正常结束后，Host 用会话的模型预测出用户接着会发的一句话。每个回合至多一条，晚于
   * `turn.finished` 到达（几秒内）。它是会话的“当前建议”，客户端只在会话空闲、输入框为空时灰着显示；`user.message`、
   * `user.steered`、`turn.started`、`turn.rewound`、`turn.undone`、`turn.redone` 任何一条出现就作废（投影在这些事件上自己清掉，
   * Host 不再另写一条“清除”）。Host 设置 `promptSuggestions` 关着时不会有。
   */
  'suggestion.updated': PromptSuggestionSchema,
  /** 用户把一项建议开成了会话（0.16.0）。 */
  'task.started': z.object({
    taskId: TaskIdSchema,
    sessionId: SessionIdSchema,
  }),
  /** 开出来的会话第一个回合结束了（0.16.0），结果回报到提出建议的会话。 */
  'task.reported': z.object({
    taskId: TaskIdSchema,
    sessionId: SessionIdSchema,
    outcome: TurnOutcomeSchema,
    /** 那个回合最后一段回答的前 2000 字；没有回答时省略。 */
    summary: z.string().optional(),
  }),
  /** 一条待发消息加入（0.8.0，domain-model §3.3.2）；`status` 恒为 `waiting`。 */
  'pending.added': z.object({
    pending: PendingMessageSchema,
  }),
  /** 待发消息变了（内容、方式、状态，含到终态），完整的消息，替换同一 `id` 的上一份。 */
  'pending.updated': z.object({
    pending: PendingMessageSchema,
  }),
  /** 一条插话进了回合 `turnId`（0.8.0）；事件的位置就是模型看到它的位置。 */
  'user.steered': z.object({
    turnId: TurnIdSchema,
    pendingId: PendingMessageIdSchema,
    clientMessageId: z.string().optional(),
    content: z.array(UserContentPartSchema).min(1),
    sentBy: ClientIdentitySchema,
    /** 别的会话发来的（0.30.0）。 */
    from: MessageFromSchema.optional(),
  }),
  /**
   * 会话里的 agent 请界面显示一样东西（0.30.0，`wevir_show`）：正在看这个会话的客户端打开对应的窗格；之后加入的客户端读历史时
   * 不再打开。
   */
  'ui.show': z.object({
    target: UiShowTargetSchema,
    turnId: TurnIdSchema.optional(),
  }),
  /**
   * Agent 把做好的文件交给用户（0.40.0，`wevir_share_file`）：消息流里在当时的位置出现文件卡片，用户可以打开、另存为、在访达中
   * 显示。文件留在会话文件夹里，事件只记路径与交出时的大小。
   */
  'file.shared': z.object({
    files: z.array(SharedFileSchema).min(1).max(SHARED_FILES_MAX),
    turnId: TurnIdSchema.optional(),
  }),
  /**
   * 消息流的一个章节从这里开始（0.82.0，`wevir_mark_chapter`，domain-model §3.15.7）：Agent 在工作换到另一个阶段时标记，消息流在当时的
   * 位置画一条带标题的分隔线，浮动目录列出所有章节。不开回合、不进引擎上下文；所在的回合被撤销或撤回时随它一起隐藏。
   */
  'chapter.marked': z.object({
    title: z.string().min(1).max(CHAPTER_TITLE_MAX_LENGTH),
    /** 一句话说明这一章做什么。 */
    summary: z.string().min(1).max(CHAPTER_SUMMARY_MAX_LENGTH).optional(),
    turnId: TurnIdSchema.optional(),
  }),
  /**
   * 一条验证记录变了（0.65.0，ADR-0008）：检查排队、开始、结束，每次带完整记录，替换同一 `id` 的上一份。与回合分开：`turnId` 只说明
   * 它验证的是哪个回合之后的代码。
   */
  'verification.updated': z.object({ run: VerificationRunSchema }),
  /** 会话的验收状态变了（0.65.0）：与引擎的回合状态分开。 */
  'acceptance.changed': z.object({ acceptance: SessionAcceptanceSchema }),
  /** 自动修复链变了（0.65.0）：开始、每次修复、复验、停下。 */
  'repair.updated': z.object({ repair: RepairChainSchema }),
  /**
   * 第二意见变了（0.75.0，domain-model §3.30）：发起、意见会话第一个回合结束、被引用。完整的意见，替换同一 `id` 的上一份；写在收到意见的
   * 会话里，不开回合、不进引擎上下文。
   */
  'opinion.updated': z.object({ opinion: SecondOpinionSchema }),
  /**
   * 一条“你应该知道”变了（0.79.0，domain-model §3.33）：Host 在回合结束后的后台检查里提出（`open`），用户标为已知或忽略。完整的一条，
   * 替换同一 `id` 的上一份；不开回合、不进引擎上下文。Host 设置 `sessionInsights` 关着时不会有新的。
   */
  'insight.updated': z.object({ insight: SessionInsightSchema }),
  /**
   * Agent 报出了审查发现（0.83.0，Host 功能 `review_findings`）：Codex 审查命令的结果（`origin: 'review'`），或 agent 调
   * `wevir_report_findings`（`tool`）。消息流里在当时的位置出现发现卡片；定位到文件与行的同时存成批注（`commentId`），之后的状态
   * 以 `review.list` 为准。`summary` 是审查的总体说明；`findings` 为空表示审查过、没有发现。
   */
  'review.findings': z.object({
    origin: ReviewFindingsOriginSchema,
    summary: z.string().max(REVIEW_SUMMARY_MAX_LENGTH).optional(),
    findings: z.array(ReviewFindingSchema).max(REVIEW_FINDINGS_MAX),
    turnId: TurnIdSchema.optional(),
  }),
  /**
   * 护栏拦下了 Agent 的一步（0.85.0，Host 功能 `tuning_guardrails`，domain-model §3.40）：拒绝了命令或改动、结束前检查失败让 Agent
   * 接着做，或已到次数上限放行。Agent 收到的理由在 `reason`；消息流显示一行工具行。
   */
  'guardrail.blocked': GuardrailBlockedSchema,
} as const;

export type WevirEventType = keyof typeof EventPayloadSchemas;

/**
 * 出现就让会话当前的输入建议作废的事件类型（0.53.0，`suggestion.updated`）：用户有了新消息、回合重新开始、回合被撤回 / 撤销 / 重做。
 * Host 的快照与 client-sdk 的投影都按它清掉建议，协议里没有“清除”事件。
 */
export const PROMPT_SUGGESTION_VOIDING_EVENTS: ReadonlySet<string> = new Set<WevirEventType>([
  'user.message',
  'user.steered',
  'turn.started',
  'turn.rewound',
  'turn.undone',
  'turn.redone',
]);
export type WevirEventPayload<T extends WevirEventType> = z.infer<(typeof EventPayloadSchemas)[T]>;

export const WEVIR_EVENT_TYPES = Object.keys(EventPayloadSchemas) as WevirEventType[];

/**
 * 信封，`payload` 不校验。客户端先用它解析：`type` 不在 `WEVIR_EVENT_TYPES` 里就忽略这条事件，
 * 但照常推进 `lastSeq`（host-api.md「订阅语义」）。
 */
export const WevirEventEnvelopeSchema = z.object({
  /** 会话内从 1 开始连续递增，无空洞。 */
  seq: SeqSchema,
  sessionId: SessionIdSchema,
  /** Host 追加时的时间。 */
  ts: IsoTimeSchema,
  type: z.string().min(1),
  /** `engine` = 引擎事实的投影；`host` = Host 自己的事实或推导。 */
  source: EventSourceSchema,
  payload: z.unknown(),
});
export type WevirEventEnvelope = z.infer<typeof WevirEventEnvelopeSchema>;

function eventSchema<T extends WevirEventType>(type: T) {
  return WevirEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: EventPayloadSchemas[type],
  });
}

export const SessionCreatedEventSchema = eventSchema('session.created');
export const SessionResumedEventSchema = eventSchema('session.resumed');
export const SessionReadOnlyEventSchema = eventSchema('session.read_only');
export const SessionTitleChangedEventSchema = eventSchema('session.title_changed');
export const SessionGoalChangedEventSchema = eventSchema('session.goal_changed');
export const SessionConfiguredEventSchema = eventSchema('session.configured');
export const SessionHandoffEventSchema = eventSchema('session.handoff');
export const SessionMovedEventSchema = eventSchema('session.moved');
export const SessionRulesEventSchema = eventSchema('session.rules');
export const SessionStateChangedEventSchema = eventSchema('session.state_changed');
export const UserMessageEventSchema = eventSchema('user.message');
export const TurnStartedEventSchema = eventSchema('turn.started');
export const TurnFinishedEventSchema = eventSchema('turn.finished');
export const TurnRewoundEventSchema = eventSchema('turn.rewound');
export const TurnUndoneEventSchema = eventSchema('turn.undone');
export const TurnRedoneEventSchema = eventSchema('turn.redone');
export const AssistantDeltaEventSchema = eventSchema('assistant.delta');
export const AssistantStreamEndedEventSchema = eventSchema('assistant.stream_ended');
export const AssistantMessageEventSchema = eventSchema('assistant.message');
export const AssistantThoughtEventSchema = eventSchema('assistant.thought');
export const ToolStartedEventSchema = eventSchema('tool.started');
export const ToolUpdatedEventSchema = eventSchema('tool.updated');
export const ToolFinishedEventSchema = eventSchema('tool.finished');
export const TodoUpdatedEventSchema = eventSchema('todo.updated');
export const PlanProposedEventSchema = eventSchema('plan.proposed');
export const PlanDeltaEventSchema = eventSchema('plan.delta');
export const ApprovalRequestedEventSchema = eventSchema('approval.requested');
export const ApprovalResolvedEventSchema = eventSchema('approval.resolved');
export const QuestionRequestedEventSchema = eventSchema('question.requested');
export const QuestionResolvedEventSchema = eventSchema('question.resolved');
export const UsageUpdatedEventSchema = eventSchema('usage.updated');
export const ContextCompactingEventSchema = eventSchema('context.compacting');
export const ContextCompactedEventSchema = eventSchema('context.compacted');
export const EngineErrorEventSchema = eventSchema('engine.error');
export const EngineRawEventSchema = eventSchema('engine.raw');
export const SubagentStartedEventSchema = eventSchema('subagent.started');
export const SubagentUpdatedEventSchema = eventSchema('subagent.updated');
export const TasksSuggestedEventSchema = eventSchema('tasks.suggested');
export const TasksBoardUpdatedEventSchema = eventSchema('tasks.board_updated');
export const SuggestionUpdatedEventSchema = eventSchema('suggestion.updated');
export const TaskStartedEventSchema = eventSchema('task.started');
export const TaskReportedEventSchema = eventSchema('task.reported');
export const PendingAddedEventSchema = eventSchema('pending.added');
export const PendingUpdatedEventSchema = eventSchema('pending.updated');
export const UserSteeredEventSchema = eventSchema('user.steered');
export const UiShowEventSchema = eventSchema('ui.show');
export const FileSharedEventSchema = eventSchema('file.shared');
export const ChapterMarkedEventSchema = eventSchema('chapter.marked');
export const GuardrailBlockedEventSchema = eventSchema('guardrail.blocked');
export const VerificationUpdatedEventSchema = eventSchema('verification.updated');
export const AcceptanceChangedEventSchema = eventSchema('acceptance.changed');
export const RepairUpdatedEventSchema = eventSchema('repair.updated');
export const OpinionUpdatedEventSchema = eventSchema('opinion.updated');
export const InsightUpdatedEventSchema = eventSchema('insight.updated');
export const ReviewFindingsEventSchema = eventSchema('review.findings');

/** 已知事件的判别联合，按 `type` 区分 `payload`。 */
export const WevirEventSchema = z.discriminatedUnion('type', [
  SessionCreatedEventSchema,
  SessionResumedEventSchema,
  SessionReadOnlyEventSchema,
  SessionTitleChangedEventSchema,
  SessionGoalChangedEventSchema,
  SessionConfiguredEventSchema,
  SessionHandoffEventSchema,
  SessionMovedEventSchema,
  SessionRulesEventSchema,
  SessionStateChangedEventSchema,
  UserMessageEventSchema,
  TurnStartedEventSchema,
  TurnFinishedEventSchema,
  TurnRewoundEventSchema,
  TurnUndoneEventSchema,
  TurnRedoneEventSchema,
  AssistantDeltaEventSchema,
  AssistantStreamEndedEventSchema,
  AssistantMessageEventSchema,
  AssistantThoughtEventSchema,
  ToolStartedEventSchema,
  ToolUpdatedEventSchema,
  ToolFinishedEventSchema,
  TodoUpdatedEventSchema,
  PlanProposedEventSchema,
  PlanDeltaEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
  UsageUpdatedEventSchema,
  ContextCompactingEventSchema,
  ContextCompactedEventSchema,
  EngineErrorEventSchema,
  EngineRawEventSchema,
  SubagentStartedEventSchema,
  SubagentUpdatedEventSchema,
  TasksSuggestedEventSchema,
  TasksBoardUpdatedEventSchema,
  SuggestionUpdatedEventSchema,
  TaskStartedEventSchema,
  TaskReportedEventSchema,
  PendingAddedEventSchema,
  PendingUpdatedEventSchema,
  UserSteeredEventSchema,
  UiShowEventSchema,
  FileSharedEventSchema,
  ChapterMarkedEventSchema,
  VerificationUpdatedEventSchema,
  AcceptanceChangedEventSchema,
  RepairUpdatedEventSchema,
  OpinionUpdatedEventSchema,
  InsightUpdatedEventSchema,
  ReviewFindingsEventSchema,
  GuardrailBlockedEventSchema,
]);
export type WevirEvent = z.infer<typeof WevirEventSchema>;
export type WevirEventOf<T extends WevirEventType> = Extract<WevirEvent, { type: T }>;

export function isKnownEventType(type: string): type is WevirEventType {
  return Object.hasOwn(EventPayloadSchemas, type);
}
