// 客户端消息投影（domain-model §8）：把一个会话按 seq 应用的事件投影成“消息 + 部件”，桌面与 CLI 共用。
// 分层照 OpenWork（openwork-notes §3.2）：协议事件 → 本投影 → 渲染。纯逻辑，不碰 DOM 与连接。
//
// 增量与已提交消息按 domain-model §6.3 合并；工具收尾按 §6.4，回合结束而工具未收尾时投影为 `unknown`
// （Host 正常会补写，这里兜底，回放旧数据也不会一直转圈）。子会话（R4）：父会话里每个子会话一个“开始”的 `subagent`
// 部件（R5 起结束时再加一个“结束”部件）与 `subagents` 摘要；子会话自己的回合输入（`turn.started.input`）投影成来自
// 父 agent 的用户消息。R11：待发消息（`pending.*`）投影成 `pendingMessages`；插话（`user.steered`）是回合中间的一条用户
// 消息，之后的助手输出放进这个回合的下一条助手消息（domain-model §8）。U2：思考部件带起止时刻（桌面端的“思考了 17 秒”），
// 插话分出的每条助手消息都带回合的开始时刻。0.24.0：由命令开始的回合（`turn.started.command`，压缩上下文、代码审查）投影成
// 一条带 `command`、没有文字的用户消息；上下文压缩（`context.*`）是回合里的 `compaction` 部件。0.35.0：为会话目标工作的回合
// （`turn.started.trigger`）的用户消息带 `trigger`；引擎自己开的目标回合没有 `user.message`，投影成一条带 `trigger`、没有文字的
// 用户消息。会话的目标（`session.goal_changed`）是 `Transcript.goal`。0.52.0：共享任务清单（`tasks.board_updated`，写在会话树的
// 根会话里）是 `Transcript.taskBoard`。0.53.0：输入建议（`suggestion.updated`）是 `Transcript.promptSuggestion`，用户有了新消息、
// 回合重新开始或被撤回 / 撤销 / 重做时清掉。0.79.0：你应该知道（`insight.updated`）是 `Transcript.insights`，不进消息流。
//
// 性能：事件只改动它涉及的那条消息。`snapshot()` 只为改动过的消息生成新对象，其余沿用上一次的对象，渲染层
// 按对象身份跳过没变的消息；部件同样整体替换、不原地修改。调用方可以攒一批事件再取一次快照（桌面按帧）。

import type {
  ApprovalId,
  ApprovalOption,
  ApprovalRequest,
  ApprovalResolution,
  ApprovalStatus,
  BoardTask,
  ClientIdentity,
  CollaborationMode,
  CompactionTrigger,
  EngineErrorCategory,
  EngineErrorInfo,
  GuardrailBlocked,
  HandoffNoteRef,
  HandoffOmittedRange,
  HandoffStrategy,
  InsightId,
  IsoTime,
  MessageFrom,
  OpinionId,
  PendingMessage,
  PendingMessageId,
  QuestionId,
  QuestionRequest,
  RepairChain,
  ReviewFinding,
  SecondOpinion,
  SessionAcceptance,
  SessionAutoContinue,
  SessionGoal,
  SessionId,
  SessionInsight,
  SessionMoveTarget,
  SessionReadOnly,
  SessionReadOnlyReason,
  SessionState,
  SessionVerification,
  SharedFile,
  StreamBlockRef,
  SubagentStatus,
  SubagentSummary,
  SuggestedTask,
  TaskId,
  TodoItem,
  ToolDisplay,
  ToolOutput,
  TurnCommand,
  TurnId,
  TurnOutcome,
  TurnTrigger,
  UiShowTarget,
  Usage,
  UsageLimit,
  UserContentPart,
  UserImagePart,
  VerificationRun,
  VerificationRunId,
  WevirEvent,
  WevirEventOf,
} from '@wevir/protocol';
import {
  PROMPT_SUGGESTION_VOIDING_EVENTS,
  type PromptSuggestion,
  VERIFICATION_RUNS_KEPT,
} from '@wevir/protocol';

/** 工具部件的状态。`awaiting_approval`：同一 `toolCallId` 有未决审批。 */
export type ToolPartStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface ToolPartApproval {
  approvalId: ApprovalId;
  status: ApprovalStatus;
  options: readonly ApprovalOption[];
  resolution?: ApprovalResolution;
}

/** 不属于任何回合的会话级提示（引擎会话恢复、只读、关闭）。 */
export type SessionNotice =
  | { kind: 'resumed'; engineVersion?: string }
  | { kind: 'read_only'; reason: SessionReadOnlyReason; message: string }
  | { kind: 'closed' }
  /** 换到了别的来源（0.25.0，`session.handoff`）：之后的回合由 `providerId` 的引擎跑。 */
  | {
      kind: 'handoff';
      providerId: string;
      modelId: string;
      fromProviderId: string;
      fromModelId: string;
      /** 接着用这个来源以前的引擎会话。 */
      resumed: boolean;
      /** 整段对话，还是只补这个来源错过的那段。 */
      strategy: HandoffStrategy;
      /** 摘要覆盖的事件（含两端）；没有要补的历史时省略。 */
      covered?: { fromSeq: number; toSeq: number };
      /** 选进摘要的条目数与因预算省掉的条目数。 */
      items: number;
      omittedItems: number;
      /** 交给新来源的摘要正文；没有要补的历史时省略。 */
      context?: string;
      /** 新来源能不能用读历史的工具拿全文；没有摘要时省略（这时不需要）。 */
      historyTool?: boolean;
      /** 递交记录（0.59.0，旧 Host 没有）：材料的字节数、预算与散列，省掉的历史条目，必须携带的约束条数，选入的笔记与版本。 */
      receipt?: {
        bytes: number;
        budgetBytes: number;
        hash: string;
        omitted: readonly HandoffOmittedRange[];
        constraints: number;
        notes: readonly HandoffNoteRef[];
      };
      delivery: HandoffDelivery;
    }
  /** 会话换了目录（0.81.0，`session.moved`）：移进了 worktree，或移回了项目目录。 */
  | {
      kind: 'moved';
      to: SessionMoveTarget;
      cwd: string;
      branch?: string;
    };

/**
 * 接力摘要交出去了没有，与 Host 的规则一致（domain-model §3.14 的“交付”）：摘要随下一条消息交给新引擎，由消息（或目标）开始的
 * 回合以 `interrupted` 以外的结局结束才算交出去；`interrupted`（引擎没开始这个回合）与由命令开始的回合不算，摘要留给下一条
 * 消息。只说明 Host 交给了引擎，不说明模型读懂了。
 */
export type HandoffDelivery =
  /** 没有要补的历史，没有摘要。 */
  | { status: 'none' }
  /** 摘要已备好，等下一条消息带过去。 */
  | { status: 'prepared' }
  /** 随这个回合的消息交给了新引擎。 */
  | { status: 'delivered'; turnId: TurnId }
  /** 交出去之前又换了来源，这份摘要不会再交（下一次接力按当时的情况另算）。 */
  | { status: 'failed'; reason: 'superseded' };

/**
 * 消息的部件。`key` 在部件的一生中不变（增量块被已提交消息替换时沿用增量块的 key），渲染层拿它做 React key。
 * 文本与思考部件与 AI SDK `UIMessage` 同形（domain-model §8 第 5 条）。
 */
