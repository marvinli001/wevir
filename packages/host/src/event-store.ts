import {
  EventPayloadSchemas,
  type EventSource,
  EventSourceSchema,
  isKnownEventType,
  type PendingMessage,
  type PendingMessageId,
  type QuestionId,
  type QuestionRequest,
  SeqCursorSchema,
  type SessionId,
  SessionIdSchema,
  type SessionSnapshot,
  type SuggestedTask,
  type TaskId,
  type WevirEvent,
  type WevirEventOf,
  type WevirEventPayload,
  type WevirEventType,
} from '@wevir/protocol';
import type { EventRecord, Storage } from '@wevir/storage';
import { EventBus, type EventListener } from './event-bus.js';
import {
  applyEvent,
  checkEvent,
  EventRejectedError,
  INITIAL_PROJECTION,
  type ProjectedEngine,
  type SessionProjection,
  toCachePatch,
  toSnapshot,
} from './snapshot.js';
import { truncateJson, truncateToolOutput } from './truncate.js';

/** 助手文本与计划增量的合并窗口（Paseo 取 60 ms，ADR-0002 §3）。 */
export const DELTA_WINDOW_MS = 60;

/** 待写入的事件：信封里由事件库决定的 `seq`、`sessionId`、`ts` 之外的部分。 */
export type EventInput = {
  [T in WevirEventType]: { type: T; source: EventSource; payload: WevirEventPayload<T> };
}[WevirEventType];

/** `append` 接受的事件。助手文本增量走 `appendDelta`、计划增量走 `appendPlanDelta`，先合并再落库。 */
export type AppendInput = Exclude<EventInput, { type: 'assistant.delta' | 'plan.delta' }>;

export type DeltaInput = WevirEventPayload<'assistant.delta'>;

/** `appendPlanDelta` 的输入（0.37.0）。 */
export type PlanDeltaInput = WevirEventPayload<'plan.delta'>;

/** 缓冲里的一段增量。 */
type BufferedDelta =
  | { type: 'assistant.delta'; payload: DeltaInput }
  | { type: 'plan.delta'; payload: PlanDeltaInput };

/** `handoffState` 的结果（0.25.0）。 */
export interface HandoffState {
  engines?: ProjectedEngine[];
  currentSeen: number;
  context?: string;
}

export interface EventStoreOptions {
  storage: Storage;
  /** 增量合并窗口，默认 `DELTA_WINDOW_MS`。 */
  deltaWindowMs?: number;
  /**
   * 后台错误：定时 flush 增量失败（这批增量随之丢弃，以随后的已提交消息为准）、订阅者抛错。
   * 默认打到 stderr。
   */
  onError?: (error: unknown) => void;
}

export class SessionNotFoundError extends Error {
  override name = 'SessionNotFoundError';
  constructor(readonly sessionId: string) {
    super(`会话 ${sessionId} 不存在`);
  }
}

interface DeltaBuffer {
  /** 待写入的增量，相邻的同一块（同一份计划）已合并。 */
  parts: BufferedDelta[];
  timer?: ReturnType<typeof setTimeout>;
  /** 上次写入增量的时间（`Date.now()`）。 */
  lastFlushAt?: number;
}

/**
 * 会话事件库（domain-model §3.5）。所有会话事件都经它写入：
 *
 * - **`seq` 在事务里分配。** 每次写入在一个 `BEGIN IMMEDIATE` 事务里读出库里的最大 `seq` 再顺延，
 *   同一会话的事件 `seq` 从 1 开始连续、无重复。同一事务里还更新 `sessions` 表的缓存列和 `approvals`
 *   表（二者都是事件的投影），提交后才通知订阅者。
 * - **增量先合并再分配 `seq`。** `appendDelta` 与 `appendPlanDelta` 把增量放进会话的缓冲：距上次写入增量已过一个窗口就
 *   立即写入（窗口首），否则等到窗口尾一起写入；相邻的同一块（同回合、同 `streamId`、同
 *   `blockIndex`、同 `kind`）合并成一条 `assistant.delta`，相邻的同一份计划（同回合、同 `planId`）合并成一条
 *   `plan.delta`。写其他事件前先写掉缓冲的增量，保证顺序。
 * - **大字段入库前截断**（host-api.md §11），回放与实时推送是同一份数据。
 * - **快照由事件推导**（`snapshot`），并在内存里随写入增量推进；Host 重启后从事件重放得到同样的结果。
 *
 * 所有方法都是同步的：Host 只有一个数据库连接，同步执行本身就把同一进程里的写入串行化了。
 */
