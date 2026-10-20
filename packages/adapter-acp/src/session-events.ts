import {
  type AgentEvent,
  type ApprovalCancelledEvent,
  type ApprovalRequestedEvent,
  EventHub,
  type PlanProposedEvent,
  type QuestionCancelledEvent,
  type QuestionRequestedEvent,
  type TodoItem,
  type TurnTerminalEvent,
  type UsageRecordedEvent,
} from '@wevir/runtime-adapter';
import {
  type AcpRawReason,
  type AcpSessionNotification,
  mapAcpUpdate,
  rawEvent,
} from './acp-mapping.js';
import { ChunkStream } from './chunk-stream.js';
import type { AcpEngine, AcpToolPresentation } from './engine.js';

/** 适配器的告警出口；Host 的 Logger 满足这个接口。 */
export interface AdapterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 一个引擎会话的有序事件队列。各路输入都是同步调用，按调用顺序产出事件：
 * - ACP `session/update`：AcpProcess 在 SDK 之前按引擎写出的顺序交来（acp-process.ts），所以本队列里的
 *   ACP 事件与 ACP 交付顺序一致，并且排在同一条流里后到的 `session/prompt` 结果（回合终结事件）之前；
 * - 审批与提问：适配器收到 `session/request_permission`（或引擎的扩展请求）与结束未决的审批、提问时交来；
 * - 回合边界：适配器发出 `session/prompt` 时 `beginTurn`，拿到结果时 `endTurn`。
 *
 * 回合之外只发 `engine.raw` 与 `engine.exited`（events.ts 的顺序约定）：回合外到达的其他 ACP 更新改发
 * `engine.raw` 并告警。
 */
export class SessionEventQueue {
  readonly engineSessionId: string;
  readonly #hub = new EventHub<AgentEvent>();
  readonly #tools: AcpToolPresentation;
  /** 逐字流式的引擎（`messageChunks: 'streamed'`）才有。 */
  readonly #chunks: ChunkStream | undefined;
  readonly #warnOnce: WarnOnce;
  #inTurn = false;
  /** 本回合最近一个写待办的工具调用（`tools.isPlanTool`），ACP `plan` 记在它上面。 */
  #planToolCallId: string | undefined;
  #planSeq = 0;

  constructor(
    engineSessionId: string,
    warnOnce: WarnOnce,
    engine: Pick<AcpEngine, 'tools' | 'messageChunks'>,
  ) {
    this.engineSessionId = engineSessionId;
    this.#warnOnce = warnOnce;
    this.#tools = engine.tools;
    this.#chunks =
      engine.messageChunks === 'streamed' ? new ChunkStream(engineSessionId) : undefined;
  }

  get ended(): boolean {
    return this.#hub.ended;
  }

  get inTurn(): boolean {
    return this.#inTurn;
  }

  subscribe(): AsyncIterableIterator<AgentEvent> {
    return this.#hub.subscribe();
  }

  beginTurn(): void {
    this.#inTurn = true;
    this.#planToolCallId = undefined;
  }

  acpUpdate(notification: AcpSessionNotification): void {
    const kind = notification.update.sessionUpdate;
    const onRaw = (reason: AcpRawReason, detail: string) => {
      if (reason === 'by_design') return;
      this.#warnOnce(
        `acp:${reason}:${kind}`,
        `ACP session/update 无法映射，保留为 engine.raw：${detail}`,
        {
          engineSessionId: this.engineSessionId,
          sessionUpdate: kind,
          reason,
        },
      );
    };
    if (
      this.#chunks !== undefined &&
      (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
    ) {
      // 回合外的增量（session/load 回放的历史等）不当消息处理。
      if (!this.#inTurn) {
        this.#outsideTurn(notification);
        return;
      }
      if (this.#streamedChunk(notification)) return;
    }
    if (kind === 'plan' && this.#tools.isPlanTool !== undefined && this.#inTurn) {
      const items = planItems(notification.update.entries);
      if (items !== undefined) {
        this.#flushChunks();
        this.#hub.emit({
          type: 'todo.updated',
          engineSessionId: this.engineSessionId,
          toolCallId: this.#planToolCallId ?? `plan-${++this.#planSeq}`,
          items,
        });
        return;
      }
    }
    const events = mapAcpUpdate(notification, this.#tools, onRaw);
    const visible = events.some((e) => e.type !== 'engine.raw' && e.type !== 'usage.updated');
    if (!this.#inTurn && visible) {
      this.#outsideTurn(notification);
      return;
    }
    // 别的可见更新（工具调用等）把正在流式的一块内容截断：先提交它，顺序与引擎写出的一致。只有 engine.raw 与用量的更新
    // （Grok 回合中途的 session_info_update、available_commands_update）不截断。
    if (visible) this.#flushChunks();
    for (const event of events) {
      if (event.type === 'tool.started' && this.#tools.isPlanTool?.(event.toolName) === true) {
        this.#planToolCallId = event.toolCallId;
      }
      this.#hub.emit(event);
    }
  }

