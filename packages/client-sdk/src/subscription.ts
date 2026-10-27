import {
  isKnownEventType,
  type SessionId,
  type SubscriptionId,
  type WevirEvent,
  type WevirEventEnvelope,
  WevirEventSchema,
} from '@wevir/protocol';

/** 订阅产出的一项。 */
export type SubscriptionItem =
  /** 一条认识的事件，按 `seq` 升序、不重不漏。 */
  | { type: 'event'; event: WevirEvent }
  /**
   * 回放结束：已应用到订阅建立时 Host 的 `lastSeq`（`replayedThroughSeq`），之后都是实时事件。每个订阅
   * 只出现一次（`reset` 之后再出现一次）；断线重连后的补发对上层透明，不再出现。
   */
  | { type: 'caught_up'; seq: number }
  /**
   * 本地已应用的 `seq` 比 Host 的还新（例如数据目录被替换），上层丢弃基于这个会话已有事件的投影；
   * 之后从 `seq = 1` 重新回放（host-api.md §4）。
   */
  | { type: 'reset' };

export interface SubscribeOptions {
  /** 已经应用过的最大 `seq`；补发 `seq > sinceSeq` 的事件。默认 0（从头回放）。 */
  sinceSeq?: number;
  /**
   * 补发时让 Host 去掉已被取代的内容（0.127.0，`events.subscribe` 的 `elideSuperseded`）：只关心投影最后样子的订阅者用，回放的
   * 字节少得多；要看工具中间输出的不用。断线重连后的每次续订都带上。
   */
  elideSuperseded?: boolean;
}

/**
 * 一个会话的事件流（`WevirClient.subscribe`）。断线重连、发现缺口后的重新订阅都在内部完成，上层只看到
 * 按 `seq` 连续的事件。`break` 出 `for await` 或调用 `close()` 即退订。客户端关闭时迭代正常结束；遇到
 * 不可恢复的错误（会话不存在、客户端因协议不兼容关闭等）时迭代以该错误结束。
 */
export interface EventSubscription extends AsyncIterableIterator<SubscriptionItem> {
  readonly sessionId: SessionId;
  /** 已应用的最大 `seq`（含因为不认识而跳过内容的事件）。 */
  readonly lastSeq: number;
  /** 当前是否已追平：订阅已建立，且已应用到它的 `replayedThroughSeq`。 */
  readonly caughtUp: boolean;
  close(): void;
}

export type ApplyResult = 'applied' | 'duplicate' | 'gap';

interface FeedHooks {
  /** 上层关闭了订阅（`close()`、`break`）。 */
  onClose(feed: SessionFeed): void;
  onWarning(message: string, detail?: Record<string, unknown>): void;
}

type Waiter = {
  resolve(result: IteratorResult<SubscriptionItem, undefined>): void;
  reject(error: unknown): void;
};

/**
 * `EventSubscription` 的实现，也是客户端内部记录订阅状态的地方。按 `seq` 应用事件（host-api.md §4）：
 * `seq == lastSeq + 1` 接受，`<= lastSeq` 是重复、丢弃，更大是缺口，由客户端以 `sinceSeq = lastSeq`
 * 重新订阅。
 */
export class SessionFeed implements EventSubscription {
  readonly sessionId: SessionId;
  /** 当前的服务端订阅；断线、发现缺口之后为 undefined，直到重新订阅成功。 */
  serverId: SubscriptionId | undefined;
  /** 每发起一次订阅加一，退订时也加一；回调据此丢弃过期的结果。 */
  generation = 0;
  /** 上一次因缺口重新订阅时的 `lastSeq`，与停在它上面连续重新订阅的次数。 */
  resyncSeq = -1;
  resyncCount = 0;
  /** 每次（续）订阅都带 `elideSuperseded`（`SubscribeOptions`）。 */
  elideSuperseded = false;
  readonly #hooks: FeedHooks;
  #lastSeq: number;
  /** 当前服务端订阅的 `replayedThroughSeq`。 */
  #through = 0;
  #caughtUp = false;
  /** 下一次追平时是否产出 `caught_up`。 */
  #announce = true;
  readonly #items: SubscriptionItem[] = [];
  readonly #waiters: Waiter[] = [];
  #ended = false;
  #failure: { error: unknown } | undefined;

