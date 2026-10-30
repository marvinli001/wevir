import type {
  AgentTextInput,
  EngineGoal,
  PendingApproval,
  TodoItem,
  ToolDisplay,
  UsageBreakdown,
  UserQuestion,
} from './types.js';

// AgentEvent：适配器上报给 Host 的引擎无关中间表示。Host 给它配上 Wevir 会话 ID、turnId、seq，
// 写成 WevirEvent（domain-model.md §6）。与那份事件目录相比：
// - 没有 Host 自己的事实（session.*、user.message、turn.started、approval.resolved）；
// - 用引擎的 ID（engineSessionId、attemptId、requestId），不用 Host 的 ses_ / stm_ / apr_；
// - 工具输出是原文，截断与 `ToolOutput` 包装由 Host 做；
// - 多了只有适配器知道的回合结算（turn.settled / turn.failed）、引擎退出（engine.exited）和
//   引擎侧结掉的审批（approval.cancelled）。
//
// 规则放在哪一侧（domain-model.md §10 留给 T1.3）：依赖引擎工具名、错误措辞或增量帧细节的放适配器
// （展示类型 `display`、`todo.updated`、`turn.failed.category`、增量与已提交消息的对齐 `replaces`）；
// 依赖 Host 状态的放 Host（取消期间的 failed 记为 cancelled、回合结束补 unknown、60 ms 合并增量、
// 截断）。
//
// 顺序约定：
// - 一个会话同一时刻至多一个回合。`send` 成功之后到该回合的终结事件之前，事件都属于这个回合。子会话（R4，
//   domain-model §3.3.1）与普通会话的目标回合（0.35.0）由引擎开始：`turn.started` 之后到终结事件之前的事件属于它。
// - 每个回合恰好一个终结事件：`turn.settled`、`turn.failed`，或（进程死了）`engine.exited`。
//   回合内的其他事件都在终结事件之前发出。
// - 回合之间只可能出现 `engine.exited`、`engine.raw`、`usage.updated`（0.50.0：回合结束后才算出来的上下文分布）、
//   `usage.recorded`（0.62.0：回合结束时才补发的请求用量）、`subagent.*`、`goal.updated` 与引擎开始的回合的 `turn.started`。
// - `engine.exited` 之后该会话的订阅结束。
// - 子会话：父会话的流里先有 `subagent.started`，子会话的流在第一个订阅者到来之前缓冲（`EventHub` 的
//   `bufferUntilSubscribed`），Host 收到 `subagent.started` 再订阅不会漏事件。

/** 增量块的引用：哪个 attempt 的第几个块。 */
export interface DeltaBlockRef {
  attemptId: string;
  blockIndex: number;
}

/**
 * 助手文本或思考的增量。只是预览，
 * 最终以替换它的 `assistant.message` / `assistant.thought` 为准。
 */
export interface AssistantDeltaEvent {
  type: 'assistant.delta';
  engineSessionId: string;
  /** 一次 LLM 调用一个，适配器内唯一；Host 为每个 attemptId 分配一个 StreamId。 */
  attemptId: string;
  /** attempt 内的块序号。同一块只会是 text 或 reasoning 之一。 */
  blockIndex: number;
  kind: 'text' | 'reasoning';
  text: string;
}

/** 一个 attempt 的增量流结束。`abandoned`：该 attempt 被引擎丢弃（重试），它的增量不会被替换。 */
export interface AssistantStreamEndedEvent {
  type: 'assistant.stream_ended';
  engineSessionId: string;
  attemptId: string;
  outcome: 'committed' | 'abandoned';
}

/**
 * 已提交的助手消息（dsh：ACP `agent_message_chunk`），替换 `replaces` 列出的 text 增量块。
 * 没有增量或对不上时 `replaces` 为空，Host 把它追加在回合末尾。
 */
export interface AssistantMessageEvent {
  type: 'assistant.message';
  engineSessionId: string;
  /** 引擎原值。 */
  messageId: string;
  text: string;
  replaces: DeltaBlockRef[];
}

/** 已提交的思考内容（dsh：ACP `agent_thought_chunk`），替换 reasoning 增量块。 */
export interface AssistantThoughtEvent {
  type: 'assistant.thought';
  engineSessionId: string;
  messageId: string;
  text: string;
  replaces: DeltaBlockRef[];
}

