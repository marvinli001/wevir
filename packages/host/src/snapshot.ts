import type {
  ActiveTurn,
  ApprovalRequest,
  EngineErrorInfo,
  IsoTime,
  PendingMessage,
  PendingMessageId,
  PendingStatus,
  PermissionMode,
  QuestionId,
  QuestionRequest,
  Session,
  SessionId,
  SessionReadOnly,
  SessionSnapshot,
  SessionState,
  StateChangeReason,
  SubagentInfo,
  SubagentStatus,
  SubagentSummary,
  TitleSource,
  TodoItem,
  TurnId,
  TurnOutcome,
  Usage,
  WevirEvent,
  WorkspaceId,
} from '@wevir/protocol';
import type { SessionCachePatch, SessionRecord } from '@wevir/storage';

// 会话快照：由事件序列推导出的产品状态（domain-model §3.3、§4；ADR-0002 §3）。`applyEvent` 是纯函数，
// 事件库在追加事件时逐条推进，Host 重启后从头重放得到同样的结果。

/** 由事件推导的会话状态。对象不可变：`applyEvent` 返回新对象，旧对象照常可用。 */
export interface SessionProjection {
  /** 已应用的最后一个事件的 `seq`；还没有事件时为 0。 */
  readonly lastSeq: number;
  /** 最后一个事件的 `ts`。 */
  readonly updatedAt?: IsoTime;
  readonly state: SessionState;
  readonly title: string;
  readonly titleSource: TitleSource;
  /**
   * 最近一次 `session.configured`（0.9.0）带来的模型、推理档位与权限模式（0.11.0）；没有时用 `sessions` 表里建会话时的值。
   */
  readonly model?: {
    readonly modelId: string;
    readonly reasoningEffort?: string;
    readonly permissionMode?: PermissionMode;
  };
  readonly activeTurn?: ActiveTurn;
  readonly lastError?: EngineErrorInfo;
  /** 引擎会话恢复不了（T3.5）：`session.read_only` 设置，`session.resumed` 清除。 */
  readonly readOnly?: SessionReadOnly;
  /** 仍是 `pending` 的审批，按请求先后排列。 */
  readonly pendingApprovals: readonly ApprovalRequest[];
  /** 最近一次 `todo.updated`。 */
  readonly todos?: readonly TodoItem[];
  /** 最近一次 `usage.updated`。 */
  readonly usage?: Usage;
  /** 最近一条 `user.message`；同一回合的 `turn.started` 从这里取 `clientMessageId`。 */
  readonly lastUserMessage?: { readonly turnId: TurnId; readonly clientMessageId?: string };
  /** 子会话（R4，domain-model §3.3.1）：`session.created.parent` 设置，状态由子会话自己的事件推导。 */
  readonly subagent?: SubagentInfo;
  /** 这个会话派出的子会话的摘要（`subagent.started` 追加，`subagent.updated` 替换），按派出的先后。 */
  readonly subagents: readonly SubagentSummary[];
  /**
   * 待发消息（R11，domain-model §3.3.2）：`pending.added` 加入、`pending.updated` 替换，含已到终态的（再取消是无操作、再编辑
   * 报 `PENDING_NOT_EDITABLE` 要用到），按加入的先后。快照只给未到终态的。
   */
  readonly pendings: ReadonlyMap<PendingMessageId, PendingMessage>;
  /**
   * 引擎向用户提的问题（0.10.0）：`question.requested` 加入，`question.resolved` 写上结局，含已结束的（再回答要返回它的
   * 结局），按提出的先后。快照只给未结束的。
   */
  readonly questions: ReadonlyMap<QuestionId, QuestionRequest>;
}

/** 未结束（等回答）的问题，按提出的先后。 */
export function openQuestions(projection: SessionProjection): QuestionRequest[] {
  return [...projection.questions.values()].filter((question) => question.status === 'pending');
}

/** 待发消息的终态：插入、发出、取消之后不再变化。 */
export const TERMINAL_PENDING_STATUSES: readonly PendingStatus[] = [
  'inserted',
  'sent',
  'cancelled',
];

