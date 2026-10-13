// 一个会话的消息投影（T5.3）：从 seq 0 订阅、按 seq 交给 client-sdk 的 TranscriptProjection，攒到下一帧再
// 取一次快照通知界面（openwork-notes §3.1：可见会话按帧冲刷增量）。没有人在看的投影只应用事件、不取快照。
// 最近看过的几个会话保留订阅，切回来不用从头回放。

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

/** 同时保留订阅的会话数（当前会话 + 最近切走的几个）。 */
const KEEP_ALIVE = 4;

/** engine.raw 只在开发模式投影（domain-model §8；T5.3 第 7 条）。 */
const INCLUDE_RAW = import.meta.env.DEV;

export class TranscriptStore {
  readonly sessionId: SessionId;
  readonly #projection = new TranscriptProjection({ includeRaw: INCLUDE_RAW });
  readonly #subscription: EventSubscription;
  readonly #listeners = new Set<() => void>();
  readonly #batch = frameBatcher(() => this.#flush());
  #state: TranscriptState;
  #caughtUp = false;
  #error: string | undefined;

  constructor(client: WevirClient, sessionId: SessionId) {
    this.sessionId = sessionId;
    this.#state = { transcript: this.#projection.snapshot(), caughtUp: false };
    this.#subscription = client.subscribe(sessionId);
    void this.#consume();
  }

  get = (): TranscriptState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    // 没人看的时候没有取快照，补一次。
    this.#batch.request();
    return () => this.#listeners.delete(listener);
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
        else this.#projection.reset();
        if (this.#listeners.size > 0) this.#batch.request();
      }
    } catch (error) {
      this.#error = describe(error);
      this.#batch.request();
    }
  }

  #flush(): void {
    const transcript = this.#projection.snapshot();
    const state = this.#state;
    if (
      transcript === state.transcript &&
      this.#caughtUp === state.caughtUp &&
      this.#error === state.error
    ) {
      return;
    }
    this.#state = {
      transcript,
      caughtUp: this.#caughtUp,
      ...(this.#error !== undefined && { error: this.#error }),
    };
    for (const listener of this.#listeners) listener();
  }
}

/** 每个客户端一份：按最近使用保留 `KEEP_ALIVE` 个会话的投影。 */
export class TranscriptCache {
  readonly #client: WevirClient;
  readonly #stores = new Map<SessionId, TranscriptStore>();

  constructor(client: WevirClient) {
    this.#client = client;
  }

  get(sessionId: SessionId): TranscriptStore {
    let store = this.#stores.get(sessionId);
    if (store) {
      this.#stores.delete(sessionId);
    } else {
      store = new TranscriptStore(this.#client, sessionId);
    }
    this.#stores.set(sessionId, store);
    for (const [id, old] of this.#stores) {
      if (this.#stores.size <= KEEP_ALIVE) break;
      old.dispose();
      this.#stores.delete(id);
    }
    return store;
  }

  dispose(): void {
    for (const store of this.#stores.values()) store.dispose();
    this.#stores.clear();
  }
}