export interface ToolStartedEvent {
  type: 'tool.started';
  engineSessionId: string;
  toolCallId: string;
  /** 引擎原值（dsh：ACP `tool_call.title`，就是工具名）。 */
  toolName: string;
  display: ToolDisplay;
  /** 引擎给的原始输入（dsh：`rawInput`），未截断；引擎没给时省略。 */
  input?: unknown;
}

export interface ToolUpdatedEvent {
  type: 'tool.updated';
  engineSessionId: string;
  toolCallId: string;
  display?: ToolDisplay;
  input?: unknown;
  /** 到目前为止的输出原文，未截断。 */
  output?: string;
}

/**
 * 工具调用结束。只有引擎报的两种状态；`cancelled`（取消期间的 failed）与 `unknown`（回合结束仍未
 * 收尾）由 Host 推导（domain-model.md §6.4）。
 */
export interface ToolFinishedEvent {
  type: 'tool.finished';
  engineSessionId: string;
  toolCallId: string;
  status: 'completed' | 'failed';
  output?: string;
  /** 工具产出的图片（0.118.0，展示类型 `image`）。Host 认格式、存进图片目录，事件里换成图片的引用。 */
  images?: AgentToolImage[];
}

/** 工具产出的一张图片：base64 的字节（PNG、JPEG、GIF 或 WebP，以文件头为准）。 */
export interface AgentToolImage {
  data: string;
}

/** 待办列表（完整列表），从引擎的待办工具输入解析（dsh：`todo_write` 的 `rawInput.todos`）。 */
export interface TodoUpdatedEvent {
  type: 'todo.updated';
  engineSessionId: string;
  /** 来源工具调用，紧跟在它的 `tool.started` 之后。 */
  toolCallId: string;
  items: TodoItem[];
}

/**
 * Agent 给出了一份计划（0.36.0，计划模式，domain-model §3.17）：整份 Markdown（Codex：`plan` item 完成时的 `text`；Claude 与
 * Grok：ExitPlanMode 的计划）。同一 `planId` 再来一次是替换。回合里的事件，在终结事件之前。
 */
export interface PlanProposedEvent {
  type: 'plan.proposed';
  engineSessionId: string;
  /** 引擎给的 ID（Codex 的 item ID、ExitPlanMode 的工具调用 ID）。 */
  planId: string;
  text: string;
}

/**
 * 计划的流式预览（0.37.0，Codex 的 `item/plan/delta`）：一段增量，Host 合并后写成 `plan.delta`。只是预览，以随后同一 `planId`
 * 的 `plan.proposed` 为准。`restart`：引擎从头重写这份计划，丢掉此前的预览。回合里的事件，在终结事件之前。
 */
export interface PlanDeltaEvent {
  type: 'plan.delta';
  engineSessionId: string;
  planId: string;
  text: string;
  restart?: true;
}

/** 引擎请求审批，携带引擎给的选项列表。等 `respondToApproval`，或以 `approval.cancelled` 结束。 */
export interface ApprovalRequestedEvent extends PendingApproval {
  type: 'approval.requested';
}

/**
 * 没有经过 `respondToApproval` 就结束的审批（适配器已以 cancelled 回复引擎，或已无引擎可回复）。
 * 之后对该 `requestId` 的 `respondToApproval` 报 `approval_not_found`。
 */
export interface ApprovalCancelledEvent {
  type: 'approval.cancelled';
  engineSessionId: string;
  requestId: string;
  /**
   * turn_cancelled：`cancel` 或 `close`；turn_ended：回合在审批未决时自己结束了；
   * engine_exited：引擎进程退出；disposed：适配器 `dispose`。
   */
  reason: 'turn_cancelled' | 'turn_ended' | 'engine_exited' | 'disposed';
}

/** 引擎向用户提问（0.10.0，Codex：`request_user_input`）。等 `respondToQuestion`，或以 `question.cancelled` 结束。 */
export interface QuestionRequestedEvent {
  type: 'question.requested';
  engineSessionId: string;
  requestId: string;
  /** 提问的工具调用；没有时省略。 */
  toolCallId?: string;
  questions: UserQuestion[];
}

/** 没有经过 `respondToQuestion` 就结束的提问，原因同 `approval.cancelled`。 */
export interface QuestionCancelledEvent {
  type: 'question.cancelled';
  engineSessionId: string;
  requestId: string;
  reason: ApprovalCancelledEvent['reason'];
}

