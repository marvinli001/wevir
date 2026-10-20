import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type ApprovalDetail,
  type ApprovalId,
  type ApprovalOption,
  type ApprovalRequest,
  type ApprovalResolution,
  type ClientIdentity,
  DEFAULT_PERMISSION_MODE,
  type EngineErrorCategory,
  type EngineErrorInfo,
  type EngineFeatures,
  type EnvironmentId,
  type FilesRestore,
  type HandoffBinding,
  type HandoffMaterialRequest,
  type HandoffNoteRef,
  IMAGE_MAX_PER_MESSAGE,
  type MessageFrom,
  type MethodParams,
  type MethodResult,
  type PendingMessage,
  type PendingMessageId,
  type PermissionMode,
  PROMPT_SUGGESTION_VOIDING_EVENTS,
  type ProviderId,
  type QuestionId,
  type QuestionRequest,
  type QuestionResolution,
  type ResolvedApprovalStatus,
  type ReviewTarget,
  SESSION_RECAP_MIN_AWAY_MS,
  type Session,
  type SessionAutomation,
  type SessionGoal,
  type SessionId,
  type SessionReadOnlyReason,
  type SessionRecap,
  type SessionSnapshot,
  type SessionState,
  type SessionWorktree,
  type SharedFile,
  type StateChangeReason,
  type StreamBlockRef,
  type StreamId,
  type SubagentSummary,
  type SuggestedTask,
  type TaskId,
  type ToolDisplay,
  type TurnCommand,
  type TurnId,
  type TurnOutcome,
  type UiShowTarget,
  type UserContentPart,
  type UserQuestion,
  type WevirEvent,
  type WevirEventType,
  type WorkspaceId,
} from '@wevir/protocol';
import {
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalCancelledEvent,
  type ApprovalRequestedEvent,
  type AppToolsEndpoint,
  type DeltaBlockRef,
  type EngineGoal,
  type EngineSession,
  isAdapterError,
  type QuestionCancelledEvent,
  type QuestionRequestedEvent,
  type ReviewRequest,
  type SessionCommandMethod,
  type SessionConfig,
  type SessionLostReason,
  type SubagentStartedEvent,
  type SubagentUpdatedEvent,
  type TurnStartedEvent,
  type TurnSteeredEvent,
  type UsageRecordedEvent,
  type UsageUpdatedEvent,
} from '@wevir/runtime-adapter';
import { writeHistoryFile } from '@wevir/runtime-adapter/history-tool';
import {
  type ApprovalRecord,
  requestFingerprint,
  type SessionRecord,
  type Storage,
  type WorkspaceRecord,
} from '@wevir/storage';
import type { ChatFolders } from './chats.js';
import type { TurnCheckpoints } from './checkpoints.js';
import { HostError, isHostError } from './errors.js';
import type { AppendInput, EventStore } from './event-store.js';
import { reviewRepo } from './git-diff.js';
import {
  type CreatedWorktree,
  createWorktree,
  removeWorktree,
  WorktreeError,
} from './git-worktree.js';
import {
  assembleHandoff,
  DELTA_SINCE_TARGET_LAST_SEEN,
  FULL_THREAD_SUMMARY,
  HANDOFF_BUDGET_BYTES,
  type HandoffAssembly,
  type HandoffNote,
  historyItems,
  withHandoffContext,
} from './handoff.js';
import { newId } from './ids.js';
import type { ImageStore } from './images.js';
import { MemoryError, type MemoryStore } from './memory.js';
import {
  parseSuggestion,
  SUGGESTION_EVENT_WINDOW,
  SUGGESTION_OUTPUT_SCHEMA,
  SUGGESTION_TIMEOUT_MS,
  suggestionInput,
  suggestionItems,
} from './prompt-suggestion.js';
import {
  analyzeSession,
  parseRecap,
  RECAP_MIN_TURNS,
  RECAP_OUTPUT_SCHEMA,
  RECAP_TIMEOUT_MS,
  RecapCache,
  recapInput,
} from './recap.js';
import { type FoundRuleFile, planRules, type RulePlan, sameRules } from './rule-files.js';
import { deleteSessionData, measureUsage } from './session-delete.js';
import { TERMINAL_PENDING_STATUSES } from './snapshot.js';
import { parseGeneratedTitle, TITLE_OUTPUT_SCHEMA, TITLE_TIMEOUT_MS, titleInput } from './title.js';
import { normalizeToolPreset, type ToolPreset } from './tool-presets.js';

/**
 * 取消后等回合结算的时限（domain-model §4.1 #9）。T0.3 实测 ACP 引擎 3–64 ms 结算；超过它仍没有终结
 * 事件，就当作无法确认已停止。
 */
export const CANCEL_TIMEOUT_MS = 5000;

/**
 * 无人值守的会话（自动化开的、子会话、另一个会话里的 agent 开的）里，提问等多久没人回答就按推荐的选项回答（0.71.0）。
 */
export const QUESTION_TIMEOUT_MS = 5 * 60_000;

/**
 * 连续几次自动压缩之后用量仍不低于压缩线，Host 就停下回合（`#checkAutoCompaction`）：这时再压缩也降不下来，引擎却会在每个
 * 请求之后接着压缩，一直花额度。
 */
export const FRUITLESS_AUTO_COMPACTIONS = 2;

/** 标题取首条用户消息的前多少个字符（按码点计，空白折叠成一个空格）。 */
export const TITLE_MAX_LENGTH = 50;

export interface SessionManagerOptions {
  storage: Storage;
  /** 与 `storage` 同一个数据库上的事件库；会话事件都经它写入。 */
  events: EventStore;
  /** 由 Host 独占的引擎适配器。SessionManager 不 `dispose` 它。 */
  adapter: AgentRuntimeAdapter;
  /** `sessions.engine` 列的值（`codex`、`echo`），默认 `echo`（测试沿用）。 */
  engine?: string;
  /** 默认 `CANCEL_TIMEOUT_MS`。 */
  cancelTimeoutMs?: number;
  /** 无人值守的会话里提问的超时（0.71.0）；默认 `QUESTION_TIMEOUT_MS`，0 表示一直等。 */
  questionTimeoutMs?: number;
  /** 后台错误：处理引擎事件失败、丢弃的引擎事件等。默认打到 stderr。 */
  onError?: (error: unknown) => void;
  /**
   * 生成会话标题用的说明（prompts/thread-title.md，`loadTitleInstructions`）。给了、并且适配器实现了
   * `generateTitle` 时，第一个回合开始后用会话的模型生成标题；否则只有首条消息截断的标题。
   */
  titleInstructions?: string;
  /**
   * 输入建议（0.53.0，domain-model §3.23）：给了、并且适配器实现了 `generateTitle` 时，会话的回合正常结束后用会话的模型预测
   * 用户接着会发的一句话（prompts/prompt-suggestion.md，`loadSuggestionInstructions`）。`enabled` 每次回合结束时问一次（Host
   * 设置 `promptSuggestions`），关着就不发请求。没给时没有输入建议。
   */
  suggestion?: { instructions: string; enabled: () => boolean };
  /**
   * 离开后摘要用的说明（prompts/session-recap.md，`loadRecapInstructions`）。给了、并且适配器实现了 `generateTitle` 时，
   * `session.recap` 才会生成；否则回 `reason: 'unsupported'`。
   */
  recapInstructions?: string;
  /** 设置里的“离开后摘要”开着没有（0.54.0，`HostSettings.sessionRecap`）；每次请求时读，不给就当开着。 */
  recapEnabled?: () => boolean;
  /** 不影响状态的告警（生成标题失败等）。默认打到 stderr。 */
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * 环境会话新开的 worktree 放在这里（0.15.0，`<数据目录>/worktrees`，每个会话一个子目录）。没给时环境里要新开 worktree 的
   * 文件夹建不了会话（`INVALID_PARAMS`）。
   */
  worktreesDir?: string;
  /**
   * 不在项目里的会话（0.39.0，chats.ts）：`session.create` 不带 `workspaceId` 时建在这里的“对话”工作区，每个会话一个新建的文件夹。
   * 没给时 `workspaceId` 必填（`INVALID_PARAMS`）。
   */
  chats?: ChatFolders;
  /**
   * 回合快照（0.20.0，checkpoints.ts）：顶层、不是支线的会话在回合开始交给引擎之前打“前”快照，回合结束后打“后”快照，
   * 会话关闭时删掉它的快照。没给时不打。
   */
  checkpoints?: TurnCheckpoints;
  /**
   * 每种 Provider 的会话由哪个引擎跑、能做什么（0.25.0，接力，`host.hello` 的 `engineFeatures`）。接力时按它决定沿用的权限模式、
   * 有额外目录的会话能不能交过去、摘要里提不提读历史的工具。没给时只看适配器自己声明的。
   */
  engineFeatures?: Readonly<Record<string, EngineFeatures>>;
  /**
   * 读历史的工具读的目录（0.25.0，`<数据目录>/history`）：接力到挂了这个工具的引擎时，把会话到那时为止的完整历史写进
   * `<会话 ID>.json`。没给时不写，摘要里也不提这个工具。
   */
  historyDir?: string;
  /** 接力时用户选入的记忆笔记从这里读（0.59.0）。没给时不能选笔记。 */
  memory?: Pick<MemoryStore, 'read'>;
  /** Host 设置的 `autoMemory`（0.57.0）：返回 false 时接力不能选笔记。省略当作开着。 */
  memoryEnabled?: () => boolean;
  /**
   * 跨引擎的规则文件（0.68.0，rule-files.ts）：建立、恢复、分支与接力引擎会话时找出会话目录的规则文件，引擎自己不读的补给它，
   * 并写 `session.rules`。没给时不找、不写。
   */
  ruleFiles?: {
    discover(cwd: string): Promise<FoundRuleFile[]>;
    /** Host 设置的 `ruleFiles`：返回 false 时只记引擎自己读的、不补。省略当作开着。 */
    enabled?: () => boolean;
  };
  /** 大输出与后台进程的日志（tool-output.ts，`<数据目录>/tool-output`）：删除会话时随会话删，存储页算进会话的文件。 */
  toolOutputDir?: string;
  /**
   * 消息里的图片（0.28.0，images.ts）。没给时、或适配器没有 `acceptsImages` 时，带图片的消息回 `INVALID_PARAMS`。
   */
  images?: ImageStore;
  /**
   * 应用级工具（0.30.0，app-tools.ts）：适配器声明了 `appTools` 时，建会话、恢复、分支与接力都给引擎会话这个会话的端点与令牌。
   * 没给时（或还没监听）引擎会话不挂。
   */
  appTools?: {
    grant(sessionId: SessionId): AppToolsEndpoint | undefined;
    /** P3：插件工具事件落库前固定安装内容并脱敏，审批沿用同一详情。 */
    prepareEvent?(sessionId: SessionId, event: AgentEvent): Promise<AgentEvent>;
    resolved?(sessionId: SessionId, toolCallId: string, approvedByUser: boolean): void;
    /** 删除会话：结束这一家会话的后台进程（processes.ts）。 */
    forget?(sessionIds: readonly SessionId[]): void;
    dispose?(): void;
  };
  /** 一个回合结束（`turn.finished` 写入之后，异步调用）：应用级工具据此把结果回报给请它做事的会话。 */
  onTurnFinished?: (info: { sessionId: SessionId; turnId: TurnId; outcome: TurnOutcome }) => void;
  /**
   * 引擎报了一次模型请求的用量（0.62.0 的用量统计，`usage.recorded`）：不写事件流，交给它记到用量表。给出会话此刻的 Provider 与
   * 模型，引擎没报模型时用会话的。
   */
  onUsage?: (
    context: { sessionId: SessionId; providerId: string; modelId: string },
    event: UsageRecordedEvent,
  ) => void;
}

/** `session.send` 之外的发送参数（0.30.0）。 */
export interface SendOptions {
  /** 别的会话发来的（应用级工具）：记进 `user.message` / 待发消息的 `from`。 */
  from?: MessageFrom;
}

/** `recover()` 的结果：启动对账修正了什么。 */
export interface RecoveryReport {
  /** 结为 `expired` 的审批数。 */
  expiredApprovals: number;
  /** 由活动状态修正为 `idle` 的会话（#15）。 */
  interruptedSessions: SessionId[];
  /** 标为结果未知的发送回执数。 */
  unknownSends: number;
}

/** 正在建、还没写进存储的会话（`SessionManager.creating`）：以后会写进它的记录的这几项。 */
export type CreatingSession = Pick<SessionRecord, 'workspaceId' | 'origin' | 'toolPreset'>;

interface ToolInfo {
  toolName: string;
  display: ToolDisplay;
  input?: unknown;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

/** 进行中的回合在 Host 内存里的部分：引擎 ID 到 Host ID 的映射、未收尾的工具。 */
interface TurnRuntime {
  readonly turnId: TurnId;
  /** 引擎的 attemptId → StreamId。 */
  readonly streams: Map<string, StreamId>;
  /** 已开始、未结束的工具调用，回合结束时补 `unknown`（domain-model §6.4）。 */
  readonly openTools: Set<string>;
  /** 本回合 `tool.started` 的内容，审批详情从这里取（domain-model §5 第 1 条）。 */
  readonly tools: Map<string, ToolInfo>;
  /** `turn.finished` 写入时完成。 */
  readonly finished: Deferred;
  /**
   * 回合在 `cancelling` 时加入的待发消息（R11，domain-model §4.6）：用户按了停止之后又发的，取消结算后不暂停、照常发出。
   * 只在内存里：Host 重启后一律暂停。
   */
  readonly addedWhileCancelling: Set<PendingMessageId>;
  /** 由命令开始的回合（0.24.0，domain-model §4.7）：不能插话，插话一律排队。 */
  readonly command?: TurnCommand;
  /**
   * 自动修复的回合（0.65.0，ADR-0008）：不能插话；用户这时发来消息，Host 停下这个回合，消息在停止后照常发出。
   */
  readonly repair?: true;
  /**
   * 这个回合里的自动压缩（`#checkAutoCompaction`）：`pending` 是刚压缩完、还没看到之后的第一次用量；`fruitless` 是连续几次
   * 自动压缩之后的第一次用量仍不低于压缩线。
   */
  autoCompaction?: { pending: boolean; fruitless: number };
}

/** 一次对引擎事件流的订阅。 */
interface Attachment {
  readonly iterator: AsyncIterator<AgentEvent>;
  /** Host 主动断开（关闭、引擎异常、dispose）。之后到达的事件丢弃，流结束也不算中断。 */
  detached: boolean;
}

interface SessionRuntime {
  readonly id: SessionId;
  /** 当前的引擎会话；接力（0.25.0）时换成新来源的。 */
  engineSessionId: string;
  /** 子会话的父会话（R4，domain-model §3.3.1）。 */
  readonly parentId?: SessionId;
  /** 命令串行：每个命令排在上一个之后（ADR-0002 §4）。永不 reject。 */
  tail: Promise<unknown>;
  /** 没有时引擎会话尚未挂上：Host 重启后、关闭后、引擎异常后。 */
  attachment?: Attachment;
  turn?: TurnRuntime;
  /** 大于 0 时引擎事件先缓冲，等审批结算写入后再处理（domain-model §5 第 4 条）。 */
  holds: number;
  readonly held: Array<() => void>;
  /** 引擎的审批 requestId ↔ Host 的 ApprovalId，只保留未决的。 */
  readonly approvalIds: Map<string, ApprovalId>;
  readonly requestIds: Map<ApprovalId, string>;
  /** 引擎的提问 requestId ↔ Host 的 QuestionId（0.10.0），只保留未结束的。 */
  readonly questionIds: Map<string, QuestionId>;
  readonly questionRequests: Map<QuestionId, string>;
  /** 正在为这个回合生成输入建议（0.53.0）；用户有了新消息、回合重新开始或回合被撤回时中止并清掉。 */
  suggestion?: { readonly turnId: TurnId; readonly abort: AbortController };
}

const ACTIVE_STATES: readonly SessionState[] = ['running', 'awaiting_approval', 'cancelling'];

/** 用户为一次接力选的材料（0.59.0）：必须携带的约束与读好的笔记。 */
interface HandoffExtras {
  constraints: readonly string[];
  notes: readonly HandoffNote[];
}

/** 一次接力的材料与怎么算出来的（0.59.0，`#handoffPlan`）。 */
interface HandoffPlan {
  /** 按接着用这个来源以前的引擎会话算的。 */
  resumed: boolean;
  strategy: typeof FULL_THREAD_SUMMARY | typeof DELTA_SINCE_TARGET_LAST_SEEN;
  /** 材料算到的事件（会话此刻的 `lastSeq`）。 */
  toSeq: number;
  historyTool: boolean;
  /** 历史条目覆盖的事件；没有历史条目时省略。 */
  covered?: { fromSeq: number; toSeq: number };
  extras: HandoffExtras;
  assembly: HandoffAssembly;
}

/** 接力的前提（0.25.0）：支线不能换来源，回合进行中要等它结束。 */
function assertHandoffAllowed(record: SessionRecord, session: Session): void {
  if (record.side) {
    throw new HostError('INVALID_STATE', 'a side session cannot switch to another provider', {
      state: session.state,
    });
  }
  if (ACTIVE_STATES.includes(session.state)) {
    throw new HostError('SESSION_BUSY', 'wait for the turn to finish before switching models', {
      state: session.state,
      ...(session.activeTurn !== undefined && { activeTurn: session.activeTurn }),
    });
  }
}

/** 选入的笔记各是哪一版（0.59.0）。 */
function noteRefs(notes: readonly HandoffNote[]): HandoffNoteRef[] {
  return notes.map(({ scope, name, revision }) => ({ scope, name, revision }));
}

/**
 * 预览的绑定和此刻重算的材料比（0.60.0）：目标来源、事件上界、方式、笔记的版本，都一样时再比散列（约束改了一类）。不符时
 * `HANDOFF_STALE`，带上不同的是哪几项。
 */
function assertBinding(binding: HandoffBinding, plan: HandoffPlan, providerId: string): void {
  const reasons: string[] = [];
  if (binding.providerId !== providerId) reasons.push('target');
  if (binding.throughSeq !== plan.toSeq) reasons.push('events');
  if (binding.strategy !== plan.strategy) reasons.push('strategy');
  if (!isDeepStrictEqual(binding.notes, noteRefs(plan.extras.notes))) reasons.push('notes');
  const hash = plan.assembly.kind === 'material' ? plan.assembly.hash : undefined;
  if (reasons.length === 0 && binding.hash !== hash) reasons.push('material');
  if (reasons.length === 0) return;
  throw new HostError(
    'HANDOFF_STALE',
    `the handoff changed since it was previewed (${reasons.join(', ')}); preview it again`,
    { reasons },
  );
}

/** 预览的结果（0.60.0）：材料、递交记录里会有的各项，与正式切换时带回的绑定（超出预算时没有）。 */
function handoffPreviewOf(
  providerId: string,
  plan: HandoffPlan,
): MethodResult<'session.handoffPreview'> {
  const { assembly, extras } = plan;
  const notes = noteRefs(extras.notes);
  const preview = {
    providerId,
    strategy: plan.strategy,
    resumed: plan.resumed,
    historyTool: plan.historyTool,
    ...(plan.covered !== undefined && { covered: plan.covered }),
    budgetBytes: assembly.kind === 'empty' ? HANDOFF_BUDGET_BYTES : assembly.budgetBytes,
    constraints: extras.constraints.length,
    notes,
  };
  if (assembly.kind === 'over_budget') {
    return {
      preview: {
        ...preview,
        items: 0,
        omittedItems: 0,
        omitted: [],
        overBudget: { bytes: assembly.bytes },
      },
    };
  }
  const binding = { providerId, throughSeq: plan.toSeq, strategy: plan.strategy, notes };
  if (assembly.kind === 'empty') {
    return { preview: { ...preview, items: 0, omittedItems: 0, omitted: [] }, binding };
  }
  return {
    preview: {
      ...preview,
      items: assembly.items,
      omittedItems: assembly.omittedItems,
      omitted: assembly.omitted,
      context: assembly.context,
      bytes: assembly.bytes,
      hash: assembly.hash,
    },
    binding: { ...binding, hash: assembly.hash },
  };
}

/** 材料（必须项、笔记与开头说明）放不下（0.59.0）：要用户缩减，不截短、不省掉。 */
function handoffOverBudget(assembly: { bytes: number; budgetBytes: number }): HostError {
  const message = `the handoff material is ${assembly.bytes} bytes, over the budget of ${assembly.budgetBytes} bytes; shorten the constraints or select fewer notes`;
  return new HostError('INVALID_PARAMS', message, { issues: [{ path: ['handoff'], message }] });
}

/** `session.handoff` 里材料的部分：摘要正文、条目数与递交记录（0.59.0）。没有材料时只有两个 0。 */
function handoffReceipt(plan: HandoffPlan) {
  const { assembly, extras } = plan;
  if (assembly.kind !== 'material') return { items: 0, omittedItems: 0 };
  return {
    ...(plan.covered !== undefined && { covered: plan.covered }),
    context: assembly.context,
    items: assembly.items,
    omittedItems: assembly.omittedItems,
    bytes: assembly.bytes,
    budgetBytes: assembly.budgetBytes,
    hash: assembly.hash,
    ...(assembly.omitted.length > 0 && { omitted: assembly.omitted }),
    historyTool: plan.historyTool,
    ...(extras.constraints.length > 0 && { constraints: extras.constraints.length }),
    ...(extras.notes.length > 0 && { notes: noteRefs(extras.notes) }),
  };
}

/** 命令开的回合（0.24.0）里的插话改为排队时记下的原因。 */
/**
 * 分支到新会话时抄过去的事件（0.38.0，`#branchHistory`）：消息记录里的。子会话、建议的任务与它们的结局照抄，指向原会话派出的会话。
 */
const BRANCH_HISTORY_EVENTS: ReadonlySet<string> = new Set<WevirEventType>([
  'user.message',
  'user.steered',
  'turn.started',
  'turn.finished',
  'turn.rewound',
  'turn.undone',
  'turn.redone',
  'assistant.delta',
  'assistant.stream_ended',
  'assistant.message',
  'assistant.thought',
  'tool.started',
  'tool.updated',
  'tool.finished',
  'todo.updated',
  'plan.delta',
  'plan.proposed',
  'usage.updated',
  'context.compacting',
  'context.compacted',
  'subagent.started',
  'subagent.updated',
  'tasks.suggested',
  'task.started',
  'task.reported',
  'file.shared',
]);

const COMMAND_TURN_NOT_STEERABLE = 'a compact or review turn cannot be steered';
const REPAIR_TURN_NOT_STEERABLE = 'an automatic repair turn stops for your message instead';

/** 引擎会话恢复不了的原因（适配器的 `session_lost`）→ 会话只读的原因。 */
const READ_ONLY_REASONS = {
  not_found: 'engine_session_not_found',
  incompatible: 'engine_session_incompatible',
  corrupted: 'engine_session_corrupted',
} as const satisfies Record<SessionLostReason, SessionReadOnlyReason>;

/**
 * 基于一个会话的历史新建会话（T3.5 只定接口，domain-model §4.4）：引擎会话恢复不了、会话只读之后的出路。
 * 新会话在原会话的工作区里建新的引擎会话，Provider 与模型默认沿用原会话；原会话的历史从事件库读，怎样交给新的
 * 引擎会话（整理成首个提示、摘要等）由实现决定，新会话的 `session.created` 记下来源。实现时 Host API 加对应的
 * 方法，并在 `HOST_FEATURES` 里声明，客户端据此显示入口。
 */
export interface SessionFromHistory {
  createFromHistory(
    sourceSessionId: SessionId,
    options?: { providerId?: ProviderId; modelId?: string; reasoningEffort?: string },
  ): Promise<Session>;
}

/** 适配器结掉审批的原因 → Host 的审批结算原因。 */
const ENGINE_CANCEL_REASONS = {
  turn_cancelled: 'turn_cancelled',
  turn_ended: 'turn_cancelled',
  engine_exited: 'engine_exited',
  disposed: 'host_shutdown',
} as const satisfies Record<ApprovalCancelledEvent['reason'], ApprovalResolution['reason']>;

/**
 * 会话管理器（T2.3）：把 `AgentRuntimeAdapter` 与事件库连起来，落地会话状态机（domain-model §4）与
 * 审批生命周期（§5）。
 *
 * - **映射。** Wevir 会话与引擎会话一一对应，映射存在 `sessions` 表；适配器的事件按会话订阅，
 *   Host 配上 `turnId`、`StreamId`、`ApprovalId` 写成 WevirEvent。
 * - **命令串行。** 每个会话的 `send`、`cancel`、`respondToApproval`、`close`、`resume` 排队执行。
 *   引擎事件不排队，随到随写；两者都是同步写库，不会交错出半个状态转换。
 * - **状态机。** 每次转换的全部事件在一个事务里写入，事件库按 §4.1 的表校验。命令在不允许的状态下
 *   返回 `SESSION_BUSY` / `INVALID_STATE` / `ALREADY_DECIDED`（§4.2）。
 * - **引擎异常。** 进程退出、适配器调用失败、事件流中断都当作引擎不可用：未决审批结为 `cancelled`、
 *   回合以 `interrupted` 结束、写 `engine.error`（`fatal: true`），会话转 `error`（#10），历史保留，
 *   `resume` 可恢复。
 * - **启动对账。** `recover()` 在服务客户端之前调用一次（#15、§5 第 6 条、ADR-0002 §4）。
 * - **恢复（T3.5）。** 引擎会话由 `resume` 或 send 前的自动 resume 重新挂上，成功写 `session.resumed`（带引擎
 *   版本）。引擎不回放历史，界面历史、会话列表与标题都来自事件库。引擎报 `session_lost`（会话日志没了、格式
 *   不兼容或损坏）时写 `session.read_only`：之后 send 返回 `INVALID_STATE` 并带上原因，resume 仍会重试引擎。
 * - **子会话（R4，domain-model §3.3.1、§4.5）。** 适配器在父会话的流里报 `subagent.started` 时建子会话（写它自己的
 *   事件流与父会话的 `subagent.started`）并订阅它；它的回合由引擎开始（`turn.started`）；它的标题、状态、未决审批
 *   每变一次，在父会话的流里写 `subagent.updated`。客户端对子会话的 send、cancel、close、resume 一律
 *   `INVALID_STATE`；父会话被取消、关闭时级联取消它活动中的子会话（Codex 自己不级联）。
 */
export class SessionManager {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #adapter: AgentRuntimeAdapter;
  readonly #engine: string;
  readonly #cancelTimeoutMs: number;
  readonly #questionTimeoutMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #onWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly #titleInstructions: string | undefined;
  readonly #suggestion: SessionManagerOptions['suggestion'];
  readonly #recapInstructions: string | undefined;
  readonly #recapEnabled: (() => boolean) | undefined;
  /** 离开后摘要的缓存（0.54.0）：只在内存里，不写事件库。 */
  readonly #recaps = new RecapCache();
  readonly #worktreesDir: string | undefined;
  readonly #toolOutputDir: string | undefined;
  readonly #chats: ChatFolders | undefined;
  readonly #checkpoints: TurnCheckpoints | undefined;
  readonly #engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined;
  readonly #historyDir: string | undefined;
  readonly #memory: SessionManagerOptions['memory'];
  readonly #memoryEnabled: () => boolean;
  readonly #ruleFiles: SessionManagerOptions['ruleFiles'];
  readonly #images: ImageStore | undefined;
  readonly #appTools: SessionManagerOptions['appTools'];
  /** 引擎未询问时由 Host 补问的应用工具审批，沿用 approval.respond。 */
  readonly #appApprovals = new Map<string, (approved: boolean) => void>();
  readonly #onTurnFinished: SessionManagerOptions['onTurnFinished'];
  readonly #onUsage: SessionManagerOptions['onUsage'];
  readonly #runtimes = new Map<SessionId, SessionRuntime>();
  /** 提过的问题属于哪个会话（0.10.0）：`question.respond` 只给 QuestionId。Host 重启后未答的问题都已取消，不必恢复。 */
  readonly #questionSessions = new Map<QuestionId, SessionId>();
  /** 到时按推荐回答的提问（0.71.0，`autoAnswerAt`）；问题结束时清掉。只在内存里：Host 重启后未答的问题都已取消。 */
  readonly #questionTimers = new Map<QuestionId, ReturnType<typeof setTimeout>>();
  /** 正在开成会话的建议（0.16.0）：同一项建议同时只能开一次。 */
  readonly #startingTasks = new Set<TaskId>();
  /**
   * 正在建的会话（新建、分支与支线）所在的工作区与来历（`origin`，Agent 开的会话的预设角色在里面）：引擎会话建好之后才写进
   * 存储，而引擎在建的时候就会连应用级工具（Codex 起 thread 时连 MCP、取说明，也可能列工具），那时要靠它认出会话属于哪个项目
   * （`workspaceOf`）、受哪个角色限制（`creating`）、用哪个工具预设（`toolPresetOf`）。
   */
  readonly #creating = new Map<SessionId, CreatingSession>();
  /** 接力时恢复失败过的引擎会话（0.59.0）：之后的接力与预览直接按新建算，不再试。只在内存里，Host 重启后重新试。 */
  readonly #unresumable = new Set<string>();
  /** `dispose` 时完成，让还在等引擎的命令（取消）不再等下去。 */
  readonly #whenDisposed = deferred();
  /** `shutdown()` 开始后为 true：新命令一律 `HOST_SHUTTING_DOWN`，已排队的照常执行。 */
  #shuttingDown = false;
  #shutdown: Promise<void> | undefined;
  #disposed = false;

