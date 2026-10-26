import type { SubscriptionItem, WevirClient } from '@wevir/client-sdk';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptCache, TranscriptStore } from './transcript-store';

const id = (n: number) => `ses_${n}` as SessionId;

/** 订阅永远不来事件；记下哪些会话的订阅被关掉了。 */
function fakeClient() {
  const closed = new Set<SessionId>();
  const client = {
    subscribe: (sessionId: SessionId) => ({
      close: () => closed.add(sessionId),
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    }),
  } as unknown as WevirClient;
  return { client, closed };
}

/** 由测试逐项推送的订阅。 */
function feedClient() {
  const items: SubscriptionItem[] = [];
  let wake: (() => void) | undefined;
  const push = (item: SubscriptionItem) => {
    items.push(item);
    wake?.();
  };
  const next = async (): Promise<IteratorResult<SubscriptionItem>> => {
    while (items.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    return { done: false, value: items.shift() as SubscriptionItem };
  };
  const client = {
    subscribe: () => ({ close: () => {}, [Symbol.asyncIterator]: () => ({ next }) }),
  } as unknown as WevirClient;
  let seq = 0;
  const stateChanged = (to: 'running' | 'idle') =>
    push({
      type: 'event',
      event: {
        seq: ++seq,
        sessionId: id(1),
        ts: new Date(Date.UTC(2026, 9, 27, 8, 0, 0, seq)).toISOString(),
        type: 'session.state_changed',
        source: 'host',
        payload: { from: to === 'running' ? 'idle' : 'running', to, reason: 'turn_started' },
      } as WevirEvent,
    });
  return { client, push, stateChanged };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 按帧冲刷（lib/frame.ts）在 Node 上用计时器代替。
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TranscriptCache', () => {
  it('没人看时按最近使用留 4 个', () => {
    const { client, closed } = fakeClient();
    const cache = new TranscriptCache(client);
    for (let n = 1; n <= 6; n++) cache.get(id(n));
    vi.runOnlyPendingTimers();
    expect([...closed]).toEqual([id(1), id(2)]);
    cache.dispose();
  });

  it('界面上正显示的不换掉，超出的只换没人看的', () => {
    const { client, closed } = fakeClient();
    const cache = new TranscriptCache(client);
    const unsubscribe: (() => void)[] = [];
    // 五个同时显示（主会话、窗格与卡片里的子会话），再看一个新的。
    for (let n = 1; n <= 5; n++) unsubscribe.push(cache.get(id(n)).subscribe(() => {}));
    cache.get(id(6));
    vi.runOnlyPendingTimers();
    expect(closed.size).toBe(0);
    // 关掉两个窗格：它们没人看了，最久没用的先换掉，直到回到 4 个。
    unsubscribe[0]?.();
    unsubscribe[1]?.();
    vi.runOnlyPendingTimers();
    expect([...closed]).toEqual([id(1), id(2)]);
    cache.dispose();
  });

  it('刚取的那个即使还没订阅也不换掉', () => {
    const { client, closed } = fakeClient();
    const cache = new TranscriptCache(client);
    for (let n = 1; n <= 4; n++) cache.get(id(n)).subscribe(() => {});
    const latest = cache.get(id(5));
    vi.runOnlyPendingTimers();
    expect(closed.has(id(5))).toBe(false);
    latest.subscribe(() => {});
    cache.dispose();
  });

  it('再取同一个会话时用同一份投影', () => {
    const { client } = fakeClient();
    const cache = new TranscriptCache(client);
    const first = cache.get(id(1));
    cache.get(id(2));
    expect(cache.get(id(1))).toBe(first);
    cache.dispose();
  });
});

describe('TranscriptStore', () => {
  it('回放追平之前不交出回放到一半的消息流', async () => {
    const { client, push, stateChanged } = feedClient();
    const store = new TranscriptStore(client, id(1));
    const listener = vi.fn();
    store.subscribe(listener);
    stateChanged('running');
    stateChanged('idle');
    await vi.runOnlyPendingTimersAsync();
    // 回放中的回合看起来还在进行，交出去就会先展开再收起。
    expect(store.get()).toMatchObject({ caughtUp: false, transcript: { lastSeq: 0 } });
    push({ type: 'caught_up', seq: 2 });
    await vi.runOnlyPendingTimersAsync();
    expect(store.get()).toMatchObject({
      caughtUp: true,
      transcript: { lastSeq: 2, state: 'idle' },
    });
    // 追平之后的实时事件照常按帧交出。
    stateChanged('running');
    await vi.runOnlyPendingTimersAsync();
    expect(store.get().transcript).toMatchObject({ lastSeq: 3, state: 'running' });
    expect(listener).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('没人看时到的事件，读的时候就是最新的', async () => {
    const { client, push, stateChanged } = feedClient();
    const store = new TranscriptStore(client, id(1));
    const unsubscribe = store.subscribe(() => {});
    stateChanged('running');
    push({ type: 'caught_up', seq: 1 });
    await vi.runOnlyPendingTimersAsync();
    unsubscribe();
    stateChanged('idle');
    await vi.advanceTimersByTimeAsync(0);
    // 切回来的第一帧不等下一次冲刷。
    expect(store.get().transcript).toMatchObject({ lastSeq: 2, state: 'idle' });
    expect(store.get()).toBe(store.get());
    store.dispose();
  });
});