  constructor(sessionId: SessionId, sinceSeq: number, hooks: FeedHooks) {
    this.sessionId = sessionId;
    this.#lastSeq = sinceSeq;
    this.#hooks = hooks;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get caughtUp(): boolean {
    return this.#caughtUp;
  }

  /** 已结束（上层关闭、客户端关闭或出错）。 */
  get ended(): boolean {
    return this.#ended;
  }

  /**
   * 服务端订阅建立了。本地的 `lastSeq` 比 `replayedThroughSeq` 还大时返回 `reset`，不登记：客户端退订它、
   * 调用 `reset()` 后从 0 重新订阅。
   */
  attach(serverId: SubscriptionId, replayedThroughSeq: number): 'attached' | 'reset' {
    if (this.#lastSeq > replayedThroughSeq) return 'reset';
    this.serverId = serverId;
    this.#through = replayedThroughSeq;
    if (this.#lastSeq >= replayedThroughSeq) this.#markCaughtUp();
    else this.#caughtUp = false;
    return 'attached';
  }

  /** 服务端订阅作废了（断线、发现缺口）。 */
  detach(): void {
    this.serverId = undefined;
    this.#caughtUp = false;
  }

  reset(): void {
    this.detach();
    this.#lastSeq = 0;
    this.#through = 0;
    this.#announce = true;
    this.#push({ type: 'reset' });
  }

  /** 应用当前服务端订阅送来的一条事件。`raw` 是原始对象，`envelope` 是它按信封解析的结果。 */
  apply(raw: unknown, envelope: WevirEventEnvelope): ApplyResult {
    if (envelope.seq <= this.#lastSeq) return 'duplicate';
    if (envelope.seq !== this.#lastSeq + 1) return 'gap';
    this.#lastSeq = envelope.seq;
    // 不认识的类型（Host 比客户端新）忽略内容、照常推进 lastSeq（host-api.md §4、§10 规则 5）。
    if (isKnownEventType(envelope.type)) {
      const parsed = WevirEventSchema.safeParse(raw);
      if (parsed.success) {
        this.#push({ type: 'event', event: parsed.data });
      } else {
        this.#hooks.onWarning('skipped an event that does not match its schema', {
          sessionId: this.sessionId,
          seq: envelope.seq,
          type: envelope.type,
          issues: parsed.error.issues,
        });
      }
    }
    if (!this.#caughtUp && this.serverId !== undefined && this.#lastSeq >= this.#through) {
      this.#markCaughtUp();
    }
    return 'applied';
  }

  /** 客户端关闭：已产出的项仍可读完，之后迭代结束。 */
  finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  /** 不可恢复的错误：已产出的项读完之后，下一次 `next()` 以它 reject。 */
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    const [first, ...rest] = this.#waiters.splice(0);
    if (first) first.reject(error);
    else this.#failure = { error };
    for (const waiter of rest) waiter.resolve({ done: true, value: undefined });
  }

  close(): void {
    if (this.#ended) return;
    this.#items.length = 0;
    this.finish();
    this.#hooks.onClose(this);
  }

  next(): Promise<IteratorResult<SubscriptionItem, undefined>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve({ done: false, value: item });
    if (this.#failure) {
      const { error } = this.#failure;
      this.#failure = undefined;
      return Promise.reject(error);
    }
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<SubscriptionItem, undefined>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  #markCaughtUp(): void {
    this.#caughtUp = true;
    if (!this.#announce) return;
    this.#announce = false;
    this.#push({ type: 'caught_up', seq: this.#lastSeq });
  }

  #push(item: SubscriptionItem): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }
}