  constructor(options: SessionManagerOptions) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#adapter = options.adapter;
    this.#engine = options.engine ?? 'echo';
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.#questionTimeoutMs = options.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] session manager:', error));
    this.#onWarning =
      options.onWarning ??
      ((message, fields) => console.warn('[wevir-host] session manager:', message, fields ?? ''));
    this.#titleInstructions = options.titleInstructions;
    this.#suggestion = options.suggestion;
    this.#recapInstructions = options.recapInstructions;
    this.#recapEnabled = options.recapEnabled;
    this.#worktreesDir = options.worktreesDir;
    this.#toolOutputDir = options.toolOutputDir;
    this.#chats = options.chats;
    this.#checkpoints = options.checkpoints;
    this.#engineFeatures = options.engineFeatures;
    this.#historyDir = options.historyDir;
    this.#memory = options.memory;
    this.#memoryEnabled = options.memoryEnabled ?? (() => true);
    this.#ruleFiles = options.ruleFiles;
    this.#images = options.images;
    this.#appTools = options.appTools;
    this.#onTurnFinished = options.onTurnFinished;
    this.#onUsage = options.onUsage;
  }

  /** 引擎会话的配置：存下的配置加上这个会话的应用级工具（适配器能挂时）。 */
  #engineConfig(
    sessionId: SessionId,
    config: SessionConfig,
    rules?: RulePlan | undefined,
  ): SessionConfig {
    // 规则文件（0.68.0）：进引擎说明的那种随配置交过去，每次建立或恢复都按当时的文件。
    const withRules =
      rules?.text !== undefined && rules.rules.channel === 'instructions'
        ? { ...config, ruleInstructions: rules.text }
        : config;
    if (this.#adapter.appTools !== true) return withRules;
    const appTools = this.#appTools?.grant(sessionId);
    return appTools === undefined ? withRules : { ...withRules, appTools };
  }

  /**
   * 这个目录交给这个来源时的规则文件（0.68.0）。没接上规则文件、或承载这个来源的引擎没声明读哪些时 `undefined`；找文件出错只记
   * 告警，不让建立或恢复会话失败。
   */
  async #rulePlan(cwd: string, providerId: string): Promise<RulePlan | undefined> {
    const options = this.#ruleFiles;
    if (options === undefined || this.#adapter.ruleFiles === undefined) return undefined;
    try {
      // 只有声明了读哪些规则文件的引擎参与（echo 等测试引擎不声明）。
      const engine = await this.#adapter.ruleFiles(providerId);
      if (engine === undefined) return undefined;
      return planRules(await options.discover(cwd), {
        providerId,
        engine,
        enabled: options.enabled?.() !== false,
      });
    } catch (error) {
      this.#onWarning('failed to read rule files', { cwd, providerId, error: errorText(error) });
      return undefined;
    }
  }

  /**
   * 建立或恢复引擎会话之后要写的 `session.rules`（0.68.0）；不用写时 `undefined`。`fresh`：新建的引擎会话（建会话、接力新建、
   * 分支），一定写。随消息补的：给过这个引擎会话的不再带正文（它的历史里有），没给过的带上，等下一条消息交出去；分出来的会话
   * （`inherited`）沿用被分会话的引擎历史，也不带。列表与要交的正文都没变时不写。
   */
  #rulesInput(
    sessionId: SessionId,
    plan: RulePlan | undefined,
    engineSessionId: string,
    { fresh, inherited = false }: { fresh: boolean; inherited?: boolean },
  ): AppendInput | undefined {
    if (plan === undefined) return undefined;
    const state = this.#events.rulesState(sessionId);
    // 一个规则文件都没有、之前也没记过：不写。
    if (plan.rules.files.length === 0 && state?.rules === undefined) return undefined;
    const delivered = !fresh && state?.sentTo.includes(engineSessionId) === true;
    const context =
      plan.rules.channel === 'message' && !inherited && !delivered ? plan.text : undefined;
    const pending = state?.pending;
    const samePending =
      context === undefined
        ? pending === undefined
        : pending?.engineSessionId === engineSessionId && pending.context === context;
    if (!fresh && samePending && sameRules(state?.rules, plan.rules)) return undefined;
    return {
      type: 'session.rules',
      source: 'host',
      payload: {
        ...plan.rules,
        engineSessionId,
        ...(context !== undefined && { context }),
      },
    };
  }

  /**
   * Host 启动对账，在接受任何命令之前调用一次。上次 Host 非正常退出时：残留的未决审批结为
   * `expired`（`host_restarted`）；停在活动状态的会话补齐未收尾的工具、以 `interrupted` 结束回合并
   * 回到 `idle`（#15）；“已接受、未确认引擎收到”的发送回执标为 `unknown`，不自动重发。引擎会话都
   * 没有挂上，下一次 `send` 前自动 resume。
   */
  recover(): RecoveryReport {
    this.#assertOpen();
    const report: RecoveryReport = {
      expiredApprovals: 0,
      interruptedSessions: [],
      unknownSends: 0,
    };
    const records = this.#storage.sessions.list({
      includeRemovedWorkspaces: true,
      includeChildren: true,
      includeSide: true,
    });
    for (const record of records) {
      const sessionId = record.id as SessionId;
      const snapshot = this.#events.snapshot(sessionId);
      if (!snapshot) continue;
      const { state, activeTurn, subagent } = snapshot.session;
      const active = ACTIVE_STATES.includes(state);
      if (!active && state === 'idle' && subagent?.status === 'running') {
        // 子会话还没开始过回合就随 Host 退出了：引擎侧的子 agent 不在了，免得一直显示“运行中”（domain-model §4.5）。
        this.#events.appendMany(sessionId, [
          engineError(
            {
              category: 'engine_exited',
              message: 'host restarted before the sub-agent session started a turn',
            },
            true,
          ),
          stateChanged('idle', 'error', 'engine_exited'),
        ]);
        this.#mirror(sessionId, record.parentSessionId as SessionId);
        continue;
      }
      // 等待中的待发消息（含回合刚完成、下一条还没来得及发出的）一律暂停，等用户继续（domain-model §4.6）。
      const holds = settlePendings(snapshot, () => 'held');
      if (
        !active &&
        snapshot.pendingApprovals.length === 0 &&
        (snapshot.pendingQuestions ?? []).length === 0
      ) {
        if (holds.length > 0) this.#events.appendMany(sessionId, holds);
        continue;
      }

      const inputs = [
        ...resolveAll(snapshot.pendingApprovals, 'expired', { reason: 'host_restarted' }),
        ...cancelQuestions(snapshot, 'host_restarted'),
      ];
      if (active) {
        if (activeTurn) {
          inputs.push(
            ...finishTurn(
              activeTurn.turnId,
              this.#openToolsFromEvents(sessionId, activeTurn.turnId),
              'interrupted',
              durationSince(activeTurn.startedAt),
            ),
          );
        }
        inputs.push(stateChanged(state, 'idle', 'host_restarted'));
        report.interruptedSessions.push(sessionId);
      }
      inputs.push(...holds);
      this.#events.appendMany(sessionId, inputs);
      report.expiredApprovals += snapshot.pendingApprovals.length;
      if (record.parentSessionId !== undefined) {
        this.#mirror(sessionId, record.parentSessionId as SessionId);
      }
    }
    report.unknownSends = this.#storage.sendReceipts.markAcceptedAsUnknown(isoNow());
    return report;
  }

  /** 会话所在的工作区：存储里的，或正在建、还没写进存储的；都不是时 `undefined`。 */
  workspaceOf(sessionId: SessionId): string | undefined {
    return (
      this.#storage.sessions.get(sessionId)?.workspaceId ??
      this.#creating.get(sessionId)?.workspaceId
    );
  }

  /** 正在建、还没写进存储的会话的工作区与来历；不是正在建的会话时 `undefined`。 */
  creating(sessionId: SessionId): CreatingSession | undefined {
    return this.#creating.get(sessionId);
  }

  /**
   * 会话的工具预设：自己记录里的（或正在建的会话将要写进去的），子会话（引擎派出的子 agent）沿用父会话的。没有选过（以前建的会话、
   * 调用方不明）时 `undefined`，等同 `full`。
   */
  toolPresetOf(sessionId: SessionId): ToolPreset | undefined {
    let record: Pick<SessionRecord, 'parentSessionId' | 'toolPreset'> | undefined =
      this.#storage.sessions.get(sessionId) ?? this.#creating.get(sessionId);
    for (let depth = 0; depth < 8 && record?.parentSessionId !== undefined; depth += 1) {
      record = this.#storage.sessions.get(record.parentSessionId);
    }
    return record?.toolPreset as ToolPreset | undefined;
  }

  /**
   * `session.create`：先建引擎会话，成功后才写 `session.created`（#1）。返回的会话是 `idle`、
   * `lastSeq` 为 1。
   */
  async create(
    params: MethodParams<'session.create'>,
    options: {
      openedBy?: SessionId;
      role?: string;
      toolPreset?: ToolPreset;
      /** 自动化运行开的会话（0.66.0）：记进 `origin`，`Session.automation` 由它来。 */
      automation?: SessionAutomation;
    } = {},
  ): Promise<Session> {
    this.#assertOpen();
    const provider = this.#storage.providers.get(params.providerId);
    if (!provider) {
      throw new HostError('PROVIDER_NOT_FOUND', `provider ${params.providerId} not found`);
    }
    const workspace = await this.#createWorkspace(params);
    const chat = this.#chats?.isChats(workspace) === true;
    await assertDirectory(workspace.rootPath);
    const permissionMode = this.#permissionMode(params.permissionMode);
    // 工具预设（0.61.0）：明说的，或 Agent 开的会话沿用开它的会话的；都没有时不记（等同 full）。
    const chosen = params.toolPreset ?? options.toolPreset;
    const toolPreset =
      chosen !== undefined
        ? normalizeToolPreset(chosen)
        : options.openedBy === undefined
          ? undefined
          : this.toolPresetOf(options.openedBy);
    const origin = this.#claimTask(params, workspace.id);
    try {
      return await this.#create(
        params,
        workspace,
        chat,
        provider,
        permissionMode,
        origin,
        options.openedBy,
        options.role,
        toolPreset,
        options.automation,
      );
    } finally {
      if (origin) this.#startingTasks.delete(origin.taskId);
    }
  }

  /**
   * 新会话所在的工作区。不带 `workspaceId`（0.39.0）时是“对话”工作区（没有就建）；对话里的会话不能带环境或新开 worktree。
   */
  async #createWorkspace(params: MethodParams<'session.create'>): Promise<WorkspaceRecord> {
    const invalid = (path: string, message: string) =>
      new HostError('INVALID_PARAMS', message, { issues: [{ path: [path], message }] });
    let workspace: WorkspaceRecord | undefined;
    if (params.workspaceId === undefined) {
      if (this.#chats === undefined) {
        throw invalid('workspaceId', 'this host needs a workspaceId (no chat sessions)');
      }
      workspace = await this.#chats.workspace(this.#storage, isoNow());
    } else {
      workspace = this.#storage.workspaces.get(params.workspaceId);
      if (!workspace || workspace.removedAt !== undefined) {
        throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${params.workspaceId} not found`);
      }
    }
    if (this.#chats?.isChats(workspace) === true) {
      if (params.environmentId !== undefined) {
        throw invalid('environmentId', 'a chat session has no environment');
      }
      if (params.worktree === 'new')
        throw invalid('worktree', 'a chat session has no git worktree');
    }
    return workspace;
  }

  /**
   * `session.create` 的 `origin`（0.16.0，domain-model §3.11）：提出建议的会话要在、与新会话同一个工作区，这项建议要在、还是
   * `suggested`，而且没有别的 `session.create` 正在开它；否则 `INVALID_PARAMS`。通过后占住它，直到建完或失败。
   */
  #claimTask(
    params: MethodParams<'session.create'>,
    workspaceId: string,
  ): MethodParams<'session.create'>['origin'] {
    const origin = params.origin;
    if (origin === undefined) return undefined;
    const fail = (message: string) =>
      new HostError('INVALID_PARAMS', message, { issues: [{ path: ['origin'], message }] });
    if (!this.#adapter.suggestedTasks) throw fail('this host engine does not suggest tasks');
    const parent = this.#storage.sessions.get(origin.sessionId);
    if (!parent || parent.workspaceId !== workspaceId) {
      throw fail(`session ${origin.sessionId} is not in workspace ${workspaceId}`);
    }
    const task = this.#events.suggestedTask(origin.sessionId, origin.taskId);
    if (task?.status !== 'suggested' || this.#startingTasks.has(origin.taskId)) {
      throw fail(`task ${origin.taskId} is not waiting to be started`);
    }
    this.#startingTasks.add(origin.taskId);
    return origin;
  }

  async #create(
    params: MethodParams<'session.create'>,
    workspace: { id: string; rootPath: string },
    chat: boolean,
    provider: { id: string; defaultModelId: string },
    permissionMode: PermissionMode | undefined,
    origin: MethodParams<'session.create'>['origin'],
    openedBy: SessionId | undefined,
    role: string | undefined,
    toolPreset: ToolPreset | undefined,
    automation?: SessionAutomation,
  ): Promise<Session> {
    const sessionId = newId('ses');
    // 环境会话（0.15.0，domain-model §3.10）：先准备目录（worktree），失败时什么都不留。对话（0.39.0）是新建的空文件夹。
    const prepared = chat
      ? await this.#chatDirectory(sessionId)
      : await this.#prepareEnvironment(params, sessionId, workspace, provider.id);
    const config: SessionConfig = {
      cwd: prepared.cwd,
      providerId: provider.id,
      modelId: params.modelId ?? provider.defaultModelId,
    };
    if (params.reasoningEffort !== undefined) config.reasoningEffort = params.reasoningEffort;
    if (permissionMode !== undefined) config.permissionMode = permissionMode;
    if (prepared.extraRoots.length > 0) config.additionalRoots = prepared.extraRoots;
    const recordOrigin: SessionRecord['origin'] =
      origin ??
      (automation !== undefined
        ? { kind: 'automation', ...automation }
        : openedBy === undefined
          ? undefined
          : { kind: 'agent', sessionId: openedBy, ...(role !== undefined && { role }) });
    let engineSession: Awaited<ReturnType<AgentRuntimeAdapter['createSession']>>;
    this.#creating.set(sessionId, {
      workspaceId: workspace.id,
      ...(recordOrigin !== undefined && { origin: recordOrigin }),
      ...(toolPreset !== undefined && { toolPreset }),
    });
    const rules = await this.#rulePlan(config.cwd, provider.id);
    try {
      engineSession = await this.#adapter.createSession(
        this.#engineConfig(sessionId, config, rules),
      );
    } catch (error) {
      this.#creating.delete(sessionId);
      await prepared.undo();
      const info = engineErrorInfo(error);
      throw new HostError('ENGINE_ERROR', info.message, info);
    }

    const now = isoNow();
    const modelId = engineSession.modelId ?? config.modelId;
    const reasoningEffort = engineSession.reasoningEffort ?? config.reasoningEffort;
    try {
      const record: SessionRecord = {
        id: sessionId,
        workspaceId: workspace.id,
        cwd: config.cwd,
        engine: this.#engine,
        engineSessionId: engineSession.engineSessionId,
        providerId: provider.id,
        modelId,
        title: '',
        titleSource: 'first_prompt',
        state: 'idle',
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
      if (permissionMode !== undefined) record.permissionMode = permissionMode;
      if (prepared.environmentId !== undefined) record.environmentId = prepared.environmentId;
      if (prepared.extraRoots.length > 0) record.extraRoots = prepared.extraRoots;
      if (prepared.worktrees.length > 0) record.worktrees = prepared.worktrees;
      if (recordOrigin !== undefined) record.origin = recordOrigin;
      if (toolPreset !== undefined) record.toolPreset = toolPreset;
      this.#storage.sessions.insert(record);
      this.#events.append(sessionId, {
        type: 'session.created',
        source: 'host',
        payload: {
          workspaceId: workspace.id as WorkspaceId,
          cwd: config.cwd,
          providerId: provider.id,
          modelId,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(permissionMode !== undefined && { permissionMode }),
          ...(prepared.environmentId !== undefined && { environmentId: prepared.environmentId }),
          ...(prepared.extraRoots.length > 0 && { extraRoots: prepared.extraRoots }),
          ...(prepared.worktrees.length > 0 && { worktrees: prepared.worktrees }),
          ...(engineSession.engineVersion !== undefined && {
            engineVersion: engineSession.engineVersion,
          }),
          ...(openedBy !== undefined && {
            openedBy: { sessionId: openedBy, ...(role !== undefined && { role }) },
          }),
          ...(toolPreset !== undefined && { toolPreset }),
        },
      });
      const rulesInput = this.#rulesInput(sessionId, rules, engineSession.engineSessionId, {
        fresh: true,
      });
      if (rulesInput !== undefined) this.#events.append(sessionId, rulesInput);
    } catch (error) {
      // 会话没建成，尽力回收引擎会话与 worktree。
      await this.#adapter.close(engineSession.engineSessionId).catch(this.#onError);
      await prepared.undo();
      throw error;
    } finally {
      this.#creating.delete(sessionId);
    }

    if (origin !== undefined) {
      this.#events.append(origin.sessionId, {
        type: 'task.started',
        source: 'host',
        payload: { taskId: origin.taskId, sessionId },
      });
    }
    const runtime = this.#runtime(sessionId);
    try {
      this.#attach(runtime);
    } catch (error) {
      this.#engineFailed(runtime, engineErrorInfo(error));
    }
    return this.#snapshot(runtime).session;
  }

  /** 对话的文件夹（0.39.0）：`<对话工作区>/<会话 ID>`，新建、空的。 */
  async #chatDirectory(sessionId: SessionId): Promise<PreparedEnvironment> {
    const chats = this.#chats;
    if (chats === undefined) throw new Error('chat sessions are not configured');
    const dir = await chats.createSessionDir(sessionId);
    return { cwd: dir.path, extraRoots: [], worktrees: [], undo: dir.undo };
  }

  /**
   * 按环境准备会话的目录（0.15.0，domain-model §3.10）。不带环境、也不要 worktree 时就是工作区目录。带环境时 `workspaceId`
   * 要是主文件夹；`worktree: 'new'`（0.18.0）等于只有这个工作区一个文件夹、要新开 worktree 的环境，只是不记 `environmentId`。
   * 不带环境时，项目的其他源文件夹（0.64.0，`Workspace.extraFolders`）原样跟在后面作为额外的可写目录（不开 worktree），引擎
   * 不支持 `additionalRoots` 时不给；带环境时只用环境的文件夹。
   * 依次处理每个文件夹，要新开 worktree 的在 `<worktreesDir>/<会话 ID>/` 下开。任何一步失败都撤回已建的 worktree 并回
   * `INVALID_PARAMS`（工作区不在时 `WORKSPACE_NOT_FOUND`）。
   */
  async #prepareEnvironment(
    params: MethodParams<'session.create'>,
    sessionId: SessionId,
    workspace: { id: string; rootPath: string },
    providerId: string,
  ): Promise<PreparedEnvironment> {
    const rootPath = workspace.rootPath;
    const kind = this.#storage.providers.get(providerId)?.kind;
    const projectFolders =
      params.environmentId === undefined &&
      kind !== undefined &&
      this.#featuresOf(kind)?.additionalRoots === true
        ? (this.#storage.workspaces.get(workspace.id)?.extraFolders ?? [])
        : [];
    for (const folder of projectFolders) await assertDirectory(folder);
    const plain: PreparedEnvironment = {
      cwd: rootPath,
      extraRoots: [...projectFolders],
      worktrees: [],
      undo: async () => {},
    };
    const invalid = (path: string, message: string) =>
      new HostError('INVALID_PARAMS', message, { issues: [{ path: [path], message }] });
    // 出错时指向请求里的哪个字段。
    let field: 'environmentId' | 'worktree';
    let folders: readonly { workspaceId: string; worktree: string }[];
    let environmentId: EnvironmentId | undefined;
    if (params.environmentId !== undefined) {
      if (params.worktree === 'new') {
        throw invalid('worktree', 'worktree cannot be combined with environmentId');
      }
      const environment = this.#storage.environments.get(params.environmentId);
      if (!environment) {
        throw new HostError(
          'ENVIRONMENT_NOT_FOUND',
          `environment ${params.environmentId} not found`,
        );
      }
      if (environment.folders[0]?.workspaceId !== workspace.id) {
        throw invalid('workspaceId', "workspaceId must be the environment's first folder");
      }
      if (environment.folders.length > 1 && !this.#adapter.additionalRoots) {
        throw invalid(
          'environmentId',
          'this host engine cannot give a session more than one folder',
        );
      }
      field = 'environmentId';
      folders = environment.folders;
      environmentId = environment.id as EnvironmentId;
    } else if (params.worktree === 'new') {
      field = 'worktree';
      folders = [{ workspaceId: workspace.id, worktree: 'new' }];
    } else {
      return plain;
    }
    const created: CreatedWorktree[] = [];
    const dir = this.#worktreesDir === undefined ? undefined : join(this.#worktreesDir, sessionId);
    const undo = async () => {
      for (const worktree of created.reverse()) {
        if (dir !== undefined) await removeWorktree(worktree, dir).catch(this.#onError);
      }
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    try {
      const paths: string[] = [];
      const worktrees: SessionWorktree[] = [];
      for (const [index, folder] of folders.entries()) {
        const workspace = this.#storage.workspaces.get(folder.workspaceId);
        if (!workspace || workspace.removedAt !== undefined) {
          throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${folder.workspaceId} not found`);
        }
        await assertDirectory(workspace.rootPath);
        if (folder.worktree !== 'new') {
          paths.push(workspace.rootPath);
          continue;
        }
        if (dir === undefined) throw invalid(field, 'this host has no place for worktrees');
        const suffix = worktrees.length === 0 ? '' : `-${worktrees.length + 1}`;
        try {
          const worktree = await createWorktree({
            workspaceRoot: workspace.rootPath,
            dir,
            index: index + 1,
            branch: `wevir/${sessionId.slice(-8).toLowerCase()}${suffix}`,
          });
          created.push(worktree);
          paths.push(worktree.path);
          worktrees.push({
            workspaceId: workspace.id as WorkspaceId,
            path: worktree.path,
            branch: worktree.branch,
          });
        } catch (error) {
          if (!(error instanceof WorktreeError)) throw error;
          throw invalid(
            field,
            `cannot create a worktree for ${workspace.displayName}: ${error.message}`,
          );
        }
      }
      return {
        ...(environmentId !== undefined && { environmentId }),
        cwd: paths[0] ?? rootPath,
        extraRoots: [...paths.slice(1), ...projectFolders],
        worktrees,
        undo,
      };
    } catch (error) {
      await undo();
      throw error;
    }
  }

  /**
   * `session.send`。`clientMessageId` 的幂等检查排在状态检查之前（domain-model §4.2）：同一 ID、同样
   * 的内容返回原结果，不再发给引擎；内容不同返回 `CLIENT_MESSAGE_CONFLICT`。会话活动中时，带 `delivery` 的成为待发消息
   * （R11，domain-model §4.6，不排进命令队列），不带的返回 `SESSION_BUSY`；`error` / `closed` 返回 `INVALID_STATE`。
   *
   * 接受后先写 `user.message`、`turn.started`、（首个回合的）`session.title_changed` 和
   * idle→running，同一事务里记回执 `accepted`，再交给引擎；引擎确认收到后回执改为 `confirmed`。
   * 引擎拒收时会话转 `error`（#10），本次仍返回已接受的 `turnId` 与 `seq`，与重发时的“原结果”一致。
   */
  async send(
    params: MethodParams<'session.send'>,
    sentBy: ClientIdentity,
    options: SendOptions = {},
  ): Promise<MethodResult<'session.send'>> {
    const { from } = options;
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const { clientMessageId } = params;
    // 计划模式的消息（0.36.0）连同模式一起算指纹；默认模式的照旧只算内容，旧回执照样对得上。
    const fingerprint = requestFingerprint(
      params.collaborationMode === 'plan'
        ? { content: params.content, collaborationMode: 'plan' }
        : params.content,
    );
    // 到达时先查一遍：会话忙就立即返回，不排在进行中的命令（例如等结算的取消）后面。回执只增不删，
    // 在命令队列外读也安全；进入队列后再查一遍。
    const replayed = this.#replay(runtime, clientMessageId, fingerprint);
    if (replayed) return replayed;
    this.#assertNotChild(runtime);
    // 计划模式（0.36.0）：只记 `plan`，`default` 与省略一样。
    const collaborationMode = params.collaborationMode === 'plan' ? 'plan' : undefined;
    if (collaborationMode !== undefined) this.#assertPlanMode(runtime);
    // 图片（0.28.0）：换成 Host 记下的、挪出暂存区。回执的指纹仍按客户端发来的内容算，重发时照样认得出。
    const content = await this.#acceptContent(runtime, params.content, ['content']);
    const accepted = { ...params, content };
    const snapshot = this.#snapshot(runtime);
    if (params.delivery !== undefined && ACTIVE_STATES.includes(snapshot.session.state)) {
      return this.#addPending(runtime, accepted, sentBy, fingerprint, from);
    }
    assertSendable(snapshot);
    return this.#serial(runtime, async () => {
      const replayed = this.#replay(runtime, clientMessageId, fingerprint);
      if (replayed) return replayed;
      const snapshot = this.#snapshot(runtime);
      if (params.delivery !== undefined && ACTIVE_STATES.includes(snapshot.session.state)) {
        return this.#addPending(runtime, accepted, sentBy, fingerprint, from);
      }
      assertSendable(snapshot);
      return this.#startTurn(runtime, {
        content,
        sentBy,
        ...(clientMessageId !== undefined && { clientMessageId, fingerprint }),
        ...(from !== undefined && { from }),
        ...(collaborationMode !== undefined && { collaborationMode }),
      });
    });
  }

  /**
   * 自动修复的回合（0.65.0，ADR-0008 决策 12）：Host 把检查失败的材料作为一条 `from.repair` 的消息交给 Agent。只在会话空闲、
   * 没有待审批 / 待回答 / 待发消息、目标没在进行时开始（用户的操作优先），否则不开始并返回原因：`user_message`（用户有了新的
   * 消息或操作）、`goal_active`、`session_unavailable`（会话出错、关闭、只读或恢复不了）、`not_repairable`（子会话）。排进命令队列。
   */
  async startRepairTurn(
    sessionId: SessionId,
    input: { content: UserContentPart[]; from: MessageFrom; sentBy: ClientIdentity },
  ): Promise<{ turnId: TurnId } | { skipped: string }> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    if (runtime.parentId !== undefined) return { skipped: 'not_repairable' };
    const blocked = (): string | undefined => {
      const snapshot = this.#snapshot(runtime);
      const { session } = snapshot;
      if (
        session.readOnly !== undefined ||
        session.state === 'error' ||
        session.state === 'closed'
      ) {
        return 'session_unavailable';
      }
      if (
        session.state !== 'idle' ||
        (snapshot.pendingMessages ?? []).length > 0 ||
        snapshot.pendingApprovals.length > 0 ||
        (snapshot.pendingQuestions?.length ?? 0) > 0
      ) {
        return 'user_message';
      }
      if (session.goal?.status === 'active') return 'goal_active';
      return undefined;
    };
    return this.#serial(runtime, async () => {
      if (this.#shuttingDown || this.#disposed) return { skipped: 'session_unavailable' };
      const before = blocked();
      if (before !== undefined) return { skipped: before };
      try {
        if (!runtime.attachment) await this.#autoResume(runtime);
      } catch (error) {
        if (isHostError(error)) return { skipped: 'session_unavailable' };
        throw error;
      }
      const after = blocked();
      if (after !== undefined) return { skipped: after };
      const { turnId } = await this.#startTurn(runtime, {
        content: input.content,
        sentBy: input.sentBy,
        from: input.from,
      });
      return { turnId };
    });
  }

  /**
   * `session.compact`（0.24.0，domain-model §4.7）：开始一个由命令开始的回合，引擎压缩会话的上下文。前提同 `send`（没有排队）。
   */
  compact(sessionId: SessionId): Promise<MethodResult<'session.compact'>> {
    return this.#command(sessionId, 'compact', async () => ({ kind: 'compact' }));
  }

  /**
   * `session.review`（0.24.0）：开始一个由命令开始的回合，引擎审查改动。会话目录要是 git 仓库；`branch` 要找得到基础分支
   * （同 `workspace.diff` 的 `branch`），否则 `INVALID_PARAMS`。
   */
  review(sessionId: SessionId, target: ReviewTarget): Promise<MethodResult<'session.review'>> {
    return this.#command(sessionId, 'review', async (runtime) => {
      const repo = await reviewRepo(this.#record(runtime).cwd);
      if (repo === undefined) {
        throw new HostError('INVALID_PARAMS', 'the session directory is not a git repository', {
          issues: [{ path: ['sessionId'], message: 'not a git repository' }],
        });
      }
      if (target === 'uncommitted') return { kind: 'review', target };
      if (repo.baseBranch === undefined) {
        throw new HostError('INVALID_PARAMS', 'no base branch to compare against', {
          issues: [{ path: ['target'], message: 'no base branch' }],
        });
      }
      return { kind: 'review', target, baseBranch: repo.baseBranch };
    });
  }

  /**
   * `session.setGoal`（0.35.0，domain-model §3.16）：替换会话的目标，以目标为用户消息开始第一个回合（`turn.started` 的 `trigger` 为
   * `goal`）；之后目标进行中、会话空闲时引擎自己开回合接着做（`#engineTurnStarted`）。前提同 `session.compact`；会话所在的引擎没有
   * 目标时 `INVALID_STATE`，不写事件。
   */
  async setGoal(
    params: MethodParams<'session.setGoal'>,
    sentBy: ClientIdentity,
  ): Promise<MethodResult<'session.setGoal'>> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    this.#assertNotChild(runtime);
    assertSendable(this.#snapshot(runtime));
    const objective = params.objective.trim();
    return this.#serial(runtime, async () => {
      assertSendable(this.#snapshot(runtime));
      await this.#goalEngine(runtime);
      assertSendable(this.#snapshot(runtime));
      return this.#startTurn(runtime, {
        content: [{ type: 'text', text: objective }],
        sentBy,
        goal: {
          objective,
          ...(params.tokenBudget !== undefined && { tokenBudget: params.tokenBudget }),
        },
      });
    });
  }

  /**
   * `session.updateGoal`（0.35.0）：暂停或继续会话的目标。继续时会话空闲则引擎随即开回合（`#engineTurnStarted`）；暂停不打断进行中
   * 的回合。会话没有目标、只读、出错或已关闭时 `INVALID_STATE`；引擎会话没挂上时先自动恢复。目标的变化随引擎的通知写成
   * `session.goal_changed`。
   */
  updateGoal(
    sessionId: SessionId,
    status: 'active' | 'paused',
  ): Promise<MethodResult<'session.updateGoal'>> {
    return this.#goalCommand(sessionId, async (runtime, goals) => {
      if (this.#snapshot(runtime).session.goal === undefined) {
        throw new HostError('INVALID_STATE', 'the session has no goal', {
          state: this.#snapshot(runtime).session.state,
        });
      }
      return { goal: toSessionGoal(await goals.update(runtime.engineSessionId, status)) };
    });
  }

  /** `session.clearGoal`（0.35.0）：清除会话的目标；进行中的回合不受影响。前提同 `session.updateGoal`（不要求有目标）。 */
  clearGoal(sessionId: SessionId): Promise<MethodResult<'session.clearGoal'>> {
    return this.#goalCommand(sessionId, async (runtime, goals) => ({
      cleared: await goals.clear(runtime.engineSessionId),
    }));
  }

  /** 目标的暂停、继续与清除：排在会话的命令队列里，引擎会话挂好、引擎有目标之后执行；引擎的错误转成 `ENGINE_ERROR`。 */
  async #goalCommand<T>(
    sessionId: SessionId,
    run: (
      runtime: SessionRuntime,
      goals: {
        update: (id: string, status: 'active' | 'paused') => Promise<EngineGoal>;
        clear: (id: string) => Promise<boolean>;
      },
    ) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    return this.#serial(runtime, async () => {
      const { session } = this.#snapshot(runtime);
      if (session.readOnly !== undefined) {
        throw new HostError('INVALID_STATE', 'session is read-only', {
          state: session.state,
          readOnly: session.readOnly,
        });
      }
      if (session.state === 'error' || session.state === 'closed') {
        throw new HostError('INVALID_STATE', `session is ${session.state}; resume it first`, {
          state: session.state,
        });
      }
      await this.#goalEngine(runtime);
      const { updateGoal, clearGoal } = this.#adapter;
      if (updateGoal === undefined || clearGoal === undefined) {
        throw new Error('adapter has startGoal but no updateGoal / clearGoal');
      }
      try {
        return await run(runtime, {
          update: (id, status) => updateGoal.call(this.#adapter, id, status),
          clear: (id) => clearGoal.call(this.#adapter, id),
        });
      } catch (error) {
        if (isHostError(error)) throw error;
        const info = engineErrorInfo(error);
        throw new HostError('ENGINE_ERROR', info.message, info);
      }
    });
  }

  /** 目标的方法之前：引擎会话没挂上时先自动恢复（路由要它才知道会话在哪个引擎上），会话所在的引擎没有目标时 `INVALID_STATE`。 */
  async #goalEngine(runtime: SessionRuntime): Promise<void> {
    if (!runtime.attachment) await this.#autoResume(runtime);
    const supported =
      this.#adapter.supports?.(runtime.engineSessionId, 'startGoal') ??
      this.#adapter.startGoal !== undefined;
    if (!supported) {
      throw new HostError('INVALID_STATE', "the session's engine has no goals", {
        state: this.#snapshot(runtime).session.state,
      });
    }
  }

  /**
   * 命令回合的共同部分：会话空闲（否则 `SESSION_BUSY`）、可以发送（`assertSendable`）；引擎会话没挂着时先自动恢复（多引擎的路由
   * 要它才知道会话在哪个引擎上）；会话所在的引擎没有这个方法时 `INVALID_STATE`，不写事件。
   */
  async #command(
    sessionId: SessionId,
    method: SessionCommandMethod,
    prepare: (runtime: SessionRuntime) => Promise<TurnCommand>,
  ): Promise<{ turnId: TurnId; seq: number }> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    assertSendable(this.#snapshot(runtime));
    return this.#serial(runtime, async () => {
      assertSendable(this.#snapshot(runtime));
      if (!runtime.attachment) {
        await this.#autoResume(runtime);
        assertSendable(this.#snapshot(runtime));
      }
      const supported =
        this.#adapter.supports?.(runtime.engineSessionId, method) ??
        this.#adapter[method] !== undefined;
      if (!supported) {
        throw new HostError(
          'INVALID_STATE',
          method === 'compact'
            ? "the session's engine cannot compact its context"
            : "the session's engine cannot review code",
          { state: this.#snapshot(runtime).session.state },
        );
      }
      const command = await prepare(runtime);
      // 准备期间（读 git）引擎可能已经报了退出。
      assertSendable(this.#snapshot(runtime));
      return this.#startCommandTurn(runtime, command);
    });
  }

  /**
   * 由命令开始的回合（0.24.0，domain-model §4.7）：同 `#startTurn`，但没有 `user.message`、不起标题，`turn.started` 带
   * `command`，交给引擎的是 `compact` 或 `review`。引擎拒收时会话转 `error`（#10）。
   */
  async #startCommandTurn(
    runtime: SessionRuntime,
    command: TurnCommand,
  ): Promise<{ turnId: TurnId; seq: number }> {
    const turnId = newId('trn');
    const [started] = this.#write(runtime, [
      { type: 'turn.started', source: 'host', payload: { turnId, command } },
      stateChanged('idle', 'running', 'turn_started'),
    ]);
    if (!started) throw new Error('turn.started 未写入');
    runtime.turn = {
      turnId,
      streams: new Map(),
      openTools: new Set(),
      tools: new Map(),
      finished: deferred(),
      addedWhileCancelling: new Set(),
      command,
    };
    const checkpointCwd = this.#checkpointCwd(runtime);
    if (checkpointCwd !== undefined) {
      await this.#checkpoints?.beforeTurn(runtime.id, checkpointCwd, turnId);
    }
    try {
      await this.#runCommand(runtime.engineSessionId, command);
    } catch (error) {
      if (runtime.turn?.turnId === turnId) this.#engineFailed(runtime, engineErrorInfo(error));
    }
    return { turnId, seq: started.seq };
  }

  #runCommand(engineSessionId: string, command: TurnCommand): Promise<void> {
    if (command.kind === 'compact') {
      if (this.#adapter.compact === undefined) throw new Error('adapter has no compact');
      return this.#adapter.compact(engineSessionId);
    }
    if (this.#adapter.review === undefined) throw new Error('adapter has no review');
    const request: ReviewRequest =
      command.target === 'branch' && command.baseBranch !== undefined
        ? { target: 'branch', baseBranch: command.baseBranch }
        : { target: 'uncommitted' };
    return this.#adapter.review(engineSessionId, request);
  }

  /**
   * 开始一个回合（#2）：普通的 `send`，或发出一条排队的待发消息（R11，`pending`）。必要时先自动 resume（#11）；写
   * `user.message`、`turn.started`、（首个回合的）标题与 idle→running，普通发送在同一事务里记回执，发出待发消息时同一
   * 事务里把它标为 `sent`；再交给引擎。引擎拒收时会话转 `error`（#10），仍返回已接受的 `turnId` 与 `seq`。
   */
  async #startTurn(
    runtime: SessionRuntime,
    input: {
      content: UserContentPart[];
      sentBy: ClientIdentity;
      clientMessageId?: string;
      /** 普通发送带 `clientMessageId` 时记回执用。 */
      fingerprint?: string;
      pending?: PendingMessage;
      from?: MessageFrom;
      /** `session.setGoal`（0.35.0）：这条消息是新的目标，交给引擎的 `startGoal`。 */
      goal?: { objective: string; tokenBudget?: number };
      /** 计划模式（0.36.0）。 */
      collaborationMode?: 'plan';
    },
  ): Promise<{ turnId: TurnId; seq: number }> {
    const { content, sentBy, clientMessageId, fingerprint, pending, goal, collaborationMode } =
      input;
    const from = input.from ?? pending?.from;
    if (!runtime.attachment) {
      await this.#autoResume(runtime);
      // 等待期间引擎可能已经报了退出。
      assertSendable(this.#snapshot(runtime));
    }

    // 图片换成磁盘上的路径；找不到时在写事件之前报错。
    const agentInput = await this.#agentInput(content);
    const snapshot = this.#snapshot(runtime);
    const turnId = newId('trn');
    const inputs: AppendInput[] = [
      {
        type: 'user.message',
        source: 'host',
        payload: {
          turnId,
          content,
          sentBy,
          ...(clientMessageId !== undefined && { clientMessageId }),
          ...(pending !== undefined && { pendingId: pending.id }),
          ...(from !== undefined && { from }),
          ...(collaborationMode !== undefined && { collaborationMode }),
        },
      },
      {
        type: 'turn.started',
        source: 'host',
        payload: { turnId, ...(goal !== undefined && { trigger: 'goal' as const }) },
      },
    ];
    if (pending !== undefined) {
      inputs.push(pendingUpdated({ ...pending, status: 'sent', turnId, updatedAt: isoNow() }));
    }
    const title = makeTitle(content);
    const firstTitle =
      title !== '' &&
      snapshot.session.title === '' &&
      snapshot.session.titleSource === 'first_prompt';
    if (firstTitle) {
      inputs.push({
        type: 'session.title_changed',
        source: 'host',
        payload: { title, source: 'first_prompt' },
      });
    }
    inputs.push(stateChanged('idle', 'running', 'turn_started'));
    const receipt =
      pending === undefined && fingerprint !== undefined ? clientMessageId : undefined;
    const [message] = this.#write(runtime, inputs, {
      inTransaction: (events) => {
        const event = events[0];
        if (receipt === undefined || fingerprint === undefined || !event) return;
        this.#storage.sendReceipts.insert({
          sessionId: runtime.id,
          clientMessageId: receipt,
          fingerprint,
          status: 'accepted',
          turnId,
          seq: event.seq,
          createdAt: event.ts,
          updatedAt: event.ts,
        });
      },
    });
    if (!message) throw new Error('user.message 未写入');
    runtime.turn = {
      turnId,
      streams: new Map(),
      openTools: new Set(),
      tools: new Map(),
      finished: deferred(),
      addedWhileCancelling: new Set(),
      ...(from?.repair !== undefined && { repair: true as const }),
    };

    // 回合前的快照（0.20.0）：打完再交给引擎，免得快照里混进这个回合的改动。不会抛错。
    const checkpointCwd = this.#checkpointCwd(runtime);
    if (checkpointCwd !== undefined) {
      await this.#checkpoints?.beforeTurn(runtime.id, checkpointCwd, turnId);
    }

    // 接力（0.25.0）：还没交出去的历史摘要放在这条消息的开头交给新引擎；消息记录里只有用户写的。规则文件（0.68.0）要随消息补的
    // 也放在开头，在摘要之前。
    const pendingRules = this.#events.rulesState(runtime.id)?.pending;
    const rules =
      pendingRules?.engineSessionId === runtime.engineSessionId ? pendingRules.context : undefined;
    const handoff = this.#events.handoffState(runtime.id)?.context;
    const prefix = [rules, handoff].filter((part) => part !== undefined).join('\n\n');
    try {
      const engineInput =
        prefix === '' ? agentInput : await this.#agentInput(withHandoffContext(prefix, content));
      if (goal === undefined) {
        await this.#adapter.send(
          runtime.engineSessionId,
          collaborationMode === undefined ? engineInput : { ...engineInput, collaborationMode },
        );
      } else {
        if (this.#adapter.startGoal === undefined) throw new Error('adapter has no startGoal');
        await this.#adapter.startGoal(runtime.engineSessionId, { ...goal, input: engineInput });
      }
    } catch (error) {
      // 引擎没有接受这个回合。等待期间回合可能已经以别的方式结束（例如引擎退出）。
      if (runtime.turn?.turnId === turnId) this.#engineFailed(runtime, engineErrorInfo(error));
      return { turnId, seq: message.seq };
    }
    if (receipt !== undefined) {
      this.#storage.sendReceipts.setStatus(runtime.id, receipt, 'confirmed', isoNow());
    }
    // 截断的标题已经写下；引擎接受了第一个回合，再用会话的模型生成标题（不等它）。
    if (firstTitle) this.#generateTitle(runtime, content);
    return { turnId, seq: message.seq };
  }

  /**
   * 消息里的图片（0.28.0）：最多 `IMAGE_MAX_PER_MESSAGE` 张；会话的引擎与模型要收图片（适配器的 `acceptsImages`），否则
   * `INVALID_PARAMS`；每张换成 Host 记下的、挪出暂存区，没有这张图片时 `IMAGE_NOT_FOUND`。没有图片时原样返回。
   */
  async #acceptContent(
    runtime: SessionRuntime,
    content: UserContentPart[],
    path: Array<string | number>,
  ): Promise<UserContentPart[]> {
    const count = content.filter((part) => part.type === 'image').length;
    if (count === 0) return content;
    if (count > IMAGE_MAX_PER_MESSAGE) {
      throw invalidContent(path, `a message can carry at most ${IMAGE_MAX_PER_MESSAGE} images`);
    }
    const { providerId, modelId } = this.#snapshot(runtime).session;
    const images = this.#images;
    // Provider 的模型列表标了不收图片的，不必再问引擎（OpenCode 等的模型目录带这一项）。
    const listed = (this.#storage.providers.get(providerId)?.models ?? []) as {
      id: string;
      supportsImages?: boolean;
    }[];
    const refused = listed.find((model) => model.id === modelId)?.supportsImages === false;
    if (
      images === undefined ||
      refused ||
      this.#adapter.acceptsImages?.({ providerId, modelId }) !== true
    ) {
      throw invalidContent(
        path,
        `model ${modelId} of provider ${providerId} does not accept images`,
      );
    }
    return images.keep(content);
  }

  /** 交给引擎的输入：图片换成数据目录里的文件。 */
  async #agentInput(content: readonly UserContentPart[]): Promise<AgentInput> {
    const parts: AgentInput['content'] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part);
        continue;
      }
      const path = await this.#images?.path(part.imageId);
      if (path === undefined) {
        throw new HostError('IMAGE_NOT_FOUND', `image ${part.imageId} not found`);
      }
      parts.push({
        type: 'image',
        path,
        mimeType: part.mimeType,
        ...(part.name !== undefined && { name: part.name }),
      });
    }
    return { content: parts };
  }

  // ── 待发消息（R11，domain-model §3.3.2、§4.6） ──────────────────────────────────

  /**
   * 回合进行中带 `delivery` 的 `send`：写 `pending.added`（同一事务里记回执，回执的 `turnId` 列放待发消息 ID），插话且
   * 引擎能插话时再交给引擎。引擎不能插话、或回合正在取消时直接以排队加入并记下原因。不排进命令队列。
   */
  async #addPending(
    runtime: SessionRuntime,
    params: MethodParams<'session.send'>,
    sentBy: ClientIdentity,
    fingerprint: string,
    from?: MessageFrom,
  ): Promise<MethodResult<'session.send'>> {
    const { state } = this.#snapshot(runtime).session;
    const wantsSteer = params.delivery === 'steer';
    // 命令开的回合（0.24.0）不能插话：Codex 的 review、compact 回合拒绝 `turn/steer`，Claude 的 `/compact` 是本地命令。
    const commandTurn = runtime.turn?.command !== undefined;
    // 自动修复的回合（0.65.0）也不插话：用户的消息让它停下，停止后再发。
    const repairTurn = runtime.turn?.repair === true;
    const steerable =
      wantsSteer &&
      state !== 'cancelling' &&
      !commandTurn &&
      !repairTurn &&
      this.#adapter.steer !== undefined;
    const now = isoNow();
    const pending: PendingMessage = {
      id: newId('pnd'),
      content: params.content,
      delivery: steerable ? 'steer' : 'queue',
      status: 'waiting',
      sentBy,
      createdAt: now,
      updatedAt: now,
    };
    if (params.clientMessageId !== undefined) pending.clientMessageId = params.clientMessageId;
    if (from !== undefined) pending.from = from;
    if (params.collaborationMode === 'plan') pending.collaborationMode = 'plan';
    if (wantsSteer && !steerable) {
      pending.fallback =
        state === 'cancelling'
          ? { reason: 'turn_ended' }
          : commandTurn
            ? { reason: 'rejected', message: COMMAND_TURN_NOT_STEERABLE }
            : repairTurn
              ? { reason: 'rejected', message: REPAIR_TURN_NOT_STEERABLE }
              : { reason: 'unsupported' };
    }
    const { clientMessageId } = params;
    const [event] = this.#write(
      runtime,
      [{ type: 'pending.added', source: 'host', payload: { pending } }],
      {
        inTransaction: (events) => {
          const added = events[0];
          if (clientMessageId === undefined || !added) return;
          this.#storage.sendReceipts.insert({
            sessionId: runtime.id,
            clientMessageId,
            fingerprint,
            status: 'confirmed',
            turnId: pending.id,
            seq: added.seq,
            createdAt: added.ts,
            updatedAt: added.ts,
          });
        },
      },
    );
    if (!event) throw new Error('pending.added 未写入');
    if (state === 'cancelling') runtime.turn?.addedWhileCancelling.add(pending.id);
    if (steerable) await this.#handOver(runtime, pending);
    // 用户在自动修复的回合里发了消息（0.65.0）：让位给用户，停下这个回合，这条消息在停止后照常发出（不暂停）。
    if (repairTurn && from === undefined && state !== 'cancelling') {
      runtime.turn?.addedWhileCancelling.add(pending.id);
      void this.cancel(runtime.id).catch((error: unknown) => {
        if (!isHostError(error)) this.#onError(error);
      });
    }
    return { pendingId: pending.id, seq: event.seq };
  }

  /**
   * 把插话交给引擎（`steer`）。引擎拒绝（或调用失败）时，它若仍是等待中的插话，就改为排队并记下原因；等待期间回合
   * 可能已经结束、它已被改为排队或已插入，那时什么都不做。
   */
  async #handOver(runtime: SessionRuntime, pending: PendingMessage): Promise<void> {
    const steer = this.#adapter.steer?.bind(this.#adapter);
    if (steer === undefined) return;
    try {
      await steer(runtime.engineSessionId, pending.id, await this.#agentInput(pending.content));
    } catch (error) {
      if (this.#disposed) return;
      const current = this.#events.pending(runtime.id, pending.id);
      if (current?.status !== 'waiting' || current.delivery !== 'steer') return;
      this.#write(runtime, [
        pendingUpdated({
          ...current,
          delivery: 'queue',
          fallback: { reason: 'rejected', message: errorText(error) },
          updatedAt: isoNow(),
        }),
      ]);
    }
  }

  /** `pending.update`：改内容或方式（domain-model §4.6 的表）。 */
  async updatePending(params: MethodParams<'pending.update'>): Promise<PendingMessage> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const pending = this.#requirePending(runtime, params.pendingId);
    if (isTerminalPending(pending)) throw notEditable(pending);
    const handedOver = pending.status === 'waiting' && pending.delivery === 'steer';
    if (handedOver) {
      // 插话已交给引擎，没有撤回的办法；只有“改成插话”是无操作。
      if (params.content !== undefined || params.delivery === 'queue') throw notEditable(pending);
      return pending;
    }
    const next: PendingMessage = { ...pending };
    let changed = false;
    const content =
      params.content === undefined
        ? undefined
        : await this.#acceptContent(runtime, params.content, ['content']);
    if (content !== undefined && !isDeepStrictEqual(content, pending.content)) {
      next.content = content;
      changed = true;
    }
    let handOver = false;
    if (params.delivery === 'steer') {
      if (pending.status === 'held') throw notEditable(pending);
      const { state } = this.#snapshot(runtime).session;
      if (state === 'running' || state === 'awaiting_approval') {
        if (runtime.turn?.command !== undefined) {
          // 命令开的回合不能插话（0.24.0），同 `#addPending`。
          next.fallback = { reason: 'rejected', message: COMMAND_TURN_NOT_STEERABLE };
        } else if (this.#adapter.steer !== undefined) {
          next.delivery = 'steer';
          delete next.fallback;
          handOver = true;
        } else {
          next.fallback = { reason: 'unsupported' };
        }
      } else {
        next.fallback = { reason: 'turn_ended' };
      }
      changed ||= !isDeepStrictEqual(next, pending);
    }
    if (!changed) return pending;
    next.updatedAt = isoNow();
    this.#write(runtime, [pendingUpdated(next)]);
    if (handOver) await this.#handOver(runtime, next);
    return this.#events.pending(runtime.id, next.id) ?? next;
  }

  /** `pending.cancel`：删掉排队的或暂停的；已取消的无操作，交出去的插话与已到终态的不行。 */
  cancelPending(params: MethodParams<'pending.cancel'>): PendingMessage {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const pending = this.#requirePending(runtime, params.pendingId);
    if (pending.status === 'cancelled') return pending;
    if (
      isTerminalPending(pending) ||
      (pending.status === 'waiting' && pending.delivery === 'steer')
    ) {
      throw notEditable(pending);
    }
    const cancelled: PendingMessage = { ...pending, status: 'cancelled', updatedAt: isoNow() };
    this.#write(runtime, [pendingUpdated(cancelled)]);
    return cancelled;
  }

  /**
   * `pending.resume`：暂停的全部转为等待；会话空闲时随后发出第一条（排进命令队列，等它开始再返回），活动中时等回合
   * 结束。`error` / `closed` 回 `INVALID_STATE`。返回未到终态的待发消息。
   */
  async resumePending(sessionId: SessionId): Promise<PendingMessage[]> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    const snapshot = this.#snapshot(runtime);
    const { state } = snapshot.session;
    if (state === 'error' || state === 'closed') {
      throw new HostError('INVALID_STATE', `session is ${state}; resume it first`, { state });
    }
    const now = isoNow();
    const held = (snapshot.pendingMessages ?? []).filter((pending) => pending.status === 'held');
    if (held.length > 0) {
      this.#write(
        runtime,
        held.map((pending) => pendingUpdated({ ...pending, status: 'waiting', updatedAt: now })),
      );
      // 停止过程中让它们继续的：与停止过程中发的一样，取消结算后照常发出。
      if (state === 'cancelling') {
        for (const pending of held) runtime.turn?.addedWhileCancelling.add(pending.id);
      }
    }
    if (state === 'idle') await this.#scheduleDispatch(runtime);
    return this.#snapshot(runtime).pendingMessages ?? [];
  }

  /** 排进命令队列：会话空闲、有等待中的排队消息时发出第一条。失败经事件体现，这里只记下。 */
  #scheduleDispatch(runtime: SessionRuntime): Promise<void> {
    return this.#serial(runtime, () => this.#dispatchNext(runtime)).catch((error: unknown) => {
      if (!isHostError(error)) this.#onError(error);
    });
  }

  async #dispatchNext(runtime: SessionRuntime): Promise<void> {
    if (this.#shuttingDown || this.#disposed) return;
    const before = this.#snapshot(runtime);
    if (before.session.state !== 'idle') return;
    if (!before.pendingMessages?.some((pending) => pending.status === 'waiting')) return;
    // 先把引擎会话挂上（失败时 #11 会把等待中的暂停），之后到写事件之间没有等待，取的就是此刻的第一条。
    if (!runtime.attachment) await this.#autoResume(runtime);
    const snapshot = this.#snapshot(runtime);
    if (snapshot.session.state !== 'idle') return;
    const next = snapshot.pendingMessages?.find((pending) => pending.status === 'waiting');
    if (next === undefined) return;
    await this.#startTurn(runtime, {
      content: next.content,
      sentBy: next.sentBy,
      ...(next.clientMessageId !== undefined && { clientMessageId: next.clientMessageId }),
      pending: next,
      ...(next.collaborationMode === 'plan' && { collaborationMode: 'plan' as const }),
    });
  }

  /** 插话进了回合（适配器的 `turn.steered`）：写 `user.steered` 并把它标为已插入。 */
  #steered(runtime: SessionRuntime, turn: TurnRuntime, event: TurnSteeredEvent): void {
    const pending = this.#events.pending(runtime.id, event.steerId as PendingMessageId);
    if (pending === undefined || isTerminalPending(pending)) {
      this.#onWarning('引擎报告插话进了回合，但没有对应的待发消息', {
        sessionId: runtime.id,
        steerId: event.steerId,
      });
      return;
    }
    const { fallback: _fallback, ...rest } = pending;
    this.#write(runtime, [
      {
        type: 'user.steered',
        source: 'host',
        payload: {
          turnId: turn.turnId,
          pendingId: pending.id,
          content: pending.content,
          sentBy: pending.sentBy,
          ...(pending.clientMessageId !== undefined && {
            clientMessageId: pending.clientMessageId,
          }),
          ...(pending.from !== undefined && { from: pending.from }),
        },
      },
      pendingUpdated({
        ...rest,
        delivery: 'steer',
        status: 'inserted',
        turnId: turn.turnId,
        updatedAt: isoNow(),
      }),
    ]);
  }

  #requirePending(runtime: SessionRuntime, pendingId: PendingMessageId): PendingMessage {
    const pending = this.#events.pending(runtime.id, pendingId);
    if (pending === undefined) {
      throw new HostError('PENDING_NOT_FOUND', `pending message ${pendingId} not found`);
    }
    return pending;
  }

  /**
   * `session.cancel`。活动中：未决审批结为 `cancelled`（`turn_cancelled`），会话转 `cancelling`，
   * 再让引擎取消（#5）；等到回合结算（#8）才返回，超过 `cancelTimeoutMs` 或引擎报
   * `cancel_unconfirmed` 时转 `error`（#9）。其他状态成功、无操作。
   */
  async cancel(sessionId: SessionId): Promise<void> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    // 0.14.0（U21，domain-model §4.5 C6）：子会话也能单独停，父会话不受影响，引擎能告诉父 agent 时告诉它。
    const notifyParent = runtime.parentId !== undefined;
    await Promise.all([
      this.#serial(runtime, () => this.#cancelTurn(runtime, 'turn_cancelled', notifyParent)),
      this.#cancelChildren(runtime, 'turn_cancelled'),
    ]);
  }

  /**
   * `session.configure`（0.9.0）：换模型或推理档位（0.11.0 起还有权限模式），从下一个回合起生效，进行中的回合不受影响。
   * `modelId` 要在会话所用 Provider 的模型列表里（Provider 列了模型时）；`reasoningEffort` 为 null、或换了模型而没给时
   * 清掉；引擎不支持权限模式时 `permissionMode` 只能是 `on_request`。值变了时先把全部当前值交给引擎（引擎会话没挂着时
   * 不交，之后 resume 的配置里就是新的值），再写 `session.configured`。子会话与只读会话回 `INVALID_STATE`；引擎不支持
   * 时回 `ENGINE_ERROR`。
   */
  async configure(params: MethodParams<'session.configure'>): Promise<Session> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    this.#assertNotChild(runtime);
    if (
      params.providerId !== undefined &&
      params.providerId !== this.#snapshot(runtime).session.providerId
    ) {
      return this.#handoff(runtime, params, params.providerId);
    }
    const configureSession = this.#adapter.configureSession?.bind(this.#adapter);
    if (configureSession === undefined) {
      const message =
        'this host engine cannot change the model of a session (use the Codex engine)';
      throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
    }
    return this.#serial(runtime, async () => {
      const { session } = this.#snapshot(runtime);
      if (session.readOnly !== undefined) {
        throw new HostError('INVALID_STATE', 'session is read-only', {
          state: session.state,
          readOnly: session.readOnly,
        });
      }
      const modelId = params.modelId ?? session.modelId;
      const models = (this.#storage.providers.get(session.providerId)?.models ?? []) as {
        id: string;
      }[];
      if (models.length > 0 && !models.some((model) => model.id === modelId)) {
        throw new HostError('INVALID_PARAMS', `provider has no model ${modelId}`, {
          issues: [
            {
              path: ['modelId'],
              message: `provider ${session.providerId} has no model ${modelId}`,
            },
          ],
        });
      }
      const reasoningEffort =
        params.reasoningEffort === null
          ? undefined
          : (params.reasoningEffort ??
            (modelId === session.modelId ? session.reasoningEffort : undefined));
      const permissionMode = this.#permissionMode(params.permissionMode ?? session.permissionMode);
      if (
        modelId === session.modelId &&
        reasoningEffort === session.reasoningEffort &&
        (permissionMode ?? DEFAULT_PERMISSION_MODE) ===
          (session.permissionMode ?? DEFAULT_PERMISSION_MODE)
      ) {
        return session;
      }
      if (runtime.attachment) {
        try {
          await configureSession(runtime.engineSessionId, {
            modelId,
            ...(reasoningEffort !== undefined && { reasoningEffort }),
            ...(permissionMode !== undefined && { permissionMode }),
          });
        } catch (error) {
          if (isAdapterError(error, 'invalid_input')) {
            throw new HostError('INVALID_PARAMS', errorText(error), {
              issues: [{ path: ['modelId'], message: errorText(error) }],
            });
          }
          const info = engineErrorInfo(error, 'unknown');
          throw new HostError('ENGINE_ERROR', info.message, info);
        }
      }
      this.#write(runtime, [
        {
          type: 'session.configured',
          source: 'host',
          payload: {
            modelId,
            ...(reasoningEffort !== undefined && { reasoningEffort }),
            ...(permissionMode !== undefined && { permissionMode }),
          },
        },
      ]);
      return this.#snapshot(runtime).session;
    });
  }

  /**
   * 接力（0.25.0，`session.configure` 带别的 `providerId`，domain-model §3.14，照 T3 Code 的 `create_with_handoff`）：会话要是
   * `idle`、`error` 或 `closed`，不是支线。先取消活动中的子会话，再断开并关闭当前的引擎会话，为新 Provider 挂上引擎会话（以前用过
   * 这个来源时恢复它以前的，恢复不了就新建），从事件库整理它没看到的那段历史的摘要，写 `session.handoff`（原来是 `error` /
   * `closed` 时接着转 `idle`），最后订阅新的引擎会话。新引擎挂不上时回 `ENGINE_ERROR`、不写事件：会话还是原来的 Provider，原来
   * 的引擎会话下次发消息时自动恢复。
   */
  async #handoff(
    runtime: SessionRuntime,
    params: MethodParams<'session.configure'>,
    providerId: ProviderId,
  ): Promise<Session> {
    const target = this.#storage.providers.get(providerId);
    if (!target) throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
    return this.#serial(runtime, async () => {
      const record = this.#record(runtime);
      const { session } = this.#snapshot(runtime);
      if (session.providerId === target.id) return session;
      assertHandoffAllowed(record, session);
      const invalid = (path: string, message: string) =>
        new HostError('INVALID_PARAMS', message, { issues: [{ path: [path], message }] });
      const modelId = params.modelId ?? target.defaultModelId;
      const models = target.models as { id: string }[];
      if (models.length > 0 && !models.some((model) => model.id === modelId)) {
        throw invalid('modelId', `provider ${target.id} has no model ${modelId}`);
      }
      const features = this.#featuresOf(target.kind);
      const reasoningEffort = params.reasoningEffort ?? undefined;
      const permissionMode = this.#handoffPermissionMode(
        params.permissionMode,
        session.permissionMode,
        features,
      );
      if ((record.extraRoots?.length ?? 0) > 0 && features?.additionalRoots !== true) {
        throw invalid('providerId', `the engine of ${target.id} has no additional folders`);
      }
      await assertDirectory(record.cwd);
      // 用户为这次接力选的材料（0.59.0）：先读好笔记，材料放不下时在动原来的引擎会话之前就拒绝。
      const extras = await this.#handoffExtras(runtime, params.handoff);
      // 当前的引擎会话先放下：之后换回这个来源时再恢复它。
      const from = {
        providerId: session.providerId,
        modelId: session.modelId,
        engineSessionId: runtime.engineSessionId,
      };
      const previous = this.#previousEngine(runtime, target.id);
      const plan = () => this.#handoffPlan(runtime, from, previous, features, extras);
      // 预览的绑定（0.60.0）：和此刻重算的不符就不切换，先查一次，什么都还没动。
      const binding = params.handoff?.binding;
      if (binding !== undefined) assertBinding(binding, plan(), target.id);
      // 子会话跟着原来的引擎：还在跑的先停下（父会话空闲时一般没有）。停下时写的事件也让绑定过期。
      await this.#cancelChildren(runtime, 'turn_cancelled');
      const planned = plan();
      if (binding !== undefined) assertBinding(binding, planned, target.id);
      if (planned.assembly.kind === 'over_budget') throw handoffOverBudget(planned.assembly);

      const config: SessionConfig = { cwd: record.cwd, providerId: target.id, modelId };
      if (reasoningEffort !== undefined) config.reasoningEffort = reasoningEffort;
      if (permissionMode !== undefined) config.permissionMode = permissionMode;
      if (record.extraRoots !== undefined) config.additionalRoots = record.extraRoots;

      // 规则文件（0.68.0）：新来源自己不读的，在它的说明里或随下一条消息补给它。
      const rules = await this.#rulePlan(record.cwd, target.id);

      const attachment = runtime.attachment;
      if (attachment) {
        attachment.detached = true;
        await this.#adapter.close(runtime.engineSessionId).catch((error: unknown) => {
          this.#onWarning('接力时关闭原来的引擎会话失败', {
            sessionId: runtime.id,
            error: errorText(error),
          });
        });
        this.#detach(runtime);
      }

      let engine: EngineSession | undefined;
      if (previous !== undefined) {
        try {
          engine = await this.#adapter.resumeSession(
            previous.engineSessionId,
            this.#engineConfig(runtime.id, config, rules),
          );
        } catch (error) {
          this.#unresumable.add(previous.engineSessionId);
          this.#onWarning('接力时恢复以前的引擎会话失败，改为新建', {
            sessionId: runtime.id,
            providerId: target.id,
            error: errorText(error),
          });
          // 用户预览的是只补错过的那段：不新建、不交没看过的整段，回去重新预览（再预览就按新建算）。原来的引擎会话已经放下，
          // 下次发消息时自动恢复，同新引擎挂不上时。
          if (binding !== undefined) {
            throw new HostError(
              'HANDOFF_STALE',
              `the earlier engine session of ${target.id} could not be resumed; preview the handoff again`,
              { reasons: ['resume_failed'] },
            );
          }
          // 以前的引擎会话恢复不了：新建一个，交给它整段对话。
        }
      }
      const resumed = engine !== undefined;
      if (engine === undefined) {
        try {
          engine = await this.#adapter.createSession(this.#engineConfig(runtime.id, config, rules));
        } catch (error) {
          if (isAdapterError(error, 'invalid_input')) throw invalid('providerId', errorText(error));
          const info = engineErrorInfo(error);
          throw new HostError('ENGINE_ERROR', info.message, info);
        }
      }

      // 材料：新引擎没看到的那段（第一次用这个来源、或以前的恢复不了时是整段对话），加上用户选的。
      const final =
        resumed === planned.resumed
          ? planned
          : this.#handoffPlan(runtime, from, undefined, features, extras);
      if (final.assembly.kind === 'over_budget') {
        await this.#adapter.close(engine.engineSessionId).catch(() => {});
        throw handoffOverBudget(final.assembly);
      }
      const material = final.assembly.kind === 'material' ? final.assembly : undefined;
      const describe = (provider: string, model: string) => this.#describeModel(provider, model);
      if (final.historyTool && material !== undefined) {
        this.#writeHistory(runtime.id, final.toSeq, describe);
      }

      runtime.engineSessionId = engine.engineSessionId;
      const inputs: AppendInput[] = [
        {
          type: 'session.handoff',
          source: 'host',
          payload: {
            from,
            to: {
              providerId: target.id,
              modelId: engine.modelId ?? modelId,
              engineSessionId: engine.engineSessionId,
            },
            ...((engine.reasoningEffort ?? reasoningEffort) !== undefined && {
              reasoningEffort: engine.reasoningEffort ?? reasoningEffort,
            }),
            ...(permissionMode !== undefined && { permissionMode }),
            resumed,
            strategy: final.strategy,
            ...handoffReceipt(final),
            ...(engine.engineVersion !== undefined && { engineVersion: engine.engineVersion }),
          },
        },
      ];
      const { state: sessionState } = this.#snapshot(runtime).session;
      if (sessionState !== 'idle') inputs.push(stateChanged(sessionState, 'idle', 'resumed'));
      this.#write(runtime, inputs);
      const rulesInput = this.#rulesInput(runtime.id, rules, engine.engineSessionId, {
        fresh: !resumed,
      });
      if (rulesInput !== undefined) this.#write(runtime, [rulesInput]);
      try {
        this.#attach(runtime);
      } catch (error) {
        this.#engineFailed(runtime, engineErrorInfo(error));
      }
      return this.#snapshot(runtime).session;
    });
  }

  /**
   * 接力预览（0.60.0，`session.handoffPreview`，只读）：会话换到 `providerId` 时会交出的材料与绑定，算法、事件与笔记都和正式切换
   * 相同，所以同样的情况下预览与递交的材料逐字节一致。前提同接力：同一个 Provider、回合进行中、支线、子会话、额外目录与笔记的限制照样
   * 报错。排在会话的命令队列里，看到的是前面的命令做完之后的状态。
   */
  async handoffPreview(
    params: MethodParams<'session.handoffPreview'>,
  ): Promise<MethodResult<'session.handoffPreview'>> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    this.#assertNotChild(runtime);
    const target = this.#storage.providers.get(params.providerId);
    if (!target) {
      throw new HostError('PROVIDER_NOT_FOUND', `provider ${params.providerId} not found`);
    }
    return this.#serial(runtime, async () => {
      const record = this.#record(runtime);
      const { session } = this.#snapshot(runtime);
      const invalid = (message: string) =>
        new HostError('INVALID_PARAMS', message, { issues: [{ path: ['providerId'], message }] });
      if (session.providerId === target.id) {
        throw invalid(`the session already uses provider ${target.id}`);
      }
      assertHandoffAllowed(record, session);
      const features = this.#featuresOf(target.kind);
      if ((record.extraRoots?.length ?? 0) > 0 && features?.additionalRoots !== true) {
        throw invalid(`the engine of ${target.id} has no additional folders`);
      }
      const extras = await this.#handoffExtras(runtime, params.handoff);
      const from = { providerId: session.providerId, modelId: session.modelId };
      const previous = this.#previousEngine(runtime, target.id);
      const plan = this.#handoffPlan(runtime, from, previous, features, extras);
      const result = handoffPreviewOf(target.id, plan);
      // 规则文件（0.68.0）：新来源会加载的，不进材料的预算与散列。
      const rules = await this.#rulePlan(record.cwd, target.id);
      return rules === undefined
        ? result
        : { ...result, preview: { ...result.preview, rules: rules.rules } };
    });
  }

  /** 接力时要接着用的这个来源以前的引擎会话；没用过、或恢复过一次失败（`#unresumable`）时没有，新建。 */
  #previousEngine(
    runtime: SessionRuntime,
    providerId: string,
  ): { engineSessionId: string; seenSeq: number } | undefined {
    const previous = this.#events
      .handoffState(runtime.id)
      ?.engines?.find((engine) => engine.providerId === providerId);
    return previous === undefined || this.#unresumable.has(previous.engineSessionId)
      ? undefined
      : previous;
  }

  /**
   * 接力的材料（0.59.0，预览与正式递交共用）：`previous` 是要接着用的这个来源以前的引擎会话（没有时新建，交整段对话），历史从它
   * 看到的地方之后读到此刻，再加上用户选的约束与笔记，交给 `assembleHandoff`。同样的输入得到逐字节相同的材料。
   */
  #handoffPlan(
    runtime: SessionRuntime,
    from: { providerId: string; modelId: string },
    previous: { seenSeq: number } | undefined,
    features: EngineFeatures | undefined,
    extras: HandoffExtras,
  ): HandoffPlan {
    const seen = previous?.seenSeq ?? 0;
    const toSeq = this.#snapshot(runtime).session.lastSeq;
    const describe = (provider: string, model: string) => this.#describeModel(provider, model);
    const items = historyItems(this.#events.readSince(runtime.id, seen), describe);
    const historyTool = features?.historyTool === true && this.#historyDir !== undefined;
    const strategy = seen === 0 ? FULL_THREAD_SUMMARY : DELTA_SINCE_TARGET_LAST_SEEN;
    const covered = { fromSeq: seen + 1, toSeq };
    return {
      resumed: previous !== undefined,
      strategy,
      toSeq,
      historyTool,
      ...(items.length > 0 && { covered }),
      extras,
      assembly: assembleHandoff({
        sessionId: runtime.id,
        strategy,
        fromModel: describe(from.providerId, from.modelId),
        covered,
        items,
        historyTool,
        constraints: extras.constraints,
        notes: extras.notes,
      }),
    };
  }

  /**
   * 用户为这次接力选的材料（0.59.0）：约束原样；笔记从记忆里读（`project` 是会话所在项目的），要是启用的。自动记忆关着时不能选笔记，
   * 同一条选两次、找不到、停用的都拒绝。
   */
  async #handoffExtras(
    runtime: SessionRuntime,
    request: HandoffMaterialRequest | undefined,
  ): Promise<HandoffExtras> {
    const constraints = request?.constraints ?? [];
    const wanted = request?.notes ?? [];
    if (wanted.length === 0) return { constraints, notes: [] };
    const refuse = (path: (string | number)[], message: string) =>
      new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
    const memory = this.#memory;
    if (memory === undefined || !this.#memoryEnabled()) {
      throw refuse(
        ['handoff', 'notes'],
        'automatic memory is off; notes cannot be added to a handoff',
      );
    }
    const { workspaceId } = this.#record(runtime);
    const notes: HandoffNote[] = [];
    for (const [index, ref] of wanted.entries()) {
      const label = `${ref.scope} note ${ref.name}`;
      if (notes.some((note) => note.scope === ref.scope && note.name === ref.name)) {
        throw refuse(['handoff', 'notes', index], `${label} is selected twice`);
      }
      const note = await memory
        .read(ref.scope, ref.scope === 'project' ? workspaceId : undefined, ref.name, {
          includeDisabled: true,
        })
        .catch((error: unknown) => {
          if (!(error instanceof MemoryError)) throw error;
          if (error.code === 'not_found') throw new HostError('MEMORY_NOT_FOUND', error.message);
          throw refuse(['handoff', 'notes', index], error.message);
        });
      if (!note.enabled) throw refuse(['handoff', 'notes', index], `${label} is turned off`);
      notes.push({
        scope: note.scope,
        name: note.name,
        revision: note.revision,
        description: note.description,
        content: note.content,
      });
    }
    return { constraints, notes };
  }

  /** 一种 Provider 的引擎能做什么（0.25.0）；没给 `engineFeatures` 时只看适配器自己的。 */
  #featuresOf(kind: string): EngineFeatures | undefined {
    if (this.#engineFeatures !== undefined) return this.#engineFeatures[kind];
    return {
      engine: this.#engine,
      ...(this.#adapter.permissionModes !== undefined && {
        permissionModes: [...this.#adapter.permissionModes],
      }),
      ...(this.#adapter.additionalRoots === true && { additionalRoots: true }),
      ...(this.#adapter.historyTool === true && { historyTool: true }),
      ...(this.#adapter.planMode === true && { planMode: true }),
    };
  }

  /**
   * 计划模式（0.36.0）：会话当前的 Provider 交给的引擎要有它（`engineFeatures` 的 `planMode`），否则 `INVALID_PARAMS`，不写事件。
   * 按 Provider 的种类判断，不必先把引擎会话挂上。
   */
  #assertPlanMode(runtime: SessionRuntime): void {
    const { providerId } = this.#snapshot(runtime).session;
    const kind = this.#storage.providers.get(providerId)?.kind;
    const features = kind === undefined ? undefined : this.#featuresOf(kind);
    if (features?.planMode === true) return;
    const message = `the engine of provider ${providerId} has no plan mode`;
    throw new HostError('INVALID_PARAMS', message, {
      issues: [{ path: ['collaborationMode'], message }],
    });
  }

  /**
   * 接力后的权限模式：请求里给了就要新引擎支持（否则 `INVALID_PARAMS`）；沿用会话原来的，新引擎不支持时退回 `on_request`
   * （最严的那个）。新引擎不认权限模式时返回 undefined。
   */
  #handoffPermissionMode(
    requested: PermissionMode | undefined,
    current: PermissionMode | undefined,
    features: EngineFeatures | undefined,
  ): PermissionMode | undefined {
    const supported = features?.permissionModes;
    if (requested !== undefined) {
      if (
        supported?.includes(requested) ||
        (supported === undefined && requested === DEFAULT_PERMISSION_MODE)
      ) {
        return supported === undefined ? undefined : requested;
      }
      const message = `the target engine does not support permission mode ${requested}`;
      throw new HostError('INVALID_PARAMS', message, {
        issues: [{ path: ['permissionMode'], message }],
      });
    }
    if (supported === undefined) return undefined;
    const mode = current ?? DEFAULT_PERMISSION_MODE;
    return supported.includes(mode) ? mode : DEFAULT_PERMISSION_MODE;
  }

  /** 给模型看的“服务 · 模型”名字（接力的摘要与之前的换模型记录）。 */
  #describeModel(providerId: string, modelId: string): string {
    const provider = this.#storage.providers.get(providerId);
    const model = (provider?.models as { id: string; displayName?: string }[] | undefined)?.find(
      (candidate) => candidate.id === modelId,
    );
    return `${provider?.displayName ?? providerId} · ${model?.displayName ?? modelId}`;
  }

  /** 读历史的工具读的文件（0.25.0）：会话到 `throughSeq` 为止的完整历史。写不了只记告警。 */
  #writeHistory(
    sessionId: SessionId,
    throughSeq: number,
    describe: (providerId: string, modelId: string) => string,
  ): void {
    const dir = this.#historyDir;
    if (dir === undefined) return;
    try {
      const items = historyItems(this.#events.readSince(sessionId, 0), describe);
      writeHistoryFile(dir, {
        sessionId,
        throughSeq,
        writtenAt: isoNow(),
        items: items.map((item, index) => ({ position: index + 1, ...item })),
      });
    } catch (error) {
      this.#onWarning('写读历史工具的历史文件失败', { sessionId, error: errorText(error) });
    }
  }

  /**
   * `session.close`。活动中先按 #5 取消（审批原因 `session_closed`）并等结算（#8 / #9），然后关闭引擎
   * 会话、转 `closed`（#13、#14）。引擎关闭失败不阻止关闭，记一条 `engine.error`。已关闭时成功、
   * 无操作。
   */
  async close(sessionId: SessionId): Promise<void> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    // 活动中的子会话一并取消，但不关闭（domain-model §4.5）。
    await this.#cancelChildren(runtime, 'turn_cancelled');
    await this.#serial(runtime, async () => {
      let { state } = this.#snapshot(runtime).session;
      if (state === 'closed') return;
      if (ACTIVE_STATES.includes(state)) {
        await this.#cancelTurn(runtime, 'session_closed');
        state = this.#snapshot(runtime).session.state;
      }
      if (state !== 'idle' && state !== 'error') {
        throw new Error(`会话 ${runtime.id} 取消后仍是 ${state}`);
      }

      const inputs: AppendInput[] = [];
      const attachment = runtime.attachment;
      if (attachment) {
        // 关闭会结束事件流，这是预期的。
        attachment.detached = true;
        try {
          await this.#adapter.close(runtime.engineSessionId);
        } catch (error) {
          inputs.push(engineError(engineErrorInfo(error, 'session_unavailable'), false));
        }
        this.#detach(runtime);
      }
      inputs.push(
        stateChanged(state, 'closed', 'closed'),
        ...settlePendings(this.#snapshot(runtime), () => 'held'),
      );
      this.#write(runtime, inputs);
      // 关闭的会话不留回合快照（0.20.0，domain-model §3.13）。
      const checkpointCwd = this.#checkpointCwd(runtime);
      if (checkpointCwd !== undefined) this.#checkpoints?.dropSession(runtime.id, checkpointCwd);
    });
  }

  /**
   * `session.delete`（0.43.0，domain-model §3.20）：永久删掉一个已归档的顶层会话的一家。先照 `session.close` 再关一次，然后排在它的命令
   * 队列里重新检查（期间可能被恢复、取消归档）再删；之后排着的命令回 `SESSION_NOT_FOUND`。
   */
  async delete(
    sessionId: SessionId,
    options: { force?: boolean } = {},
  ): Promise<MethodResult<'session.delete'>> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertDeletable(sessionId);
    await this.close(sessionId);
    return this.#serial(runtime, async () => {
      const record = this.#assertDeletable(sessionId);
      return deleteSessionData(
        {
          storage: this.#storage,
          events: this.#events,
          adapter: this.#adapter,
          images: this.#images,
          chats: this.#chats,
          historyDir: this.#historyDir,
          worktreesDir: this.#worktreesDir,
          toolOutputDir: this.#toolOutputDir,
          onWarning: this.#onWarning,
          detach: (ids) => {
            this.#forget(ids);
            this.#appTools?.forget?.(ids);
          },
        },
        record,
        options.force === true,
      );
    });
  }

  /** `session.usage`（0.43.0）：范围同 `session.list` 的顶层会话。 */
  usage(archived: boolean): Promise<MethodResult<'session.usage'>['sessions']> {
    this.#assertOpen();
    const records = this.#storage.sessions.list(archived ? { archived: 'only' } : {});
    return measureUsage(
      {
        storage: this.#storage,
        images: this.#images,
        chats: this.#chats,
        historyDir: this.#historyDir,
        worktreesDir: this.#worktreesDir,
        toolOutputDir: this.#toolOutputDir,
      },
      records,
    );
  }

  #assertDeletable(sessionId: SessionId): SessionRecord {
    const invalid = (path: string, message: string) =>
      new HostError('INVALID_PARAMS', message, { issues: [{ path: [path], message }] });
    const record = this.#storage.sessions.get(sessionId);
    if (!record) throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    if (record.parentSessionId !== undefined || record.side) {
      throw invalid('sessionId', 'only top-level sessions can be deleted');
    }
    if (record.archivedAt === undefined) {
      throw invalid('sessionId', 'only archived sessions can be deleted');
    }
    return record;
  }

  /** 会话删掉了（0.43.0）：断开还挂着的引擎会话，忘掉运行时与它们的提问。 */
  #forget(sessionIds: readonly SessionId[]): void {
    const ids = new Set<SessionId>(sessionIds);
    for (const id of ids) {
      const runtime = this.#runtimes.get(id);
      if (runtime === undefined) continue;
      this.#detach(runtime);
      this.#runtimes.delete(id);
      this.#recaps.forget(id);
    }
    for (const [questionId, sessionId] of this.#questionSessions) {
      if (!ids.has(sessionId)) continue;
      this.#questionSessions.delete(questionId);
      this.#clearQuestionTimer(questionId);
    }
  }

  /**
   * `session.rename`（0.23.0）：用户改名，写 `session.title_changed`（`user`），之后模型生成的标题不再覆盖它（生成标题只在
   * 来源是 `first_prompt` 时写）。标题与来源都没变时不写。子会话由父 agent 驱动，不能改名。已关闭、只读的会话可以。
   */
  /**
   * 应用级工具的 `wevir_show`（0.30.0）：在会话的流里写 `ui.show`，正在看这个会话的客户端打开对应的窗格。会话有进行中的回合时
   * 带上它。
   */
  showInUi(sessionId: SessionId, target: UiShowTarget): void {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    const turnId = runtime.turn?.turnId;
    this.#write(runtime, [
      {
        type: 'ui.show',
        source: 'host',
        payload: { target, ...(turnId !== undefined && { turnId }) },
      },
    ]);
  }

  /**
   * 应用级工具的 `wevir_share_file`（0.40.0）：在会话的流里写 `file.shared`，消息流在当时的位置出现文件卡片。会话有进行中的回合时
   * 带上它。
   */
  shareFiles(sessionId: SessionId, files: readonly SharedFile[]): void {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    const turnId = runtime.turn?.turnId;
    this.#write(runtime, [
      {
        type: 'file.shared',
        source: 'host',
        payload: { files: [...files], ...(turnId !== undefined && { turnId }) },
      },
    ]);
  }

  async rename(sessionId: SessionId, title: string): Promise<Session> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    return this.#serial(runtime, async () => {
      const { session } = this.#snapshot(runtime);
      if (session.title !== title || session.titleSource !== 'user') {
        this.#write(runtime, [
          { type: 'session.title_changed', source: 'host', payload: { title, source: 'user' } },
        ]);
      }
      return this.#snapshot(runtime).session;
    });
  }

  /** 打回合快照的会话（0.20.0）：顶层、不是支线的会话，返回它的目录。子会话的改动算在父会话的回合里。 */
  #checkpointCwd(runtime: SessionRuntime): string | undefined {
    if (this.#checkpoints === undefined || runtime.parentId !== undefined) return undefined;
    const record = this.#storage.sessions.get(runtime.id);
    return record && !record.side ? record.cwd : undefined;
  }

  /**
   * `session.resume`：`error` / `closed` 时把引擎会话重新挂上（创建时的 cwd），成功后写 `session.resumed` 并转
   * `idle`（#12）；其他状态成功、无操作。工作区目录不在了返回 `WORKSPACE_PATH_INVALID`，不写事件。引擎拒绝时
   * 追加一条 `engine.error`（`session_unavailable`）、状态不变，返回 `ENGINE_ERROR`；引擎会话恢复不了
   * （`session_lost`）时另写 `session.read_only`。只读的会话照样重试引擎（引擎数据可能已经找回），成功即解除。
   */
  async resume(sessionId: SessionId): Promise<Session> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    this.#assertNotChild(runtime);
    return this.#serial(runtime, async () => {
      const snapshot = this.#snapshot(runtime);
      const { session } = snapshot;
      if (session.state !== 'error' && session.state !== 'closed') return session;
      const record = this.#record(runtime);
      if (!this.#storage.providers.get(record.providerId)) {
        throw new HostError('PROVIDER_NOT_FOUND', `provider ${record.providerId} not found`);
      }
      await assertDirectory(record.cwd);
      let engine: EngineSession;
      const rules = await this.#rulePlan(record.cwd, record.providerId);
      try {
        engine = await this.#adapter.resumeSession(
          runtime.engineSessionId,
          this.#engineConfig(runtime.id, sessionConfig(record), rules),
        );
        if (!runtime.attachment) this.#attach(runtime);
      } catch (error) {
        const info = engineErrorInfo(error, 'session_unavailable');
        this.#write(runtime, [engineError(info, false), ...readOnlyInputs(snapshot, error)]);
        throw new HostError('ENGINE_ERROR', info.message, info);
      }
      const rulesInput = this.#rulesInput(runtime.id, rules, runtime.engineSessionId, {
        fresh: false,
      });
      this.#write(runtime, [
        resumedEvent(engine),
        ...(rulesInput === undefined ? [] : [rulesInput]),
        stateChanged(session.state, 'idle', 'resumed'),
      ]);
      return this.#snapshot(runtime).session;
    });
  }

  /**
   * `session.fork`：从顶层会话分出一个新会话。被分的会话不能是子会话、支线、只读、出错或已关闭，要有完成的回合；引擎会话没挂上时
   * 先自动恢复。排在被分会话的命令队列里；它的回合进行中也可以（只分到完成的回合）。新会话沿用它的项目、目录、Provider、模型、推理
   * 档位、权限模式与环境字段（不含 worktree），事件流从 `session.created`（带 `forkedFrom`）开始。被分的会话是用预设角色开的时，
   * 新会话的记录带 `origin: { kind: 'fork', role }`，受同一个角色的工具限制；工具预设也抄过去（对话里用过的工具还在）。
   *
   * - 支线（`side: true`，0.17.0，domain-model §3.12）：到最近一个完成的回合，带 `side`，不进 `session.list`。
   * - 分支（不带 `side`，0.38.0，§3.18）：到 `turnId`（省略时最近一个完成的回合），普通的顶层会话，标题同被分的会话；
   *   `session.created` 之后抄来被分会话到那个回合为止的消息记录（`#branchHistory`）。引擎去掉那个回合之后的回合
   *   （`dropTurns`）。接力（0.25.0）之前的回合不在现在的引擎里，分不了。
   */
  async fork(params: MethodParams<'session.fork'>): Promise<Session> {
    this.#assertOpen();
    const side = params.side === true;
    if (side && params.turnId !== undefined) {
      throw invalidContent(['turnId'], 'a side session forks at the latest finished turn');
    }
    const source = this.#runtime(params.sessionId);
    this.#assertNotChild(source);
    const fork = this.#adapter.fork?.bind(this.#adapter);
    return this.#serial(source, async () => {
      const record = this.#record(source);
      const { session } = this.#snapshot(source);
      const refuse = (message: string) =>
        new HostError('INVALID_STATE', message, { state: session.state });
      if (fork === undefined || (!side && this.#adapter.branches !== true)) {
        throw refuse('this host engine cannot fork sessions');
      }
      if (record.side) throw refuse('a side session cannot be forked again');
      if (session.readOnly !== undefined) throw refuse('session is read-only');
      if (session.state === 'error' || session.state === 'closed') {
        throw refuse(`session is ${session.state}; resume it first`);
      }
      const { turns, handoffSeq, hidden } = this.#finishedTurns(source.id);
      const visibleTurns = turns.filter((turn) => !hidden.has(turn.turnId));
      if (visibleTurns.length === 0) throw refuse('session has no finished turn to fork from');
      const target =
        params.turnId === undefined
          ? visibleTurns.at(-1)
          : visibleTurns.find((turn) => turn.turnId === params.turnId);
      if (target === undefined) {
        throw invalidContent(['turnId'], 'turnId is not a finished turn of the session');
      }
      const index = turns.indexOf(target);
      // 刚接力（0.25.0）、新引擎还没跑过回合时，它的会话里没有可分的内容；接力之前的回合不在新引擎里。
      if (this.#events.handoffState(source.id)?.context !== undefined) {
        throw refuse('the session just switched models; send a message before forking');
      }
      if (target.seq < handoffSeq) {
        throw refuse('the turn is from before the session switched models');
      }
      if (!source.attachment) await this.#autoResume(source);
      if (!side && this.#adapter.supports?.(source.engineSessionId, 'branch') === false) {
        throw refuse("the session's engine cannot branch");
      }
      const config = sessionConfig(record);
      const sessionId = newId('ses');
      // 角色会话分出来的会话带着同一个角色（工具限制跟着走）；记在自己的记录里，被分的会话之后删了也不丢。
      const role = record.origin?.role;
      const origin: SessionRecord['origin'] =
        role === undefined ? undefined : { kind: 'fork', sessionId: source.id, role };
      let engineSession: EngineSession;
      this.#creating.set(sessionId, {
        workspaceId: record.workspaceId,
        ...(origin !== undefined && { origin }),
        ...(record.toolPreset !== undefined && { toolPreset: record.toolPreset }),
      });
      const rules = await this.#rulePlan(record.cwd, record.providerId);
      try {
        engineSession = await fork(
          source.engineSessionId,
          this.#engineConfig(sessionId, config, rules),
          side ? { kind: 'side' } : { kind: 'branch', dropTurns: turns.length - 1 - index },
        );
      } catch (error) {
        this.#creating.delete(sessionId);
        const info = engineErrorInfo(error);
        throw new HostError('ENGINE_ERROR', info.message, info);
      }

      const now = isoNow();
      const modelId = engineSession.modelId ?? config.modelId;
      const reasoningEffort = engineSession.reasoningEffort ?? config.reasoningEffort;
      const forkedFrom = { sessionId: source.id, turnId: target.turnId };
      try {
        const forked: SessionRecord = {
          id: sessionId,
          workspaceId: record.workspaceId,
          cwd: record.cwd,
          engine: this.#engine,
          engineSessionId: engineSession.engineSessionId,
          providerId: record.providerId,
          modelId,
          forkedFrom,
          ...(side && { side: true as const }),
          title: '',
          titleSource: 'first_prompt',
          state: 'idle',
          lastSeq: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (reasoningEffort !== undefined) forked.reasoningEffort = reasoningEffort;
        if (record.permissionMode !== undefined) forked.permissionMode = record.permissionMode;
        if (record.environmentId !== undefined) forked.environmentId = record.environmentId;
        if (record.extraRoots !== undefined) forked.extraRoots = record.extraRoots;
        if (origin !== undefined) forked.origin = origin;
        if (record.toolPreset !== undefined) forked.toolPreset = record.toolPreset;
        this.#storage.sessions.insert(forked);
        this.#events.append(sessionId, {
          type: 'session.created',
          source: 'host',
          payload: {
            workspaceId: record.workspaceId as WorkspaceId,
            cwd: record.cwd,
            providerId: record.providerId,
            modelId,
            ...(reasoningEffort !== undefined && { reasoningEffort }),
            ...(record.permissionMode !== undefined && {
              permissionMode: record.permissionMode as PermissionMode,
            }),
            ...(record.environmentId !== undefined && {
              environmentId: record.environmentId as EnvironmentId,
            }),
            ...(record.extraRoots !== undefined && { extraRoots: record.extraRoots }),
            forkedFrom,
            ...(side && { side: true as const }),
            ...(engineSession.engineVersion !== undefined && {
              engineVersion: engineSession.engineVersion,
            }),
            ...(record.toolPreset !== undefined && {
              toolPreset: record.toolPreset as ToolPreset,
            }),
          },
        });
        if (!side) {
          this.#events.appendHistory(sessionId, this.#branchHistory(source.id, target.seq));
          if (session.title !== '') {
            this.#events.append(sessionId, {
              type: 'session.title_changed',
              source: 'host',
              payload: { title: session.title, source: session.titleSource },
            });
          }
        }
        // 规则文件（0.68.0）：分出来的引擎会话带着被分会话的上下文，随消息补过的不再补。
        const rulesInput = this.#rulesInput(sessionId, rules, engineSession.engineSessionId, {
          fresh: true,
          inherited: true,
        });
        if (rulesInput !== undefined) this.#events.append(sessionId, rulesInput);
      } catch (error) {
        await this.#adapter.close(engineSession.engineSessionId).catch(this.#onError);
        throw error;
      } finally {
        this.#creating.delete(sessionId);
      }
      const runtime = this.#runtime(sessionId);
      try {
        this.#attach(runtime);
      } catch (error) {
        this.#engineFailed(runtime, engineErrorInfo(error));
      }
      return this.#snapshot(runtime).session;
    });
  }

  /**
   * `session.rewind`（0.38.0，domain-model §3.18）：撤回顶层会话（不是支线）最后一个完成的回合，客户端随后把改过的消息照常发出。
   * 会话要空闲（`SESSION_BUSY`）、不是只读、出错或已关闭；`turnId` 必须是最后一个没撤回的完成的回合（`INVALID_STATE`）。引擎会话
   * 没挂上时先自动恢复，引擎撤回之后写 `turn.rewound`。会话目录里的文件不动。
   */
  async rewind(params: MethodParams<'session.rewind'>): Promise<{ seq: number }> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    this.#assertNotChild(runtime);
    const rewind = this.#adapter.rewind?.bind(this.#adapter);
    return this.#serial(runtime, async () => {
      const record = this.#record(runtime);
      const { session } = this.#snapshot(runtime);
      const refuse = (message: string) =>
        new HostError('INVALID_STATE', message, { state: session.state });
      if (rewind === undefined) throw refuse('this host engine cannot rewind turns');
      if (record.side) throw refuse('a side session cannot be rewound');
      if (session.readOnly !== undefined) throw refuse('session is read-only');
      if (session.state === 'error' || session.state === 'closed') {
        throw refuse(`session is ${session.state}; resume it first`);
      }
      if (session.state !== 'idle') {
        throw new HostError('SESSION_BUSY', 'a turn is running', { state: session.state });
      }
      const { turns, handoffSeq, hidden } = this.#finishedTurns(runtime.id);
      const last = turns.filter((turn) => !hidden.has(turn.turnId)).at(-1);
      if (last === undefined || last.turnId !== params.turnId) {
        throw refuse('only the last finished turn can be rewound');
      }
      if (this.#events.handoffState(runtime.id)?.context !== undefined || last.seq < handoffSeq) {
        throw refuse('the turn is from before the session switched models');
      }
      if (!runtime.attachment) await this.#autoResume(runtime);
      if (this.#adapter.supports?.(runtime.engineSessionId, 'rewind') === false) {
        throw refuse("the session's engine cannot rewind turns");
      }
      // 引擎的历史里还留着最后一个看得见的回合之后被撤销的回合（0.51.0）：一并退掉，从后往前，每退一个写一条 `turn.rewound`。
      const dropped = turns.slice(turns.findIndex((turn) => turn.turnId === last.turnId)).reverse();
      let seq = 0;
      for (const turn of dropped) {
        try {
          await rewind(runtime.engineSessionId);
        } catch (error) {
          const info = engineErrorInfo(error);
          throw new HostError('ENGINE_ERROR', info.message, info);
        }
        seq = this.#events.append(runtime.id, {
          type: 'turn.rewound',
          source: 'host',
          payload: { turnId: turn.turnId },
        }).seq;
      }
      return { seq };
    });
  }

  /**
   * `session.undo`（0.51.0，domain-model §3.22）：撤销会话最后一个看得见的回合——目录里的文件还原到这个回合开始前（回合快照，
   * §3.13），消息记录隐藏它，引擎的上下文里补一条说明。引擎自己的历史不动，所以不要求引擎能撤回；会话要空闲、不是支线或只读、
   * 引擎收得了说明（`injectNote`）。文件不能还原（不在 git 仓库、没有快照、HEAD 动过）时对话照样撤销，结果的 `files` 说明；还原
   * 中途出错回 `INVALID_STATE`，目录已放回原样、不写事件。
   */
  async undo(params: MethodParams<'session.undo'>): Promise<MethodResult<'session.undo'>> {
    return this.#undoRedo(params, 'undo');
  }

  /** `session.redo`：重做最近撤销的回合；撤销之后会话开始过新回合就没有可重做的了。其余同 `session.undo`。 */
  async redo(params: MethodParams<'session.redo'>): Promise<MethodResult<'session.redo'>> {
    return this.#undoRedo(params, 'redo');
  }

  async #undoRedo(
    params: { sessionId: SessionId; turnId?: TurnId | undefined },
    kind: 'undo' | 'redo',
  ): Promise<{ seq: number; turnId: TurnId; files: FilesRestore }> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    this.#assertNotChild(runtime);
    return this.#serial(runtime, async () => {
      const record = this.#record(runtime);
      const { session } = this.#snapshot(runtime);
      const refuse = (message: string) =>
        new HostError('INVALID_STATE', message, { state: session.state });
      if (this.#adapter.injectNote === undefined) {
        throw refuse(`this host engine cannot ${kind} turns`);
      }
      if (record.side) throw refuse(`a side session cannot ${kind} turns`);
      if (session.readOnly !== undefined) throw refuse('session is read-only');
      if (session.state === 'error' || session.state === 'closed') {
        throw refuse(`session is ${session.state}; resume it first`);
      }
      if (session.state !== 'idle') {
        throw new HostError('SESSION_BUSY', 'a turn is running', { state: session.state });
      }
      const { turns, hidden, redo } = this.#finishedTurns(runtime.id);
      const targetId =
        kind === 'undo'
          ? turns.filter((turn) => !hidden.has(turn.turnId)).at(-1)?.turnId
          : redo.at(-1);
      if (targetId === undefined) {
        throw refuse(kind === 'undo' ? 'there is no turn to undo' : 'there is no turn to redo');
      }
      if (params.turnId !== undefined && params.turnId !== targetId) {
        throw refuse(
          kind === 'undo'
            ? 'only the last turn can be undone'
            : 'only the most recently undone turn can be redone',
        );
      }
      if (!runtime.attachment) await this.#autoResume(runtime);
      if (this.#adapter.supports?.(runtime.engineSessionId, 'injectNote') === false) {
        throw refuse(`the session's engine cannot ${kind} turns`);
      }

      const cwd = this.#checkpointCwd(runtime);
      let files: FilesRestore = { status: 'unavailable', reason: 'no_checkpoint' };
      if (cwd !== undefined && this.#checkpoints !== undefined) {
        try {
          files = await (kind === 'undo' ? this.#checkpoints.undo : this.#checkpoints.redo).call(
            this.#checkpoints,
            runtime.id,
            cwd,
            targetId,
          );
        } catch (error) {
          throw refuse(`could not ${kind} the files of the turn: ${errorText(error)}`);
        }
      }
      const event = this.#events.append(runtime.id, {
        type: kind === 'undo' ? 'turn.undone' : 'turn.redone',
        source: 'host',
        payload: { turnId: targetId, files },
      });
      const note = undoRedoNote(kind, this.#turnPrompt(runtime.id, targetId), files);
      this.#adapter.injectNote(runtime.engineSessionId, note).catch((error) =>
        this.#onWarning('撤销或重做的说明没能补进引擎的上下文', {
          sessionId: runtime.id,
          error: errorText(error),
        }),
      );
      return { seq: event.seq, turnId: targetId, files };
    });
  }

  /** 一个回合的用户消息文字（前 `UNDO_NOTE_PROMPT_MAX_LENGTH` 字，折叠空白）；命令或目标回合没有，是 `undefined`。 */
  #turnPrompt(sessionId: SessionId, turnId: TurnId): string | undefined {
    for (const event of this.#events.readSince(sessionId, 0)) {
      if (event.type !== 'user.message' || event.payload.turnId !== turnId) continue;
      const text = event.payload.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text === '') return undefined;
      return text.length > UNDO_NOTE_PROMPT_MAX_LENGTH
        ? `${text.slice(0, UNDO_NOTE_PROMPT_MAX_LENGTH)}…`
        : text;
    }
    return undefined;
  }

  /**
   * 会话里完成、没被撤回的回合（`turn.finished` 的 `seq`），按先后——这些回合都还在引擎的历史里；`handoffSeq` 是最近一次接力
   * （`session.handoff`）的 `seq`，没有时 0。分支与撤回按它数引擎的回合（0.38.0）。
   *
   * 撤销（0.51.0，§3.22）不改引擎的历史，只让回合在消息记录里隐藏：`hidden` 是现在被撤销的回合，`redo` 是还能重做的（撤销的先后，
   * 最后一个先重做；会话一开始新回合，栈就清空，那些回合从此只是隐藏）。看得见的回合是 `turns` 去掉 `hidden`。
   */
  #finishedTurns(sessionId: SessionId): {
    turns: Array<{ turnId: TurnId; seq: number }>;
    handoffSeq: number;
    hidden: Set<TurnId>;
    redo: TurnId[];
  } {
    const turns: Array<{ turnId: TurnId; seq: number }> = [];
    const hidden = new Set<TurnId>();
    let redo: TurnId[] = [];
    let handoffSeq = 0;
    for (const event of this.#events.readSince(sessionId, 0)) {
      if (event.type === 'turn.finished')
        turns.push({ turnId: event.payload.turnId, seq: event.seq });
      else if (event.type === 'turn.rewound') {
        const index = turns.findIndex((turn) => turn.turnId === event.payload.turnId);
        if (index >= 0) turns.splice(index, 1);
        hidden.delete(event.payload.turnId);
        redo = redo.filter((turnId) => turnId !== event.payload.turnId);
      } else if (event.type === 'turn.undone') {
        hidden.add(event.payload.turnId);
        redo.push(event.payload.turnId);
      } else if (event.type === 'turn.redone') {
        hidden.delete(event.payload.turnId);
        redo = redo.filter((turnId) => turnId !== event.payload.turnId);
      } else if (event.type === 'turn.started') redo = [];
      else if (event.type === 'session.handoff') handoffSeq = event.seq;
    }
    return { turns, handoffSeq, hidden, redo };
  }

  /**
   * 分支要抄的消息记录（0.38.0，domain-model §3.18）：被分会话 `seq` 不超过 `untilSeq` 的事件里属于消息记录的那些。会话自己的事实
   * （`session.*`）、审批与提问（结算过的，属于原会话）、待发消息、原始帧与界面请求不抄。
   */
  #branchHistory(sessionId: SessionId, untilSeq: number): WevirEvent[] {
    return this.#events
      .readSince(sessionId, 0, untilSeq)
      .filter((event) => event.seq <= untilSeq && BRANCH_HISTORY_EVENTS.has(event.type));
  }

  /**
   * `approval.respond`，按会话串行，首个决定生效（domain-model §5）。提交到引擎期间暂扣该会话的引擎
   * 事件，引擎确认后先写 `approval.resolved`（带 `decidedBy`）、必要时 awaiting_approval→running，
   * 再处理暂扣的事件。审批已结算时返回 `ALREADY_DECIDED` 与既有决定；`optionId` 不在选项里返回
   * `INVALID_PARAMS`，审批不变。引擎回复失败当作引擎异常（#10），审批随之结为 `cancelled`，本次
   * 同样返回 `ALREADY_DECIDED`。
   */
  async respondToApproval(
    params: MethodParams<'approval.respond'>,
    decidedBy: ClientIdentity,
  ): Promise<MethodResult<'approval.respond'>> {
    this.#assertOpen();
    const { approvalId, optionId } = params;
    const found = this.#storage.approvals.get(approvalId);
    if (!found) throw new HostError('APPROVAL_NOT_FOUND', `approval ${approvalId} not found`);
    const runtime = this.#runtime(found.sessionId as SessionId, 'APPROVAL_NOT_FOUND');
    return this.#serial(runtime, async () => {
      const approval = this.#approvalRecord(approvalId);
      if (approval.status !== 'pending') throw alreadyDecided(approval);
      const option = (approval.options as ApprovalOption[]).find((o) => o.optionId === optionId);
      if (!option) throw invalidOption(approvalId, optionId);
      const requestId = runtime.requestIds.get(approvalId);
      if (requestId === undefined) throw new Error(`审批 ${approvalId} 没有对应的引擎请求`);

      const status: ResolvedApprovalStatus = option.category === 'allow' ? 'approved' : 'denied';
      const resolution: ApprovalResolution = { reason: 'user', optionId, decidedBy };
      let failure: { error: unknown } | undefined;
      runtime.holds += 1;
      try {
        try {
          if (!this.#appApprovals.has(requestId))
            await this.#adapter.respondToApproval(runtime.engineSessionId, requestId, { optionId });
        } catch (error) {
          failure = { error };
        }
        if (!failure) {
          const snapshot = this.#snapshot(runtime);
          const inputs: AppendInput[] = [resolved(approvalId, status, resolution)];
          if (
            snapshot.session.state === 'awaiting_approval' &&
            snapshot.pendingApprovals.every((pending) => pending.id === approvalId)
          ) {
            inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
          }
          this.#write(runtime, inputs);
        } else if (
          // approval_not_found：引擎侧已经结束了这个审批，它的 approval.cancelled 在暂扣的事件里。
          !isAdapterError(failure.error, 'invalid_option') &&
          !isAdapterError(failure.error, 'approval_not_found')
        ) {
          this.#engineFailed(runtime, engineErrorInfo(failure.error));
        }
      } finally {
        this.#release(runtime);
      }

      if (!failure) return { approvalId, status, resolution };
      if (isAdapterError(failure.error, 'invalid_option'))
        throw invalidOption(approvalId, optionId);
      const after = this.#approvalRecord(approvalId);
      if (after.status !== 'pending') throw alreadyDecided(after);
      throw new Error(`引擎报告审批 ${approvalId} 已不在未决状态，但没有上报结束事件`);
    });
  }

  /** 插件写工具必须由用户批准；引擎没问时补问，不让 full_access / 自动审查绕过全局配置确认。 */
  requestAppToolApproval(
    sessionId: SessionId,
    toolCallId: string,
    detail: ApprovalDetail,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.#assertOpen();
    const runtime = this.#runtime(sessionId);
    const turn = runtime.turn;
    const state = this.#snapshot(runtime).session.state;
    if (!turn || !['running', 'awaiting_approval'].includes(state) || signal.aborted)
      return Promise.resolve(false);
    const requestId = `app-${newId('apr')}`;
    turn.tools.set(toolCallId, {
      toolName: detail.toolName,
      display: detail.display,
      input: detail.input,
    });
    return new Promise<boolean>((resolve) => {
      const abort = () =>
        this.#dispatch(runtime, () =>
          this.#approvalCancelled(runtime, {
            type: 'approval.cancelled',
            engineSessionId: runtime.engineSessionId,
            requestId,
            reason: 'turn_cancelled',
          }),
        );
      this.#appApprovals.set(requestId, (approved) => {
        signal.removeEventListener('abort', abort);
        resolve(approved);
      });
      this.#approvalRequested(
        runtime,
        turn,
        {
          type: 'approval.requested',
          engineSessionId: runtime.engineSessionId,
          requestId,
          toolCallId,
          options: [
            { optionId: 'allow', label: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', label: 'Deny', kind: 'reject_once' },
          ],
        },
        'host',
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  /**
   * Host 优雅退出的“取消运行中的回合”一步（ADR-0002 §6）：之后到达的命令返回
   * `HOST_SHUTTING_DOWN`；每个会话排在已有命令之后，活动中的按 #5 取消，未决审批结为 `cancelled`
   * （`host_shutdown`，domain-model §5 第 5 条），等结算（#8）或判定无法确认（#9）；最后 `dispose()`。
   * 各会话并行，单个会话最多等 `cancelTimeoutMs`。不 `dispose` 适配器。可重复调用，返回同一个
   * Promise。
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= this.#runShutdown();
    return this.#shutdown;
  }

  async #runShutdown(): Promise<void> {
    this.#shuttingDown = true;
    await Promise.all(
      [...this.#runtimes.values()].map((runtime) =>
        this.#serial(runtime, () => this.#cancelTurn(runtime, 'host_shutdown')).catch(
          this.#onError,
        ),
      ),
    );
    await this.dispose();
  }

  /**
   * 停止消费引擎事件，之后不再写任何事件（不 `dispose` 适配器），等进行中的命令结束：还在等引擎的
   * 命令照常等适配器返回，然后以 `HOST_SHUTTING_DOWN` 失败。之后的调用同样返回
   * `HOST_SHUTTING_DOWN`。Host 优雅退出时用 `shutdown()`，它先取消回合再调用这里。
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#whenDisposed.resolve();
    for (const settle of this.#appApprovals.values()) settle(false);
    this.#appApprovals.clear();
    for (const timer of this.#questionTimers.values()) clearTimeout(timer);
    this.#questionTimers.clear();
    this.#appTools?.dispose?.();
    this.#recaps.clear();
    for (const runtime of this.#runtimes.values()) this.#detach(runtime);
    await Promise.all([...this.#runtimes.values()].map((runtime) => runtime.tail));
  }

  /**
   * 用会话的模型生成标题（prompts/README.md「会话标题」）：适配器发一次不带工具的请求，Host 解析并整理输出。成功、
   * 且这时标题仍是首条消息截断的那个（用户没有改过名）才写 `session.title_changed`（`generated`，带检索摘要）；
   * 失败或超时只记告警，保留截断的标题。不排进会话的命令队列，也不影响状态机。
   */
  #generateTitle(runtime: SessionRuntime, content: readonly UserContentPart[]): void {
    const instructions = this.#titleInstructions;
    const generate = this.#adapter.generateTitle?.bind(this.#adapter);
    if (instructions === undefined || generate === undefined) return;
    const prompt = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    if (prompt.trim() === '') return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
    const stop = () => abort.abort();
    void this.#whenDisposed.promise.then(stop);
    generate(runtime.engineSessionId, {
      instructions,
      input: titleInput(prompt),
      outputSchema: { ...TITLE_OUTPUT_SCHEMA },
      signal: abort.signal,
    })
      .then((output) => {
        if (this.#disposed || abort.signal.aborted) return;
        const generated = parseGeneratedTitle(output);
        if (generated === undefined) {
          this.#onWarning('生成的会话标题无法解析，保留截断的标题', {
            sessionId: runtime.id,
            output: output.slice(0, 500),
          });
          return;
        }
        // 等待期间用户可能改了名，或者标题已经不是这次截断的那个。
        const { session } = this.#snapshot(runtime);
        if (session.titleSource !== 'first_prompt') return;
        this.#write(runtime, [
          {
            type: 'session.title_changed',
            source: 'host',
            payload: {
              title: generated.title,
              source: 'generated',
              ...(generated.description !== undefined && { description: generated.description }),
            },
          },
        ]);
      })
      .catch((error: unknown) => {
        if (this.#disposed) return;
        this.#onWarning('生成会话标题失败，保留截断的标题', {
          sessionId: runtime.id,
          error: abort.signal.aborted ? `${TITLE_TIMEOUT_MS} ms 内没有结果` : errorText(error),
        });
      })
      .finally(() => clearTimeout(timer));
  }

  /** 中止还在生成的输入建议（它的结果已经没有用了）。 */
  #voidSuggestion(runtime: SessionRuntime): void {
    runtime.suggestion?.abort.abort();
    runtime.suggestion = undefined;
  }

  /**
   * 输入建议（0.53.0，domain-model §3.23）：回合 `turnId` 正常结束后，用会话的模型发一次不带工具的请求，预测用户接着会发的一句话，
   * 写 `suggestion.updated`。只在值得的时候生成——设置开着，会话是顶层的、不是支线、不是 agent 开的、空闲、不在计划模式、没有
   * 待审批 / 待回答 / 排着的消息，回合是用户的消息开的（不是命令、不是目标续跑）并且有回答——同一个回合只生成一次。等待期间
   * 用户发了消息、开始了新回合或回合被撤回，结果丢弃。失败、超时、解析不出来都只记告警：建议只是锦上添花，不影响会话。
   * 不排进会话的命令队列，也不影响状态机。
   */
  #suggest(runtime: SessionRuntime, turnId: TurnId): void {
    const options = this.#suggestion;
    const generate = this.#adapter.generateTitle?.bind(this.#adapter);
    if (options === undefined || generate === undefined || this.#disposed) return;
    if (runtime.parentId !== undefined || runtime.suggestion !== undefined) return;
    let input: string;
    try {
      if (!options.enabled()) return;
      const record = this.#record(runtime);
      if (record.side || record.origin?.kind === 'agent') return;
      const snapshot = this.#snapshot(runtime);
      const { session } = snapshot;
      if (
        session.state !== 'idle' ||
        session.activeTurn !== undefined ||
        session.readOnly !== undefined ||
        session.archivedAt !== undefined ||
        session.collaborationMode === 'plan' ||
        snapshot.pendingApprovals.length > 0 ||
        (snapshot.pendingQuestions?.length ?? 0) > 0 ||
        (snapshot.pendingMessages ?? []).some((pending) => pending.status === 'waiting')
      ) {
        return;
      }
      const events = this.#events.readSince(
        runtime.id,
        Math.max(0, session.lastSeq - SUGGESTION_EVENT_WINDOW),
      );
      // 命令开的回合（压缩、审查）与目标续跑不是用户在对话。
      const started = events.find(
        (event) => event.type === 'turn.started' && event.payload.turnId === turnId,
      );
      if (
        started?.type === 'turn.started' &&
        (started.payload.command !== undefined || started.payload.trigger === 'goal')
      ) {
        return;
      }
      const items = suggestionItems(events, turnId);
      if (items === undefined) return;
      input = suggestionInput(items);
    } catch (error) {
      // 会话在这期间被删了，等等：没有建议就是了。
      this.#onWarning('准备输入建议失败', { sessionId: runtime.id, error: errorText(error) });
      return;
    }
    const abort = new AbortController();
    const mine = { turnId, abort };
    runtime.suggestion = mine;
    const timer = setTimeout(() => abort.abort(), SUGGESTION_TIMEOUT_MS);
    void this.#whenDisposed.promise.then(() => abort.abort());
    generate(runtime.engineSessionId, {
      instructions: options.instructions,
      input,
      outputSchema: { ...SUGGESTION_OUTPUT_SCHEMA },
      signal: abort.signal,
    })
      .then((output) => {
        if (this.#disposed || abort.signal.aborted || runtime.suggestion !== mine) return;
        const text = parseSuggestion(output);
        if (text === undefined) return;
        this.#write(runtime, [
          { type: 'suggestion.updated', source: 'host', payload: { turnId, text } },
        ]);
      })
      .catch((error: unknown) => {
        if (this.#disposed || abort.signal.aborted) return;
        this.#onWarning('生成输入建议失败', { sessionId: runtime.id, error: errorText(error) });
      })
      .finally(() => {
        clearTimeout(timer);
        if (runtime.suggestion === mine) runtime.suggestion = undefined;
      });
  }

  /**
   * `session.recap`（0.54.0，domain-model §3.24）：用户回到离开过的会话时，客户端报告 `seenSeq`（离开时看到的最后一个事件）与
   * `awayMs`，这里判断要不要生成离开后摘要，要的话用会话的模型发一次不带工具的请求（适配器的 `generateTitle`，同会话标题）。
   * 不排进会话的命令队列、不写事件、不影响状态机；摘要只缓存在内存里，同一个位置（最后一个看得见的回合的结束事件）只生成
   * 一次，并发的请求共用同一次生成。不生成时回 `reason`；生成失败或超时静默，只记告警，回 `failed`。
   */
  async recap(params: MethodParams<'session.recap'>): Promise<MethodResult<'session.recap'>> {
    this.#assertOpen();
    const runtime = this.#runtime(params.sessionId);
    const skip = (reason: string): MethodResult<'session.recap'> => ({ reason });
    if (this.#recapEnabled?.() === false) return skip('disabled');
    const generate = this.#adapter.generateTitle?.bind(this.#adapter);
    const instructions = this.#recapInstructions;
    if (generate === undefined || instructions === undefined) return skip('unsupported');
    if (params.awayMs < SESSION_RECAP_MIN_AWAY_MS) return skip('too_short');
    if (runtime.parentId !== undefined || this.#record(runtime).side) return skip('sub_session');
    const { session } = this.#snapshot(runtime);
    if (session.state === 'running' || session.state === 'cancelling') return skip('running');
    if (session.state === 'awaiting_approval' || session.awaitingInput === true) {
      return skip('waiting');
    }
    if (session.state === 'closed' || runtime.attachment === undefined) return skip('detached');
    const analysis = analyzeSession(this.#events.readSince(runtime.id, 0));
    if (analysis.turns < RECAP_MIN_TURNS) return skip('few_turns');
    const marker = analysis.marker;
    if (marker === undefined || marker <= params.seenSeq) return skip('no_activity');
    const cached = this.#recaps.get(runtime.id, marker);
    if (cached !== undefined) return { recap: cached };
    const pending =
      this.#recaps.pending(runtime.id, marker) ??
      this.#recaps.track(
        runtime.id,
        marker,
        this.#generateRecap(runtime, marker, instructions, recapInput(analysis), generate),
      );
    const recap = await pending;
    return recap === undefined ? skip('failed') : { recap };
  }

  async #generateRecap(
    runtime: SessionRuntime,
    marker: number,
    instructions: string,
    input: string,
    generate: NonNullable<AgentRuntimeAdapter['generateTitle']>,
  ): Promise<SessionRecap | undefined> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RECAP_TIMEOUT_MS);
    const stop = () => abort.abort();
    void this.#whenDisposed.promise.then(stop);
    try {
      const output = await generate(runtime.engineSessionId, {
        instructions,
        input,
        outputSchema: { ...RECAP_OUTPUT_SCHEMA },
        signal: abort.signal,
      });
      if (this.#disposed || abort.signal.aborted) return undefined;
      const text = parseRecap(output);
      if (text === undefined) {
        this.#onWarning('生成的离开后摘要无法解析，不显示', {
          sessionId: runtime.id,
          output: output.slice(0, 500),
        });
        return undefined;
      }
      return { text, generatedAt: new Date().toISOString(), throughSeq: marker };
    } catch (error) {
      if (!this.#disposed) {
        this.#onWarning('生成离开后摘要失败', {
          sessionId: runtime.id,
          error: abort.signal.aborted ? `${RECAP_TIMEOUT_MS} ms 内没有结果` : errorText(error),
        });
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 命令的组成部分 ──────────────────────────────────────────────────

  /** `clientMessageId` 已有回执时：内容相同返回原结果，不同抛 `CLIENT_MESSAGE_CONFLICT`。 */
  #replay(
    runtime: SessionRuntime,
    clientMessageId: string | undefined,
    fingerprint: string,
  ): MethodResult<'session.send'> | undefined {
    if (clientMessageId === undefined) return undefined;
    const receipt = this.#storage.sendReceipts.get(runtime.id, clientMessageId);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint) {
      throw new HostError(
        'CLIENT_MESSAGE_CONFLICT',
        `clientMessageId ${clientMessageId} was used with a different request`,
        { clientMessageId },
      );
    }
    // 成为待发消息的发送（R11）：回执的 turnId 列放的是待发消息 ID。
    if (receipt.turnId.startsWith('pnd_')) {
      return { pendingId: receipt.turnId as PendingMessageId, seq: receipt.seq };
    }
    return { turnId: receipt.turnId as TurnId, seq: receipt.seq };
  }

  /**
   * send 前把尚未挂上的引擎会话挂上，成功写 `session.resumed`（状态仍是 idle）。工作区目录不在了返回
   * `WORKSPACE_PATH_INVALID`，状态不变；引擎失败时 idle→error（#11），返回 `ENGINE_ERROR`，引擎会话恢复不了时
   * 另写 `session.read_only`。
   */
  async #autoResume(runtime: SessionRuntime): Promise<void> {
    const record = this.#record(runtime);
    await assertDirectory(record.cwd);
    let engine: EngineSession;
    const rules = await this.#rulePlan(record.cwd, record.providerId);
    try {
      engine = await this.#adapter.resumeSession(
        runtime.engineSessionId,
        this.#engineConfig(runtime.id, sessionConfig(record), rules),
      );
      this.#attach(runtime);
    } catch (error) {
      const info = engineErrorInfo(error, 'session_unavailable');
      const snapshot = this.#snapshot(runtime);
      if (snapshot.session.state === 'idle') {
        this.#write(runtime, [
          engineError(info, true),
          stateChanged('idle', 'error', 'resume_failed'),
          ...readOnlyInputs(snapshot, error),
          ...settlePendings(snapshot, () => 'held'),
        ]);
      }
      throw new HostError('ENGINE_ERROR', info.message, info);
    }
    // 等待期间引擎可能已经报了退出（会话转 error），那时不再记恢复。
    if (this.#snapshot(runtime).session.state === 'idle') {
      const rulesInput = this.#rulesInput(runtime.id, rules, runtime.engineSessionId, {
        fresh: false,
      });
      this.#write(runtime, [
        resumedEvent(engine),
        ...(rulesInput === undefined ? [] : [rulesInput]),
      ]);
    }
  }

  /** #5，然后等结算（#8）或判定无法确认（#9）。不在活动状态时什么都不做。 */
  async #cancelTurn(
    runtime: SessionRuntime,
    reason: 'turn_cancelled' | 'session_closed' | 'host_shutdown',
    /** 用户单独停掉的子会话（0.14.0）：交给适配器，让它告诉父 agent。 */
    notifyParent = false,
  ): Promise<void> {
    const snapshot = this.#snapshot(runtime);
    const { state } = snapshot.session;
    if (state === 'running' || state === 'awaiting_approval') {
      this.#write(runtime, [
        ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason }),
        ...cancelQuestions(snapshot, reason),
        stateChanged(state, 'cancelling', 'cancel_requested'),
      ]);
    } else if (state !== 'cancelling') {
      return;
    }
    // 等到回合结算（turn.finished 写入，可能经由引擎退出等别的路径）为止。引擎报取消失败、超时，
    // 或者没有内存里的回合可等，都按无法确认处理。
    const turn = runtime.turn;
    const deadline = Date.now() + this.#cancelTimeoutMs;
    const finished = turn ? turn.finished.promise.then(() => 'finished' as const) : never();
    const disposed = this.#whenDisposed.promise.then(() => 'disposed' as const);
    const engine = this.#adapter
      .cancel(runtime.engineSessionId, notifyParent ? { notifyParent } : undefined)
      .then(
        () => (turn ? ('confirmed' as const) : ('failed' as const)),
        () => 'failed' as const,
      );
    let outcome = await settleBy(Promise.race([finished, engine, disposed]), deadline);
    // 适配器返回时终结事件已经发出，等 Host 处理完。
    if (outcome === 'confirmed')
      outcome = await settleBy(Promise.race([finished, disposed]), deadline);
    if (outcome === 'finished' || outcome === 'disposed' || runtime.turn !== turn) return;

    // #9
    const { session } = this.#snapshot(runtime);
    if (session.state !== 'cancelling') return;
    const turnId = session.activeTurn?.turnId;
    this.#detach(runtime);
    this.#write(runtime, [
      engineError(
        {
          category: 'cancel_unconfirmed',
          message: `engine did not confirm the cancellation within ${this.#cancelTimeoutMs} ms`,
        },
        true,
        turnId,
      ),
      ...(turnId !== undefined
        ? finishTurn(turnId, turn?.openTools ?? [], 'interrupted', this.#turnDuration(runtime))
        : []),
      stateChanged('cancelling', 'error', 'cancel_unconfirmed'),
      ...settlePendings(this.#snapshot(runtime), () => 'held'),
    ]);
  }

  // ── 引擎事件 ──────────────────────────────────────────────────────

  /** 订阅引擎会话的事件并开始消费。`subscribe` 同步抛出的错误交给调用方。 */
  #attach(runtime: SessionRuntime): void {
    const iterator = this.#adapter.subscribe(runtime.engineSessionId)[Symbol.asyncIterator]();
    const attachment: Attachment = { iterator, detached: false };
    runtime.attachment = attachment;
    void this.#consume(runtime, attachment);
  }

  /** Host 主动断开当前订阅：之后的事件丢弃，流结束不算中断。 */
  #detach(runtime: SessionRuntime): void {
    const attachment = runtime.attachment;
    if (!attachment) return;
    runtime.attachment = undefined;
    attachment.detached = true;
    attachment.iterator.return?.().catch(this.#onError);
  }

  async #consume(runtime: SessionRuntime, attachment: Attachment): Promise<void> {
    let failure: EngineErrorInfo;
    try {
      for (;;) {
        const result = await attachment.iterator.next();
        if (attachment.detached) return;
        if (result.done) break;
        const event = await (this.#appTools?.prepareEvent?.(runtime.id, result.value) ??
          result.value);
        if (attachment.detached) return;
        this.#dispatch(runtime, () => this.#handle(runtime, event));
        // engine.exited 是该会话订阅的最后一个事件。
        if (event.type === 'engine.exited') return;
      }
      failure = { category: 'unknown', message: 'engine event stream ended unexpectedly' };
    } catch (error) {
      if (attachment.detached) return;
      failure = { category: 'unknown', message: `engine event stream failed: ${errorText(error)}` };
    }
    this.#dispatch(runtime, () => {
      if (runtime.attachment === attachment) this.#engineFailed(runtime, failure);
    });
  }

  /** 审批提交期间先缓冲，否则立即处理。处理失败交给 `onError`。 */
  #dispatch(runtime: SessionRuntime, task: () => void): void {
    if (runtime.holds > 0) {
      runtime.held.push(task);
      return;
    }
    try {
      task();
    } catch (error) {
      this.#onError(error);
    }
  }

  /** 解除一层暂扣；全部解除后按到达顺序处理缓冲的事件。 */
  #release(runtime: SessionRuntime): void {
    runtime.holds -= 1;
    // dispose 之后不再写事件，暂扣的事件随之丢弃。
    if (this.#disposed) runtime.held.length = 0;
    while (runtime.holds === 0 && runtime.held.length > 0) {
      const task = runtime.held.shift() as () => void;
      try {
        task();
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** 把一个引擎事件写成 WevirEvent（domain-model §6、§9）。 */
  #handle(runtime: SessionRuntime, event: AgentEvent): void {
    const sessionId = runtime.id;
    switch (event.type) {
      case 'engine.exited':
        this.#engineFailed(runtime, exitInfo(event), { exited: true });
        return;
      case 'engine.raw':
        this.#write(runtime, [
          {
            type: 'engine.raw',
            source: 'engine',
            payload: {
              protocol: event.protocol,
              method: event.method,
              ...(event.kind !== undefined && { kind: event.kind }),
              ...(event.params !== undefined && { params: event.params }),
            },
          },
        ]);
        return;
      case 'usage.updated':
        this.#write(runtime, [
          {
            type: 'usage.updated',
            source: 'engine',
            payload: {
              contextUsed: event.contextUsed,
              contextSize: event.contextSize,
              ...(event.totalTokens !== undefined && { totalTokens: event.totalTokens }),
              ...(event.autoCompactAt !== undefined && { autoCompactAt: event.autoCompactAt }),
              ...(event.breakdown !== undefined && { breakdown: event.breakdown }),
            },
          },
        ]);
        this.#checkAutoCompaction(runtime, event);
        return;
      case 'usage.recorded': {
        if (this.#onUsage === undefined) return;
        const { providerId, modelId } = this.#snapshot(runtime).session;
        this.#onUsage({ sessionId, providerId, modelId }, event);
        return;
      }
      case 'subagent.started':
        this.#subagentStarted(runtime, event);
        return;
      case 'subagent.updated':
        this.#subagentUpdated(runtime, event);
        return;
      case 'turn.started':
        this.#engineTurnStarted(runtime, event);
        return;
      case 'goal.updated':
        this.#goalUpdated(runtime, event.goal);
        return;
    }

    // 其余事件都属于进行中的回合。
    const turn = runtime.turn;
    if (!turn) {
      // Host 已判定回合结束（取消超时、引擎异常、关闭）之后，引擎的残余事件是预期的。
      const { state } = this.#snapshot(runtime).session;
      if (state !== 'error' && state !== 'closed') {
        this.#onError(new Error(`会话 ${sessionId} 没有进行中的回合，丢弃引擎事件 ${event.type}`));
      }
      return;
    }
    const { turnId } = turn;
    switch (event.type) {
      case 'assistant.delta':
        this.#events.appendDelta(sessionId, {
          turnId,
          streamId: streamOf(turn, event.attemptId),
          blockIndex: event.blockIndex,
          kind: event.kind,
          text: event.text,
        });
        return;
      case 'assistant.stream_ended':
        this.#write(runtime, [
          {
            type: 'assistant.stream_ended',
            source: 'engine',
            payload: { turnId, streamId: streamOf(turn, event.attemptId), outcome: event.outcome },
          },
        ]);
        return;
      case 'assistant.message':
      case 'assistant.thought':
        this.#write(runtime, [
          {
            type: event.type,
            source: 'engine',
            payload: {
              turnId,
              messageId: event.messageId,
              text: event.text,
              replaces: blockRefs(turn, event.replaces),
            },
          },
        ]);
        return;
      case 'tool.started': {
        const info: ToolInfo = { toolName: event.toolName, display: event.display };
        if (event.input !== undefined) info.input = event.input;
        turn.tools.set(event.toolCallId, info);
        turn.openTools.add(event.toolCallId);
        this.#write(runtime, [
          {
            type: 'tool.started',
            source: 'engine',
            payload: { turnId, toolCallId: event.toolCallId, ...info },
          },
        ]);
        return;
      }
      case 'tool.updated': {
        // 审批详情取工具最新的展示与输入（Codex 在请求审批前补上命令的理由，codex-event-mapping.md §6.6）。
        const info = turn.tools.get(event.toolCallId);
        if (info) {
          if (event.display !== undefined) info.display = event.display;
          if (event.input !== undefined) info.input = event.input;
        }
        this.#write(runtime, [
          {
            type: 'tool.updated',
            source: 'engine',
            payload: {
              turnId,
              toolCallId: event.toolCallId,
              ...(event.display !== undefined && { display: event.display }),
              ...(event.input !== undefined && { input: event.input }),
              ...(event.output !== undefined && {
                output: { text: event.output, truncated: false },
              }),
            },
          },
        ]);
        return;
      }
      case 'tool.finished': {
        // 取消期间的 failed 记为 cancelled，原文保留（domain-model §6.4）。
        const cancelling = this.#snapshot(runtime).session.state === 'cancelling';
        turn.openTools.delete(event.toolCallId);
        this.#write(runtime, [
          {
            type: 'tool.finished',
            source: 'engine',
            payload: {
              turnId,
              toolCallId: event.toolCallId,
              status: event.status === 'failed' && cancelling ? 'cancelled' : event.status,
              ...(event.output !== undefined && {
                output: { text: event.output, truncated: false },
              }),
            },
          },
        ]);
        return;
      }
      case 'context.compacting':
      case 'context.compacted':
        this.#write(runtime, [
          {
            type: event.type,
            source: 'engine',
            payload: { turnId, compactionId: event.compactionId, trigger: event.trigger },
          },
        ]);
        if (event.type === 'context.compacted' && event.trigger === 'auto') {
          turn.autoCompaction = { pending: true, fruitless: turn.autoCompaction?.fruitless ?? 0 };
        }
        return;
      case 'todo.updated':
        this.#write(runtime, [
          {
            type: 'todo.updated',
            source: 'host',
            payload: { turnId, toolCallId: event.toolCallId, items: event.items },
          },
        ]);
        return;
      case 'plan.delta':
        // 计划的流式预览（0.37.0）：同助手增量，按窗口合并后写入。
        if (event.planId === '') return;
        this.#events.appendPlanDelta(sessionId, {
          turnId,
          planId: event.planId,
          text: event.text,
          ...(event.restart && { restart: true }),
        });
        return;
      case 'plan.proposed':
        if (event.text.trim() === '' || event.planId === '') {
          this.#onWarning('引擎的计划是空的，丢弃', { sessionId });
          return;
        }
        this.#write(runtime, [
          {
            type: 'plan.proposed',
            source: 'engine',
            payload: { turnId, planId: event.planId, text: event.text },
          },
        ]);
        return;
      case 'tasks.suggested': {
        const tasks = suggestedTasks(event.tasks, event.toolCallId, turnId);
        if (tasks.length === 0) {
          this.#onWarning('引擎的建议没有可用的任务（标题或说明为空），丢弃', { sessionId });
          return;
        }
        this.#write(runtime, [
          {
            type: 'tasks.suggested',
            source: 'host',
            payload: { toolCallId: event.toolCallId, turnId, tasks },
          },
        ]);
        return;
      }
      case 'approval.requested':
        this.#approvalRequested(runtime, turn, event);
        return;
      case 'approval.cancelled':
        this.#approvalCancelled(runtime, event);
        return;
      case 'question.requested':
        this.#questionRequested(runtime, turn, event);
        return;
      case 'question.cancelled':
        this.#questionCancelled(runtime, event);
        return;
      case 'turn.steered':
        this.#steered(runtime, turn, event);
        return;
      case 'turn.settled':
        this.#turnEnded(runtime, turn, event.outcome, event.stopReason);
        return;
      case 'turn.failed':
        this.#turnEnded(runtime, turn, 'failed', undefined, {
          category: event.category,
          message: event.message,
          ...(event.code !== undefined && { code: event.code }),
        });
        return;
    }
  }

  /**
   * 压缩不管用时停下回合：自动压缩之后的第一次用量仍不低于压缩线（`autoCompactAt`）时，引擎在下一个请求之后又会压缩，而再
   * 压缩也降不下来——上下文里压不掉的部分（工具与说明）已经到了压缩线，或模型服务回报的用量与实际不符。引擎不会自己停，
   * 回合一直压缩、每次都花额度（Codex 按 128k 登记 DeepSeek 时测到过）。连续 `FRUITLESS_AUTO_COMPACTIONS` 次这样，就写一条
   * 说明原因的 `engine.error`（不致命）并取消回合。引擎不报压缩线时不管。
   */
  #checkAutoCompaction(runtime: SessionRuntime, usage: UsageUpdatedEvent): void {
    const turn = runtime.turn;
    const compaction = turn?.autoCompaction;
    if (turn === undefined || compaction === undefined || !compaction.pending) return;
    compaction.pending = false;
    const { autoCompactAt, contextUsed, contextSize } = usage;
    if (autoCompactAt === undefined || contextUsed < autoCompactAt) {
      compaction.fruitless = 0;
      return;
    }
    compaction.fruitless += 1;
    if (compaction.fruitless < FRUITLESS_AUTO_COMPACTIONS) return;
    if (this.#shuttingDown || this.#disposed) return;
    const { state } = this.#snapshot(runtime).session;
    if (state !== 'running' && state !== 'awaiting_approval') return;
    this.#write(runtime, [
      engineError(
        {
          category: 'provider',
          message:
            `Stopped the turn: after ${compaction.fruitless} automatic context compactions in a row the model ` +
            `service still reported ${contextUsed} tokens in use, at or above the compaction threshold of ` +
            `${autoCompactAt} for a ${contextSize}-token context window, so compacting again would not help ` +
            `and every attempt costs tokens. If the model's context window is larger than ${contextSize}, ` +
            'set it in the model service settings; otherwise start a new session.',
        },
        false,
        turn.turnId,
      ),
    ]);
    this.cancel(runtime.id).catch(this.#onError);
  }

  /** #3：分配 ApprovalId，详情取自同一 toolCallId 的 `tool.started`。 */
  #approvalRequested(
    runtime: SessionRuntime,
    turn: TurnRuntime,
    event: ApprovalRequestedEvent,
    source: 'engine' | 'host' = 'engine',
  ): void {
    const { state } = this.#snapshot(runtime).session;
    const approvalId = newId('apr');
    const tool = turn.tools.get(event.toolCallId);
    const approval: ApprovalRequest = {
      id: approvalId,
      sessionId: runtime.id,
      turnId: turn.turnId,
      toolCallId: event.toolCallId,
      options: event.options.map((option) => ({
        optionId: option.optionId,
        label: option.label,
        kind: option.kind,
        category: option.kind.startsWith('allow_') ? 'allow' : 'reject',
      })),
      detail: tool ? approvalDetail(tool) : null,
      status: 'pending',
      createdAt: isoNow(),
    };
    runtime.approvalIds.set(event.requestId, approvalId);
    runtime.requestIds.set(approvalId, event.requestId);
    const inputs: AppendInput[] = [{ type: 'approval.requested', source, payload: { approval } }];
    if (state === 'running') {
      inputs.push(stateChanged('running', 'awaiting_approval', 'approval_requested'));
    } else if (state === 'cancelling') {
      // 取消已经开始：照记这次请求，并立即结掉；引擎侧由适配器的取消一并回复。
      inputs.push(resolved(approvalId, 'cancelled', { reason: 'turn_cancelled' }));
    }
    this.#write(runtime, inputs);
  }

  /**
   * 引擎侧结掉的审批。Host 已经结算过的（取消、关闭）不再重复。原因是引擎退出时不在这里结算：随后的
   * `engine.exited` 一并处理，会话从 awaiting_approval 直接转 error（#10），不经过 running。
   */
  #approvalCancelled(runtime: SessionRuntime, event: ApprovalCancelledEvent): void {
    if (event.reason === 'engine_exited') return;
    const approvalId = runtime.approvalIds.get(event.requestId);
    if (approvalId === undefined) return;
    const snapshot = this.#snapshot(runtime);
    if (!snapshot.pendingApprovals.some((pending) => pending.id === approvalId)) return;
    const inputs: AppendInput[] = [
      resolved(approvalId, 'cancelled', { reason: ENGINE_CANCEL_REASONS[event.reason] }),
    ];
    if (snapshot.session.state === 'awaiting_approval' && snapshot.pendingApprovals.length === 1) {
      inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
    }
    this.#write(runtime, inputs);
  }

  /** 引擎向用户提问（0.10.0）：分配 QuestionId，写 `question.requested`；取消已开始时随即结掉。 */
  #questionRequested(
    runtime: SessionRuntime,
    turn: TurnRuntime,
    event: QuestionRequestedEvent,
  ): void {
    const { session } = this.#snapshot(runtime);
    const questionId = newId('qst');
    const now = Date.now();
    const timeoutMs =
      this.#questionTimeoutMs > 0 && unattended(session) ? this.#questionTimeoutMs : undefined;
    const question: QuestionRequest = {
      id: questionId,
      sessionId: runtime.id,
      turnId: turn.turnId,
      ...(event.toolCallId !== undefined && { toolCallId: event.toolCallId }),
      questions: event.questions.map((item) => {
        const defaultOption = defaultOptionOf(item);
        return {
          ...item,
          options: item.options.map((option) => ({ ...option })),
          ...(defaultOption !== undefined && { defaultOption }),
        };
      }),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      ...(timeoutMs !== undefined && { autoAnswerAt: new Date(now + timeoutMs).toISOString() }),
    };
    runtime.questionIds.set(event.requestId, questionId);
    runtime.questionRequests.set(questionId, event.requestId);
    this.#questionSessions.set(questionId, runtime.id);
    const inputs: AppendInput[] = [
      { type: 'question.requested', source: 'engine', payload: { question } },
    ];
    if (session.state === 'cancelling') {
      inputs.push(questionResolved(questionId, 'cancelled', { reason: 'turn_cancelled' }));
    } else if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        this.#questionTimers.delete(questionId);
        this.#autoAnswer(runtime, questionId).catch(this.#onError);
      }, timeoutMs);
      timer.unref?.();
      this.#questionTimers.set(questionId, timer);
    }
    this.#write(runtime, inputs);
  }

  #clearQuestionTimer(questionId: QuestionId): void {
    const timer = this.#questionTimers.get(questionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#questionTimers.delete(questionId);
  }

  /**
   * 到了 `autoAnswerAt` 还没人回答（0.71.0）：按每题的 `defaultOption` 回答（没有选项的题跳过），写 `question.resolved`
   * （`answered`，`timeout`）。排在会话的命令队列里，在这之前回答了或取消了就什么都不做。
   */
  async #autoAnswer(runtime: SessionRuntime, questionId: QuestionId): Promise<void> {
    if (this.#shuttingDown || this.#disposed) return;
    await this.#serial(runtime, async () => {
      const question = this.#events.question(runtime.id, questionId);
      if (question?.status !== 'pending') return;
      const answers = Object.fromEntries(
        question.questions.map((item) => [
          item.id,
          item.defaultOption === undefined ? [] : [item.defaultOption],
        ]),
      );
      await this.#answerQuestion(runtime, questionId, answers, {
        reason: 'timeout',
        answers: toAnswerRecord(answers),
      });
    });
  }

  /** 引擎侧结掉的提问；引擎退出时不在这里结算，随后的 `engine.exited` 一并处理。 */
  #questionCancelled(runtime: SessionRuntime, event: QuestionCancelledEvent): void {
    if (event.reason === 'engine_exited') return;
    const questionId = runtime.questionIds.get(event.requestId);
    if (questionId === undefined) return;
    const pending = this.#snapshot(runtime).pendingQuestions ?? [];
    if (!pending.some((question) => question.id === questionId)) return;
    this.#write(runtime, [
      questionResolved(questionId, 'cancelled', { reason: ENGINE_CANCEL_REASONS[event.reason] }),
    ]);
  }

  /**
   * `question.respond`（0.10.0）：按会话串行，首个回答生效。回答按问题核对（问题要在这一组里，单选的最多一个回答，不允许
   * “其他”的只能选选项），交给引擎后写 `question.resolved`（`answered`）。已经结束的问题返回它的结局，不报错；引擎侧已经
   * 结束（`question_not_found`）时它的 `question.cancelled` 在暂扣的事件里，处理完返回那个结局。
   */
  async respondToQuestion(
    params: MethodParams<'question.respond'>,
    answeredBy: ClientIdentity,
  ): Promise<MethodResult<'question.respond'>> {
    this.#assertOpen();
    const { questionId } = params;
    const sessionId = this.#questionSessions.get(questionId);
    if (sessionId === undefined) {
      throw new HostError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
    }
    const runtime = this.#runtime(sessionId);
    return this.#serial(runtime, async () => {
      const outcome = () => {
        const question = this.#events.question(runtime.id, questionId);
        if (!question || question.status === 'pending' || !question.resolution) return undefined;
        return { questionId, status: question.status, resolution: question.resolution };
      };
      const done = outcome();
      if (done) return done;
      const question = this.#events.question(runtime.id, questionId);
      if (!question) throw new HostError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
      const answers = checkAnswers(question, params.answers);
      const resolution: QuestionResolution = {
        reason: 'user',
        answers: toAnswerRecord(answers),
        answeredBy,
      };
      if (await this.#answerQuestion(runtime, questionId, answers, resolution)) {
        return { questionId, status: 'answered' as const, resolution };
      }
      const after = outcome();
      if (after) return after;
      throw new Error(`引擎报告问题 ${questionId} 已结束，但没有上报结束事件`);
    });
  }

  /**
   * 把回答交给引擎，成功后写 `question.resolved`（`answered`）。引擎侧已经结束（`question_not_found`）时返回 false，它的
   * `question.cancelled` 在暂扣的事件里；别的失败当作引擎异常。要在会话的命令队列里调用。
   */
  async #answerQuestion(
    runtime: SessionRuntime,
    questionId: QuestionId,
    answers: Record<string, string[]>,
    resolution: QuestionResolution,
  ): Promise<boolean> {
    const requestId = runtime.questionRequests.get(questionId);
    if (requestId === undefined) throw new Error(`问题 ${questionId} 没有对应的引擎请求`);
    const respond = this.#adapter.respondToQuestion?.bind(this.#adapter);
    if (respond === undefined) throw new Error('引擎不支持提问，却提了问题');
    let failure: { error: unknown } | undefined;
    runtime.holds += 1;
    try {
      try {
        await respond(runtime.engineSessionId, requestId, answers);
      } catch (error) {
        failure = { error };
      }
      if (!failure) {
        this.#write(runtime, [questionResolved(questionId, 'answered', resolution)]);
      } else if (!isAdapterError(failure.error, 'question_not_found')) {
        this.#engineFailed(runtime, engineErrorInfo(failure.error));
      }
    } finally {
      this.#release(runtime);
    }
    return failure === undefined;
  }

  // ── 子会话（R4，domain-model §3.3.1、§4.5） ─────────────────────────────

  /**
   * 适配器在父会话的流里报出一个子 agent（C1、C5）。没见过的引擎会话：建子会话（父会话的工作区、cwd 与 Provider，模型取
   * 适配器报的），写它的 `session.created`（带 `parent`）与兜底标题，再写父会话的 `subagent.started`，然后订阅它、用会话
   * 的模型生成标题。见过的（引擎重启后父 agent 又用到它）：重新订阅，`closed` / `error` 时恢复。
   */
  #subagentStarted(parent: SessionRuntime, event: SubagentStartedEvent): void {
    const existing = this.#storage.sessions.getByEngineSessionId(
      this.#engine,
      event.childEngineSessionId,
    );
    if (existing !== undefined) {
      if (existing.parentSessionId !== parent.id) {
        this.#onError(
          new Error(
            `引擎会话 ${event.childEngineSessionId} 已属于会话 ${existing.id}，不能当作 ${parent.id} 的子会话`,
          ),
        );
        return;
      }
      this.#reattachChild(this.#runtime(existing.id as SessionId));
      return;
    }
    const parentRecord = this.#record(parent);
    const childId = newId('ses');
    const now = isoNow();
    const modelId = event.modelId ?? parentRecord.modelId;
    const reasoningEffort =
      event.reasoningEffort ??
      (event.modelId === undefined ? parentRecord.reasoningEffort : undefined);
    const parentTurnId = parent.turn?.turnId;
    const record: SessionRecord = {
      id: childId,
      workspaceId: parentRecord.workspaceId,
      cwd: parentRecord.cwd,
      engine: this.#engine,
      engineSessionId: event.childEngineSessionId,
      providerId: parentRecord.providerId,
      modelId,
      parentSessionId: parent.id,
      parentToolCallId: event.parentToolCallId,
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
    // 子 agent 沿用父会话当时的权限模式（Codex 的子 thread 继承父回合的审批与沙箱设置）。
    const permissionMode = this.#snapshot(parent).session.permissionMode;
    if (permissionMode !== undefined) record.permissionMode = permissionMode;
    this.#storage.sessions.insert(record);
    const child = this.#runtime(childId);
    const title = makeTitle([{ type: 'text', text: event.title }]);
    this.#write(child, [
      {
        type: 'session.created',
        source: 'host',
        payload: {
          workspaceId: parentRecord.workspaceId as WorkspaceId,
          cwd: parentRecord.cwd,
          providerId: parentRecord.providerId,
          modelId,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(permissionMode !== undefined && { permissionMode }),
          parent: {
            sessionId: parent.id,
            toolCallId: event.parentToolCallId,
            ...(parentTurnId !== undefined && { turnId: parentTurnId }),
          },
        },
      },
      ...(title === ''
        ? []
        : [
            {
              type: 'session.title_changed',
              source: 'host',
              payload: { title, source: 'first_prompt' },
            } satisfies AppendInput,
          ]),
    ]);
    const summary = this.#summary(childId, {
      parentToolCallId: event.parentToolCallId,
      ...(parentTurnId !== undefined && { parentTurnId }),
      ...(event.nickname !== undefined && { nickname: event.nickname }),
      ...(event.role !== undefined && { role: event.role }),
    });
    this.#write(parent, [
      { type: 'subagent.started', source: 'host', payload: { subagent: summary } },
    ]);
    try {
      this.#attach(child);
    } catch (error) {
      this.#engineFailed(child, engineErrorInfo(error));
      return;
    }
    if (event.prompt !== undefined)
      this.#generateTitle(child, [{ type: 'text', text: event.prompt }]);
  }

  /** 子会话又被报出：重新订阅；`closed` / `error` 时恢复（C5）。 */
  #reattachChild(child: SessionRuntime): void {
    if (!child.attachment) {
      try {
        this.#attach(child);
      } catch (error) {
        this.#onError(error);
        return;
      }
    }
    const { state } = this.#snapshot(child).session;
    if (state === 'closed' || state === 'error') {
      this.#write(child, [
        { type: 'session.resumed', source: 'host', payload: {} },
        stateChanged(state, 'idle', 'resumed'),
      ]);
    }
  }

  /**
   * 子 agent 晚到的信息：新的兜底标题（标题仍是兜底的才换）、昵称与角色（只在父会话的摘要里）；`closed` 是父 agent 关掉了
   * 它（C4）。
   */
  #subagentUpdated(parent: SessionRuntime, event: SubagentUpdatedEvent): void {
    const record = this.#storage.sessions.getByEngineSessionId(
      this.#engine,
      event.childEngineSessionId,
    );
    if (record === undefined || record.parentSessionId !== parent.id) {
      this.#onError(
        new Error(`会话 ${parent.id} 没有引擎会话为 ${event.childEngineSessionId} 的子会话`),
      );
      return;
    }
    const child = this.#runtime(record.id as SessionId);
    if (event.title !== undefined) {
      const title = makeTitle([{ type: 'text', text: event.title }]);
      const { session } = this.#snapshot(child);
      if (title !== '' && session.titleSource === 'first_prompt' && session.title !== title) {
        this.#write(child, [
          {
            type: 'session.title_changed',
            source: 'host',
            payload: { title, source: 'first_prompt' },
          },
        ]);
      }
    }
    if (event.nickname !== undefined || event.role !== undefined) {
      this.#mirror(child.id, parent.id, {
        ...(event.nickname !== undefined && { nickname: event.nickname }),
        ...(event.role !== undefined && { role: event.role }),
      });
    }
    if (event.closed) this.#closeChild(child);
  }

  /**
   * 父 agent 关掉了子会话（C4）：回合进行中时先结掉（未决审批 `session_closed`、未收尾工具 `unknown`、回合 `cancelled`），
   * 再转 `closed`。不断开订阅：父 agent 可能又用到它（C5）；引擎随后报的这个回合的结算没有回合可对，丢弃。
   */
  #closeChild(child: SessionRuntime): void {
    const snapshot = this.#snapshot(child);
    let { state } = snapshot.session;
    const { activeTurn } = snapshot.session;
    if (state === 'closed') return;
    const inputs: AppendInput[] = [];
    if (activeTurn) {
      inputs.push(
        ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason: 'session_closed' }),
        ...cancelQuestions(snapshot, 'session_closed'),
      );
      if (state === 'awaiting_approval') {
        inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
        state = 'running';
      }
      inputs.push(
        ...finishTurn(
          activeTurn.turnId,
          child.turn?.openTools ?? [],
          'cancelled',
          durationSince(activeTurn.startedAt),
        ),
        stateChanged(state, 'idle', 'turn_finished'),
      );
      state = 'idle';
    }
    inputs.push(stateChanged(state, 'closed', 'closed'));
    this.#write(child, inputs);
  }

  /**
   * 会话的目标变了（0.35.0）：与快照里的不同才写 `session.goal_changed`（引擎恢复会话时会再报一次当前的目标）。子会话没有目标。
   */
  #goalUpdated(runtime: SessionRuntime, goal: EngineGoal | null): void {
    if (runtime.parentId !== undefined) return;
    const next = goal === null ? undefined : toSessionGoal(goal);
    if (isDeepStrictEqual(this.#snapshot(runtime).session.goal, next)) return;
    this.#write(runtime, [
      { type: 'session.goal_changed', source: 'engine', payload: { goal: next ?? null } },
    ]);
  }

  /**
   * 普通会话的回合由引擎开始（0.35.0，目标进行中、会话空闲时引擎自己接着做）：会话 `idle` 时写 `turn.started`（带 `trigger`，没有
   * `user.message`）并转 `running`，不起标题。Host 这时已经开了自己的回合（消息交给引擎的路上引擎开了回合，引擎把消息并进了它）
   * 时丢掉，之后的事件归 Host 的回合。
   */
  #engineMainTurnStarted(runtime: SessionRuntime, event: TurnStartedEvent): void {
    if (runtime.turn) return;
    const { state } = this.#snapshot(runtime).session;
    if (state !== 'idle') {
      this.#onError(new Error(`会话 ${runtime.id} 是 ${state}，丢弃引擎开始的回合`));
      return;
    }
    const turnId = newId('trn');
    this.#write(runtime, [
      {
        type: 'turn.started',
        source: 'host',
        payload: { turnId, ...(event.trigger !== undefined && { trigger: event.trigger }) },
      },
      stateChanged('idle', 'running', 'turn_started'),
    ]);
    runtime.turn = {
      turnId,
      streams: new Map(),
      openTools: new Set(),
      tools: new Map(),
      finished: deferred(),
      addedWhileCancelling: new Set(),
    };
    // 回合前的快照（0.20.0）：引擎已经开始了，尽快打；不会抛错。
    const checkpointCwd = this.#checkpointCwd(runtime);
    if (checkpointCwd !== undefined) {
      void this.#checkpoints?.beforeTurn(runtime.id, checkpointCwd, turnId);
    }
  }

  /** 子会话的回合由引擎开始（C2）：`closed` / `error` 时先恢复（C5），再 `turn.started`（带输入）并转 `running`。 */
  #engineTurnStarted(child: SessionRuntime, event: TurnStartedEvent): void {
    if (child.parentId === undefined) {
      this.#engineMainTurnStarted(child, event);
      return;
    }
    if (child.turn) {
      this.#onError(
        new Error(`子会话 ${child.id} 的回合 ${child.turn.turnId} 尚未结束，丢弃引擎开始的回合`),
      );
      return;
    }
    const { state } = this.#snapshot(child).session;
    const inputs: AppendInput[] = [];
    if (state === 'closed' || state === 'error') {
      inputs.push(
        { type: 'session.resumed', source: 'host', payload: {} },
        stateChanged(state, 'idle', 'resumed'),
      );
    } else if (state !== 'idle') {
      this.#onError(new Error(`子会话 ${child.id} 是 ${state}，丢弃引擎开始的回合`));
      return;
    }
    const turnId = newId('trn');
    const input = event.input?.filter((part) => part.text !== '');
    inputs.push(
      {
        type: 'turn.started',
        source: 'host',
        payload: { turnId, ...(input !== undefined && input.length > 0 && { input }) },
      },
      stateChanged('idle', 'running', 'turn_started'),
    );
    this.#write(child, inputs);
    child.turn = {
      turnId,
      streams: new Map(),
      openTools: new Set(),
      tools: new Map(),
      finished: deferred(),
      addedWhileCancelling: new Set(),
    };
  }

  /**
   * 子会话的摘要变了就在父会话的流里写 `subagent.updated`（完整摘要）。父会话还没有这个子会话的摘要（`subagent.started`
   * 写下之前）时不写。`meta` 是适配器晚报的昵称与角色。
   */
  #mirror(
    childId: SessionId,
    parentId: SessionId | undefined,
    meta: Pick<SubagentSummary, 'nickname' | 'role'> = {},
  ): void {
    if (parentId === undefined || this.#disposed) return;
    const previous = this.#events
      .snapshot(parentId)
      ?.subagents?.find((summary) => summary.sessionId === childId);
    if (previous === undefined) return;
    const next = this.#summary(childId, { ...previous, ...meta });
    if (isDeepStrictEqual(next, previous)) return;
    this.#events.appendMany(parentId, [
      { type: 'subagent.updated', source: 'host', payload: { subagent: next } },
    ]);
  }

  /**
   * 建议开出来的会话回合结束（0.16.0，domain-model §3.11）：建议还是 `started`（这是它开始之后第一个结束的回合）时，在提出
   * 建议的会话里写 `task.reported`，并在那个会话的引擎会话挂着时补一条说明（`injectNote`）。失败只记下，不影响这个会话。
   */
  #reportTask(runtime: SessionRuntime, turnId: TurnId, outcome: TurnOutcome): void {
    try {
      const origin = this.#storage.sessions.get(runtime.id)?.origin;
      if (origin?.kind !== 'suggested_task' || origin.taskId === undefined) return;
      const parentId = origin.sessionId as SessionId;
      const taskId = origin.taskId as TaskId;
      const task = this.#events.suggestedTask(parentId, taskId);
      if (task?.status !== 'started' || task.sessionId !== runtime.id) return;
      const summary = this.#lastAnswer(runtime.id, turnId);
      this.#events.append(parentId, {
        type: 'task.reported',
        source: 'host',
        payload: {
          taskId,
          sessionId: runtime.id,
          outcome,
          ...(summary !== undefined && { summary }),
        },
      });
      const parent = this.#runtimes.get(parentId);
      if (parent?.attachment && !parent.attachment.detached && this.#adapter.injectNote) {
        this.#adapter
          .injectNote(parent.engineSessionId, taskReportNote(task, runtime.id, outcome, summary))
          .catch((error) =>
            this.#onWarning('任务会话的结果没能补进提出建议的会话', {
              sessionId: parentId,
              error: errorText(error),
            }),
          );
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  /** 一个回合最后一段回答的前 `TASK_SUMMARY_MAX_LENGTH` 字；没有回答时 `undefined`。 */
  #lastAnswer(sessionId: SessionId, turnId: TurnId): string | undefined {
    let text: string | undefined;
    for (const event of this.#events.readSince(sessionId, 0)) {
      if (event.type === 'assistant.message' && event.payload.turnId === turnId) {
        text = event.payload.text;
      }
    }
    const trimmed = text?.trim();
    if (!trimmed) return undefined;
    return trimmed.length > TASK_SUMMARY_MAX_LENGTH
      ? `${trimmed.slice(0, TASK_SUMMARY_MAX_LENGTH)}…`
      : trimmed;
  }

  /** 子会话的摘要：标题、模型、状态、起止时间与未决审批取自子会话的快照，其余取 `base`。 */
  #summary(
    childId: SessionId,
    base: Pick<SubagentSummary, 'parentToolCallId' | 'parentTurnId' | 'nickname' | 'role'>,
  ): SubagentSummary {
    const snapshot = this.#events.snapshot(childId);
    if (!snapshot) throw new Error(`会话 ${childId} 不存在`);
    const { session, pendingApprovals } = snapshot;
    const info = session.subagent;
    return {
      sessionId: childId,
      parentToolCallId: base.parentToolCallId,
      ...(base.parentTurnId !== undefined && { parentTurnId: base.parentTurnId }),
      title: session.title,
      modelId: session.modelId,
      ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
      ...(base.nickname !== undefined && { nickname: base.nickname }),
      ...(base.role !== undefined && { role: base.role }),
      status: info?.status ?? 'running',
      startedAt: info?.startedAt ?? session.createdAt,
      ...(info?.endedAt !== undefined && { endedAt: info.endedAt }),
      pendingApprovals,
    };
  }

  /**
   * 父会话被取消或关闭时级联取消子会话（domain-model §4.5：Codex 取消父回合时不动子 agent，ADR-0005 决策 6.1 要求取消
   * 父回合即取消它）：每个活动中的子会话（递归）排进它自己的命令队列按 #5 取消，等它们都结算。
   */
  async #cancelChildren(
    parent: SessionRuntime,
    reason: 'turn_cancelled' | 'host_shutdown',
  ): Promise<void> {
    const children = this.#storage.sessions.list({
      parentSessionId: parent.id,
      includeRemovedWorkspaces: true,
    });
    await Promise.all(
      children.map(async (record) => {
        const child = this.#runtime(record.id as SessionId);
        await Promise.all([
          this.#serial(child, () => this.#cancelTurn(child, reason)),
          this.#cancelChildren(child, reason),
        ]);
      }),
    );
  }

  /** 子会话由父 agent 驱动，客户端的 send、cancel、close、resume 都不接受（domain-model §3.3.1）。 */
  /**
   * 请求里的权限模式（0.11.0）：引擎声明了 `permissionModes` 时返回它（省略时是 `on_request`，写进会话）；引擎不支持时只
   * 接受省略或 `on_request`，返回 undefined（会话不带这个字段）。引擎不支持的值回 `INVALID_PARAMS`。
   */
  #permissionMode(requested: PermissionMode | undefined): PermissionMode | undefined {
    const supported = this.#adapter.permissionModes;
    const mode = requested ?? DEFAULT_PERMISSION_MODE;
    if (supported === undefined && mode === DEFAULT_PERMISSION_MODE) return undefined;
    if (supported?.includes(mode)) return mode;
    const message = `this host engine does not support permission mode ${mode}`;
    throw new HostError('INVALID_PARAMS', message, {
      issues: [{ path: ['permissionMode'], message }],
    });
  }

  #assertNotChild(runtime: SessionRuntime): void {
    if (runtime.parentId === undefined) return;
    throw new HostError(
      'INVALID_STATE',
      'session is a sub-agent session; it is driven by its parent agent',
      { state: this.#snapshot(runtime).session.state, parentSessionId: runtime.parentId },
    );
  }

  /**
   * 回合结算（#6、#7、#8）：回合失败先写 `engine.error`（`fatal: false`）；仍未决的审批结为
   * `cancelled`；未收尾的工具补 `unknown`；`turn.finished`；回到 `idle`。取消期间的失败记为
   * `cancelled`。
   */
  #turnEnded(
    runtime: SessionRuntime,
    turn: TurnRuntime,
    outcome: TurnOutcome,
    engineStopReason?: string,
    error?: EngineErrorInfo & { code?: number },
  ): void {
    const snapshot = this.#snapshot(runtime);
    let state = snapshot.session.state;
    const inputs: AppendInput[] = [];
    if (error) {
      inputs.push({
        type: 'engine.error',
        source: 'engine',
        payload: { ...error, turnId: turn.turnId, fatal: false },
      });
    }
    // 适配器本应先发 approval.cancelled（turn_ended）；没发的话由 Host 结掉。
    inputs.push(
      ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason: 'turn_cancelled' }),
      ...cancelQuestions(snapshot, 'turn_cancelled'),
    );
    if (state === 'awaiting_approval') {
      inputs.push(stateChanged('awaiting_approval', 'running', 'approvals_settled'));
      state = 'running';
    }
    const finalOutcome = outcome === 'failed' && state === 'cancelling' ? 'cancelled' : outcome;
    inputs.push(
      ...finishTurn(
        turn.turnId,
        turn.openTools,
        finalOutcome,
        this.#turnDuration(runtime),
        engineStopReason,
      ),
      stateChanged(state, 'idle', 'turn_finished'),
      // 待发消息（domain-model §4.6）：没插进去的插话改为排队；回合没完成就暂停（取消过程中加入的除外）。
      ...settlePendings(snapshot, (pending) =>
        finalOutcome === 'completed' || turn.addedWhileCancelling.has(pending.id)
          ? 'waiting'
          : 'held',
      ),
    );
    this.#write(runtime, inputs);
    // 还有等待中的排队消息：随后发出第一条，排在命令队列里。
    if (this.#snapshot(runtime).pendingMessages?.some((pending) => pending.status === 'waiting')) {
      void this.#scheduleDispatch(runtime);
    }
  }

  /**
   * 引擎不可用（#10）：进程退出、适配器调用失败、事件流中断。断开订阅；会话已是 `error` / `closed`
   * 时只断开。否则未决审批结为 `cancelled`（`engine_exited`）、有回合时补齐工具并以 `interrupted`
   * 结束、写 `engine.error`（`fatal: true`），转 `error`。不是进程退出时，再尽力让引擎停下可能还在
   * 跑的回合。
   */
  #engineFailed(
    runtime: SessionRuntime,
    info: EngineErrorInfo,
    options: { exited?: boolean } = {},
  ): void {
    this.#detach(runtime);
    const snapshot = this.#snapshot(runtime);
    const { state, activeTurn } = snapshot.session;
    if (state === 'error' || state === 'closed') return;
    const inputs = [
      ...resolveAll(snapshot.pendingApprovals, 'cancelled', { reason: 'engine_exited' }),
      ...cancelQuestions(snapshot, 'engine_exited'),
    ];
    if (activeTurn) {
      inputs.push(
        ...finishTurn(
          activeTurn.turnId,
          runtime.turn?.openTools ?? [],
          'interrupted',
          durationSince(activeTurn.startedAt),
        ),
      );
    }
    inputs.push(
      engineError(info, true, activeTurn?.turnId),
      stateChanged(state, 'error', 'engine_exited'),
      ...settlePendings(snapshot, () => 'held'),
    );
    this.#write(runtime, inputs);
    if (!options.exited) this.#adapter.cancel(runtime.engineSessionId).catch(() => {});
  }

  // ── 工具 ─────────────────────────────────────────────────────────

  /**
   * 写一批事件，并同步内存里的回合与审批映射：`turn.finished` 清掉进行中的回合，`approval.resolved`
   * 去掉 requestId 映射（之后引擎再报这个审批就忽略）。`dispose` 之后不再写。
   */
  #write(
    runtime: SessionRuntime,
    inputs: readonly AppendInput[],
    options?: Parameters<EventStore['appendMany']>[2],
  ) {
    // 不用 #assertOpen：shutdown() 期间取消回合、处理引擎事件仍要写。
    if (this.#disposed) throw new HostError('HOST_SHUTTING_DOWN', 'host is shutting down');
    const events = this.#events.appendMany(runtime.id, inputs, options);
    for (const event of events) {
      if (PROMPT_SUGGESTION_VOIDING_EVENTS.has(event.type)) this.#voidSuggestion(runtime);
      if (event.type === 'turn.finished') {
        const turn = runtime.turn;
        if (turn?.turnId === event.payload.turnId) {
          runtime.turn = undefined;
          turn.finished.resolve();
        }
        this.#reportTask(runtime, event.payload.turnId, event.payload.outcome);
        const onTurnFinished = this.#onTurnFinished;
        if (onTurnFinished !== undefined) {
          const info = {
            sessionId: runtime.id,
            turnId: event.payload.turnId,
            outcome: event.payload.outcome,
          };
          queueMicrotask(() => {
            try {
              onTurnFinished(info);
            } catch (error) {
              this.#onError(error);
            }
          });
        }
        const checkpointCwd = this.#checkpointCwd(runtime);
        if (checkpointCwd !== undefined) {
          this.#checkpoints?.afterTurn(runtime.id, checkpointCwd, event.payload.turnId);
        }
        if (event.payload.outcome === 'completed') {
          const { turnId } = event.payload;
          queueMicrotask(() => this.#suggest(runtime, turnId));
        }
      } else if (event.type === 'approval.resolved') {
        const requestId = runtime.requestIds.get(event.payload.approvalId);
        if (requestId !== undefined) {
          const approval = this.#approvalRecord(event.payload.approvalId);
          const approved =
            event.payload.status === 'approved' &&
            event.payload.resolution.reason === 'user' &&
            event.payload.resolution.decidedBy !== undefined;
          this.#appTools?.resolved?.(runtime.id, approval.toolCallId, approved);
          this.#appApprovals.get(requestId)?.(approved);
          this.#appApprovals.delete(requestId);
          runtime.requestIds.delete(event.payload.approvalId);
          runtime.approvalIds.delete(requestId);
        }
      } else if (event.type === 'question.resolved') {
        this.#clearQuestionTimer(event.payload.questionId);
        const requestId = runtime.questionRequests.get(event.payload.questionId);
        if (requestId !== undefined) {
          runtime.questionRequests.delete(event.payload.questionId);
          runtime.questionIds.delete(requestId);
        }
      }
    }
    // 子会话的标题、状态、审批变了：父会话的摘要跟着变。
    if (runtime.parentId !== undefined) this.#mirror(runtime.id, runtime.parentId);
    return events;
  }

  /** 排在该会话上一个命令之后执行。 */
  #serial<T>(runtime: SessionRuntime, command: () => Promise<T>): Promise<T> {
    const result = runtime.tail.then(command);
    runtime.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 会话的内存状态；会话不存在或所属工作区已移除时抛 `notFound`。 */
  #runtime(
    sessionId: SessionId,
    notFound: 'SESSION_NOT_FOUND' | 'APPROVAL_NOT_FOUND' = 'SESSION_NOT_FOUND',
  ): SessionRuntime {
    const record = this.#storage.sessions.get(sessionId);
    const workspace = record && this.#storage.workspaces.get(record.workspaceId);
    if (!record || !workspace || workspace.removedAt !== undefined) {
      throw notFound === 'SESSION_NOT_FOUND'
        ? new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`)
        : new HostError('APPROVAL_NOT_FOUND', `approval of session ${sessionId} not found`);
    }
    let runtime = this.#runtimes.get(sessionId);
    if (!runtime) {
      runtime = {
        id: sessionId,
        engineSessionId: record.engineSessionId,
        ...(record.parentSessionId !== undefined && {
          parentId: record.parentSessionId as SessionId,
        }),
        tail: Promise.resolve(),
        holds: 0,
        held: [],
        approvalIds: new Map(),
        requestIds: new Map(),
        questionIds: new Map(),
        questionRequests: new Map(),
      };
      this.#runtimes.set(sessionId, runtime);
    }
    return runtime;
  }

  #record(runtime: SessionRuntime): SessionRecord {
    const record = this.#storage.sessions.get(runtime.id);
    if (!record) throw new Error(`会话 ${runtime.id} 不存在`);
    return record;
  }

  #snapshot(runtime: SessionRuntime): SessionSnapshot {
    const snapshot = this.#events.snapshot(runtime.id);
    // 0.43.0：会话可能在排着的命令之前被删掉。
    if (!snapshot) throw new HostError('SESSION_NOT_FOUND', `session ${runtime.id} not found`);
    return snapshot;
  }

  #approvalRecord(approvalId: ApprovalId): ApprovalRecord {
    const record = this.#storage.approvals.get(approvalId);
    if (!record) throw new HostError('APPROVAL_NOT_FOUND', `approval ${approvalId} not found`);
    return record;
  }

  #turnDuration(runtime: SessionRuntime): number {
    const activeTurn = this.#snapshot(runtime).session.activeTurn;
    return activeTurn ? durationSince(activeTurn.startedAt) : 0;
  }

  /** 启动对账用：从事件里找出回合中已开始、未结束的工具调用。 */
  #openToolsFromEvents(sessionId: SessionId, turnId: TurnId): Set<string> {
    const open = new Set<string>();
    for (const event of this.#events.readSince(sessionId, 0)) {
      if (event.type === 'tool.started' && event.payload.turnId === turnId) {
        open.add(event.payload.toolCallId);
      } else if (event.type === 'tool.finished' && event.payload.turnId === turnId) {
        open.delete(event.payload.toolCallId);
      }
    }
    return open;
  }

  #assertOpen(): void {
    if (this.#shuttingDown || this.#disposed) {
      throw new HostError('HOST_SHUTTING_DOWN', 'host is shutting down');
    }
  }
}

// ── 事件构造 ─────────────────────────────────────────────────────────

function stateChanged(
  from: SessionState,
  to: SessionState,
  reason: StateChangeReason,
): AppendInput {
  return { type: 'session.state_changed', source: 'host', payload: { from, to, reason } };
}

function resolved(
  approvalId: ApprovalId,
  status: ResolvedApprovalStatus,
  resolution: ApprovalResolution,
): AppendInput {
  return { type: 'approval.resolved', source: 'host', payload: { approvalId, status, resolution } };
}

function resolveAll(
  pending: readonly ApprovalRequest[],
  status: ResolvedApprovalStatus,
  resolution: ApprovalResolution,
): AppendInput[] {
  return pending.map((approval) => resolved(approval.id, status, resolution));
}

function questionResolved(
  questionId: QuestionId,
  status: 'answered' | 'cancelled',
  resolution: QuestionResolution,
): AppendInput {
  return { type: 'question.resolved', source: 'host', payload: { questionId, status, resolution } };
}

function toAnswerRecord(answers: Record<string, string[]>): QuestionResolution['answers'] {
  return Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, { answers: list }]));
}

/** 没人盯着回答提问的会话（0.71.0）：自动化开的、引擎派出的子会话、另一个会话里的 agent 开的。 */
function unattended(session: Session): boolean {
  return (
    session.automation !== undefined ||
    session.parentSessionId !== undefined ||
    session.openedBy !== undefined
  );
}

/** 标签末尾的“(Recommended)”“（推荐）”一类标记：Claude 与 Codex 的提问工具都让模型这样标出推荐的选项。 */
const RECOMMENDED_LABEL = /[(（]\s*(?:recommended|推荐|建议)\s*[)）]\s*$/i;

/** 推荐的选项（0.71.0）：引擎给的、标签标了推荐的，或第一个；没有选项时没有。 */
export function defaultOptionOf(question: UserQuestion): string | undefined {
  const labels = question.options.map((option) => option.label);
  if (question.defaultOption !== undefined && labels.includes(question.defaultOption)) {
    return question.defaultOption;
  }
  return labels.find((label) => RECOMMENDED_LABEL.test(label)) ?? labels[0];
}

/** 未答的问题随回合、会话、引擎或 Host 一起取消（原因同审批）。 */
function cancelQuestions(
  snapshot: SessionSnapshot,
  reason: QuestionResolution['reason'],
): AppendInput[] {
  return (snapshot.pendingQuestions ?? []).map((question) =>
    questionResolved(question.id, 'cancelled', { reason }),
  );
}

/**
 * 核对回答：问题要在这一组里；单选的最多一个回答；不允许“其他”的回答只能是选项的 `label`。没回答的问题当作跳过（空数组）。
 */
function checkAnswers(
  question: QuestionRequest,
  answers: Record<string, { answers: string[] }>,
): Record<string, string[]> {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const result: Record<string, string[]> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const item = question.questions.find((candidate) => candidate.id === id);
    if (!item) {
      issues.push({ path: ['answers', id], message: `question ${id} is not in this request` });
      continue;
    }
    if (!item.multiSelect && answer.answers.length > 1) {
      issues.push({ path: ['answers', id, 'answers'], message: 'single-select question' });
    }
    if (!item.allowOther) {
      const labels = new Set(item.options.map((option) => option.label));
      answer.answers.forEach((value, index) => {
        if (!labels.has(value)) {
          issues.push({
            path: ['answers', id, 'answers', index],
            message: 'not one of the options',
          });
        }
      });
    }
    result[id] = answer.answers;
  }
  if (issues.length > 0) throw new HostError('INVALID_PARAMS', 'invalid answers', { issues });
  for (const item of question.questions) result[item.id] ??= [];
  return result;
}

function engineError(
  info: EngineErrorInfo & { code?: number },
  fatal: boolean,
  turnId?: TurnId,
): AppendInput {
  return {
    type: 'engine.error',
    source: 'host',
    payload: { ...info, fatal, ...(turnId !== undefined && { turnId }) },
  };
}

function resumedEvent(engine: EngineSession): AppendInput {
  return {
    type: 'session.resumed',
    source: 'host',
    payload: engine.engineVersion === undefined ? {} : { engineVersion: engine.engineVersion },
  };
}

/**
 * 引擎报 `session_lost` 时的 `session.read_only`。已经因同一原因只读的不再重复写。写在会话转入 `error` 之后，
 * 或会话已是 `error` / `closed` 时。
 */
function readOnlyInputs(snapshot: SessionSnapshot, error: unknown): AppendInput[] {
  if (!isAdapterError(error, 'session_lost') || error.lostReason === undefined) return [];
  const reason = READ_ONLY_REASONS[error.lostReason];
  if (snapshot.session.readOnly?.reason === reason) return [];
  return [
    {
      type: 'session.read_only',
      source: 'host',
      payload: { reason, message: error.message },
    },
  ];
}

function pendingUpdated(pending: PendingMessage): AppendInput {
  return { type: 'pending.updated', source: 'host', payload: { pending } };
}

/**
 * 回合结束或会话出错、关闭、Host 重启时的待发消息（domain-model §4.6）：等待中的插话（交出去还没插进去）改为排队
 * （`turn_ended`）；每条等待中的按 `status` 留在等待或暂停。没有变化的不写。
 */
function settlePendings(
  snapshot: SessionSnapshot,
  status: (pending: PendingMessage) => 'waiting' | 'held',
): AppendInput[] {
  const now = isoNow();
  return (snapshot.pendingMessages ?? []).flatMap((pending) => {
    if (pending.status !== 'waiting') return [];
    const next: PendingMessage = { ...pending, status: status(pending) };
    if (pending.delivery === 'steer') {
      next.delivery = 'queue';
      next.fallback = { reason: 'turn_ended' };
    }
    if (isDeepStrictEqual(next, pending)) return [];
    return [pendingUpdated({ ...next, updatedAt: now })];
  });
}

function isTerminalPending(pending: PendingMessage): boolean {
  return TERMINAL_PENDING_STATUSES.includes(pending.status);
}

function notEditable(pending: PendingMessage): HostError<'PENDING_NOT_EDITABLE'> {
  return new HostError(
    'PENDING_NOT_EDITABLE',
    pending.status === 'waiting' && pending.delivery === 'steer'
      ? 'the steer has been handed to the engine and cannot be changed'
      : `pending message is ${pending.status}`,
    { pendingId: pending.id, status: pending.status, delivery: pending.delivery },
  );
}

/** 结束回合：未收尾的工具补 `tool.finished`（`unknown`，domain-model §6.4），再 `turn.finished`。 */
function finishTurn(
  turnId: TurnId,
  openTools: Iterable<string>,
  outcome: TurnOutcome,
  durationMs: number,
  engineStopReason?: string,
): AppendInput[] {
  const inputs: AppendInput[] = [...openTools].map((toolCallId) => ({
    type: 'tool.finished',
    source: 'host',
    payload: { turnId, toolCallId, status: 'unknown' },
  }));
  inputs.push({
    type: 'turn.finished',
    source: 'host',
    payload: {
      turnId,
      outcome,
      durationMs,
      ...(engineStopReason !== undefined && { engineStopReason }),
    },
  });
  return inputs;
}

// ── 小工具 ───────────────────────────────────────────────────────────

/** 引擎的目标 → 协议的 `SessionGoal`（0.35.0）。 */
function toSessionGoal(goal: EngineGoal): SessionGoal {
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.tokenBudget !== undefined && { tokenBudget: goal.tokenBudget }),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    updatedAt: goal.updatedAt,
  };
}

function assertSendable(snapshot: SessionSnapshot): void {
  const { state, activeTurn } = snapshot.session;
  if (ACTIVE_STATES.includes(state)) {
    throw new HostError('SESSION_BUSY', 'session is busy', {
      state,
      ...(activeTurn !== undefined && { activeTurn }),
    });
  }
  const { readOnly } = snapshot.session;
  if (readOnly !== undefined) {
    throw new HostError(
      'INVALID_STATE',
      `session is read-only (${readOnly.reason}): its engine session cannot be resumed; start a new session from its history`,
      { state, readOnly },
    );
  }
  if (state !== 'idle') {
    throw new HostError('INVALID_STATE', `session is ${state}; resume it first`, { state });
  }
}

function alreadyDecided(approval: ApprovalRecord): HostError<'ALREADY_DECIDED'> {
  return new HostError('ALREADY_DECIDED', 'approval already decided', {
    approvalId: approval.id as ApprovalId,
    status: approval.status as ResolvedApprovalStatus,
    resolution: approval.resolution as ApprovalResolution,
  });
}

/** `task.reported` 的 `summary` 最多多少字（domain-model §3.11）。 */
const TASK_SUMMARY_MAX_LENGTH = 2000;
const TASK_TITLE_MAX_LENGTH = 200;
const TASK_PROMPT_MAX_LENGTH = 8000;

/** 引擎报的建议 → `SuggestedTask`：分配 ID，去掉标题或说明为空的，超长的截断。 */
function suggestedTasks(
  tasks: ReadonlyArray<{ title: string; prompt: string; reason?: string }>,
  toolCallId: string,
  turnId: TurnId,
): SuggestedTask[] {
  return tasks.flatMap((task) => {
    const title = task.title.trim().slice(0, TASK_TITLE_MAX_LENGTH);
    const prompt = task.prompt.trim().slice(0, TASK_PROMPT_MAX_LENGTH);
    if (title === '' || prompt === '') return [];
    const reason = task.reason?.trim();
    return [
      {
        id: newId('tsk'),
        title,
        prompt,
        ...(reason && { reason }),
        toolCallId,
        turnId,
        status: 'suggested' as const,
      },
    ];
  });
}

/** 补进提出建议的会话的说明（`injectNote`）：模型下一次请求时看得到任务的结果。 */
export function taskReportNote(
  task: Pick<SuggestedTask, 'title'>,
  sessionId: SessionId,
  outcome: TurnOutcome,
  summary: string | undefined,
): string {
  const lines = [
    `The user started the follow-up task you suggested, "${task.title}", as a separate session (${sessionId}). Its first turn ended: ${outcome}.`,
  ];
  lines.push(summary === undefined ? 'It gave no final answer.' : `Its final answer:\n${summary}`);
  lines.push('This is for your information; do not redo that task here unless the user asks.');
  return lines.join('\n\n');
}

/** 撤销 / 重做的说明里引用用户消息的字数上限。 */
const UNDO_NOTE_PROMPT_MAX_LENGTH = 300;

/**
 * 撤销或重做之后补进引擎上下文的说明（`injectNote`，0.51.0）：引擎的历史里还有这个回合，要告诉模型它的文件改动现在是什么状态。
 * 文件没能还原（`files.status` 是 `unavailable`）时明说，让模型别当作已还原。
 */
export function undoRedoNote(
  kind: 'undo' | 'redo',
  prompt: string | undefined,
  files: FilesRestore,
): string {
  const turn =
    prompt === undefined ? 'one of your earlier turns' : `your earlier turn for "${prompt}"`;
  const count = files.fileCount ?? 0;
  const lines: string[] = [];
  if (kind === 'undo') {
    lines.push(`The user undid ${turn}. Treat that turn as if it had not happened.`);
    if (files.status === 'restored') {
      lines.push(
        `Its file changes were reverted automatically (${count} file${count === 1 ? '' : 's'}); the working directory is back to how it was before that turn.`,
      );
    } else if (files.status === 'unchanged') {
      lines.push(
        'The working directory already matched its state before that turn, so nothing needed reverting.',
      );
    } else {
      lines.push(
        'Its file changes could NOT be reverted automatically; check the files before relying on them.',
      );
    }
  } else {
    lines.push(`The user redid ${turn}, which they had undone before. It counts again.`);
    if (files.status === 'restored') {
      lines.push(
        `Its file changes were restored (${count} file${count === 1 ? '' : 's'}); the working directory is back to how it was after that turn.`,
      );
    } else if (files.status === 'unchanged') {
      lines.push('The working directory already matched its state after that turn.');
    } else {
      lines.push(
        'Its file changes could NOT be restored automatically; check the files before relying on them.',
      );
    }
  }
  return lines.join('\n\n');
}

function invalidOption(approvalId: ApprovalId, optionId: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', `option ${optionId} is not offered by ${approvalId}`, {
    issues: [{ path: ['optionId'], message: `not one of the approval's options: ${optionId}` }],
  });
}