export type ChatPart =
  /** 用户消息的文本带粘贴的段落（0.90.0）时另有 `segments`：按顺序的各段，`text` 仍是它们以换行相连的全文。 */
  | ({ type: 'text'; segments?: readonly UserTextSegment[] } & StreamPartFields)
  | ({ type: 'reasoning' } & StreamPartFields & ReasoningTiming)
  /** 用户消息里的一张图片（0.28.0），在文本之后，按发送时的顺序。 */
  | { type: 'image'; key: string; image: UserImagePart }
  | {
      type: 'tool';
      key: string;
      toolCallId: string;
      toolName: string;
      display: ToolDisplay;
      status: ToolPartStatus;
      input: unknown;
      output?: ToolOutput;
      /** 工具产出的图片（0.118.0，`tool.finished.images`），字节经 `image.read` 读。 */
      images?: readonly UserImagePart[];
      approval?: ToolPartApproval;
      startedAt: IsoTime;
      finishedAt?: IsoTime;
    }
  | { type: 'todo'; key: string; items: readonly TodoItem[] }
  /**
   * Agent 给出的计划（0.36.0，`plan.proposed`）：在给出它的回合里（`key` 是 `p:<planId>`），同一 `planId` 再来一次原位替换。
   * 0.37.0 起计划写的时候就出现（`plan.delta`）。
   */
  | {
      type: 'plan';
      key: string;
      planId: string;
      text: string;
      /**
       * `streaming`：还在写的预览（`plan.delta`）；`done`：给出的计划（`plan.proposed`）；`incomplete`：回合结束时还没写完的预览
       * （没等到 `plan.proposed`，例如回合被停止）。只有 `done` 的计划会成为 `latestPlan`。
       */
      state: 'streaming' | 'done' | 'incomplete';
    }
  /** 引擎向用户提的一组问题（0.10.0），在提问时所在的位置；结束后原位换成带结局的。 */
  | { type: 'question'; key: string; question: QuestionRequest }
  /**
   * 引擎的错误（`engine.error`）。0.119.0：回合因订阅的用量上限失败时带 `turnId` 与 `usageLimit`，界面画成额度卡片；Host 替用户发了继续
   * 消息之后（`from.usageLimit` 指向这个回合）带 `resumedAt`。
   */
  | {
      type: 'error';
      key: string;
      category: EngineErrorCategory;
      message: string;
      fatal: boolean;
      turnId?: TurnId;
      usageLimit?: UsageLimit;
      resumedAt?: IsoTime;
    }
  /**
   * 引擎在重试模型请求（0.119.0，`turn.retrying`）：同一条消息里接连的几次合成一个部件（`key` 是第一次的 `t:<seq>`），只留最近一次的
   * 次数与原因。它是消息的最后一个部件、回合还在进行时就是“正在重新连接”。
   */
  | {
      type: 'retry';
      key: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
    }
  /** 适配器不认识的引擎消息（`engine.raw`），只在 `includeRaw` 时投影。 */
  | { type: 'raw'; key: string; method: string; kind?: string; params: unknown }
  | { type: 'notice'; key: string; notice: SessionNotice }
  /**
   * 上下文压缩（0.24.0）：`context.compacting` 时出现（`key` 是 `c:<compactionId>`），`context.compacted` 时原位换成
   * `completed`；回合结束时还在 `running` 的（没压缩成）去掉。没有 `compacting` 的 `compacted` 直接是 `completed`。
   */
  | {
      type: 'compaction';
      key: string;
      compactionId: string;
      trigger: CompactionTrigger;
      status: 'running' | 'completed';
    }
  /**
   * 这个会话派出的一个子会话（R4，domain-model §8）。“开始”部件在派出它的回合里，`subagent.started` 时出现（`key` 是
   * `a:<子会话 ID>`）；子会话离开 `running` 时，在父会话当时所在的位置再加一个“结束”部件（R5：`ended` 是当时的状态，
   * `key` 是 `a:<子会话 ID>:end:<seq>`）。两种部件的 `subagent` 都随 `subagent.updated` 原位换成最新的摘要。界面据此
   * 画“开始工作”“已完成”两行。
   */
  | {
      type: 'subagent';
      key: string;
      subagent: SubagentSummary;
      ended?: Exclude<SubagentStatus, 'running'>;
    }
  /**
   * Agent 建议的后续任务（0.16.0，domain-model §3.11）：`tasks.suggested` 时出现在提出建议的回合里（`key` 是
   * `k:<toolCallId>`），`tasks` 随 `task.started` / `task.reported` 原位换成最新的状态。
   */
  | { type: 'tasks'; key: string; toolCallId: string; tasks: readonly SuggestedTask[] }
  /** 一项建议开出来的会话回报了结果（`task.reported`），在当时所在的位置（当前回合，空闲时一条系统消息）。 */
  | { type: 'task_report'; key: string; task: SuggestedTask; summary?: string }
  /**
   * 第二意见（0.75.0，`opinion.updated`）：第一次出现时在当时所在的位置（当前回合，空闲时一条系统消息；`key` 是 `o:<意见 ID>`），之后
   * `opinion` 随同一 `id` 的 `opinion.updated` 原位换成最新的。
   */
  | { type: 'opinion'; key: string; opinion: SecondOpinion }
  /**
   * Agent 交给用户的文件（0.40.0，`file.shared`）：在当时所在的位置（`key` 是 `f:<seq>`），`path` 相对会话的 `cwd`。
   */
  | { type: 'files'; key: string; files: readonly SharedFile[] }
  /**
   * 章节的开始（0.82.0，`chapter.marked`）：在当时所在的位置（`key` 是 `h:<seq>`）。界面画一条带标题的分隔线；所有章节另见
   * `Transcript.chapters`。
   */
  | { type: 'chapter'; key: string; seq: number; title: string; summary?: string }
  /**
   * 审查发现（0.83.0，`review.findings`）：在当时所在的位置（`key` 是 `r:<seq>`）。`commentId` 指向存成的批注，之后的状态（已发送、
   * 已删、过期）以 `review.list` 为准。
   */
  | {
      type: 'findings';
      key: string;
      origin: string;
      summary?: string;
      findings: readonly ReviewFinding[];
    }
  /**
   * 护栏拦下一步（0.86.0，`guardrail.blocked`）：在当时所在的位置（`key` 是 `g:<seq>`），界面画成一行工具行。结束前检查在回合收尾时
   * 报，可能没有 `turnId`，这时是一条系统消息。
   */
  | { type: 'guardrail'; key: string; blocked: GuardrailBlocked };

/** 文本与思考部件共有的字段。 */
/** 用户消息文本的一段（0.90.0）：用户自己写的，或粘贴进来的（`pasted`）。 */
export interface UserTextSegment {
  text: string;
  pasted?: true;
}

export interface StreamPartFields {
  key: string;
  text: string;
  state: 'streaming' | 'done';
  /** 来自增量（尚未被替换）时有。 */
  stream?: StreamBlockRef;
}

/**
 * 思考部件的起止时刻（U2）。协议里思考没有开始事件，开始取这个回合上一次有输出的时刻（回合开始、上一段文字或思考、
 * 工具的开始与收尾、审批的结算）——模型从那一刻起在想，引擎只发摘要或只发已提交思考时也算得出来；结束取最后一段
 * 增量的时刻，没有增量时取已提交思考的时刻。
 */
export interface ReasoningTiming {
  startedAt?: IsoTime;
  endedAt?: IsoTime;
}

export type ChatPartOf<T extends ChatPart['type']> = Extract<ChatPart, { type: T }>;

interface MessageBase {
  id: string;
  parts: readonly ChatPart[];
  /** 组成本消息的事件 seq 范围。 */
  seqRange: readonly [number, number];
}

export interface UserChatMessage extends MessageBase {
  role: 'user';
  turnId: TurnId;
  /** 发出这条消息的客户端（`user.message`）。子会话里父 agent 给的输入没有。 */
  sentBy?: ClientIdentity;
  /** 子会话（R4）：这一回合的输入来自父 agent（`turn.started.input`），不是客户端发的。 */
  fromParentAgent?: true;
  /** 0.24.0：回合由命令开始（`turn.started.command`），没有文字部件。 */
  command?: TurnCommand;
  /** 0.35.0：为会话目标工作的回合（`turn.started.trigger`）；引擎自己开的那种没有文字部件。 */
  trigger?: TurnTrigger;
  /** 0.36.0：这个回合在计划模式里跑（`user.message` 的 `collaborationMode`）。 */
  collaborationMode?: 'plan';
  clientMessageId?: string;
  /** R11：插话（`user.steered`），在回合中间；`id` 是 `<turnId>:steer:<pendingId>`。 */
  steered?: true;
  /** R11：来自一条待发消息（插话，或排队后作为这个回合发出的）。 */
  pendingId?: PendingMessageId;
  /** 0.30.0：别的会话发来的消息或回报（应用级工具）。 */
  from?: MessageFrom;
  ts: IsoTime;
}

export interface AssistantChatMessage extends MessageBase {
  role: 'assistant';
  turnId: TurnId;
  /** 回合开始（`turn.started`）的时刻；插话分出的每条助手消息都有。 */
  startedAt?: IsoTime;
  /** 回合结束后有。 */
  finished?: { outcome: TurnOutcome; durationMs: number };
}

/** 不属于回合的提示与错误（如引擎在空闲时退出、resume 失败）。 */
export interface SystemChatMessage extends MessageBase {
  role: 'system';
}

export type ChatMessage = UserChatMessage | AssistantChatMessage | SystemChatMessage;

