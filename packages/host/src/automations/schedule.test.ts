import type { AutomationSchedule } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { isValidTimezone, nextOccurrence, schedulePeriod, zonedTimeToUtc } from './schedule.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe('zonedTimeToUtc', () => {
  it('按时区换算墙上时间', () => {
    expect(
      iso(zonedTimeToUtc({ year: 2026, month: 10, day: 21, hour: 9, minute: 0 }, 'Asia/Shanghai')),
    ).toBe('2026-10-21T01:00:00.000Z');
    expect(
      iso(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'Pacific/Auckland')),
    ).toBe('2026-06-30T21:00:00.000Z');
    expect(
      iso(zonedTimeToUtc({ year: 2026, month: 1, day: 1, hour: 9, minute: 0 }, 'Pacific/Auckland')),
    ).toBe('2025-12-31T20:00:00.000Z');
  });

  it('夏令时开始那天不存在的时刻落到跳过之后，结束那天重复的时刻取第一次', () => {
    // 美国东部 2026-03-08 02:00 跳到 03:00；2026-11-01 02:00 回到 01:00。
    expect(
      iso(
        zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'),
      ),
    ).toBe('2026-03-08T07:30:00.000Z');
    expect(
      iso(
        zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'),
      ),
    ).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('nextOccurrence', () => {
  const tz = 'Asia/Shanghai';

  it('manual 没有下一次，once 只在未来', () => {
    expect(nextOccurrence({ kind: 'manual' }, tz, at('2026-10-20T00:00:00Z'))).toBeUndefined();
    const once = { kind: 'once', at: '2026-10-21T01:00:00.000Z' } as const;
    expect(iso(nextOccurrence(once, tz, at('2026-10-20T00:00:00Z')))).toBe(once.at);
    expect(nextOccurrence(once, tz, at('2026-10-21T01:00:00Z'))).toBeUndefined();
  });

  it('interval 从给的时刻起算', () => {
    expect(
      iso(nextOccurrence({ kind: 'interval', minutes: 90 }, tz, at('2026-10-20T00:00:00Z'))),
    ).toBe('2026-10-20T01:30:00.000Z');
  });

  it('daily 当天没过就是当天，过了是第二天', () => {
    const daily = { kind: 'daily', time: '09:00' } as const;
    expect(iso(nextOccurrence(daily, tz, at('2026-10-20T00:59:00Z')))).toBe(
      '2026-10-20T01:00:00.000Z',
    );
    expect(iso(nextOccurrence(daily, tz, at('2026-10-20T01:00:00Z')))).toBe(
      '2026-10-21T01:00:00.000Z',
    );
  });

  it('daily 带 weekdays 时跳过别的日子', () => {
    // 2026-10-23 是星期五（上海）；工作日的下一次是星期一 10-26。
    const weekdays = {
      kind: 'daily',
      time: '09:00',
      weekdays: [1, 2, 3, 4, 5],
    } satisfies AutomationSchedule;
    expect(iso(nextOccurrence(weekdays, tz, at('2026-10-23T02:00:00Z')))).toBe(
      '2026-10-26T01:00:00.000Z',
    );
    const sunday: AutomationSchedule = { kind: 'daily', time: '20:00', weekdays: [0] };
    expect(iso(nextOccurrence(sunday, tz, at('2026-10-20T00:00:00Z')))).toBe(
      '2026-10-25T12:00:00.000Z',
    );
  });

  it('daily 按时区的日期算，不按 UTC 的', () => {
    // 奥克兰 2026-10-21 08:30（UTC 10-20 19:30）时，当天 09:00 还没到。
    expect(
      iso(
        nextOccurrence(
          { kind: 'daily', time: '09:00' },
          'Pacific/Auckland',
          at('2026-10-20T19:30:00Z'),
        ),
      ),
    ).toBe('2026-10-20T20:00:00.000Z');
  });

  it('monthly 没有这一天的月份在月末', () => {
    const monthly = { kind: 'monthly', time: '08:00', day: 31 } as const;
    expect(iso(nextOccurrence(monthly, tz, at('2026-10-31T00:00:00Z')))).toBe(
      '2026-11-30T00:00:00.000Z',
    );
    expect(iso(nextOccurrence(monthly, tz, at('2026-12-31T00:00:00Z')))).toBe(
      '2027-01-31T00:00:00.000Z',
    );
    expect(iso(nextOccurrence(monthly, tz, at('2027-01-31T00:00:00Z')))).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });
});

it('isValidTimezone 与 schedulePeriod', () => {
  expect(isValidTimezone('Asia/Shanghai')).toBe(true);
  expect(isValidTimezone('Mars/Olympus')).toBe(false);
  expect(schedulePeriod({ kind: 'daily', time: '09:00' })).toBe(86_400_000);
  expect(schedulePeriod({ kind: 'daily', time: '09:00', weekdays: [1] })).toBe(7 * 86_400_000);
  expect(schedulePeriod({ kind: 'manual' })).toBeUndefined();
});