export class EventStore {
  readonly #storage: Storage;
  readonly #deltaWindowMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #bus: EventBus;
  readonly #projections = new Map<SessionId, SessionProjection>();
  readonly #buffers = new Map<SessionId, DeltaBuffer>();
  #closed = false;

  constructor(options: EventStoreOptions) {
    this.#storage = options.storage;
    this.#deltaWindowMs = options.deltaWindowMs ?? DELTA_WINDOW_MS;
    this.#onError =
      options.onError ?? ((error) => console.error('[wevir-host] event store:', error));
    this.#bus = new EventBus({ onError: this.#onError });
  }

  /**
   * 追加一条事件，返回分配了 `seq` 的完整事件。会话有缓冲的增量时先写增量（`seq` 更小），与这条
   * 事件在同一事务里提交。事件不合 schema 时抛 zod 的错误，违反事件目录或状态机时抛
   * `EventRejectedError`，会话不存在时抛 `SessionNotFoundError`；抛错时什么都不写。
   */
  append<I extends AppendInput>(sessionId: SessionId, input: I): WevirEventOf<I['type']> {
    return this.appendMany(sessionId, [input])[0] as WevirEventOf<I['type']>;
  }

  /**
   * 在一个事务里依次追加多条事件（例如一次状态转换的全部事件，domain-model §4.1），要么全写，
   * 要么全不写。`options.inTransaction` 在同一事务里、事件写入之后同步执行，拿到的是这批事件
   * （不含先写掉的增量）；用来写必须与事件同生共死的其他行，例如 `session.send` 的发送回执。
   * 它抛错时整批回滚。
   */
  appendMany(
    sessionId: SessionId,
    inputs: readonly AppendInput[],
    options: { inTransaction?: (events: readonly WevirEvent[]) => void } = {},
  ): WevirEvent[] {
    this.#assertOpen();
    SessionIdSchema.parse(sessionId);
    const prepared = inputs.map((input) => {
      if (input.type === ('assistant.delta' as string) || input.type === ('plan.delta' as string)) {
        throw new EventRejectedError(
          `${input.type} 要经 appendDelta / appendPlanDelta 合并后再写入`,
        );
      }
      return prepare(input);
    });
    return this.#commit(sessionId, prepared, options.inTransaction);
  }

  /**
   * 缓冲一段助手文本或思考的增量，按窗口合并后写成 `assistant.delta`。写入的事件只经订阅通知，不在
   * 这里返回。空文本忽略。
   */
  appendDelta(sessionId: SessionId, delta: DeltaInput): void {
    this.#assertOpen();
    SessionIdSchema.parse(sessionId);
    const payload = EventPayloadSchemas['assistant.delta'].parse(delta);
    if (payload.text === '') return;
    this.#buffer(sessionId, { type: 'assistant.delta', payload });
  }

