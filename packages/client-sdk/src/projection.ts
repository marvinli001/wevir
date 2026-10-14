// 客户端消息投影（domain-model §8）：把一个会话按 seq 应用的事件投影成“消息 + 部件”，桌面与 CLI 共用。
// 分层照 OpenWork（openwork-notes §3.2）：协议事件 → 本投影 → 渲染。纯逻辑，不碰 DOM 与连接。
//
// 增量与已提交消息按 domain-model §6.3 合并；工具收尾按 §6.4，回合结束而工具未收尾时投影为 `unknown`
// （Host 正常会补写，这里兜底，回放旧数据也不会一直转圈）。子会话（R4）：父会话里每个子会话一个 `subagent` 部件与
// `subagents` 摘要；子会话自己的回合输入（`turn.started.input`）投影成来自父 agent 的用户消息。
//
// 性能：事件只改动它涉及的那条消息。`snapshot()` 只为改动过的消息生成新对象，其余沿用上一次的对象，渲染层
// 按对象身份跳过没变的消息；部件同样整体替换、不原地修改。调用方可以攒一批事件再取一次快照（桌面按帧）。

import type {
  ApprovalId,
  ApprovalOption,
  ApprovalRequest,
  ApprovalResolution,
  ApprovalStatus,
  ClientIdentity,
  EngineErrorCategory,
  EngineErrorInfo,
  IsoTime,
  SessionId,
  SessionReadOnly,
  SessionReadOnlyReason,
  SessionState,
  StreamBlockRef,
  SubagentSummary,
  TodoItem,
  ToolDisplay,
  ToolOutput,
  TurnId,
  TurnOutcome,
  Usage,
  WevirEvent,
  WevirEventOf,
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
  | { kind: 'closed' };

/**
 * 消息的部件。`key` 在部件的一生中不变（增量块被已提交消息替换时沿用增量块的 key），渲染层拿它做 React key。
 * 文本与思考部件与 AI SDK `UIMessage` 同形（domain-model §8 第 5 条）。
 */
export type ChatPart =
  | ({ type: 'text' } & StreamPartFields)
  | ({ type: 'reasoning' } & StreamPartFields)
  | {
      type: 'tool';
      key: string;
      toolCallId: string;
      toolName: string;
      display: ToolDisplay;
      status: ToolPartStatus;
      input: unknown;
      output?: ToolOutput;
      approval?: ToolPartApproval;
      startedAt: IsoTime;
      finishedAt?: IsoTime;
    }
  | { type: 'todo'; key: string; items: readonly TodoItem[] }
  | { type: 'error'; key: string; category: EngineErrorCategory; message: string; fatal: boolean }
  /** 适配器不认识的引擎消息（`engine.raw`），只在 `includeRaw` 时投影。 */
  | { type: 'raw'; key: string; method: string; kind?: string; params: unknown }
  | { type: 'notice'; key: string; notice: SessionNotice }
  /**
   * 这个会话派出的一个子会话（R4，domain-model §8）：在派出它的回合里，`subagent.started` 时出现，随 `subagent.updated`
   * 原位更新（`key` 是 `a:<子会话 ID>`）。界面据此画“开始工作 / 已完成”两行（R5）。
   */
  | { type: 'subagent'; key: string; subagent: SubagentSummary };

/** 文本与思考部件共有的字段。 */
export interface StreamPartFields {
  key: string;
  text: string;
  state: 'streaming' | 'done';
  /** 来自增量（尚未被替换）时有。 */
  stream?: StreamBlockRef;
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
  clientMessageId?: string;
  ts: IsoTime;
}

export interface AssistantChatMessage extends MessageBase {
  role: 'assistant';
  turnId: TurnId;
  /** `turn.started` 的时刻。 */
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
  lastSeq: number;
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
  clientMessageId?: string;
  ts?: IsoTime;
  startedAt?: IsoTime;
  finished?: { outcome: TurnOutcome; durationMs: number };
  /** 上一次快照里的对象；改动后清空。 */
  snapshot: ChatMessage | undefined;
}

const EMPTY_APPROVALS: ReadonlyMap<ApprovalId, ApprovalRequest> = new Map();

/** 按 seq 应用事件、产出 `Transcript` 快照。事件必须按 seq 连续送入（client-sdk 的订阅保证这一点）。 */
export class TranscriptProjection {
  readonly #includeRaw: boolean;
  #messages: MutableMessage[] = [];
  #turns = new Map<TurnId, { user?: MutableMessage; assistant?: MutableMessage }>();
  /** toolCallId → 所在消息。 */
  #tools = new Map<string, MutableMessage>();
  #approvals = new Map<ApprovalId, ApprovalRequest>();
  #approvalsDirty = false;
  #sessionId: SessionId | undefined;
  #state: SessionState | undefined;
  #activeTurnId: TurnId | undefined;
  #title = '';
  #readOnly: SessionReadOnly | undefined;
  #lastError: EngineErrorInfo | undefined;
  #usage: Usage | undefined;
  #subagents: SubagentSummary[] = [];
  /** 子会话 ID → 它的部件所在的消息。 */
  #subagentParts = new Map<SessionId, MutableMessage>();
  #parent: ParentRef | undefined;
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
    this.#approvalsDirty = true;
    this.#sessionId = undefined;
    this.#state = undefined;
    this.#activeTurnId = undefined;
    this.#title = '';
    this.#readOnly = undefined;
    this.#lastError = undefined;
    this.#usage = undefined;
    this.#subagents = [];
    this.#subagentParts.clear();
    this.#parent = undefined;
    this.#lastSeq = 0;
    this.#dirty = true;
  }

  apply(event: WevirEvent): void {
    this.#sessionId = event.sessionId;
    this.#lastSeq = event.seq;
    this.#dirty = true;
    switch (event.type) {
      case 'session.created': {
        this.#state = 'idle';
        const parent = event.payload.parent;
        if (parent !== undefined) this.#parent = { ...parent };
        return;
      }
      case 'session.resumed':
        this.#readOnly = undefined;
        this.#notice(event, { kind: 'resumed', engineVersion: event.payload.engineVersion });
        return;
      case 'session.read_only': {
        const { reason, message } = event.payload;
        this.#readOnly = { reason, message, since: event.ts };
        this.#notice(event, { kind: 'read_only', reason, message });
        return;
      }
      case 'session.title_changed':
        this.#title = event.payload.title;
        return;
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
        // 子会话：这一回合的输入来自父 agent（R4），投影成一条用户消息。
        if (event.payload.input !== undefined) this.#agentInput(event);
        const message = this.#assistant(event.payload.turnId, event.seq);
        message.startedAt = event.ts;
        this.#activeTurnId = event.payload.turnId;
        return;
      }
      case 'turn.finished':
        this.#turnFinished(event);
        return;
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
      case 'approval.requested':
        this.#approvalRequested(event);
        return;
      case 'approval.resolved':
        this.#approvalResolved(event);
        return;
      case 'usage.updated':
        this.#usage = {
          contextUsed: event.payload.contextUsed,
          contextSize: event.payload.contextSize,
        };
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
    }
  }

  /** 当前投影。自上次调用以来没有新事件时返回同一个对象。 */
  snapshot(): Transcript {
    if (!this.#dirty && this.#snapshot) return this.#snapshot;
    const messages = this.#messages.map((message) => {
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
    const { turnId, content, sentBy, clientMessageId } = event.payload;
    const turn = this.#turn(turnId);
    if (turn.user) return;
    const text = content.map((part) => part.text).join('\n');
    turn.user = this.#push({
      role: 'user',
      id: turnId,
      turnId,
      parts: [{ type: 'text', key: 'text', text, state: 'done' }],
      firstSeq: event.seq,
      lastSeq: event.seq,
      sentBy,
      clientMessageId,
      ts: event.ts,
      snapshot: undefined,
    });
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
      parts: [
        {
          type: 'text',
          key: 'text',
          text: input.map((part) => part.text).join('\n'),
          state: 'done',
        },
      ],
      firstSeq: event.seq,
      lastSeq: event.seq,
      fromParentAgent: true,
      ts: event.ts,
      snapshot: undefined,
    });
  }

  #turn(turnId: TurnId): { user?: MutableMessage; assistant?: MutableMessage } {
    let turn = this.#turns.get(turnId);
    if (!turn) {
      turn = {};
      this.#turns.set(turnId, turn);
    }
    return turn;
  }

  /** 回合的助手消息，没有就建（紧跟在本回合的用户消息之后追加）。 */
  #assistant(turnId: TurnId, seq: number): MutableMessage {
    const turn = this.#turn(turnId);
    if (!turn.assistant) {
      turn.assistant = this.#push({
        role: 'assistant',
        id: `${turnId}:assistant`,
        turnId,
        parts: [],
        firstSeq: seq,
        lastSeq: seq,
        snapshot: undefined,
      });
    }
    return this.#touch(turn.assistant, seq);
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

  // ── 回合 ─────────────────────────────────────────────────────────────

  #turnFinished(event: WevirEventOf<'turn.finished'>): void {
    const { turnId, outcome, durationMs } = event.payload;
    const message = this.#assistant(turnId, event.seq);
    message.finished = { outcome, durationMs };
    // domain-model §6.3 规则 4：本回合没被替换的增量丢弃，以已提交消息为准；回合被中断（Host 或引擎退出）时已提交
    // 消息不会再来，保留中断前已生成的部分（T5.5）。§6.4：未收尾的工具不再转圈。
    const keepPartial = outcome === 'interrupted';
    message.parts = message.parts.flatMap((part): ChatPart[] => {
      if (isStreamPart(part) && part.state === 'streaming') {
        return keepPartial && part.text.trim() !== '' ? [{ ...part, state: 'done' }] : [];
      }
      return [part.type === 'tool' && isOpen(part.status) ? { ...part, status: 'unknown' } : part];
    });
    if (this.#activeTurnId === turnId) this.#activeTurnId = undefined;
  }

  #delta(event: WevirEventOf<'assistant.delta'>): void {
    const { turnId, streamId, blockIndex, kind, text } = event.payload;
    const message = this.#assistant(turnId, event.seq);
    const key = streamKey({ streamId, blockIndex });
    const index = message.parts.findIndex((part) => part.key === key);
    const part = message.parts[index];
    if (part && isStreamPart(part)) {
      message.parts[index] = { ...part, text: part.text + text };
      return;
    }
    message.parts.push({
      type: kind,
      key,
      text,
      state: 'streaming',
      stream: { streamId, blockIndex },
    });
  }

  #dropStream(event: WevirEventOf<'assistant.stream_ended'>): void {
    const message = this.#assistant(event.payload.turnId, event.seq);
    const prefix = `s:${event.payload.streamId}:`;
    message.parts = message.parts.filter(
      (part) => !(part.key.startsWith(prefix) && isStreamPart(part) && part.state === 'streaming'),
    );
  }

  #committed(event: WevirEventOf<'assistant.message'> | WevirEventOf<'assistant.thought'>): void {
    const { turnId, text, replaces } = event.payload;
    const type = event.type === 'assistant.message' ? 'text' : 'reasoning';
    const message = this.#assistant(turnId, event.seq);
    const replacedKeys = new Set(replaces.map(streamKey));
    const at = message.parts.findIndex((part) => replacedKeys.has(part.key));
    const blank = text.trim() === '';
    if (at < 0) {
      // 规则 3：没有可替换的增量时追加在回合末尾。只含空白的已提交块不显示。
      if (!blank) message.parts.push({ type, key: `m:${event.seq}`, text, state: 'done' });
      return;
    }
    const key = message.parts[at]?.key ?? `m:${event.seq}`;
    const parts = message.parts.filter(
      (part, index) => index === at || !replacedKeys.has(part.key),
    );
    const index = parts.findIndex((part) => part.key === key);
    if (blank) parts.splice(index, 1);
    else parts[index] = { type, key, text, state: 'done' };
    message.parts = parts;
  }

  // ── 工具 ─────────────────────────────────────────────────────────────

  #toolStarted(event: WevirEventOf<'tool.started'>): void {
    const { turnId, toolCallId, toolName, display, input } = event.payload;
    if (this.#tools.has(toolCallId)) return;
    const message = this.#assistant(turnId, event.seq);
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
    const { toolCallId, display, input, output } = event.payload;
    this.#updateTool(toolCallId, event.seq, (part) => ({
      ...part,
      ...(display && { display }),
      ...(input !== undefined && { input }),
      ...(output && { output }),
    }));
  }

  #toolFinished(event: WevirEventOf<'tool.finished'>): void {
    const { toolCallId, status, output } = event.payload;
    this.#updateTool(toolCallId, event.seq, (part) => ({
      ...part,
      status,
      ...(output && { output }),
      finishedAt: event.ts,
    }));
  }

  #todo(event: WevirEventOf<'todo.updated'>): void {
    const message = this.#assistant(event.payload.turnId, event.seq);
    const items = event.payload.items;
    // 每个回合只留一份最新的待办列表，位置在第一次出现的地方。
    const index = message.parts.findIndex((part) => part.type === 'todo');
    if (index >= 0) message.parts[index] = { type: 'todo', key: 'todo', items };
    else message.parts.push({ type: 'todo', key: 'todo', items });
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
    this.#approvals.set(approvalId, { ...approval, status, resolution, resolvedAt: event.ts });
    this.#approvalsDirty = true;
    this.#updateTool(approval.toolCallId, event.seq, (part) => ({
      ...part,
      status: part.status === 'awaiting_approval' ? 'running' : part.status,
      approval: part.approval && { ...part.approval, status, resolution },
    }));
  }

  // ── 子会话 ───────────────────────────────────────────────────────────

  /**
   * `subagent.started` / `subagent.updated`：摘要列表按 `sessionId` 追加或替换；部件放在派出它的回合（没有回合时一条
   * 系统消息），之后原位更新。
   */
  #subagent(event: WevirEventOf<'subagent.started'> | WevirEventOf<'subagent.updated'>): void {
    const summary = event.payload.subagent;
    const index = this.#subagents.findIndex((item) => item.sessionId === summary.sessionId);
    this.#subagents =
      index < 0
        ? [...this.#subagents, summary]
        : this.#subagents.map((item, i) => (i === index ? summary : item));
    const key = `a:${summary.sessionId}`;
    const existing = this.#subagentParts.get(summary.sessionId);
    if (existing) {
      this.#touch(existing, event.seq);
      existing.parts = existing.parts.map((part) =>
        part.key === key ? { type: 'subagent', key, subagent: summary } : part,
      );
      return;
    }
    const message = this.#target(summary.parentTurnId, event.seq);
    message.parts.push({ type: 'subagent', key, subagent: summary });
    this.#subagentParts.set(summary.sessionId, message);
  }

  // ── 错误与调试 ───────────────────────────────────────────────────────

  #engineError(event: WevirEventOf<'engine.error'>): void {
    const { category, message, turnId, fatal } = event.payload;
    this.#lastError = { category, message };
    this.#target(turnId, event.seq).parts.push({
      type: 'error',
      key: `e:${event.seq}`,
      category,
      message,
      fatal,
    });
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
        ...(message.clientMessageId !== undefined && { clientMessageId: message.clientMessageId }),
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
