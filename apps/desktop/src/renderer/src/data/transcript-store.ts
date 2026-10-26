// 一个会话的消息投影（T5.3）：从 seq 0 订阅、按 seq 交给 client-sdk 的 TranscriptProjection，攒到下一帧再
// 取一次快照通知界面（openwork-notes §3.1：可见会话按帧冲刷增量）。没有人在看的投影只应用事件、不取快照，切回来读的
// 时候再取。回放追平之前不交出快照：回放到一半的回合还没有 turn.finished，会按进行中的样子展开、跟着滚，追平后
// 又收起来；打开会话时界面一开始就是完整的消息流。最近看过的几个会话保留订阅，切回来不用从头回放；界面上正显示的不会被换掉。

import {
  type EventSubscription,
  type Transcript,
  TranscriptProjection,
  type WevirClient,
} from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import { describe } from '@/host/host-connection';
import { frameBatcher } from '@/lib/frame';

export interface TranscriptState {
  transcript: Transcript;
  /** 回放已追平（之后都是实时事件）。 */
  caughtUp: boolean;
  /** 订阅以错误结束（会话不存在等）。 */
  error?: string;
}

/** 同时保留订阅的会话数（当前会话 + 最近切走的几个）。界面上同时显示的更多时，显示着的都留着、只是不再多留没人看的。 */
const KEEP_ALIVE = 4;

/** engine.raw 只在开发模式投影（domain-model §8；T5.3 第 7 条）。 */
const INCLUDE_RAW = import.meta.env.DEV;

export class TranscriptStore {
  readonly sessionId: SessionId;
  readonly #projection = new TranscriptProjection({ includeRaw: INCLUDE_RAW });
  readonly #subscription: EventSubscription;
  readonly #listeners = new Set<() => void>();
  readonly #batch = frameBatcher(() => this.#flush());
  readonly #onIdle: (() => void) | undefined;
  #state: TranscriptState;
  #caughtUp = false;
  #error: string | undefined;

  /** `onIdle`：最后一个订阅者离开时调用（缓存借此换掉多出来的投影）。 */
  constructor(client: WevirClient, sessionId: SessionId, onIdle?: () => void) {
    this.sessionId = sessionId;
    this.#onIdle = onIdle;
    this.#state = { transcript: this.#projection.snapshot(), caughtUp: false };
    this.#subscription = client.subscribe(sessionId);
    void this.#consume();
  }

  get = (): TranscriptState => {
    // 没人看时事件没有冲刷：读的时候补上，切回来的第一帧就是最新的，不先画一帧旧的。
    if (this.#listeners.size === 0) this.#refresh();
    return this.#state;
  };

  /** 有组件订阅着（界面上正显示它）。 */
  get watched(): boolean {
    return this.#listeners.size > 0;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    // 没人看的时候没有取快照，补一次。
    this.#batch.request();
    return () => {
      if (this.#listeners.delete(listener) && this.#listeners.size === 0) this.#onIdle?.();
    };
  };

  dispose(): void {
    this.#batch.cancel();
    this.#subscription.close();
    this.#listeners.clear();
  }

  async #consume(): Promise<void> {
    try {
      for await (const item of this.#subscription) {
        if (item.type === 'event') this.#projection.apply(item.event);
        else if (item.type === 'caught_up') this.#caughtUp = true;
        else {
          // 从头重新回放，同样等追平。
          this.#projection.reset();
          this.#caughtUp = false;
        }
        if (this.#listeners.size > 0) this.#batch.request();
      }
    } catch (error) {
      this.#error = describe(error);
      this.#batch.request();
    }
  }

  #flush(): void {
    if (this.#refresh()) for (const listener of this.#listeners) listener();
  }

  /** 按投影更新 `#state`，有变化时返回 true。追平之前消息流停在上一次交出的样子（新订阅是空的）。 */
  #refresh(): boolean {
    const state = this.#state;
    const transcript = this.#caughtUp ? this.#projection.snapshot() : state.transcript;
    if (
      transcript === state.transcript &&
      this.#caughtUp === state.caughtUp &&
      this.#error === state.error
    ) {
      return false;
    }
    this.#state = {
      transcript,
      caughtUp: this.#caughtUp,
      ...(this.#error !== undefined && { error: this.#error }),
    };
    return true;
  }
}

/**
 * 每个客户端一份：按最近使用保留 `KEEP_ALIVE` 个会话的投影，只换掉没人在看的；界面上正显示的（主会话、窗格与侧栏卡片里的
 * 子会话）一直保留，换掉了它界面就不再更新。`get` 在渲染时调用，那时新组件还没订阅：换掉多余的投影放到这次提交之后再做，
 * 免得换掉刚要用的。
 */
export class TranscriptCache {
  readonly #client: WevirClient;
  readonly #stores = new Map<SessionId, TranscriptStore>();
  #trimTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最近一次 `get` 的会话：它的组件可能还没提交、没订阅，不换掉它。 */
  #latest: SessionId | undefined;

  constructor(client: WevirClient) {
    this.#client = client;
  }

  get(sessionId: SessionId): TranscriptStore {
    let store = this.#stores.get(sessionId);
    if (store) {
      this.#stores.delete(sessionId);
    } else {
      store = new TranscriptStore(this.#client, sessionId, () => this.#scheduleTrim());
    }
    this.#stores.set(sessionId, store);
    this.#latest = sessionId;
    this.#scheduleTrim();
    return store;
  }

  dispose(): void {
    clearTimeout(this.#trimTimer);
    this.#trimTimer = undefined;
    for (const store of this.#stores.values()) store.dispose();
    this.#stores.clear();
  }

  #scheduleTrim(): void {
    this.#trimTimer ??= setTimeout(() => {
      this.#trimTimer = undefined;
      this.#trim();
    }, 0);
  }

  /** 超过 `KEEP_ALIVE` 个时，从最久没用的换掉没人在看的。 */
  #trim(): void {
    for (const [id, store] of this.#stores) {
      if (this.#stores.size <= KEEP_ALIVE) break;
      if (store.watched || id === this.#latest) continue;
      store.dispose();
      this.#stores.delete(id);
    }
  }
}