/** 上下文用量（dsh：ACP `usage_update`）。字段名与 WevirEvent `usage.updated` 相同。 */
export interface UsageUpdatedEvent {
  type: 'usage.updated';
  engineSessionId: string;
  contextUsed: number;
  contextSize: number;
  /** 这个会话累计用掉的 token（0.14.0，U21）；引擎不报时省略。 */
  totalTokens?: number;
  /** 已用到这个数时引擎自己压缩上下文（0.29.0）；不自动压缩或不知道阈值时省略。 */
  autoCompactAt?: number;
  /** 上下文的分布（0.50.0）；引擎不报或这次没算时省略（Host 与客户端沿用上一次的）。 */
  breakdown?: UsageBreakdown;
}

/**
 * 一次模型请求用掉的 token（0.62.0，用量统计）。引擎按请求报的（Claude 的每条 assistant 消息、Codex 的 `last`、OpenCode 的
 * 每条 assistant 消息）每个请求一条；只按回合报的（Cursor、ACP 的 `session/prompt` 结果）每个回合一条。Host 不写进事件流，
 * 只记到用量表；同一会话里同一个 `requestId` 只记第一次。
 *
 * token 用 Anthropic 的口径：`inputTokens` 不含缓存命中与缓存写入（OpenAI 口径的输入要先减去缓存命中），`reasoningTokens`
 * 已含在 `outputTokens` 里。
 */
export interface UsageRecordedEvent {
  type: 'usage.recorded';
  engineSessionId: string;
  /** 这次请求在这个引擎会话里唯一（引擎的消息 ID、回合 ID 等）。 */
  requestId: string;
  /** 实际回答的模型（引擎报的原值）；引擎不报时省略，Host 用会话的模型。 */
  model?: string;
  /** 来源后面实际接的上游（0.62.0，OpenCode 的 `providerID`）；没有时省略。 */
  upstream?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** 请求从发出到最后一个 token 的毫秒数；引擎不报、适配器也量不出时省略。 */
  durationMs?: number;
  /** 从发出到第一个输出 token 的毫秒数；同上。 */
  firstTokenMs?: number;
}

/**
 * 引擎开始压缩上下文（0.24.0）：`compact` 开的回合里（`manual`），或引擎在上下文快满时自己压缩（`auto`，在普通回合中间；Codex：
 * `contextCompaction` item 开始，Claude：`status` 是 `compacting`）。属于进行中的回合。
 */
export interface ContextCompactingEvent {
  type: 'context.compacting';
  engineSessionId: string;
  /** 适配器内唯一；同一次压缩的 `context.compacted` 用同一个。 */
  compactionId: string;
  trigger: 'manual' | 'auto';
}

/** 上下文压缩完成（0.24.0；Codex：`contextCompaction` item 完成，Claude：`compact_boundary`）。 */
export interface ContextCompactedEvent {
  type: 'context.compacted';
  engineSessionId: string;
  compactionId: string;
  trigger: 'manual' | 'auto';
}

/** 回合正常结算（dsh：`session/prompt` 的结果）。 */
export interface TurnSettledEvent {
  type: 'turn.settled';
  engineSessionId: string;
  /** completed：引擎自然结束（含 max_tokens、refusal 等）；cancelled：因 `cancel` 结束。 */
  outcome: 'completed' | 'cancelled';
  /** 引擎原值（ACP stopReason：end_turn / cancelled / max_tokens / …）。 */
  stopReason: string;
}

/** 回合以错误结束（dsh：`session/prompt` 返回 JSON-RPC 错误）。会话仍可用。 */
export interface TurnFailedEvent {
  type: 'turn.failed';
  engineSessionId: string;
  /** 适配器按错误原文归类；归不了类就是 unknown。值是 protocol `EngineErrorCategory` 的子集。 */
  category: 'missing_credentials' | 'provider' | 'unknown';
  /** 引擎原文，始终保留。 */
  message: string;
  /** 引擎的错误码（dsh：JSON-RPC 错误码，如 -32603）。 */
  code?: number;
  /**
   * 回合因订阅账号的用量上限失败（0.119.0，Codex 的 `usageLimitExceeded`、Claude 被拒的 `rate_limit_event`；Cursor 的
   * `RateLimitError` / 429 / 用量上限错误码，OpenCode 上游的 HTTP 429，这两家报之前先重读账号的用量）。引擎报了额度恢复的
   * 时刻与窗口长度时带上；都没报时是空对象，Host 从账号的用量里补。
   */
  usageLimit?: { resetsAt?: string; windowMinutes?: number };
}