/** 未到终态（等待、暂停）的待发消息，按加入的先后。 */
export function openPendings(projection: SessionProjection): PendingMessage[] {
  return [...projection.pendings.values()].filter(
    (pending) => !TERMINAL_PENDING_STATUSES.includes(pending.status),
  );
}

/** 还没有任何事件时的状态。`session.created` 不改变它（建会话后的初始状态隐含为 `idle`）。 */
export const INITIAL_PROJECTION: SessionProjection = {
  lastSeq: 0,
  state: 'idle',
  title: '',
  titleSource: 'first_prompt',
  pendingApprovals: [],
  subagents: [],
  pendings: new Map(),
  questions: new Map(),
};

/** 子会话的回合结果 → 子会话的状态（domain-model §3.3.1）。 */
const SUBAGENT_STATUS_OF_OUTCOME: Record<TurnOutcome, SubagentStatus> = {
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
  interrupted: 'failed',
};

/**
 * 应用一条事件。只读状态、不做校验：库里已有的事件都是事实，重放时照单全收；不认识的 `type`
 * （更新版本写入的事件）只推进 `lastSeq` 与 `updatedAt`。写入前的校验见 `checkEvent`。
 *
 * - `lastError`：每条 `engine.error` 都会覆盖它（含回合失败这类不改变状态的错误）；回合开始
 *   （`turn_started`）或恢复（`resumed`）时清空。
 * - `activeTurn`：`turn.started` 设置，`turn.finished` 清空。
 * - `readOnly`：`session.read_only` 设置（`since` 取事件的 `ts`），`session.resumed` 清空。
 * - `subagent`（子会话，domain-model §3.3.1）：`session.created` 的 `parent` 设置（`running`）；`turn.started` →
 *   `running`；`turn.finished` 按结果；转 `closed` → `closed`；还在 `running` 时转 `error` → `failed`。
 * - `subagents`（父会话）：`subagent.started` 追加，`subagent.updated` 按 `sessionId` 替换。
 * - `pendings`（R11）：`pending.added` 加入，`pending.updated` 按 `id` 替换。
 */
