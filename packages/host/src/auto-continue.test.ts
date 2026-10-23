import type { AccountState, SessionId } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_CONTINUE_DELAY_MS,
  AutoContinueTimers,
  completeUsageLimit,
  resumeAtFor,
} from './auto-continue.js';

const account = (rateLimits: AccountState['rateLimits']): AccountState => ({
  kind: 'chatgpt',
  status: 'signed_in',
  ...(rateLimits !== undefined && { rateLimits }),
});

describe('completeUsageLimit', () => {
  it('引擎报了重置时刻就用它', () => {
    expect(
      completeUsageLimit(
        { resetsAt: '2026-10-23T10:00:00Z', windowMinutes: 300 },
        account({ primary: { usedPercent: 100, resetsAt: '2026-10-24T00:00:00.000Z' } }),
      ),
    ).toEqual({ resetsAt: '2026-10-23T10:00:00.000Z', windowMinutes: 300 });
  });

  it('没报时取用完的窗口里最晚重置的那个，窗口长度跟着它；没用完的不算', () => {
    const state = account({
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-10-23T10:00:00.000Z' },
      secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-10-27T10:00:00.000Z' },
      windows: [
        { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-10-23T10:00:00.000Z' },
        { usedPercent: 40, windowMinutes: 10080, resetsAt: '2026-10-29T10:00:00.000Z' },
      ],
    });
    // `windows` 优先于 primary / secondary。
    expect(completeUsageLimit({}, state)).toEqual({
      resetsAt: '2026-10-23T10:00:00.000Z',
      windowMinutes: 300,
    });
    const { windows: _windows, ...legacy } = state.rateLimits ?? {};
    expect(completeUsageLimit({}, account(legacy as AccountState['rateLimits']))).toEqual({
      resetsAt: '2026-10-27T10:00:00.000Z',
      windowMinutes: 10080,
    });
    expect(completeUsageLimit({ windowMinutes: 300 }, undefined)).toEqual({ windowMinutes: 300 });
    expect(
      completeUsageLimit(
        {},
        account({ primary: { usedPercent: 99, resetsAt: '2026-10-23T10:00:00Z' } }),
      ),
    ).toEqual({});
  });
});

describe('resumeAtFor', () => {
  const now = Date.parse('2026-10-23T08:00:00.000Z');

  it('重置之后再等一会儿；已经重置过的从现在算', () => {
    expect(resumeAtFor('2026-10-23T10:00:00.000Z', now)).toBe(
      new Date(Date.parse('2026-10-23T10:00:00.000Z') + AUTO_CONTINUE_DELAY_MS).toISOString(),
    );
    expect(resumeAtFor('2026-10-23T07:00:00.000Z', now, 0)).toBe('2026-10-23T08:00:00.000Z');
  });

  it('一天之后才重置、或不知道时不能开', () => {
    expect(resumeAtFor('2026-10-24T08:00:00.000Z', now)).toBeDefined();
    expect(resumeAtFor('2026-10-24T08:00:01.000Z', now)).toBeUndefined();
    expect(resumeAtFor(undefined, now)).toBeUndefined();
    expect(resumeAtFor('soon', now)).toBeUndefined();
  });
});

describe('AutoContinueTimers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('按墙上时钟：一次最多睡一分钟，睡过头醒来后补上；替换与清除', () => {
    vi.useFakeTimers();
    let clock = Date.parse('2026-10-23T08:00:00.000Z');
    const fired: SessionId[] = [];
    const timers = new AutoContinueTimers(
      (id) => fired.push(id),
      () => clock,
    );
    const a = 'ses_a' as SessionId;
    const b = 'ses_b' as SessionId;
    timers.set(a, '2026-10-23T09:00:00.000Z');
    timers.set(b, '2026-10-23T08:00:30.000Z');
    // 电脑睡了一小时：计时器没走，墙上时钟走了。
    clock += 60 * 60 * 1000;
    vi.advanceTimersByTime(30_000);
    expect(fired).toEqual([b]);
    vi.advanceTimersByTime(30_000);
    expect(fired).toEqual([b, a]);
    expect(timers.has(a)).toBe(false);

    timers.set(a, '2026-10-23T09:10:00.000Z');
    timers.set(a, '2026-10-23T09:20:00.000Z');
    timers.clear(a);
    clock += 60 * 60 * 1000;
    vi.advanceTimersByTime(120_000);
    expect(fired).toEqual([b, a]);
    timers.dispose();
  });
});
