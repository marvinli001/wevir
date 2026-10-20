import type { AccountKind, AccountState } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nextReset,
  USAGE_ACTIVE_MS,
  USAGE_AFTER_TURN_MS,
  USAGE_IDLE_MS,
  USAGE_NUDGE_MIN_MS,
  USAGE_RESET_GRACE_MS,
  USAGE_TICK_MS,
  UsageRefresher,
  type UsageRefreshTarget,
} from './usage-refresh.js';

// UsageRefresher 对着假的账号：记下每次 refreshUsage，状态由测试经 observe 推进去。

function setup(kinds: AccountKind[] = ['cursor', 'grok']) {
  const calls: string[] = [];
  let observer: ((state: AccountState) => void) | undefined;
  const target: UsageRefreshTarget & { watching: boolean } = {
    ids: kinds,
    watching: true,
    refreshUsage: async (id) => {
      calls.push(id);
    },
    observe: (listener) => {
      observer = listener;
      return () => {
        observer = undefined;
      };
    },
  };
  // 假定时器同时推进 Date.now()。
  vi.setSystemTime(Date.parse('2026-10-20T08:00:00.000Z'));
  const refresher = new UsageRefresher({ target, onWarning: () => {} });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  /** 时钟走了、定时器没跑（电脑睡着了）。 */
  const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const push = (state: AccountState) => observer?.(state);
  return { refresher, target, calls, advance, sleep, push, now: () => Date.now() };
}

const signedIn = (kind: AccountKind, rateLimits?: AccountState['rateLimits']): AccountState => ({
  kind,
  status: 'signed_in',
  ...(rateLimits !== undefined && { rateLimits }),
});

describe('UsageRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('有客户端看着时每 5 分钟读一次已登录的账号；没登录的不读', async () => {
    const { refresher, calls, advance, push } = setup();
    push(signedIn('cursor', { primary: { usedPercent: 10 } }));
    push({ kind: 'grok', status: 'signed_out' });
    refresher.start();
    await advance(USAGE_IDLE_MS - USAGE_TICK_MS);
    expect(calls).toEqual([]);
    await advance(USAGE_TICK_MS);
    expect(calls).toEqual(['cursor']);
    await advance(USAGE_IDLE_MS);
    expect(calls).toEqual(['cursor', 'cursor']);
    refresher.dispose();
  });

  it('没有客户端时不读；回合结束后照样读，之后一段时间每分钟一次', async () => {
    const { refresher, target, calls, advance, push } = setup();
    target.watching = false;
    push(signedIn('cursor', { primary: { usedPercent: 10 } }));
    refresher.start();
    await advance(USAGE_IDLE_MS * 2);
    expect(calls).toEqual([]);
    refresher.turnEnded('cursor');
    await advance(USAGE_AFTER_TURN_MS);
    expect(calls).toEqual(['cursor']);
    // 检查每 30 秒一次，所以至多晚一个检查间隔。
    await advance(USAGE_ACTIVE_MS + USAGE_TICK_MS);
    expect(calls).toEqual(['cursor', 'cursor']);
    refresher.turnEnded('opencode');
    await advance(USAGE_AFTER_TURN_MS);
    expect(calls).toEqual(['cursor', 'cursor']);
    refresher.dispose();
  });

  it('重置时间过了一会儿就读', async () => {
    const { refresher, calls, advance, push, now } = setup();
    const resetsAt = new Date(now() + 2 * 60_000).toISOString();
    push(signedIn('cursor', { primary: { usedPercent: 100, resetsAt } }));
    refresher.start();
    await advance(2 * 60_000 + USAGE_RESET_GRACE_MS);
    expect(calls).toEqual(['cursor']);
    // 读过的重置时间不再触发。
    await advance(USAGE_TICK_MS * 2);
    expect(calls).toEqual(['cursor']);
    refresher.dispose();
  });

  it('客户端回到前台：离上次读超过 1 分钟才读；只催指定的种类', async () => {
    const { refresher, calls, advance, push } = setup();
    push(signedIn('cursor', { primary: { usedPercent: 10 } }));
    push(signedIn('grok', { primary: { usedPercent: 10 } }));
    refresher.nudge('cursor');
    // 刚读到带用量的已登录状态，算刚读过。
    expect(calls).toEqual([]);
    await advance(USAGE_NUDGE_MIN_MS);
    refresher.nudge('cursor');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['cursor']);
    refresher.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['cursor', 'grok']);
    refresher.dispose();
  });

  it('睡眠醒来（两次检查隔得远）全部读一次', async () => {
    const { refresher, calls, advance, sleep, push } = setup();
    push(signedIn('cursor', { primary: { usedPercent: 10 } }));
    push(signedIn('grok', { primary: { usedPercent: 10 } }));
    refresher.start();
    await advance(USAGE_TICK_MS);
    expect(calls).toEqual([]);
    sleep(2 * 60_000);
    await advance(USAGE_TICK_MS);
    expect(calls).toEqual(['cursor', 'grok']);
    refresher.dispose();
  });

  it('同一种的两个账号（0.63.0）按账号 ID 分开读；之后添加的账号报了状态就算上，删掉的不再读', async () => {
    const { refresher, calls, advance, push } = setup(['cursor']);
    push(signedIn('cursor', { primary: { usedPercent: 10 } }));
    push({ ...signedIn('cursor', { primary: { usedPercent: 20 } }), id: 'cursor-1a2b' });
    refresher.start();
    refresher.turnEnded('cursor-1a2b');
    await advance(USAGE_AFTER_TURN_MS);
    expect(calls).toEqual(['cursor-1a2b']);
    refresher.forget('cursor-1a2b');
    await advance(USAGE_NUDGE_MIN_MS);
    refresher.nudge();
    await advance(USAGE_TICK_MS);
    expect(calls).toEqual(['cursor-1a2b', 'cursor']);
    refresher.dispose();
  });

  it('nextReset：各窗口里最早的、还没到的', () => {
    const now = Date.parse('2026-10-20T08:00:00.000Z');
    expect(
      nextReset(
        signedIn('antigravity', {
          windows: [
            { usedPercent: 1, resetsAt: '2026-10-20T07:00:00.000Z' },
            { usedPercent: 1, resetsAt: '2026-10-21T00:00:00.000Z' },
            { usedPercent: 1, resetsAt: '2026-10-20T12:00:00.000Z' },
            { usedPercent: 1 },
          ],
        }),
        now,
      ),
    ).toBe(Date.parse('2026-10-20T12:00:00.000Z'));
    expect(nextReset(signedIn('cursor'), now)).toBeUndefined();
  });
});
