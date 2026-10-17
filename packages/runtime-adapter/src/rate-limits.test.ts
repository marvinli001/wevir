import { describe, expect, it } from 'vitest';
import { accountRateLimits, clampPercent, isoTime } from './rate-limits.js';

describe('accountRateLimits', () => {
  it('按长度排序：5 小时、每周、按月、长度不明；前两个是 primary / secondary', () => {
    const limits = accountRateLimits([
      { usedPercent: 30, period: 'monthly' },
      { usedPercent: 5 },
      { usedPercent: 120, windowMinutes: 10080 },
      { usedPercent: 10, windowMinutes: 300 },
    ]);
    expect(limits?.windows).toEqual([
      { usedPercent: 10, windowMinutes: 300 },
      { usedPercent: 100, windowMinutes: 10080 },
      { usedPercent: 30, period: 'monthly' },
      { usedPercent: 5 },
    ]);
    expect(limits?.primary).toEqual({ usedPercent: 10, windowMinutes: 300 });
    expect(limits?.secondary).toEqual({ usedPercent: 100, windowMinutes: 10080 });
  });

  it('同样长的保持原来的顺序；一个窗口时没有 secondary；没有窗口时 undefined', () => {
    const limits = accountRateLimits([
      { usedPercent: 1, period: 'monthly' },
      { usedPercent: 2, period: 'monthly', scope: 'API' },
    ]);
    expect(limits?.windows?.map((window) => window.usedPercent)).toEqual([1, 2]);
    expect(accountRateLimits([{ usedPercent: 3 }])).toEqual({
      primary: { usedPercent: 3 },
      windows: [{ usedPercent: 3 }],
    });
    expect(accountRateLimits([])).toBeUndefined();
  });

  it('clampPercent 与 isoTime', () => {
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(42.5)).toBe(42.5);
    expect(isoTime(1_760_000_000_000)).toBe('2025-10-09T08:53:20.000Z');
    expect(isoTime('2026-10-17T00:00:00Z')).toBe('2026-10-17T00:00:00.000Z');
    expect(isoTime('soon')).toBeUndefined();
    expect(isoTime(undefined)).toBeUndefined();
  });
});