export function applyEvent(projection: SessionProjection, event: WevirEvent): SessionProjection {
  const next: { -readonly [K in keyof SessionProjection]: SessionProjection[K] } = {
    ...projection,
    lastSeq: event.seq,
    updatedAt: event.ts,
  };
  switch (event.type) {
    case 'session.created': {
      const parent = event.payload.parent;
      if (parent !== undefined) {
        next.subagent = {
          parentToolCallId: parent.toolCallId,
          ...(parent.turnId !== undefined && { parentTurnId: parent.turnId }),
          status: 'running',
          startedAt: event.ts,
        };
      }
      break;
    }
    case 'subagent.started':
    case 'subagent.updated': {
      const summary = event.payload.subagent;
      const index = projection.subagents.findIndex((item) => item.sessionId === summary.sessionId);
      next.subagents =
        index < 0
          ? [...projection.subagents, summary]
          : projection.subagents.map((item, i) => (i === index ? summary : item));
      break;
    }
    case 'pending.added':
    case 'pending.updated': {
      const { pending } = event.payload;
      next.pendings = new Map(projection.pendings).set(pending.id, pending);
      break;
    }
    case 'session.read_only':
      next.readOnly = {
        reason: event.payload.reason,
        message: event.payload.message,
        since: event.ts,
      };
      break;
    case 'session.resumed':
      next.readOnly = undefined;
      break;
    case 'session.title_changed':
      next.title = event.payload.title;
      next.titleSource = event.payload.source;
      break;
    case 'session.configured':
      next.model = {
        modelId: event.payload.modelId,
        ...(event.payload.reasoningEffort !== undefined && {
          reasoningEffort: event.payload.reasoningEffort,
        }),
        ...(event.payload.permissionMode !== undefined && {
          permissionMode: event.payload.permissionMode,
        }),
      };
      break;
    case 'session.state_changed': {
      next.state = event.payload.to;
      if (event.payload.reason === 'turn_started' || event.payload.reason === 'resumed') {
        next.lastError = undefined;
      }
      const subagent = projection.subagent;
      if (subagent !== undefined && event.payload.to === 'closed') {
        next.subagent = { ...subagent, status: 'closed', endedAt: subagent.endedAt ?? event.ts };
      } else if (subagent?.status === 'running' && event.payload.to === 'error') {
        next.subagent = { ...subagent, status: 'failed', endedAt: subagent.endedAt ?? event.ts };
      }
      break;
    }
    case 'user.message': {
      const { turnId, clientMessageId } = event.payload;
      next.lastUserMessage =
        clientMessageId === undefined ? { turnId } : { turnId, clientMessageId };
      break;
    }
    case 'turn.started': {
      const { turnId } = event.payload;
      const activeTurn: ActiveTurn = { turnId, startedAt: event.ts };
      const clientMessageId =
        projection.lastUserMessage?.turnId === turnId
          ? projection.lastUserMessage.clientMessageId
          : undefined;
      if (clientMessageId !== undefined) activeTurn.clientMessageId = clientMessageId;
      next.activeTurn = activeTurn;
      if (projection.subagent !== undefined) {
        const { endedAt: _ended, ...rest } = projection.subagent;
        next.subagent = { ...rest, status: 'running' };
      }
      break;
    }
    case 'turn.finished':
      if (projection.activeTurn?.turnId === event.payload.turnId) next.activeTurn = undefined;
      if (projection.subagent !== undefined) {
        next.subagent = {
          ...projection.subagent,
          status: SUBAGENT_STATUS_OF_OUTCOME[event.payload.outcome],
          endedAt: event.ts,
        };
      }
      break;
    case 'approval.requested':
      next.pendingApprovals = [...projection.pendingApprovals, event.payload.approval];
      break;
    case 'approval.resolved':
      next.pendingApprovals = projection.pendingApprovals.filter(
        (approval) => approval.id !== event.payload.approvalId,
      );
      break;
    case 'question.requested': {
      const questions = new Map(projection.questions);
      questions.set(event.payload.question.id, event.payload.question);
      next.questions = questions;
      break;
    }
    case 'question.resolved': {
      const previous = projection.questions.get(event.payload.questionId);
      if (previous) {
        const questions = new Map(projection.questions);
        questions.set(previous.id, {
          ...previous,
          status: event.payload.status,
          resolvedAt: event.ts,
          resolution: event.payload.resolution,
        });
        next.questions = questions;
      }
      break;
    }
    case 'todo.updated':
      next.todos = event.payload.items;
      break;
    case 'usage.updated':
      next.usage = {
        contextUsed: event.payload.contextUsed,
        contextSize: event.payload.contextSize,
      };
      break;
    case 'engine.error':
      next.lastError = { category: event.payload.category, message: event.payload.message };
      break;
  }
  return next;
}

/** 写入前被拒绝的事件：违反事件目录或状态机的不变量，说明调用方有 bug。 */
export class EventRejectedError extends Error {
  override name = 'EventRejectedError';
}

/**
 * 会话状态机的全部转换（domain-model §4.1，注释是该表的编号）。`session.state_changed` 的
 * `(from, to, reason)` 必须是其中一条。
 */
export const SESSION_TRANSITIONS: ReadonlyArray<{
  readonly from: readonly SessionState[];
  readonly to: SessionState;
  readonly reason: StateChangeReason;
}> = [
  { from: ['idle'], to: 'running', reason: 'turn_started' }, // #2
  { from: ['running'], to: 'awaiting_approval', reason: 'approval_requested' }, // #3
  { from: ['awaiting_approval'], to: 'running', reason: 'approvals_settled' }, // #4
  { from: ['running', 'awaiting_approval'], to: 'cancelling', reason: 'cancel_requested' }, // #5
  { from: ['running', 'cancelling'], to: 'idle', reason: 'turn_finished' }, // #6、#7、#8
  { from: ['cancelling'], to: 'error', reason: 'cancel_unconfirmed' }, // #9
  {
    from: ['idle', 'running', 'awaiting_approval', 'cancelling'],
    to: 'error',
    reason: 'engine_exited',
  }, // #10
  { from: ['idle'], to: 'error', reason: 'resume_failed' }, // #11
  { from: ['error', 'closed'], to: 'idle', reason: 'resumed' }, // #12
  { from: ['idle', 'error'], to: 'closed', reason: 'closed' }, // #13（#14 先经 #5、#8 回到 idle）
  {
    from: ['running', 'awaiting_approval', 'cancelling'],
    to: 'idle',
    reason: 'host_restarted',
  }, // #15
];

