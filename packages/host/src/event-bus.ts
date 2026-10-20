import type { SessionId, WevirEvent } from '@wevir/protocol';

export type EventListener = (event: WevirEvent) => void;

interface Subscription {
  readonly listener: EventListener;
  /** 只交付 `seq` 大于它的事件。 */
  afterSeq: number;
  active: boolean;
}

/**
 * 进程内事件总线：事件库提交成功后按 `seq` 顺序同步通知同一会话的订阅者。
 *
 * - **全局按发布顺序交付。** 订阅者在回调里再追加事件（重入）时，新事件排在队尾，等当前这批交付给
 *   所有订阅者之后才交付；每个订阅者看到的同一会话的事件都按 `seq` 递增。
 * - **只收 `afterSeq` 之后的事件。** 订阅时给出订阅那一刻库里的 `lastSeq`；已提交、还在队列里没交付的
 *   事件不会再交给它，所以“先按 `lastSeq` 回放、再收实时事件”不丢不重（host-api.md §4）。
 * - 订阅者抛出的错误交给 `onError`，不影响其他订阅者，也不影响已提交的追加。
 */
export class EventBus {
  readonly #subscriptions = new Map<SessionId, Set<Subscription>>();
  /** 收全部会话事件的监听者（0.65.0，回合后验证）：按发布顺序，不回放。 */
  readonly #everything = new Set<EventListener>();
  readonly #queue: WevirEvent[] = [];
  readonly #onError: (error: unknown) => void;
  #draining = false;

  constructor(options: { onError: (error: unknown) => void }) {
    this.#onError = options.onError;
  }

  /** 订阅一个会话 `seq > afterSeq` 的事件，返回退订函数（可重复调用）。 */
  subscribe(sessionId: SessionId, listener: EventListener, afterSeq: number): () => void {
    const subscription: Subscription = { listener, afterSeq, active: true };
    let set = this.#subscriptions.get(sessionId);
    if (!set) {
      set = new Set();
      this.#subscriptions.set(sessionId, set);
    }
    set.add(subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      set.delete(subscription);
      if (set.size === 0 && this.#subscriptions.get(sessionId) === set) {
        this.#subscriptions.delete(sessionId);
      }
    };
  }

  /** 收此后发布的全部会话的事件（不回放），返回取消函数。监听者在回调里追加的事件同样排在队尾。 */
  listenAll(listener: EventListener): () => void {
    this.#everything.add(listener);
    return () => this.#everything.delete(listener);
  }

  publish(events: readonly WevirEvent[]): void {
    this.#queue.push(...events);
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let event = this.#queue.shift(); event; event = this.#queue.shift()) {
        this.#deliver(event);
      }
    } finally {
      this.#draining = false;
    }
  }

  #deliver(event: WevirEvent): void {
    for (const listener of [...this.#everything]) {
      try {
        listener(event);
      } catch (error) {
        this.#onError(error);
      }
    }
    const set = this.#subscriptions.get(event.sessionId);
    if (!set) return;
    for (const subscription of [...set]) {
      if (!subscription.active || event.seq <= subscription.afterSeq) continue;
      subscription.afterSeq = event.seq;
      try {
        subscription.listener(event);
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}