  /**
   * 缓冲一段计划的增量（0.37.0），与助手增量同一个缓冲、同一个窗口，写成 `plan.delta`。空文本忽略；带 `restart` 的作废缓冲里
   * 紧挨着的同一份计划。
   */
  appendPlanDelta(sessionId: SessionId, delta: PlanDeltaInput): void {
    this.#assertOpen();
    SessionIdSchema.parse(sessionId);
    if (delta.text === '') return;
    this.#buffer(sessionId, {
      type: 'plan.delta',
      payload: EventPayloadSchemas['plan.delta'].parse(delta),
    });
  }

  #buffer(sessionId: SessionId, part: BufferedDelta): void {
    this.#projection(sessionId); // 会话不存在时现在就报错，而不是在定时器里。
    let buffer = this.#buffers.get(sessionId);
    if (!buffer) {
      buffer = { parts: [] };
      this.#buffers.set(sessionId, buffer);
    }
    const last = buffer.parts.at(-1);
    const merged = last && mergeDelta(last, part);
    if (merged) buffer.parts[buffer.parts.length - 1] = merged;
    else buffer.parts.push(part);
    if (buffer.timer) return;

    const sinceFlush =
      buffer.lastFlushAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - buffer.lastFlushAt;
    if (sinceFlush >= this.#deltaWindowMs) {
      this.#commit(sessionId, []); // 窗口首：一段静默之后的第一个增量不等待。
    } else {
      buffer.timer = setTimeout(
        () => this.#flushOnTimer(sessionId),
        this.#deltaWindowMs - sinceFlush,
      );
      buffer.timer.unref?.();
    }
  }

  /** 立即写入会话缓冲的增量。 */
  flush(sessionId: SessionId): void {
    this.#assertOpen();
    this.#commit(sessionId, []);
  }

  /** 立即写入所有会话缓冲的增量。 */
  flushAll(): void {
    this.#assertOpen();
    for (const sessionId of this.#buffers.keys()) this.#commit(sessionId, []);
  }

  /**
   * 写入所有缓冲的增量（失败交给 `onError`），然后停止接受写入。不关闭数据库（它属于调用方）。
   * 可重复调用。
   */
  close(): void {
    if (this.#closed) return;
    for (const [sessionId, buffer] of this.#buffers) {
      try {
        this.#commit(sessionId, []);
      } catch (error) {
        this.#onError(error);
      }
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.#buffers.clear();
    this.#closed = true;
  }

  /**
   * 按 `seq` 升序读取 `seq > sinceSeq` 的事件，最多 `limit` 条（省略则不限）。还在缓冲里的增量没有
   * `seq`，不在其中；它们写入后经订阅送达。会话不存在时返回空数组。
   */
  readSince(sessionId: SessionId, sinceSeq: number, limit?: number): WevirEvent[] {
    SeqCursorSchema.parse(sinceSeq);
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
      throw new RangeError(`limit 必须是正整数，收到 ${limit}`);
    }
    const options = limit === undefined ? { afterSeq: sinceSeq } : { afterSeq: sinceSeq, limit };
    return this.#storage.events.list(sessionId, options).map(fromRecord);
  }

  /**
   * 订阅一个会话之后写入的事件。返回订阅时库里的 `lastSeq`：`listener` 恰好收到 `seq > lastSeq`
   * 的每一条事件，按 `seq` 升序、同步回调；`(sinceSeq, lastSeq]` 由调用方用 `readSince` 补发，
   * 两者衔接不丢不重（host-api.md §4）。
   */
  subscribe(
    sessionId: SessionId,
    listener: EventListener,
  ): { lastSeq: number; unsubscribe: () => void } {
    const lastSeq = this.#storage.events.lastSeq(sessionId);
    return { lastSeq, unsubscribe: this.#bus.subscribe(sessionId, listener, lastSeq) };
  }

  /** `session.get` 的快照；会话不存在时为 `undefined`。 */
  snapshot(sessionId: SessionId): SessionSnapshot | undefined {
    const record = this.#storage.sessions.get(sessionId);
    if (!record) return undefined;
    return toSnapshot(record, this.#projection(sessionId));
  }

  /** 一条待发消息（R11），含已到终态的；会话或消息不存在时为 `undefined`。 */
  pending(sessionId: SessionId, pendingId: PendingMessageId): PendingMessage | undefined {
    if (!this.#storage.sessions.get(sessionId)) return undefined;
    return this.#projection(sessionId).pendings.get(pendingId);
  }

  /** 一组问题（0.10.0），含已结束的；会话或问题不存在时为 `undefined`。 */
  question(sessionId: SessionId, questionId: QuestionId): QuestionRequest | undefined {
    if (!this.#storage.sessions.get(sessionId)) return undefined;
    return structuredClone(this.#projection(sessionId).questions.get(questionId));
  }

  /** 一项建议的后续任务（0.16.0）；会话或建议不存在时为 `undefined`。 */
  suggestedTask(sessionId: SessionId, taskId: TaskId): SuggestedTask | undefined {
    if (!this.#storage.sessions.get(sessionId)) return undefined;
    return structuredClone(this.#projection(sessionId).suggestedTasks.get(taskId));
  }

  /**
   * 接力的状态（0.25.0，domain-model §3.14）：挂过的引擎会话（第一次接力之前是 `undefined`）、当前的引擎会话看到了哪儿、还没
   * 交出去的接力摘要。会话不存在时为 `undefined`。
   */
  handoffState(sessionId: SessionId): HandoffState | undefined {
    if (!this.#storage.sessions.get(sessionId)) return undefined;
    const { engines, currentSeen, handoffContext } = this.#projection(sessionId);
    return {
      ...(engines !== undefined && { engines: [...engines] }),
      currentSeen,
      ...(handoffContext !== undefined && { context: handoffContext }),
    };
  }

  /** 写入缓冲的增量与 `inputs`，返回 `inputs` 对应的事件。 */
  #commit(
    sessionId: SessionId,
    inputs: readonly AppendInput[],
    inTransaction?: (events: readonly WevirEvent[]) => void,
  ): WevirEvent[] {
    const buffer = this.#buffers.get(sessionId);
    const deltas = buffer?.parts ?? [];
    if (deltas.length === 0 && inputs.length === 0) return [];
    const all: EventInput[] = [
      ...deltas.map((delta) => ({ ...delta, source: 'engine' }) as EventInput),
      ...inputs,
    ];
    const ts = new Date().toISOString();

    const { events, projection } = this.#storage.transaction(() => {
      let projection = this.#catchUp(sessionId);
      const events: WevirEvent[] = [];
      for (const input of all) {
        checkEvent(projection, sessionId, input);
        const event = { seq: projection.lastSeq + 1, sessionId, ts, ...input } as WevirEvent;
        this.#storage.events.insert(event);
        this.#projectApprovals(event);
        projection = applyEvent(projection, event);
        events.push(event);
      }
      this.#storage.sessions.update(sessionId, toCachePatch(projection));
      inTransaction?.(events.slice(deltas.length));
      return { events, projection };
    });

    this.#projections.set(sessionId, projection);
    if (buffer && deltas.length > 0) {
      buffer.parts = [];
      buffer.lastFlushAt = Date.now();
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    this.#bus.publish(events);
    return events.slice(deltas.length);
  }

  #flushOnTimer(sessionId: SessionId): void {
    const buffer = this.#buffers.get(sessionId);
    if (!buffer) return;
    buffer.timer = undefined;
    try {
      this.#commit(sessionId, []);
    } catch (error) {
      buffer.parts = [];
      this.#onError(error);
    }
  }

  /** `approvals` 表是审批事件的投影，与事件在同一事务里写入。 */
  #projectApprovals(event: WevirEvent): void {
    if (event.type === 'approval.requested') {
      const { approval } = event.payload;
      this.#storage.approvals.insert({
        id: approval.id,
        sessionId: approval.sessionId,
        turnId: approval.turnId,
        toolCallId: approval.toolCallId,
        options: approval.options,
        detail: approval.detail,
        status: approval.status,
        createdAt: approval.createdAt,
      });
    } else if (event.type === 'approval.resolved') {
      const { approvalId, status, resolution } = event.payload;
      if (
        !this.#storage.approvals.resolve(approvalId, { status, resolvedAt: event.ts, resolution })
      ) {
        throw new EventRejectedError(`approvals 表里没有未决审批 ${approvalId}`);
      }
    }
  }

  /** 取缓存的投影并读入库里比它新的事件；缓存不存在时从头重放。只读，可在事务内外调用。 */
  #catchUp(sessionId: SessionId): SessionProjection {
    const cached = this.#projections.get(sessionId);
    const lastSeq = this.#storage.events.lastSeq(sessionId);
    if (cached?.lastSeq === lastSeq) return cached;
    if (!cached && !this.#storage.sessions.get(sessionId))
      throw new SessionNotFoundError(sessionId);
    // 缓存比库还新只可能是库被换掉了，从头重放。
    let projection = cached && cached.lastSeq < lastSeq ? cached : INITIAL_PROJECTION;
    for (const record of this.#storage.events.list(sessionId, { afterSeq: projection.lastSeq })) {
      projection = applyEvent(projection, fromRecord(record));
    }
    return projection;
  }

  #projection(sessionId: SessionId): SessionProjection {
    const projection = this.#catchUp(sessionId);
    this.#projections.set(sessionId, projection);
    return projection;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('EventStore 已关闭');
  }
}

/** 截断大字段并按 schema 校验 payload（剥掉 schema 之外的字段）。 */
function prepare(input: AppendInput): AppendInput {
  if (!isKnownEventType(input.type)) {
    throw new EventRejectedError(`未知的事件类型 ${String(input.type)}`);
  }
  const source = EventSourceSchema.parse(input.source);
  const payload = EventPayloadSchemas[input.type].parse(truncatePayload(input));
  return { type: input.type, source, payload } as AppendInput;
}

function truncatePayload(input: AppendInput): unknown {
  switch (input.type) {
    case 'tool.started':
      return withInput(input.payload);
    case 'tool.updated': {
      const payload = withInput(input.payload);
      return payload.output ? { ...payload, output: truncateToolOutput(payload.output) } : payload;
    }
    case 'tool.finished':
      return input.payload.output
        ? { ...input.payload, output: truncateToolOutput(input.payload.output) }
        : input.payload;
    case 'approval.requested': {
      const { approval } = input.payload;
      return approval.detail
        ? { approval: { ...approval, detail: withInput(approval.detail) } }
        : input.payload;
    }
    case 'engine.raw':
      return 'params' in input.payload
        ? { ...input.payload, params: truncateJson(input.payload.params) }
        : input.payload;
    default:
      return input.payload;
  }
}

function withInput<T extends { input?: unknown }>(value: T): T {
  return value.input === undefined ? value : { ...value, input: truncateJson(value.input) };
}

/** 相邻两段增量合并的结果；不是同一块（同一份计划）时是 `undefined`。 */
function mergeDelta(last: BufferedDelta, next: BufferedDelta): BufferedDelta | undefined {
  if (last.type === 'assistant.delta' && next.type === 'assistant.delta') {
    const [a, b] = [last.payload, next.payload];
    const same =
      a.turnId === b.turnId &&
      a.streamId === b.streamId &&
      a.blockIndex === b.blockIndex &&
      a.kind === b.kind;
    return same ? { type: last.type, payload: { ...a, text: a.text + b.text } } : undefined;
  }
  if (last.type === 'plan.delta' && next.type === 'plan.delta') {
    const [a, b] = [last.payload, next.payload];
    if (a.turnId !== b.turnId || a.planId !== b.planId) return undefined;
    // 从头重写：缓冲里这份计划之前的增量作废（写出去的那些由 `restart` 告诉客户端丢掉）。
    if (b.restart) return next;
    return { type: last.type, payload: { ...a, text: a.text + b.text } };
  }
  return undefined;
}

/** 库里的事件都在写入时校验过，读出时不再解析 payload。 */
function fromRecord(record: EventRecord): WevirEvent {
  return record as WevirEvent;
}