/** 工作区目录必须还在（domain-model §3.1：目录被移动或删除后建会话会失败）。 */
async function assertDirectory(path: string): Promise<void> {
  let reason: 'not_found' | 'not_directory' | 'not_accessible' | undefined;
  try {
    if (!(await stat(path)).isDirectory()) reason = 'not_directory';
  } catch (error) {
    reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'not_accessible';
  }
  if (reason) {
    throw new HostError('WORKSPACE_PATH_INVALID', `workspace path is unusable: ${path}`, {
      path,
      reason,
    });
  }
}

function sessionConfig(record: SessionRecord): SessionConfig {
  const config: SessionConfig = {
    cwd: record.cwd,
    providerId: record.providerId,
    modelId: record.modelId,
  };
  if (record.reasoningEffort !== undefined) config.reasoningEffort = record.reasoningEffort;
  if (record.permissionMode !== undefined) {
    config.permissionMode = record.permissionMode as PermissionMode;
  }
  if (record.extraRoots !== undefined) config.additionalRoots = record.extraRoots;
  return config;
}

/** 适配器错误 → `engine.error` 的归类与原文。 */
function engineErrorInfo(
  error: unknown,
  fallback: EngineErrorCategory = 'unknown',
): EngineErrorInfo {
  const message = errorText(error);
  if (isAdapterError(error)) {
    switch (error.code) {
      case 'session_not_found':
      case 'session_closed':
      case 'session_unavailable':
      case 'session_lost':
        return { category: 'session_unavailable', message };
      case 'cancel_unconfirmed':
        return { category: 'cancel_unconfirmed', message };
      case 'missing_credentials':
        return { category: 'missing_credentials', message };
    }
  }
  return { category: fallback, message };
}