/**
 * 引擎在重试回合里的模型请求（0.119.0）：连接或流断开、服务暂时不可用，引擎等一会儿重发（Codex 的 `error` 带 `willRetry`，Claude
 * 的 `api_retry`）。回合继续；之前已经流出、没提交的增量适配器另报 `abandoned`。`attempt` / `maxAttempts` 是第几次与最多几次，
 * 引擎不计次数时省略；`reason` 是断开原因的原文。
 */
export interface TurnRetryingEvent {
  type: 'turn.retrying';
  engineSessionId: string;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

/**
 * 引擎进程退出，不论是否在回合中（ADR-0001 §2）。发给每个挂在该进程上的会话，是该会话订阅的最后
 * 一个事件；之后会话不再挂在引擎上，`send` 报 `session_closed`，要先 `resumeSession`。
 * `dispose` 引起的退出不上报。
 */
export interface EngineExitedEvent {
  type: 'engine.exited';
  engineSessionId: string;
  /** 进程退出码；被信号杀死、或适配器主动重启（`reason`）时为 null。 */
  exitCode: number | null;
  signal: string | null;
  /** stderr 尾部，供诊断。 */
  stderrTail?: string;
  /**
   * 不是意外退出，而是适配器主动重启了引擎：config_changed 为应用新的 Provider 配置（T3.4，只在没有回合时
   * 发生）；cancel_unconfirmed 是某个会话的取消在时限内得不到确认，引擎可能卡住，挂在同一进程上的会话一并
   * 脱开（T3.5）。省略表示进程自己退出了。
   */
  reason?: 'config_changed' | 'cancel_unconfirmed';
}

/**
 * 引擎开始的回合，不经 `send`：子会话（R4，父 agent 派了任务或发来消息），或普通会话的目标回合（0.35.0：目标进行中、会话空闲时
 * Codex 自己接着做，或 `updateGoal` 继续目标时适配器开的）。之后到终结事件为止的事件属于这个回合。普通会话在 Host 刚好也开了
 * 回合（`send` 已经交给引擎）时，Host 丢掉它：引擎把那条消息并进了这个回合，之后的事件归 Host 的回合。
 */
export interface TurnStartedEvent {
  type: 'turn.started';
  engineSessionId: string;
  /** 父 agent 给的输入（Codex：子 thread 这一回合的 userMessage，只取文本）；引擎没给时省略。 */
  input?: AgentTextInput[];
  /** 为会话目标工作的回合（0.35.0）。 */
  trigger?: 'goal';
}

/**
 * 会话的目标变了（0.35.0）：设置、状态或用量变化时带完整的目标，清除时 `goal` 为 `null`。回合之内或之间都可能（Codex：
 * `thread/goal/updated` / `thread/goal/cleared`，恢复会话时也报一次当前的目标）。
 */
export interface GoalUpdatedEvent {
  type: 'goal.updated';
  engineSessionId: string;
  goal: EngineGoal | null;
}

/**
 * 父会话派出了一个子 agent（R4，domain-model §3.3.1）。发在**父**会话的流里，回合之内或之间都可能；子会话的流此后
 * 可以订阅（之前的事件已缓冲）。同一个子会话被重新认出（引擎重启后父 agent 又用到它）时再发一次。
 */
export interface SubagentStartedEvent {
  type: 'subagent.started';
  /** 父会话。 */
  engineSessionId: string;
  /** 子会话的引擎会话 ID（Codex：子 thread）。 */
  childEngineSessionId: string;
  /** 父会话里派出它的工具调用（同一流里 `tool.started` 的 `toolCallId`）。 */
  parentToolCallId: string;
  /** 兜底标题：引擎给的名称 → 任务描述首行 → 昵称；都没有时为空串。 */
  title: string;
  /** 任务描述原文；Host 用它生成标题。 */
  prompt?: string;
  /** 子 agent 实际用的模型与推理强度；不知道时省略，Host 沿用父会话的。 */
  modelId?: string;
  reasoningEffort?: string;
  /** 引擎给子 agent 起的名字（Codex 的 agentNickname）。 */
  nickname?: string;
  /** 引擎的子 agent 类型（Codex 的 agentRole）。 */
  role?: string;
}

/**
 * 子 agent 晚到的信息（R4），发在父会话的流里：新的兜底标题（引擎给的名称等）、昵称、角色，或父 agent 关掉了它
 * （`closed`）。子会话的回合与状态以子会话自己的流为准。
 */
export interface SubagentUpdatedEvent {
  type: 'subagent.updated';
  /** 父会话。 */
  engineSessionId: string;
  childEngineSessionId: string;
  title?: string;
  nickname?: string;
  role?: string;
  /** 父 agent 关掉了它（Codex：`close_agent`）；进行中的回合引擎会另外结束。 */
  closed?: true;
}

/**
 * 插话进了回合（R11）：`steer` 交出去的输入被引擎放进了进行中的回合（Codex：带同一 `clientId` 的 userMessage 完成）。
 * 在模型看到它的位置报出：之前的输出与工具结果属于前一步，之后的是模型接着做的。
 */
export interface TurnSteeredEvent {
  type: 'turn.steered';
  engineSessionId: string;
  /** `steer` 的 `steerId`。 */
  steerId: string;
}

/**
 * Agent 建议了后续任务（0.16.0，U23，domain-model §3.11）：在提出建议的工具调用完成之后报出（Codex：Wevir 的 MCP 工具
 * `wevir_tasks.suggest_tasks`，codex-event-mapping.md §6.8）。ID 由 Host 分配；工具调用本身照常是工具事件。
 */
export interface TasksSuggestedEvent {
  type: 'tasks.suggested';
  engineSessionId: string;
  /** 提出建议的工具调用。 */
  toolCallId: string;
  tasks: Array<{ title: string; prompt: string; reason?: string }>;
}

/**
 * 引擎的审查命令给出的结构化结果（0.83.0，协议的 `review.findings`）：`review` 回合里报出，Host 把能定位到会话目录里文件与行的发现
 * 存成批注，再写 `review.findings` 事件。`path` 是引擎给的原样（Codex 是绝对路径），Host 换成相对会话目录的；`summary` 是审查的
 * 总体说明，已经作为助手消息报过的不用再给。Codex：`exitedReviewMode` 的文字由适配器拆开（codex-event-mapping.md §4.9）。
 */
export interface ReviewFindingsEvent {
  type: 'review.findings';
  engineSessionId: string;
  summary?: string;
  findings: Array<{
    title: string;
    body: string;
    /** 0–3，同 Codex 的 P0–P3。 */
    priority?: number;
    /** 0–1。 */
    confidence?: number;
    path: string;
    startLine: number;
    endLine: number;
  }>;
}

/**
 * 护栏的检查程序拦下了一步（0.86.0，协议的 `guardrail.blocked`，domain-model §3.40）：适配器从引擎的 hook 结果里认出检查程序留下的
 * 标记（`@wevir/runtime-adapter/guardrail` 的 `parseGuardrailMarker`），原样交给 Host；Host 补上回合、写事件、记命中。
 */
export interface GuardrailBlockedEvent {
  type: 'guardrail.blocked';
  engineSessionId: string;
  guardrailId: string;
  kind: string;
  action: string;
  tool?: string;
  command?: string;
  path?: string;
  reason: string;
  attempt?: number;
  maxAttempts?: number;
}

/** 适配器不认识的引擎消息，原样保留，不丢弃。 */
export interface EngineRawEvent {
  type: 'engine.raw';
  engineSessionId: string;
  /** 如 'acp'。 */
  protocol: string;
  /** 如 'session/update'。 */
  method: string;
  /** 如 `session/update` 的 `sessionUpdate` 值。 */
  kind?: string;
  params?: unknown;
}

export type AgentEvent =
  | AssistantDeltaEvent
  | AssistantStreamEndedEvent
  | AssistantMessageEvent
  | AssistantThoughtEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolFinishedEvent
  | TodoUpdatedEvent
  | PlanProposedEvent
  | PlanDeltaEvent
  | ApprovalRequestedEvent
  | ApprovalCancelledEvent
  | QuestionRequestedEvent
  | QuestionCancelledEvent
  | UsageUpdatedEvent
  | UsageRecordedEvent
  | ContextCompactingEvent
  | ContextCompactedEvent
  | TurnSettledEvent
  | TurnFailedEvent
  | TurnRetryingEvent
  | EngineExitedEvent
  | EngineRawEvent
  | TurnStartedEvent
  | TurnSteeredEvent
  | SubagentStartedEvent
  | SubagentUpdatedEvent
  | TasksSuggestedEvent
  | ReviewFindingsEvent
  | GuardrailBlockedEvent
  | GoalUpdatedEvent;

export type AgentEventType = AgentEvent['type'];

/** 回合的终结事件。 */
export type TurnTerminalEvent = TurnSettledEvent | TurnFailedEvent | EngineExitedEvent;

export function isTurnTerminal(event: AgentEvent): event is TurnTerminalEvent {
  return (
    event.type === 'turn.settled' || event.type === 'turn.failed' || event.type === 'engine.exited'
  );
}