  /**
   * 审批与提问的开始与结束。它们只属于回合（events.ts 的顺序约定），不在回合中时忽略；适配器在回合结束、
   * 引擎退出之前先结束未决的审批与提问，所以 `approval.cancelled` / `question.cancelled` 不会被丢掉。工具调用之后
   * 才有审批：正在流式的一块内容先提交。
   */
  approval(
    event:
      | ApprovalRequestedEvent
      | ApprovalCancelledEvent
      | QuestionRequestedEvent
      | QuestionCancelledEvent,
  ): void {
    if (!this.#inTurn) return;
    if (event.type === 'approval.requested' || event.type === 'question.requested') {
      this.#flushChunks();
    }
    this.#hub.emit(event);
  }

  /** 计划（0.36.0，引擎的扩展请求，例如 Grok 的退出计划模式）。只属于回合；正在流式的一块内容先提交。 */
  plan(event: PlanProposedEvent): void {
    if (!this.#inTurn) return;
    this.#flushChunks();
    this.#hub.emit(event);
  }

  /**
   * 一次模型请求或一个回合的用量（0.62.0，引擎的扩展通知，例如 Grok 的 `turn_completed`）。和 `usage.updated` 一样不是可见
   * 内容，不截断正在流式的一块；回合外（引擎自己开的回合）也照发，Host 只把它记到用量表。
   */
  usage(event: UsageRecordedEvent): void {
    this.#hub.emit(event);
  }

  /** 回合的终结事件（`turn.settled` / `turn.failed`）。不在回合中时忽略。 */
  endTurn(event: Exclude<TurnTerminalEvent, { type: 'engine.exited' }>): void {
    if (!this.#inTurn) return;
    // 取消或出错时停在半途的一块内容按已生成的部分提交（与 dsh 取消时补发已生成部分的做法一致）。
    this.#flushChunks();
    this.#inTurn = false;
    this.#hub.emit(event);
  }

  /** 引擎进程退出：发 `engine.exited`（订阅的最后一个事件）并结束。 */
  exited(event: Extract<AgentEvent, { type: 'engine.exited' }>): void {
    if (this.#inTurn) this.#flushChunks();
    this.#inTurn = false;
    this.#hub.emit(event);
    this.#hub.end();
  }

  /** 结束订阅（会话关闭、适配器 dispose），不再发事件。 */
  end(): void {
    this.#inTurn = false;
    this.#hub.end();
  }

  /**
   * 逐字流式的引擎在回合中的文本增量：交给 `ChunkStream`，返回 true。内容不是文本（图片等）时返回 false，照
   * `mapAcpUpdate` 的规则保留为 `engine.raw`。
   */
  #streamedChunk(notification: AcpSessionNotification): boolean {
    const { update } = notification;
    if (
      update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk'
    ) {
      return false;
    }
    const content = update.content as { type?: unknown; text?: unknown } | null | undefined;
    if (content?.type !== 'text' || typeof content.text !== 'string') return false;
    const messageId =
      typeof update.messageId === 'string' && update.messageId !== ''
        ? update.messageId
        : undefined;
    const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning';
    for (const event of this.#chunks?.chunk(kind, messageId, content.text) ?? []) {
      this.#hub.emit(event);
    }
    return true;
  }

  #outsideTurn(notification: AcpSessionNotification): void {
    const kind = notification.update.sessionUpdate;
    this.#warnOnce(
      `acp:outside_turn:${kind}`,
      'ACP session/update 到达时没有进行中的回合，保留为 engine.raw',
      { engineSessionId: this.engineSessionId, sessionUpdate: kind },
    );
    this.#hub.emit(rawEvent(notification));
  }

  #flushChunks(): void {
    for (const event of this.#chunks?.flush() ?? []) this.#hub.emit(event);
  }
}

/** ACP `plan` 的 `entries`（`content`、`status`，`priority` 不用）→ 待办条目；形状不对时 undefined。 */
function planItems(entries: unknown): TodoItem[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const items: TodoItem[] = [];
  for (const entry of entries) {
    const { content, status } = (entry ?? {}) as { content?: unknown; status?: unknown };
    if (typeof content !== 'string' || typeof status !== 'string') return undefined;
    items.push({ content, status });
  }
  return items;
}

/** 同一个 `key` 只告警一次（一个适配器实例内），避免同类消息刷屏。 */
export type WarnOnce = (key: string, message: string, fields?: Record<string, unknown>) => void;

export function warnOnceVia(logger: AdapterLogger): WarnOnce {
  const seen = new Set<string>();
  return (key, message, fields) => {
    if (seen.has(key)) return;
    seen.add(key);
    logger.warn(message, fields);
  };
}