/** 一个会话在某个 seq 上的投影。同一份投影在没有新事件时返回同一个对象。 */
export interface Transcript {
  /** 收到第一条事件之前为 undefined。 */
  sessionId: SessionId | undefined;
  messages: readonly ChatMessage[];
  /** 全部审批（含已结算），按 ID。 */
  approvals: ReadonlyMap<ApprovalId, ApprovalRequest>;
  /** 未决审批，按创建时间。 */
  pendingApprovals: readonly ApprovalRequest[];
  state: SessionState | undefined;
  activeTurnId: TurnId | undefined;
  title: string;
  readOnly: SessionReadOnly | undefined;
  lastError: EngineErrorInfo | undefined;
  usage: Usage | undefined;
  /** 这个会话派出的子会话的摘要（R4），按派出的先后；规则同 Host 快照的 `subagents`。 */
  subagents: readonly SubagentSummary[];
  /** 子会话（R4）：父会话与派出它的工具调用（`session.created.parent`）。 */
  parent: ParentRef | undefined;
  /** R11：等待中与暂停的待发消息，按加入的先后；规则同 Host 快照的 `pendingMessages`。 */
  pendingMessages: readonly PendingMessage[];
  /** 0.10.0：等用户回答的问题，按提出的先后；规则同 Host 快照的 `pendingQuestions`。 */
  pendingQuestions: readonly QuestionRequest[];
  /** 0.16.0：Agent 建议的后续任务，按提出的先后；规则同 Host 快照的 `suggestedTasks`。 */
  suggestedTasks: readonly SuggestedTask[];
  /** 0.75.0：这个会话收到的第二意见，按发起的先后；规则同 Host 快照的 `opinions`。 */
  opinions: readonly SecondOpinion[];
  /** 0.79.0：你应该知道，按提出的先后，含已处理的；规则同 Host 快照的 `insights`。 */
  insights: readonly SessionInsight[];
  /**
   * 0.30.0：最近一次 `ui.show`（会话里的 agent 请界面显示的东西）。客户端只对订阅之后新到的打开窗格，用 `seq` 与 `ts` 区分
   * 历史里的。
   */
  uiShow: { seq: number; ts: IsoTime; target: UiShowTarget } | undefined;
  /** 0.35.0：会话的目标（最近一次 `session.goal_changed`），清除或没有时 undefined。 */
  goal: SessionGoal | undefined;
  /** 0.119.0：额度恢复后自动继续（最近一次 `session.auto_continue`）；关掉、发出或有了新的回合时 undefined。规则同 `Session.autoContinue`。 */
  autoContinue: SessionAutoContinue | undefined;
  /** 0.36.0：最近一条用户消息（`user.message`）的协作模式；还没有消息时是 `default`。规则同 Host 快照的 `collaborationMode`。 */
  collaborationMode: CollaborationMode;
  /**
   * 0.36.0：最近一条用户消息开始的回合里最后给出的计划（`plan.proposed`）；之后又有用户消息时清空，这份计划被从头重写
   * （`plan.delta` 的 `restart`，0.37.0）时也清空。写的时候的预览不算。界面据此在输入框上方提供“实施”。
   */
  latestPlan: LatestPlan | undefined;
  /**
   * 0.51.0：能重做的回合（`session.redo`），最近撤销的在最后；撤销之后会话又开始新回合时清空。被撤销的回合不在 `messages` 里。
   */
  redoTurnIds: readonly TurnId[];
  /**
   * 0.52.0：共享任务清单（最近一次 `tasks.board_updated`，整份替换），只有会话树的根会话有；没收到过时是空数组。规则同 Host 快照的
   * `taskBoard`。
   */
  taskBoard: readonly BoardTask[];
  /**
   * 0.53.0：输入建议（最近一次 `suggestion.updated`）；`PROMPT_SUGGESTION_VOIDING_EVENTS` 里的事件（用户有了新消息、回合重新
   * 开始、回合被撤回 / 撤销 / 重做）出现后没有。规则同 Host 快照的 `promptSuggestion`。
   */
  promptSuggestion: PromptSuggestion | undefined;
  /**
   * 0.65.0：回合后验证——验收状态（最近一次 `acceptance.changed`）、最近的验证记录（`verification.updated` 按 `id` 替换，按最近一次
   * 变化的先后，最多 `VERIFICATION_RUNS_KEPT` 条）与最近的修复链（`repair.updated`）。没收到过验证事件时没有。规则同 Host 快照的
   * `verification`。
   */
  verification: SessionVerification | undefined;
  /**
   * 0.82.0：章节（`chapter.marked`），按先后，给目录用；只有 `messages` 里看得见的（撤销、撤回的回合里标的不在）。没有新章节时
   * 是同一个数组。
   */
  chapters: readonly TranscriptChapter[];
  lastSeq: number;
}

/** `Transcript.chapters`（0.82.0）：一个章节与它所在的消息。 */
export interface TranscriptChapter {
  /** 同消息里那个部件的 `key`。 */
  key: string;
  seq: number;
  title: string;
  summary?: string;
  messageId: string;
  turnId?: TurnId;
}

/** `Transcript.latestPlan`（0.36.0）。 */
export interface LatestPlan {
  turnId: TurnId;
  planId: string;
  text: string;
  /** 那条 `plan.proposed` 的 `seq`。 */
  seq: number;
}

/** 子会话的父会话（`session.created` 的 `parent`）。 */
export interface ParentRef {
  sessionId: SessionId;
  toolCallId: string;
  turnId?: TurnId;
}

export interface TranscriptProjectionOptions {
  /** 是否投影 `engine.raw`（domain-model §8：默认不投影，开发者模式下作为调试信息显示）。 */
  includeRaw?: boolean;
}

interface MutableMessage {
  role: ChatMessage['role'];
  id: string;
  turnId?: TurnId;
  parts: ChatPart[];
  firstSeq: number;
  lastSeq: number;
  sentBy?: ClientIdentity;
  fromParentAgent?: true;
  command?: TurnCommand;
  trigger?: TurnTrigger;
  collaborationMode?: 'plan';
  clientMessageId?: string;
  steered?: true;
  pendingId?: PendingMessageId;
  from?: MessageFrom;
  ts?: IsoTime;
  startedAt?: IsoTime;
  finished?: { outcome: TurnOutcome; durationMs: number };
  /** 上一次快照里的对象；改动后清空。 */
  snapshot: ChatMessage | undefined;
}

const EMPTY_APPROVALS: ReadonlyMap<ApprovalId, ApprovalRequest> = new Map();

/**
 * 接力摘要的开头说明里讲读历史工具的那一行（Host 的 `handoff.ts`，0.25.0 起不变）：只在新来源挂了这个工具时写。0.59.0 起事件里有
 * `historyTool`，更早的 Host 写的事件由这一行判断。
 */
const HISTORY_TOOL_LINE = 'Read the full history with the read_session_history tool';

/** 一个回合在投影里的消息：用户消息，与按插话分开的几条助手消息（最后一条是当前的）。 */
interface TurnMessages {
  user?: MutableMessage;
  /** 当前的助手消息：之后的输出放进它；插话之后清空，下一条输出另起一条。 */
  assistant?: MutableMessage;
  /** 这个回合的全部助手消息，按先后。 */
  readonly segments: MutableMessage[];
  /** 插话之后下一条助手消息的 `id`。 */
  nextAssistantId?: string;
  /** `turn.started` 的时刻。 */
  startedAt?: IsoTime;
  /** 这个回合上一次有输出的时刻（思考部件的开始，`ReasoningTiming`）。 */
  activityAt?: IsoTime;
}

const PENDING_DONE: ReadonlySet<PendingMessage['status']> = new Set([
  'inserted',
  'sent',
  'cancelled',
]);

/** 按 seq 应用事件、产出 `Transcript` 快照。事件必须按 seq 连续送入（client-sdk 的订阅保证这一点）。 */
export class TranscriptProjection {
  readonly #includeRaw: boolean;
  #messages: MutableMessage[] = [];
  #turns = new Map<TurnId, TurnMessages>();
  /** 未到终态的待发消息（R11）。 */
  #pending: PendingMessage[] = [];
  /** toolCallId → 所在消息。 */
  #tools = new Map<string, MutableMessage>();
  #approvals = new Map<ApprovalId, ApprovalRequest>();
  /** 全部问题（0.10.0），含已结束的。 */
  #questions = new Map<QuestionId, QuestionRequest>();
  #approvalsDirty = false;
  #sessionId: SessionId | undefined;
  #state: SessionState | undefined;
  #activeTurnId: TurnId | undefined;
  #title = '';
  #readOnly: SessionReadOnly | undefined;
  /** 最近一条 `session.moved` 的 seq（0.81.0）：紧跟着的 `session.resumed` 不另起一行。 */
  #lastMoved: number | undefined;
  #lastError: EngineErrorInfo | undefined;
  #usage: Usage | undefined;
  #goal: SessionGoal | undefined;
  #autoContinue: SessionAutoContinue | undefined;
  #taskBoard: readonly BoardTask[] = [];
  #promptSuggestion: PromptSuggestion | undefined;
  #acceptance: SessionAcceptance | undefined;
  #runs = new Map<VerificationRunId, VerificationRun>();
  #repair: RepairChain | undefined;
  #subagents: SubagentSummary[] = [];
  /** 子会话 ID → 它的部件（开始与结束）所在的消息。 */
  #subagentParts = new Map<SessionId, MutableMessage[]>();
  #parent: ParentRef | undefined;
  /** 建议的后续任务（0.16.0），按提出的先后。 */
  #tasks = new Map<TaskId, SuggestedTask>();
  #uiShow: Transcript['uiShow'];
  /** 提出建议的工具调用 → 它的 `tasks` 部件所在的消息。 */
  #taskParts = new Map<string, MutableMessage>();
  /** 第二意见（0.75.0），按发起的先后；意见 → 它的部件所在的消息。 */
  #opinions = new Map<OpinionId, SecondOpinion>();
  #opinionParts = new Map<OpinionId, MutableMessage>();
  /** 你应该知道（0.79.0），按提出的先后。 */
  #insights = new Map<InsightId, SessionInsight>();
  /** 最近一条用户消息的协作模式（0.36.0）。 */
  #collaborationMode: CollaborationMode = 'default';
  #latestPlan: LatestPlan | undefined;
  /** 现在被撤销（`turn.undone`，0.51.0）、从 `messages` 里隐藏的回合；消息留在内部，重做时回来。 */
  #hidden = new Set<TurnId>();
  /** 能重做的回合，最近撤销的在最后。 */
  #redo: readonly TurnId[] = [];
  /** 摘要还没交出去的那次接力的提示部件（`key`）。 */
  #pendingHandoff: string | undefined;
  /** 进行中的回合由命令开始（0.24.0）：它不带接力摘要。 */
  #commandTurnId: TurnId | undefined;
  #lastSeq = 0;
  #dirty = true;
  #snapshot: Transcript | undefined;