export function isAllowedTransition(
  from: SessionState,
  to: SessionState,
  reason: StateChangeReason,
): boolean {
  return SESSION_TRANSITIONS.some(
    (t) => t.to === to && t.reason === reason && t.from.includes(from),
  );
}

/**
 * 检查一条待写入的事件与当前状态是否相容，不相容时抛 `EventRejectedError`。只守事件库自己能判断的
 * 不变量：第一条事件是 `session.created` 且只有一条；状态转换合法且 `from` 是当前状态；回合不重叠；
 * 审批只结算一次；引擎会话只在没有活动回合时恢复；只读只出现在 `error` / `closed`。
 */
export function checkEvent(
  projection: SessionProjection,
  sessionId: SessionId,
  event: Pick<WevirEvent, 'type' | 'payload'>,
): void {
  const isCreated = event.type === 'session.created';
  if (projection.lastSeq === 0 && !isCreated) {
    reject(`会话 ${sessionId} 的第一条事件必须是 session.created，收到 ${event.type}`);
  }
  if (projection.lastSeq > 0 && isCreated) {
    reject(`会话 ${sessionId} 已有 session.created`);
  }
  const e = event as WevirEvent;
  switch (e.type) {
    case 'session.state_changed': {
      const { from, to, reason } = e.payload;
      if (from !== projection.state) {
        reject(`状态转换的 from 是 ${from}，会话当前是 ${projection.state}`);
      }
      if (!isAllowedTransition(from, to, reason)) {
        reject(`不允许的状态转换 ${from} → ${to}（${reason}）`);
      }
      break;
    }
    case 'turn.started':
      if (projection.activeTurn) {
        reject(`回合 ${projection.activeTurn.turnId} 尚未结束，不能开始 ${e.payload.turnId}`);
      }
      break;
    case 'turn.finished':
      if (projection.activeTurn?.turnId !== e.payload.turnId) {
        reject(`回合 ${e.payload.turnId} 不是当前回合`);
      }
      break;
    case 'session.resumed':
      if (
        projection.state !== 'idle' &&
        projection.state !== 'error' &&
        projection.state !== 'closed'
      ) {
        reject(`会话是 ${projection.state}，引擎会话不会在此时恢复`);
      }
      break;
    case 'session.read_only':
      if (projection.state !== 'error' && projection.state !== 'closed') {
        reject(`只读只出现在 error / closed 状态，会话是 ${projection.state}`);
      }
      break;
    case 'approval.requested': {
      const { approval } = e.payload;
      if (approval.sessionId !== sessionId) {
        reject(`审批 ${approval.id} 属于会话 ${approval.sessionId}`);
      }
      if (approval.status !== 'pending') reject(`新审批 ${approval.id} 的状态必须是 pending`);
      break;
    }
    case 'approval.resolved':
      if (!projection.pendingApprovals.some((a) => a.id === e.payload.approvalId)) {
        reject(`审批 ${e.payload.approvalId} 不是未决审批`);
      }
      break;
    case 'question.requested': {
      const { question } = e.payload;
      if (question.sessionId !== sessionId) {
        reject(`问题 ${question.id} 属于会话 ${question.sessionId}`);
      }
      if (question.status !== 'pending') reject(`新问题 ${question.id} 的状态必须是 pending`);
      if (projection.questions.has(question.id)) reject(`问题 ${question.id} 已经提过`);
      break;
    }
    case 'question.resolved':
      if (projection.questions.get(e.payload.questionId)?.status !== 'pending') {
        reject(`问题 ${e.payload.questionId} 不在等回答`);
      }
      break;
    case 'pending.added':
      if (projection.pendings.has(e.payload.pending.id)) {
        reject(`待发消息 ${e.payload.pending.id} 已经加入过`);
      }
      if (e.payload.pending.status !== 'waiting') {
        reject(`新的待发消息 ${e.payload.pending.id} 的状态必须是 waiting`);
      }
      break;
    case 'pending.updated': {
      const previous = projection.pendings.get(e.payload.pending.id);
      if (!previous) reject(`待发消息 ${e.payload.pending.id} 不存在`);
      if (TERMINAL_PENDING_STATUSES.includes(previous.status)) {
        reject(`待发消息 ${e.payload.pending.id} 已是 ${previous.status}，不再变化`);
      }
      break;
    }
    case 'user.steered':
      if (projection.activeTurn?.turnId !== e.payload.turnId) {
        reject(`插话的回合 ${e.payload.turnId} 不是当前回合`);
      }
      break;
  }
}

