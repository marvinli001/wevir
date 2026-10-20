// 自动化的计划（0.66.0）：算下一次运行的时刻。`daily` / `monthly` 的时刻是自动化 `timezone` 里的墙上时间，靠 Intl 换算，
// 不依赖时区库。夏令时开始那天不存在的时刻（02:30）落到跳过之后的同一偏移处；结束那天重复的时刻取第一次。
// 移植思路参考 T3 Code 的 apps/server/src/scheduledTasks/Schedule.ts（pingdotgg/t3code@ec1313c，MIT）：只按计划往后找下一个
// 时刻，错过很久的不补跑多次。

import type { AutomationSchedule } from '@wevir/protocol';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface ZonedParts {
  year: number;
  /** 1–12。 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, format);
  }
  return format;
}

/** Intl 认得的 IANA 时区。 */
export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Host 所在电脑的时区；取不到时是 `UTC`。 */
export function localTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone !== undefined && zone !== '' && isValidTimezone(zone) ? zone : 'UTC';
}

function zonedParts(ms: number, timezone: string): ZonedParts & { second: number } {
  const values: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** 时区在这一刻比 UTC 快多少毫秒。 */
function offsetAt(ms: number, timezone: string): number {
  const parts = zonedParts(ms, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** 时区里的墙上时间对应的时刻。 */
export function zonedTimeToUtc(parts: ZonedParts, timezone: string): number {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // 切换处前后两个偏移各试一次：墙上时间对得上的（重复的时刻有两个）取早的；都对不上说明这个时刻被跳过了，取晚的。
  const candidates = [
    ...new Set([-DAY_MS, DAY_MS].map((d) => wall - offsetAt(wall + d, timezone))),
  ];
  const exact = candidates.filter((ms) => {
    const parts = zonedParts(ms, timezone);
    return (
      parts.hour === hourOf(wall) && parts.minute === minuteOf(wall) && parts.day === dayOf(wall)
    );
  });
  return exact.length > 0 ? Math.min(...exact) : Math.max(...candidates);
}

const hourOf = (wall: number) => new Date(wall).getUTCHours();
const minuteOf = (wall: number) => new Date(wall).getUTCMinutes();
const dayOf = (wall: number) => new Date(wall).getUTCDate();

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 时区里 `after` 那天往后数 `offset` 天的日期（年月日与星期几）。 */
function dateAfter(
  after: number,
  timezone: string,
  offset: number,
): { year: number; month: number; day: number; weekday: number } {
  const today = zonedParts(after, timezone);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day) + offset * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

/**
 * 计划里严格晚于 `after` 的下一个时刻；没有（`manual`、`once` 已过）时 `undefined`。`interval` 从 `after` 起算，调用方传
 * 上一次运行开始的时刻（或启用的时刻）。
 */
export function nextOccurrence(
  schedule: AutomationSchedule,
  timezone: string,
  after: number,
): number | undefined {
  switch (schedule.kind) {
    case 'manual':
      return undefined;
    case 'once': {
      const at = Date.parse(schedule.at);
      return at > after ? at : undefined;
    }
    case 'interval':
      return after + schedule.minutes * MINUTE_MS;
    case 'daily': {
      const { hour, minute } = parseTime(schedule.time);
      const days = schedule.weekdays === undefined ? undefined : new Set(schedule.weekdays);
      for (let offset = 0; offset <= 8; offset += 1) {
        const date = dateAfter(after, timezone, offset);
        if (days !== undefined && !days.has(date.weekday)) continue;
        const at = zonedTimeToUtc({ ...date, hour, minute }, timezone);
        if (at > after) return at;
      }
      return undefined;
    }
    case 'monthly': {
      const { hour, minute } = parseTime(schedule.time);
      const today = zonedParts(after, timezone);
      for (let offset = 0; offset <= 2; offset += 1) {
        const index = today.month - 1 + offset;
        const year = today.year + Math.floor(index / 12);
        const month = (index % 12) + 1;
        const day = Math.min(schedule.day, daysInMonth(year, month));
        const at = zonedTimeToUtc({ year, month, day, hour, minute }, timezone);
        if (at > after) return at;
      }
      return undefined;
    }
  }
}

/** 计划的一个周期大约多长（毫秒），用来判断错过的运行还值不值得补；没有周期时 `undefined`。 */
export function schedulePeriod(schedule: AutomationSchedule): number | undefined {
  switch (schedule.kind) {
    case 'interval':
      return schedule.minutes * MINUTE_MS;
    case 'daily':
      return schedule.weekdays === undefined || schedule.weekdays.length === 7
        ? DAY_MS
        : 7 * DAY_MS;
    case 'monthly':
      return 28 * DAY_MS;
    default:
      return undefined;
  }
}
