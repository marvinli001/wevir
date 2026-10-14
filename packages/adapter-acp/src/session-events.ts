import {
  type AgentEvent,
  type ApprovalCancelledEvent,
  type ApprovalRequestedEvent,
  EventHub,
  type TurnTerminalEvent,
} from '@wevir/runtime-adapter';
import {
  type AcpRawReason,
  type AcpSessionNotification,
  mapAcpUpdate,
  rawEvent,
} from './acp-mapping.js';
import type {
  AcpEngine,
  AcpToolPresentation,
  IncrementalEvent,
  IncrementalMerger,
} from './engine.js';

/** 适配器的告警出口；Host 的 Logger 满足这个接口。 */
export interface AdapterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 一个引擎会话的有序事件队列。各路输入都是同步调用，按调用顺序产出事件：
 * - ACP `session/update`：AcpProcess 在 SDK 之前按引擎写出的顺序交来（acp-process.ts），所以本队列里的
 *   ACP 事件与 ACP 交付顺序一致，并且排在同一条流里后到的 `session/prompt` 结果（回合终结事件）之前；
 * - 增量旁路（引擎描述有 `incremental` 时，另一条管道）：实时转发，由引擎给的对齐器与已提交消息对齐；
 * - 审批：适配器收到 `session/request_permission` 与结束未决审批时交来；
 * - 回合边界：适配器发出 `session/prompt` 时 `beginTurn`，拿到结果时 `endTurn`。
 *
 * 回合之外只发 `engine.raw` 与 `engine.exited`（events.ts 的顺序约定）：回合外到达的其他 ACP 更新改发
 * `engine.raw` 并告警，增量与 stream_ended 丢弃（dsh 的 committed end 帧可能晚于 `session/prompt` 的结果，
 * T3.2a 实测）。
 */
export class SessionEventQueue {
  readonly engineSessionId: string;
  readonly #hub = new EventHub<AgentEvent>();
  readonly #tools: AcpToolPresentation;
  readonly #merger: IncrementalMerger | undefined;
  readonly #warnOnce: WarnOnce;
  #inTurn = false;

  constructor(
    engineSessionId: string,
    warnOnce: WarnOnce,
    engine: Pick<AcpEngine, 'tools' | 'incremental'>,
  ) {
    this.engineSessionId = engineSessionId;
    this.#warnOnce = warnOnce;
    this.#tools = engine.tools;
    this.#merger = engine.incremental?.createMerger();
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
    const events = mapAcpUpdate(notification, this.#tools, onRaw);
    if (
      !this.#inTurn &&
      events.some((e) => e.type !== 'engine.raw' && e.type !== 'usage.updated')
    ) {
      this.#warnOnce(
        `acp:outside_turn:${kind}`,
        'ACP session/update 到达时没有进行中的回合，保留为 engine.raw',
        { engineSessionId: this.engineSessionId, sessionUpdate: kind },
      );
      this.#hub.emit(rawEvent(notification));
      return;
    }
    for (const event of events) {
      if (event.type === 'assistant.message' || event.type === 'assistant.thought') {
        const blockKind = event.type === 'assistant.message' ? 'text' : 'reasoning';
        const replaces = this.#merger?.commit(blockKind, event.messageId, event.text) ?? [];
        this.#hub.emit({ ...event, replaces });
      } else {
        this.#hub.emit(event);
      }
    }
  }

  /** 增量旁路的增量与 stream_ended。引擎没有旁路、或不在回合中时忽略。 */
  incremental(event: IncrementalEvent): void {
    if (!this.#inTurn || this.#merger === undefined) return;
    const out =
      event.type === 'assistant.delta' ? this.#merger.delta(event) : this.#merger.ended(event);
    if (out !== undefined) this.#hub.emit(out);
  }

  /**
   * 审批的开始与结束。审批只属于回合（events.ts 的顺序约定），不在回合中时忽略；适配器在回合结束、
   * 引擎退出之前先结束未决审批，所以 `approval.cancelled` 不会被丢掉。
   */
  approval(event: ApprovalRequestedEvent | ApprovalCancelledEvent): void {
    if (this.#inTurn) this.#hub.emit(event);
  }

  /** 回合的终结事件（`turn.settled` / `turn.failed`）。不在回合中时忽略。 */
  endTurn(event: Exclude<TurnTerminalEvent, { type: 'engine.exited' }>): void {
    if (!this.#inTurn) return;
    this.#inTurn = false;
    this.#merger?.reset();
    this.#hub.emit(event);
  }

  /** 引擎进程退出：发 `engine.exited`（订阅的最后一个事件）并结束。 */
  exited(event: Extract<AgentEvent, { type: 'engine.exited' }>): void {
    this.#inTurn = false;
    this.#hub.emit(event);
    this.#hub.end();
  }

  /** 结束订阅（会话关闭、适配器 dispose），不再发事件。 */
  end(): void {
    this.#inTurn = false;
    this.#hub.end();
  }
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