function reject(message: string): never {
  throw new EventRejectedError(message);
}

/**
 * `session.get` 的结果：身份字段取自 `sessions` 表，其余取自事件推导（与表里的缓存列不一致时以事件
 * 为准，domain-model §3.3）。返回独立的副本。
 */
export function toSnapshot(record: SessionRecord, projection: SessionProjection): SessionSnapshot {
  const session: Session = {
    id: record.id as SessionId,
    workspaceId: record.workspaceId as WorkspaceId,
    cwd: record.cwd,
    engine: { kind: record.engine, sessionId: record.engineSessionId },
    providerId: record.providerId,
    modelId: projection.model?.modelId ?? record.modelId,
    title: projection.title,
    titleSource: projection.titleSource,
    state: projection.state,
    createdAt: record.createdAt,
    updatedAt: projection.updatedAt ?? record.updatedAt,
    lastSeq: projection.lastSeq,
  };
  const reasoningEffort = projection.model
    ? projection.model.reasoningEffort
    : record.reasoningEffort;
  if (reasoningEffort !== undefined) session.reasoningEffort = reasoningEffort;
  const permissionMode = projection.model
    ? projection.model.permissionMode
    : (record.permissionMode as PermissionMode | undefined);
  if (permissionMode !== undefined) session.permissionMode = permissionMode;
  if (projection.activeTurn) session.activeTurn = projection.activeTurn;
  if (projection.lastError) session.lastError = projection.lastError;
  if (projection.readOnly) session.readOnly = projection.readOnly;
  if (record.parentSessionId !== undefined) {
    session.parentSessionId = record.parentSessionId as SessionId;
  }
  if (projection.subagent) session.subagent = projection.subagent;
  const snapshot: SessionSnapshot = {
    session,
    pendingApprovals: [...projection.pendingApprovals],
  };
  if (projection.todos) snapshot.todos = [...projection.todos];
  if (projection.usage) snapshot.usage = projection.usage;
  if (projection.subagents.length > 0) snapshot.subagents = [...projection.subagents];
  const pendingMessages = openPendings(projection);
  if (pendingMessages.length > 0) snapshot.pendingMessages = pendingMessages;
  const pendingQuestions = openQuestions(projection);
  if (pendingQuestions.length > 0) {
    snapshot.pendingQuestions = pendingQuestions;
    session.awaitingInput = true;
  }
  return structuredClone(snapshot);
}

/** `sessions` 表里由事件推导的缓存列，与 `toSnapshot` 的同名字段一致。 */
export function toCachePatch(projection: SessionProjection): SessionCachePatch {
  const patch: SessionCachePatch = {
    title: projection.title,
    titleSource: projection.titleSource,
    state: projection.state,
    activeTurn: projection.activeTurn ?? null,
    lastError: projection.lastError ?? null,
    lastSeq: projection.lastSeq,
  };
  if (projection.updatedAt !== undefined) patch.updatedAt = projection.updatedAt;
  if (projection.model) {
    patch.modelId = projection.model.modelId;
    patch.reasoningEffort = projection.model.reasoningEffort ?? null;
    if (projection.model.permissionMode !== undefined) {
      patch.permissionMode = projection.model.permissionMode;
    }
  }
  return patch;
}