function exitInfo(event: Extract<AgentEvent, { type: 'engine.exited' }>): EngineErrorInfo {
  if (event.reason === 'config_changed') {
    return {
      category: 'engine_exited',
      message: 'engine restarted to apply provider changes; resume the session to continue',
    };
  }
  if (event.reason === 'cancel_unconfirmed') {
    return {
      category: 'engine_exited',
      message:
        'engine restarted because a cancellation could not be confirmed; resume the session to continue',
    };
  }
  const how = event.signal !== null ? `signal ${event.signal}` : `code ${event.exitCode}`;
  const tail = event.stderrTail ? `\n${event.stderrTail}` : '';
  return { category: 'engine_exited', message: `engine exited with ${how}${tail}` };
}

function invalidContent(path: Array<string | number>, message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeTitle(content: readonly UserContentPart[]): string {
  const text = content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, TITLE_MAX_LENGTH).join('');
}

function approvalDetail(tool: ToolInfo): ApprovalDetail {
  const detail: ApprovalDetail = { toolName: tool.toolName, display: tool.display };
  const { input } = tool;
  if (input === undefined) return detail;
  detail.input = input;
  if (input !== null && typeof input === 'object') {
    const { justification, sandbox_permissions: sandboxPermissions } = input as Record<
      string,
      unknown
    >;
    if (typeof justification === 'string') detail.justification = justification;
    if (typeof sandboxPermissions === 'string') detail.sandboxPermissions = sandboxPermissions;
  }
  return detail;
}