  constructor(options: TranscriptProjectionOptions = {}) {
    this.#includeRaw = options.includeRaw ?? false;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** 丢掉全部投影（订阅 `reset`：之后从 seq 1 重新回放）。 */
  reset(): void {
    this.#messages = [];
    this.#turns.clear();
    this.#tools.clear();
    this.#approvals.clear();
    this.#questions.clear();
    this.#approvalsDirty = true;
    this.#sessionId = undefined;
    this.#state = undefined;
    this.#activeTurnId = undefined;
    this.#title = '';
    this.#readOnly = undefined;
    this.#lastMoved = undefined;
    this.#lastError = undefined;
    this.#usage = undefined;
    this.#goal = undefined;
    this.#autoContinue = undefined;
    this.#taskBoard = [];
    this.#promptSuggestion = undefined;
    this.#acceptance = undefined;
    this.#runs.clear();
    this.#repair = undefined;
    this.#subagents = [];
    this.#subagentParts.clear();
    this.#parent = undefined;
    this.#tasks.clear();
    this.#taskParts.clear();
    this.#opinions.clear();
    this.#opinionParts.clear();
    this.#insights.clear();
    this.#pending = [];
    this.#collaborationMode = 'default';
    this.#latestPlan = undefined;
    this.#hidden.clear();
    this.#redo = [];
    this.#pendingHandoff = undefined;
    this.#commandTurnId = undefined;
    this.#lastSeq = 0;
    this.#dirty = true;
  }

  apply(event: WevirEvent): void {
    this.#sessionId = event.sessionId;
    this.#lastSeq = event.seq;
    this.#dirty = true;
    if (PROMPT_SUGGESTION_VOIDING_EVENTS.has(event.type)) this.#promptSuggestion = undefined;
    switch (event.type) {
      case 'session.created': {
        this.#state = 'idle';
        const parent = event.payload.parent;
        if (parent !== undefined) this.#parent = { ...parent };
        return;
      }
      case 'session.resumed':
        this.#readOnly = undefined;
        // 换目录时接着用原来的引擎会话（0.81.0）：只显示换目录那一行。
        if (this.#lastMoved === event.seq - 1) return;
        this.#notice(event, { kind: 'resumed', engineVersion: event.payload.engineVersion });
        return;
      case 'session.moved': {
        const { to, cwd, branch } = event.payload;
        this.#lastMoved = event.seq;
        this.#notice(event, { kind: 'moved', to, cwd, ...(branch !== undefined && { branch }) });
        return;
      }
      case 'session.read_only': {
        const { reason, message } = event.payload;
        this.#readOnly = { reason, message, since: event.ts };
        this.#notice(event, { kind: 'read_only', reason, message });
        return;
      }
      case 'session.title_changed':
        this.#title = event.payload.title;
        return;
      case 'session.goal_changed':
        this.#goal = event.payload.goal ?? undefined;
        return;
      case 'session.auto_continue': {
        const { turnId, resumeAt } = event.payload;
        this.#autoContinue = resumeAt === null ? undefined : { turnId, resumeAt };
        return;
      }
      case 'turn.retrying':
        this.#retrying(event);
        return;
      case 'tasks.board_updated':
        this.#taskBoard = event.payload.tasks;
        return;
      case 'suggestion.updated':
        this.#promptSuggestion = event.payload;
        return;
      case 'verification.updated': {
        const { run } = event.payload;
        this.#runs.delete(run.id);
        this.#runs.set(run.id, run);
        for (const id of this.#runs.keys()) {
          if (this.#runs.size <= VERIFICATION_RUNS_KEPT) break;
          this.#runs.delete(id);
        }
        this.#acceptance ??= { status: 'unverified', updatedAt: event.ts };
        return;
      }
      case 'acceptance.changed':
        this.#acceptance = event.payload.acceptance;
        return;
      case 'repair.updated':
        this.#repair = event.payload.repair;
        this.#acceptance ??= { status: 'unverified', updatedAt: event.ts };
        return;
      case 'session.configured':
        return;
      case 'session.handoff': {
        const { from, to, resumed, strategy, covered, items, omittedItems, context } =
          event.payload;
        const { bytes, budgetBytes, hash, omitted, constraints, notes, historyTool } =
          event.payload;
        this.#readOnly = undefined;
        // 上一份摘要还没交出去就又换了来源：它不会再交了。
        this.#setHandoffDelivery({ status: 'failed', reason: 'superseded' });
        this.#notice(event, {
          kind: 'handoff',
          providerId: to.providerId,
          modelId: to.modelId,
          fromProviderId: from.providerId,
          fromModelId: from.modelId,
          resumed,
          strategy,
          ...(covered !== undefined && { covered: { ...covered } }),
          items,
          omittedItems,
          ...(context !== undefined && {
            context,
            historyTool: historyTool ?? context.includes(HISTORY_TOOL_LINE),
          }),
          ...(bytes !== undefined &&
            budgetBytes !== undefined &&
            hash !== undefined && {
              receipt: {
                bytes,
                budgetBytes,
                hash,
                omitted: omitted ?? [],
                constraints: constraints ?? 0,
                notes: notes ?? [],
              },
            }),
          delivery: context === undefined ? { status: 'none' } : { status: 'prepared' },
        });
        if (context !== undefined) this.#pendingHandoff = `n:${event.seq}`;
        return;
      }
      case 'session.state_changed': {
        const { to, reason } = event.payload;
        this.#state = to;
        if (reason === 'turn_started' || reason === 'resumed') this.#lastError = undefined;
        if (to === 'closed') this.#notice(event, { kind: 'closed' });
        return;
      }
      case 'user.message':
        this.#userMessage(event);
        return;
      case 'turn.started': {
        // 子会话：这一回合的输入来自父 agent（R4），投影成一条用户消息；命令开的回合（0.24.0）同样有一条，带 `command`。
        if (event.payload.input !== undefined) this.#agentInput(event);
        if (event.payload.command !== undefined) this.#commandInput(event);
        if (event.payload.trigger !== undefined) this.#triggerInput(event);
        const turn = this.#turn(event.payload.turnId);
        turn.startedAt = event.ts;
        turn.activityAt = event.ts;
        for (const segment of this.#segments(event.payload.turnId, event.seq)) {
          this.#touch(segment, event.seq).startedAt = event.ts;
        }
        this.#activeTurnId = event.payload.turnId;
        this.#commandTurnId =
          event.payload.command === undefined ? undefined : event.payload.turnId;
        // 新的回合让排着的自动继续作废（或就是它开的，0.119.0）。
        this.#autoContinue = undefined;
        // 新的回合开始，撤销的回合不能再重做了（它们一直隐藏）。
        if (this.#redo.length > 0) this.#redo = [];
        return;
      }
      case 'turn.finished': {
        this.#turnFinished(event);
        const { turnId, outcome } = event.payload;
        if (outcome !== 'interrupted' && this.#commandTurnId !== turnId) {
          this.#setHandoffDelivery({ status: 'delivered', turnId });
        }
        if (this.#commandTurnId === turnId) this.#commandTurnId = undefined;
        return;
      }
      case 'turn.rewound':
        this.#turnRewound(event.payload.turnId);
        return;
      case 'turn.undone': {
        const { turnId } = event.payload;
        this.#hidden.add(turnId);
        this.#redo = [...this.#redo.filter((id) => id !== turnId), turnId];
        if (this.#latestPlan?.turnId === turnId) this.#latestPlan = undefined;
        return;
      }
      case 'turn.redone': {
        const { turnId } = event.payload;
        this.#hidden.delete(turnId);
        this.#redo = this.#redo.filter((id) => id !== turnId);
        return;
      }
      case 'assistant.delta':
        this.#delta(event);
        return;
      case 'assistant.stream_ended':
        if (event.payload.outcome === 'abandoned') this.#dropStream(event);
        return;
      case 'assistant.message':
      case 'assistant.thought':
        this.#committed(event);
        return;
      case 'tool.started':
        this.#toolStarted(event);
        return;
      case 'tool.updated':
        this.#toolUpdated(event);
        return;
      case 'tool.finished':
        this.#toolFinished(event);
        return;
      case 'todo.updated':
        this.#todo(event);
        return;
      case 'plan.proposed':
        this.#plan(event);
        return;
      case 'plan.delta':
        this.#planDelta(event);
        return;
      case 'approval.requested':
        this.#approvalRequested(event);
        return;
      case 'approval.resolved':
        this.#approvalResolved(event);
        return;
      case 'question.requested':
        this.#questionRequested(event);
        return;
      case 'question.resolved':
        this.#questionResolved(event);
        return;
      case 'usage.updated':
        this.#usage = {
          contextUsed: event.payload.contextUsed,
          contextSize: event.payload.contextSize,
          ...(event.payload.totalTokens !== undefined && {
            totalTokens: event.payload.totalTokens,
          }),
          ...(event.payload.autoCompactAt !== undefined && {
            autoCompactAt: event.payload.autoCompactAt,
          }),
          // 回合中间的用量更新不带分布时沿用上一次的（0.50.0）。
          ...((event.payload.breakdown ?? this.#usage?.breakdown) !== undefined && {
            breakdown: event.payload.breakdown ?? this.#usage?.breakdown,
          }),
        };
        return;
      case 'context.compacting':
      case 'context.compacted':
        this.#compaction(event);
        return;
      case 'engine.error':
        this.#engineError(event);
        return;
      case 'engine.raw':
        if (this.#includeRaw) this.#raw(event);
        return;
      case 'subagent.started':
      case 'subagent.updated':
        this.#subagent(event);
        return;
      case 'pending.added':
      case 'pending.updated':
        this.#pendingChanged(event.payload.pending);
        return;
      case 'user.steered':
        this.#steered(event);
        return;
      case 'tasks.suggested':
      case 'task.started':
      case 'task.reported':
        this.#task(event);
        return;
      case 'ui.show':
        this.#uiShow = { seq: event.seq, ts: event.ts, target: event.payload.target };
        return;
      case 'opinion.updated':
        this.#opinion(event);
        return;
      case 'insight.updated':
        this.#insights.set(event.payload.insight.id, event.payload.insight);
        return;
      case 'file.shared':
        this.#target(event.payload.turnId, event.seq).parts.push({
          type: 'files',
          key: `f:${event.seq}`,
          files: event.payload.files,
        });
        return;
      case 'chapter.marked': {
        const { title, summary } = event.payload;
        this.#target(event.payload.turnId, event.seq).parts.push({
          type: 'chapter',
          key: `h:${event.seq}`,
          seq: event.seq,
          title,
          ...(summary !== undefined && { summary }),
        });
        return;
      }
      case 'guardrail.blocked':
        this.#target(event.payload.turnId, event.seq).parts.push({
          type: 'guardrail',
          key: `g:${event.seq}`,
          blocked: event.payload,
        });
        return;
      case 'review.findings':
        this.#target(event.payload.turnId, event.seq).parts.push({
          type: 'findings',
          key: `r:${event.seq}`,
          origin: event.payload.origin,
          ...(event.payload.summary !== undefined && { summary: event.payload.summary }),
          findings: event.payload.findings,
        });
        return;
    }
  }

  /** 当前投影。自上次调用以来没有新事件时返回同一个对象。 */
  snapshot(): Transcript {
    if (!this.#dirty && this.#snapshot) return this.#snapshot;
    const messages = this.#messages
      .filter((message) => message.turnId === undefined || !this.#hidden.has(message.turnId))
      .map((message) => {
        message.snapshot ??= freeze(message);
        return message.snapshot;
      });
    const previous = this.#snapshot;
    let approvals = previous?.approvals ?? EMPTY_APPROVALS;
    let pendingApprovals = previous?.pendingApprovals ?? [];
    if (this.#approvalsDirty || !previous) {
      approvals = new Map(this.#approvals);
      pendingApprovals = [...this.#approvals.values()]
        .filter((approval) => approval.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.#approvalsDirty = false;
    }
    this.#snapshot = {
      sessionId: this.#sessionId,
      messages,
      approvals,
      pendingApprovals,
      state: this.#state,
      activeTurnId: this.#activeTurnId,
      title: this.#title,
      readOnly: this.#readOnly,
      lastError: this.#lastError,
      usage: this.#usage,
      subagents: this.#subagents,
      parent: this.#parent,
      pendingMessages: this.#pending,
      pendingQuestions: [...this.#questions.values()].filter(
        (question) => question.status === 'pending',
      ),
      suggestedTasks: [...this.#tasks.values()],
      opinions: [...this.#opinions.values()],
      insights: [...this.#insights.values()],
      uiShow: this.#uiShow,
      goal: this.#goal,
      autoContinue: this.#autoContinue,
      collaborationMode: this.#collaborationMode,
      latestPlan: this.#latestPlan,
      redoTurnIds: this.#redo,
      taskBoard: this.#taskBoard,
      promptSuggestion: this.#promptSuggestion,
      verification:
        this.#acceptance === undefined
          ? undefined
          : {
              acceptance: this.#acceptance,
              runs: [...this.#runs.values()],
              ...(this.#repair !== undefined && { repair: this.#repair }),
            },
      chapters: chaptersOf(messages, previous?.chapters),
      lastSeq: this.#lastSeq,
    };
    this.#dirty = false;
    return this.#snapshot;
  }

  // ── 消息 ─────────────────────────────────────────────────────────────

  #push(message: MutableMessage): MutableMessage {
    this.#messages.push(message);
    return message;
  }

  #touch(message: MutableMessage, seq: number): MutableMessage {
    message.snapshot = undefined;
    message.lastSeq = seq;
    return message;
  }

  #userMessage(event: WevirEventOf<'user.message'>): void {
    const { turnId, content, sentBy, clientMessageId, pendingId, from, collaborationMode } =
      event.payload;
    const turn = this.#turn(turnId);
    if (turn.user) return;
    if (from?.usageLimit !== undefined)
      this.#autoContinued(from.usageLimit.turnId, event.ts, event.seq);
    const planning = collaborationMode === 'plan';
    this.#collaborationMode = planning ? 'plan' : 'default';
    this.#latestPlan = undefined;
    turn.user = this.#push({
      role: 'user',
      id: turnId,
      turnId,
      parts: userParts(content),
      firstSeq: event.seq,
      lastSeq: event.seq,
      sentBy,
      clientMessageId,
      ...(pendingId !== undefined && { pendingId }),
      ...(from !== undefined && { from }),
      ...(planning && { collaborationMode: 'plan' as const }),
      ts: event.ts,
      snapshot: undefined,
    });
  }

  /**
   * 插话进了回合（R11）：在当前位置加一条用户消息，这个回合之后的助手输出另起一条助手消息（`<turnId>:assistant:<seq>`）。
   */
  #steered(event: WevirEventOf<'user.steered'>): void {
    const { turnId, pendingId, content, sentBy, clientMessageId, from } = event.payload;
    const turn = this.#turn(turnId);
    this.#push({
      role: 'user',
      id: `${turnId}:steer:${pendingId}`,
      turnId,
      parts: userParts(content),
      firstSeq: event.seq,
      lastSeq: event.seq,
      sentBy,
      ...(clientMessageId !== undefined && { clientMessageId }),
      steered: true,
      pendingId,
      ...(from !== undefined && { from }),
      ts: event.ts,
      snapshot: undefined,
    });
    turn.assistant = undefined;
    turn.nextAssistantId = `${turnId}:assistant:${event.seq}`;
    turn.activityAt = event.ts;
  }

  /** `pending.added` / `pending.updated`（R11）：替换同一 `id` 的，到了终态就去掉。 */
  #pendingChanged(pending: PendingMessage): void {
    const index = this.#pending.findIndex((item) => item.id === pending.id);
    const done = PENDING_DONE.has(pending.status);
    if (index < 0) {
      if (!done) this.#pending = [...this.#pending, pending];
      return;
    }
    this.#pending = done
      ? this.#pending.filter((item) => item.id !== pending.id)
      : this.#pending.map((item, i) => (i === index ? pending : item));
  }

  /** 子会话的回合输入（`turn.started.input`）：父 agent 发来的，没有 `sentBy`。 */
  #agentInput(event: WevirEventOf<'turn.started'>): void {
    const { turnId, input } = event.payload;
    const turn = this.#turn(turnId);
    if (turn.user || input === undefined) return;
    turn.user = this.#push({
      role: 'user',
      id: turnId,
      turnId,
      parts: userParts(input),
      firstSeq: event.seq,
      lastSeq: event.seq,
      fromParentAgent: true,
      ts: event.ts,
      snapshot: undefined,
    });
  }

  /** 由命令开始的回合（0.24.0）：一条带 `command`、没有文字的用户消息。 */
  #commandInput(event: WevirEventOf<'turn.started'>): void {
    const { turnId, command } = event.payload;
    const turn = this.#turn(turnId);
    if (turn.user || command === undefined) return;
    turn.user = this.#push({
      role: 'user',
      id: turnId,
      turnId,
      parts: [],
      firstSeq: event.seq,
      lastSeq: event.seq,
      command,
      ts: event.ts,
      snapshot: undefined,
    });
  }

  /**
   * 为会话目标工作的回合（0.35.0）：有 `user.message`（设目标的第一个回合）时给它标上 `trigger`；没有（引擎自己开的）时补一条
   * 带 `trigger`、没有文字的用户消息。
   */
  #triggerInput(event: WevirEventOf<'turn.started'>): void {
    const { turnId, trigger } = event.payload;
    const turn = this.#turn(turnId);
    if (trigger === undefined) return;
    if (turn.user) {
      this.#touch(turn.user, turn.user.lastSeq).trigger = trigger;
      return;
    }
    turn.user = this.#push({
      role: 'user',
      id: turnId,
      turnId,
      parts: [],
      firstSeq: event.seq,
      lastSeq: event.seq,
      trigger,
      ts: event.ts,
      snapshot: undefined,
    });
  }

  /** `context.compacting` / `context.compacted`（0.24.0）：回合里的 `compaction` 部件，完成时原位更新。 */
  #compaction(event: WevirEventOf<'context.compacting'> | WevirEventOf<'context.compacted'>): void {
    const { turnId, compactionId, trigger } = event.payload;
    const key = `c:${compactionId}`;
    const status = event.type === 'context.compacted' ? 'completed' : 'running';
    this.#activity(turnId, event.ts);
    const part = { type: 'compaction', key, compactionId, trigger, status } as const;
    for (const segment of this.#turn(turnId).segments) {
      const index = segment.parts.findIndex((candidate) => candidate.key === key);
      if (index < 0) continue;
      this.#touch(segment, event.seq);
      segment.parts = segment.parts.map((candidate, i) => (i === index ? part : candidate));
      return;
    }
    this.#assistant(turnId, event.seq).parts.push(part);
  }

  #turn(turnId: TurnId): TurnMessages {
    let turn = this.#turns.get(turnId);
    if (!turn) {
      turn = { segments: [] };
      this.#turns.set(turnId, turn);
    }
    return turn;
  }

  /** 回合当前的助手消息，没有就建（追加在末尾：紧跟本回合的用户消息，或插话之后）。 */
  #assistant(turnId: TurnId, seq: number): MutableMessage {
    const turn = this.#turn(turnId);
    if (!turn.assistant) {
      turn.assistant = this.#push({
        role: 'assistant',
        id: turn.nextAssistantId ?? `${turnId}:assistant`,
        turnId,
        parts: [],
        firstSeq: seq,
        lastSeq: seq,
        ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
        snapshot: undefined,
      });
      turn.segments.push(turn.assistant);
    }
    return this.#touch(turn.assistant, seq);
  }

  /** 回合的全部助手消息（插话把一个回合分成几条），没有时建一条当前的。 */
  #segments(turnId: TurnId, seq: number): MutableMessage[] {
    this.#assistant(turnId, seq);
    return this.#turn(turnId).segments;
  }

  /** 事件属于回合时放进回合的助手消息，否则成为一条系统消息。 */
  #target(turnId: TurnId | undefined, seq: number): MutableMessage {
    if (turnId) return this.#assistant(turnId, seq);
    return this.#push({
      role: 'system',
      id: `system:${seq}`,
      parts: [],
      firstSeq: seq,
      lastSeq: seq,
      snapshot: undefined,
    });
  }

  #notice(event: WevirEvent, notice: SessionNotice): void {
    this.#target(undefined, event.seq).parts.push({
      type: 'notice',
      key: `n:${event.seq}`,
      notice,
    });
  }

  /** 还没交出去的那份接力摘要有了结果（交出去了，或被下一次接力取代）。 */
  #setHandoffDelivery(delivery: HandoffDelivery): void {
    const key = this.#pendingHandoff;
    if (key === undefined) return;
    this.#pendingHandoff = undefined;
    for (let index = this.#messages.length - 1; index >= 0; index--) {
      const message = this.#messages[index];
      const at = message?.parts.findIndex((part) => part.key === key) ?? -1;
      const part = message?.parts[at];
      if (message === undefined || part?.type !== 'notice' || part.notice.kind !== 'handoff') {
        continue;
      }
      this.#touch(message, this.#lastSeq);
      message.parts[at] = { ...part, notice: { ...part.notice, delivery } };
      return;
    }
  }

  // ── 回合 ─────────────────────────────────────────────────────────────

  /**
   * 回合被撤回（0.38.0）：它的用户消息与助手消息从消息记录里去掉，连同指向它们的工具、子会话与建议的部件；最近的计划是它的时也去掉。
   */
  #turnRewound(turnId: TurnId): void {
    const removed = new Set(this.#messages.filter((message) => message.turnId === turnId));
    if (removed.size === 0) return;
    this.#messages = this.#messages.filter((message) => !removed.has(message));
    this.#turns.delete(turnId);
    for (const [toolCallId, message] of this.#tools) {
      if (removed.has(message)) this.#tools.delete(toolCallId);
    }
    for (const [key, message] of this.#taskParts) {
      if (removed.has(message)) this.#taskParts.delete(key);
    }
    for (const [sessionId, messages] of this.#subagentParts) {
      this.#subagentParts.set(
        sessionId,
        messages.filter((message) => !removed.has(message)),
      );
    }
    if (this.#latestPlan?.turnId === turnId) this.#latestPlan = undefined;
    // 撤销的回合被撤回（编辑重发退掉了它）：不再能重做。
    this.#hidden.delete(turnId);
    this.#redo = this.#redo.filter((id) => id !== turnId);
  }

  #turnFinished(event: WevirEventOf<'turn.finished'>): void {
    const { turnId, outcome, durationMs } = event.payload;
    const message = this.#assistant(turnId, event.seq);
    message.finished = { outcome, durationMs };
    // domain-model §6.3 规则 4：本回合没被替换的增量丢弃，以已提交消息为准；回合被中断（Host 或引擎退出）时已提交
    // 消息不会再来，保留中断前已生成的部分（T5.5）。§6.4：未收尾的工具不再转圈。插话把回合分成几条助手消息，每条都收尾。
    const keepPartial = outcome === 'interrupted';
    for (const segment of this.#turn(turnId).segments) {
      const parts = segment.parts.flatMap((part): ChatPart[] => {
        if (isStreamPart(part) && part.state === 'streaming') {
          return keepPartial && part.text.trim() !== '' ? [{ ...part, state: 'done' }] : [];
        }
        // 0.24.0：没压缩成的压缩不再转圈。
        if (part.type === 'compaction' && part.status === 'running') return [];
        // 0.37.0：没写完的计划留下已写出的部分，不能实施。
        if (part.type === 'plan' && part.state === 'streaming') {
          return part.text.trim() === '' ? [] : [{ ...part, state: 'incomplete' }];
        }
        return [
          part.type === 'tool' && isOpen(part.status) ? { ...part, status: 'unknown' } : part,
        ];
      });
      if (parts.length !== segment.parts.length || parts.some((p, i) => p !== segment.parts[i])) {
        this.#touch(segment, event.seq);
        segment.parts = parts;
      }
    }
    if (this.#activeTurnId === turnId) this.#activeTurnId = undefined;
  }

  #delta(event: WevirEventOf<'assistant.delta'>): void {
    const { turnId, streamId, blockIndex, kind, text } = event.payload;
    const message = this.#assistant(turnId, event.seq);
    const since = this.#activity(turnId, event.ts);
    const key = streamKey({ streamId, blockIndex });
    const index = message.parts.findIndex((part) => part.key === key);
    const part = message.parts[index];
    if (part && isStreamPart(part)) {
      message.parts[index] =
        part.type === 'reasoning'
          ? { ...part, text: part.text + text, endedAt: event.ts }
          : { ...part, text: part.text + text };
      return;
    }
    const stream = { key, text, state: 'streaming', stream: { streamId, blockIndex } } as const;
    message.parts.push(
      kind === 'reasoning'
        ? { type: kind, ...stream, startedAt: since ?? event.ts, endedAt: event.ts }
        : { type: kind, ...stream },
    );
  }

  #dropStream(event: WevirEventOf<'assistant.stream_ended'>): void {
    const prefix = `s:${event.payload.streamId}:`;
    const dropped = (part: ChatPart) =>
      part.key.startsWith(prefix) && isStreamPart(part) && part.state === 'streaming';
    for (const segment of this.#segments(event.payload.turnId, event.seq)) {
      if (!segment.parts.some(dropped)) continue;
      this.#touch(segment, event.seq);
      segment.parts = segment.parts.filter((part) => !dropped(part));
    }
  }

  #committed(event: WevirEventOf<'assistant.message'> | WevirEventOf<'assistant.thought'>): void {
    const { turnId, text, replaces } = event.payload;
    const type = event.type === 'assistant.message' ? 'text' : 'reasoning';
    const replacedKeys = new Set(replaces.map(streamKey));
    // 增量可能在插话之前的那条助手消息里：在这个回合的全部助手消息里找，找不到就放进当前的。
    const message =
      this.#segments(turnId, event.seq).findLast((segment) =>
        segment.parts.some((part) => replacedKeys.has(part.key)),
      ) ?? this.#assistant(turnId, event.seq);
    this.#touch(message, event.seq);
    const since = this.#activity(turnId, event.ts);
    const at = message.parts.findIndex((part) => replacedKeys.has(part.key));
    const blank = text.trim() === '';
    // 替换增量的思考沿用增量的起止时刻；没有增量的从回合上一次有输出算到现在。
    const replaced = message.parts[at];
    const timing: ReasoningTiming =
      replaced?.type === 'reasoning' && replaced.startedAt !== undefined
        ? { startedAt: replaced.startedAt, endedAt: replaced.endedAt ?? event.ts }
        : { startedAt: since ?? event.ts, endedAt: event.ts };
    const part = (key: string): ChatPart =>
      type === 'reasoning'
        ? { type, key, text, state: 'done', ...timing }
        : { type, key, text, state: 'done' };
    if (at < 0) {
      // 规则 3：没有可替换的增量时追加在回合末尾。只含空白的已提交块不显示。
      if (!blank) message.parts.push(part(`m:${event.seq}`));
      return;
    }
    const key = replaced?.key ?? `m:${event.seq}`;
    const parts = message.parts.filter(
      (part, index) => index === at || !replacedKeys.has(part.key),
    );
    const index = parts.findIndex((part) => part.key === key);
    if (blank) parts.splice(index, 1);
    else parts[index] = part(key);
    message.parts = parts;
  }

  /** 记下回合这一刻有输出，返回上一次有输出的时刻（思考部件的开始，`ReasoningTiming`）。 */
  #activity(turnId: TurnId, ts: IsoTime): IsoTime | undefined {
    const turn = this.#turn(turnId);
    const since = turn.activityAt;
    turn.activityAt = ts;
    return since;
  }

  // ── 工具 ─────────────────────────────────────────────────────────────

  #toolStarted(event: WevirEventOf<'tool.started'>): void {
    const { turnId, toolCallId, toolName, display, input } = event.payload;
    if (this.#tools.has(toolCallId)) return;
    const message = this.#assistant(turnId, event.seq);
    this.#activity(turnId, event.ts);
    message.parts.push({
      type: 'tool',
      key: `t:${toolCallId}`,
      toolCallId,
      toolName,
      display,
      status: 'running',
      input,
      startedAt: event.ts,
    });
    this.#tools.set(toolCallId, message);
  }

  #updateTool(
    toolCallId: string,
    seq: number,
    update: (part: ChatPartOf<'tool'>) => ChatPartOf<'tool'>,
  ): boolean {
    const message = this.#tools.get(toolCallId);
    if (!message) return false;
    const index = message.parts.findIndex(
      (part) => part.type === 'tool' && part.toolCallId === toolCallId,
    );
    const part = message.parts[index];
    if (part?.type !== 'tool') return false;
    this.#touch(message, seq);
    message.parts[index] = update(part);
    return true;
  }

  #toolUpdated(event: WevirEventOf<'tool.updated'>): void {
    const { turnId, toolCallId, display, input, output } = event.payload;
    this.#activity(turnId, event.ts);
    this.#updateTool(toolCallId, event.seq, (part) => ({
      ...part,
      ...(display && { display }),
      ...(input !== undefined && { input }),
      ...(output && { output }),
    }));
  }

  #toolFinished(event: WevirEventOf<'tool.finished'>): void {
    const { turnId, toolCallId, status, output, images } = event.payload;
    this.#activity(turnId, event.ts);
    this.#updateTool(toolCallId, event.seq, (part) => ({
      ...part,
      status,
      ...(output && { output }),
      ...(images && { images }),
      finishedAt: event.ts,
    }));
  }

  #todo(event: WevirEventOf<'todo.updated'>): void {
    const items = event.payload.items;
    // 每个回合只留一份最新的待办列表，位置在第一次出现的地方（插话之前的那条助手消息里也算）。
    const message =
      this.#segments(event.payload.turnId, event.seq).find((segment) =>
        segment.parts.some((part) => part.type === 'todo'),
      ) ?? this.#assistant(event.payload.turnId, event.seq);
    this.#touch(message, event.seq);
    const index = message.parts.findIndex((part) => part.type === 'todo');
    if (index >= 0) message.parts[index] = { type: 'todo', key: 'todo', items };
    else message.parts.push({ type: 'todo', key: 'todo', items });
  }

  /**
   * `plan.proposed`（0.36.0）：回合里的 `plan` 部件，同一 `planId` 原位替换（写的时候的预览也是）；记为最近的计划。
   */
  #plan(event: WevirEventOf<'plan.proposed'>): void {
    const { turnId, planId, text } = event.payload;
    this.#activity(turnId, event.ts);
    this.#latestPlan = { turnId, planId, text, seq: event.seq };
    this.#putPlan(turnId, event.seq, {
      type: 'plan',
      key: `p:${planId}`,
      planId,
      text,
      state: 'done',
    });
  }

  /**
   * `plan.delta`（0.37.0）：计划的预览，追加到同一 `planId` 的 `plan` 部件（`streaming`）。`restart` 时从这一段重来（给出过的
   * 计划也作废）；没有 `restart` 时已经给出的计划不再追加。
   */
  #planDelta(event: WevirEventOf<'plan.delta'>): void {
    const { turnId, planId, text, restart } = event.payload;
    const key = `p:${planId}`;
    this.#activity(turnId, event.ts);
    const current = this.#turn(turnId)
      .segments.flatMap((segment) => segment.parts)
      .find((part): part is ChatPartOf<'plan'> => part.key === key && part.type === 'plan');
    if (current && !restart && current.state !== 'streaming') return;
    const latest = this.#latestPlan;
    if (restart && latest?.turnId === turnId && latest.planId === planId) {
      this.#latestPlan = undefined;
    }
    this.#putPlan(turnId, event.seq, {
      type: 'plan',
      key,
      planId,
      text: current && !restart ? current.text + text : text,
      state: 'streaming',
    });
  }

  /** 回合里同一 `key` 的计划部件原位换成 `part`，没有就加在当前的助手消息里。 */
  #putPlan(turnId: TurnId, seq: number, part: ChatPartOf<'plan'>): void {
    for (const segment of this.#turn(turnId).segments) {
      const index = segment.parts.findIndex((candidate) => candidate.key === part.key);
      if (index < 0) continue;
      this.#touch(segment, seq);
      segment.parts = segment.parts.map((candidate, i) => (i === index ? part : candidate));
      return;
    }
    this.#assistant(turnId, seq).parts.push(part);
  }

  // ── 审批 ─────────────────────────────────────────────────────────────

  #approvalRequested(event: WevirEventOf<'approval.requested'>): void {
    const { approval } = event.payload;
    this.#approvals.set(approval.id, approval);
    this.#approvalsDirty = true;
    this.#updateTool(approval.toolCallId, event.seq, (part) => ({
      ...part,
      status: isOpen(part.status) ? 'awaiting_approval' : part.status,
      approval: { approvalId: approval.id, status: approval.status, options: approval.options },
    }));
  }

  #approvalResolved(event: WevirEventOf<'approval.resolved'>): void {
    const { approvalId, status, resolution } = event.payload;
    const approval = this.#approvals.get(approvalId);
    if (!approval) return;
    // 等审批的时间不算思考：模型从审批结算之后才接着想。
    this.#activity(approval.turnId, event.ts);
    this.#approvals.set(approvalId, { ...approval, status, resolution, resolvedAt: event.ts });
    this.#approvalsDirty = true;
    this.#updateTool(approval.toolCallId, event.seq, (part) => ({
      ...part,
      status: part.status === 'awaiting_approval' ? 'running' : part.status,
      approval: part.approval && { ...part.approval, status, resolution },
    }));
  }

  // ── 提问（0.10.0） ───────────────────────────────────────────────────

  #questionRequested(event: WevirEventOf<'question.requested'>): void {
    const { question } = event.payload;
    this.#questions.set(question.id, question);
    const message = this.#assistant(question.turnId, event.seq);
    this.#touch(message, event.seq);
    message.parts.push({ type: 'question', key: `q:${question.id}`, question });
  }

  #questionResolved(event: WevirEventOf<'question.resolved'>): void {
    const { questionId, status, resolution } = event.payload;
    const previous = this.#questions.get(questionId);
    if (!previous) return;
    // 等回答的时间不算思考。
    this.#activity(previous.turnId, event.ts);
    const question: QuestionRequest = { ...previous, status, resolution, resolvedAt: event.ts };
    this.#questions.set(questionId, question);
    for (const segment of this.#segments(previous.turnId, event.seq)) {
      const index = segment.parts.findIndex(
        (part) => part.type === 'question' && part.question.id === questionId,
      );
      if (index < 0) continue;
      this.#touch(segment, event.seq);
      segment.parts[index] = { type: 'question', key: `q:${questionId}`, question };
    }
    this.#dirty = true;
  }

  // ── 子会话 ───────────────────────────────────────────────────────────

  /**
   * `subagent.started` / `subagent.updated`：摘要列表按 `sessionId` 追加或替换；“开始”部件放在派出它的回合（没有回合时
   * 一条系统消息），之后原位更新。子会话离开 `running` 时，在父会话当前的回合（父会话空闲时一条系统消息）里加一个
   * “结束”部件，所以“已完成”出现在它真正结束的位置（R5）。
   */
  #subagent(event: WevirEventOf<'subagent.started'> | WevirEventOf<'subagent.updated'>): void {
    const summary = event.payload.subagent;
    const index = this.#subagents.findIndex((item) => item.sessionId === summary.sessionId);
    const previous = index < 0 ? undefined : this.#subagents[index];
    this.#subagents =
      index < 0
        ? [...this.#subagents, summary]
        : this.#subagents.map((item, i) => (i === index ? summary : item));
    const messages = this.#subagentParts.get(summary.sessionId) ?? [];
    for (const message of messages) {
      this.#touch(message, event.seq);
      message.parts = message.parts.map((part) =>
        part.type === 'subagent' && part.subagent.sessionId === summary.sessionId
          ? { ...part, subagent: summary }
          : part,
      );
    }
    if (messages.length === 0) {
      const message = this.#target(summary.parentTurnId, event.seq);
      message.parts.push({ type: 'subagent', key: `a:${summary.sessionId}`, subagent: summary });
      messages.push(message);
    }
    if (previous?.status === 'running' && summary.status !== 'running') {
      const message = this.#target(this.#activeTurnId, event.seq);
      message.parts.push({
        type: 'subagent',
        key: `a:${summary.sessionId}:end:${event.seq}`,
        subagent: summary,
        ended: summary.status,
      });
      if (!messages.includes(message)) messages.push(message);
    }
    this.#subagentParts.set(summary.sessionId, messages);
  }

  // ── 建议的后续任务 ───────────────────────────────────────────────────

  /**
   * `tasks.suggested` 在提出建议的回合里加一个 `tasks` 部件；`task.started` / `task.reported` 更新任务并原位换掉那个部件的
   * `tasks`，`task.reported` 另在当时所在的位置加一个 `task_report` 部件。
   */
  #task(
    event:
      | WevirEventOf<'tasks.suggested'>
      | WevirEventOf<'task.started'>
      | WevirEventOf<'task.reported'>,
  ): void {
    if (event.type === 'tasks.suggested') {
      const { toolCallId, turnId, tasks } = event.payload;
      for (const task of tasks) this.#tasks.set(task.id, task);
      const message = this.#target(turnId, event.seq);
      message.parts.push({ type: 'tasks', key: `k:${toolCallId}`, toolCallId, tasks });
      this.#taskParts.set(toolCallId, message);
      return;
    }
    const previous = this.#tasks.get(event.payload.taskId);
    if (!previous) return;
    const task: SuggestedTask =
      event.type === 'task.started'
        ? { ...previous, status: 'started', sessionId: event.payload.sessionId }
        : {
            ...previous,
            status: 'reported',
            sessionId: event.payload.sessionId,
            outcome: event.payload.outcome,
          };
    this.#tasks.set(task.id, task);
    const message = this.#taskParts.get(task.toolCallId);
    if (message) {
      this.#touch(message, event.seq);
      const tasks = [...this.#tasks.values()].filter((item) => item.toolCallId === task.toolCallId);
      message.parts = message.parts.map((part) =>
        part.type === 'tasks' && part.toolCallId === task.toolCallId ? { ...part, tasks } : part,
      );
    }
    if (event.type === 'task.reported') {
      this.#target(this.#activeTurnId, event.seq).parts.push({
        type: 'task_report',
        key: `kr:${task.id}`,
        task,
        ...(event.payload.summary !== undefined && { summary: event.payload.summary }),
      });
    }
  }

  // ── 第二意见 ─────────────────────────────────────────────────────────

  /** `opinion.updated`：新的意见在当时所在的位置加一个 `opinion` 部件，之后原位换成最新的。 */
  #opinion(event: WevirEventOf<'opinion.updated'>): void {
    const { opinion } = event.payload;
    this.#opinions.set(opinion.id, opinion);
    const message = this.#opinionParts.get(opinion.id);
    if (message === undefined) {
      const target = this.#target(this.#activeTurnId, event.seq);
      target.parts.push({ type: 'opinion', key: `o:${opinion.id}`, opinion });
      this.#opinionParts.set(opinion.id, target);
      return;
    }
    this.#touch(message, event.seq);
    message.parts = message.parts.map((part) =>
      part.type === 'opinion' && part.opinion.id === opinion.id ? { ...part, opinion } : part,
    );
  }

  // ── 错误与调试 ───────────────────────────────────────────────────────

  #engineError(event: WevirEventOf<'engine.error'>): void {
    const { category, message, turnId, fatal, usageLimit } = event.payload;
    this.#lastError = { category, message };
    this.#target(turnId, event.seq).parts.push({
      type: 'error',
      key: `e:${event.seq}`,
      category,
      message,
      fatal,
      ...(usageLimit !== undefined && turnId !== undefined && { turnId, usageLimit }),
    });
  }

  /** 引擎重试请求（0.119.0）：消息的最后一个部件已经是重试时原位换成这一次的。 */
  #retrying(event: WevirEventOf<'turn.retrying'>): void {
    const { turnId, attempt, maxAttempts, reason } = event.payload;
    const target = this.#target(turnId, event.seq);
    const last = target.parts.at(-1);
    const part: ChatPartOf<'retry'> = {
      type: 'retry',
      key: last?.type === 'retry' ? last.key : `t:${event.seq}`,
      ...(attempt !== undefined && { attempt }),
      ...(maxAttempts !== undefined && { maxAttempts }),
      ...(reason !== undefined && { reason }),
    };
    if (last?.type === 'retry') target.parts[target.parts.length - 1] = part;
    else target.parts.push(part);
  }

  /** Host 替用户发了继续消息（0.119.0）：那个回合的额度卡片记下发出的时刻。 */
  #autoContinued(failedTurnId: TurnId, at: IsoTime, seq: number): void {
    for (let index = this.#messages.length - 1; index >= 0; index--) {
      const message = this.#messages[index];
      if (message === undefined || message.turnId !== failedTurnId) continue;
      const found = message.parts.findIndex(
        (part) => part.type === 'error' && part.usageLimit !== undefined,
      );
      const part = message.parts[found];
      if (part?.type !== 'error') continue;
      this.#touch(message, seq);
      message.parts[found] = { ...part, resumedAt: at };
      return;
    }
  }

  #raw(event: WevirEventOf<'engine.raw'>): void {
    const { method, kind, params } = event.payload;
    this.#target(this.#activeTurnId, event.seq).parts.push({
      type: 'raw',
      key: `r:${event.seq}`,
      method,
      ...(kind !== undefined && { kind }),
      params,
    });
  }
}

