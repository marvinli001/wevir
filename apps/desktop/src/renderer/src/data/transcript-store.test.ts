import type { WevirClient } from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptCache } from './transcript-store';

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