function streamOf(turn: TurnRuntime, attemptId: string): StreamId {
  let streamId = turn.streams.get(attemptId);
  if (!streamId) {
    streamId = newId('stm');
    turn.streams.set(attemptId, streamId);
  }
  return streamId;
}

/** 引擎的增量块引用换成 StreamId；对不上的（没见过的 attempt）丢掉。 */
function blockRefs(turn: TurnRuntime, refs: readonly DeltaBlockRef[]): StreamBlockRef[] {
  const result: StreamBlockRef[] = [];
  for (const ref of refs) {
    const streamId = turn.streams.get(ref.attemptId);
    if (streamId) result.push({ streamId, blockIndex: ref.blockIndex });
  }
  return result;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 在 `deadline`（`Date.now()` 毫秒）之前等到 `promise` 的结果，超时为 `'timeout'`。 */
async function settleBy<T>(promise: Promise<T>, deadline: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function never(): Promise<never> {
  return new Promise(() => {});
}

function durationSince(startedAt: string): number {
  return Math.max(0, Date.now() - Date.parse(startedAt));
}

function isoNow(): string {
  return new Date().toISOString();
}

/** 环境会话准备好的目录（#prepareEnvironment）。 */
interface PreparedEnvironment {
  environmentId?: EnvironmentId;
  cwd: string;
  extraRoots: string[];
  worktrees: SessionWorktree[];
  /** 会话没建成时撤回已建的 worktree。 */
  undo: () => Promise<void>;
}