/** 一批事件的投影（测试与一次性渲染用）。 */
export function projectTranscript(
  events: Iterable<WevirEvent>,
  options?: TranscriptProjectionOptions,
): Transcript {
  const projection = new TranscriptProjection(options);
  for (const event of events) projection.apply(event);
  return projection.snapshot();
}

/** 用户消息里的文本：文本段以换行相连，图片不算（0.28.0）。 */
export function userContentText(content: readonly UserContentPart[]): string {
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** 用户消息的部件：一个文本部件（只有图片时没有），之后每张图片一个（0.28.0）。 */
function userParts(content: readonly UserContentPart[]): ChatPart[] {
  const images: ChatPart[] = content.flatMap((part, index) =>
    part.type === 'image' ? [{ type: 'image' as const, key: `image:${index}`, image: part }] : [],
  );
  const text = userContentText(content);
  if (text === '' && images.length > 0) return images;
  const segments = content.flatMap((part) =>
    part.type === 'text'
      ? [{ text: part.text, ...(part.pasted && { pasted: true as const }) }]
      : [],
  );
  return [
    {
      type: 'text',
      key: 'text',
      text,
      state: 'done',
      ...(segments.some((segment) => segment.pasted) && { segments }),
    },
    ...images,
  ];
}

function streamKey(ref: StreamBlockRef): string {
  return `s:${ref.streamId}:${ref.blockIndex}`;
}

function isStreamPart(part: ChatPart): part is ChatPartOf<'text' | 'reasoning'> {
  return part.type === 'text' || part.type === 'reasoning';
}

function isOpen(status: ToolPartStatus): boolean {
  return status === 'running' || status === 'awaiting_approval';
}

function freeze(message: MutableMessage): ChatMessage {
  const base = {
    id: message.id,
    parts: [...message.parts],
    seqRange: [message.firstSeq, message.lastSeq] as const,
  };
  switch (message.role) {
    case 'user':
      return {
        ...base,
        role: 'user',
        turnId: message.turnId as TurnId,
        ...(message.sentBy !== undefined && { sentBy: message.sentBy }),
        ...(message.fromParentAgent && { fromParentAgent: true }),
        ...(message.command !== undefined && { command: message.command }),
        ...(message.trigger !== undefined && { trigger: message.trigger }),
        ...(message.collaborationMode !== undefined && {
          collaborationMode: message.collaborationMode,
        }),
        ...(message.clientMessageId !== undefined && { clientMessageId: message.clientMessageId }),
        ...(message.steered && { steered: true }),
        ...(message.pendingId !== undefined && { pendingId: message.pendingId }),
        ...(message.from !== undefined && { from: message.from }),
        ts: message.ts as IsoTime,
      };
    case 'assistant':
      return {
        ...base,
        role: 'assistant',
        turnId: message.turnId as TurnId,
        ...(message.startedAt && { startedAt: message.startedAt }),
        ...(message.finished && { finished: message.finished }),
      };
    case 'system':
      return { ...base, role: 'system' };
  }
}

const NO_CHAPTERS: readonly TranscriptChapter[] = [];

/** 看得见的消息里的章节；与上一份相同（同样的章节在同样的消息里）时返回上一份。 */
function chaptersOf(
  messages: readonly ChatMessage[],
  previous: readonly TranscriptChapter[] | undefined,
): readonly TranscriptChapter[] {
  const chapters: TranscriptChapter[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'chapter') continue;
      chapters.push({
        key: part.key,
        seq: part.seq,
        title: part.title,
        ...(part.summary !== undefined && { summary: part.summary }),
        messageId: message.id,
        ...(message.role !== 'system' && { turnId: message.turnId }),
      });
    }
  }
  if (chapters.length === 0) return NO_CHAPTERS;
  if (
    previous !== undefined &&
    previous.length === chapters.length &&
    previous.every(
      (chapter, index) =>
        chapter.key === chapters[index]?.key && chapter.messageId === chapters[index]?.messageId,
    )
  ) {
    return previous;
  }
  return Object.freeze(chapters);
}
