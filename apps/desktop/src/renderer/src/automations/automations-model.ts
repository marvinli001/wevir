// 自动化页的纯逻辑（0.66.0，Host 功能 `automations`）：功能门控、“重复”预设与计划的互换、计划与下一次运行的写法、列表分组、
// 运行的提醒规则、表单与请求参数的互换。不碰 DOM 与 Host，组件与测试都用它。

import { hostSupports } from '@wevir/client-sdk';
import type {
  Automation,
  AutomationNotify,
  AutomationRun,
  AutomationSchedule,
  HostFeatures,
  MethodParams,
  PermissionMode,
} from '@wevir/protocol';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import type { ModelChoice } from '@/session/model-picker';

// ---- 功能门控 ----

export type AutomationsAvailability = 'pending' | 'unsupported' | 'ready';

export function automationsAvailability(
  features: HostFeatures | undefined,
): AutomationsAvailability {
  if (features === undefined) return 'pending';
  return hostSupports(features, 'automations') ? 'ready' : 'unsupported';
}

// ---- “重复”预设 ----

/** 对话框里“重复”的选项；`hourly` 是每 60 分钟，`weekdays` 是周一到周五，`weekly` 是选定的几天。 */
export const REPEATS = [
  'manual',
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'interval',
] as const;
export type Repeat = (typeof REPEATS)[number];

export const REPEAT_LABEL: Record<Repeat, PlainMessageKey> = {
  manual: 'automations.repeat.manual',
  once: 'automations.repeat.once',
  hourly: 'automations.repeat.hourly',
  daily: 'automations.repeat.daily',
  weekdays: 'automations.repeat.weekdays',
  weekly: 'automations.repeat.weekly',
  monthly: 'automations.repeat.monthly',
  interval: 'automations.repeat.interval',
};

/** “自定义间隔”能选的分钟数（Host 最少 5 分钟）。 */
export const INTERVAL_CHOICES = [5, 10, 15, 30, 120, 180, 360, 720] as const;

const WORKDAYS = [1, 2, 3, 4, 5];

/** 星期几的显示顺序：周一在前。 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** 表单里的计划：所有预设的字段都留着，换预设时不丢。 */
export interface ScheduleDraft {
  repeat: Repeat;
  /** `HH:MM`，每天 / 工作日 / 每周 / 每月用。 */
  time: string;
  /** 每周选的几天（0 = 周日）。 */
  weekdays: number[];
  /** 每月的几号。 */
  day: number;
  /** 自定义间隔的分钟数。 */
  minutes: number;
  /** 一次：`YYYY-MM-DDTHH:MM`，按 `timezone` 的墙上时间。 */
  at: string;
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  const sorted = [...a].sort();
  return sorted.length === b.length && sorted.every((day, index) => day === b[index]);
}

export function defaultScheduleDraft(now: number, timezone: string): ScheduleDraft {
  // 一次：默认明天这个整点。
  const tomorrow = wallTime(now + 86_400_000, timezone);
  return {
    repeat: 'daily',
    time: '09:00',
    weekdays: [1],
    day: 1,
    minutes: 30,
    at: `${tomorrow.date}T${tomorrow.time.slice(0, 2)}:00`,
  };
}

export function draftOfSchedule(
  schedule: AutomationSchedule,
  timezone: string,
  now: number,
): ScheduleDraft {
  const base = defaultScheduleDraft(now, timezone);
  switch (schedule.kind) {
    case 'manual':
      return { ...base, repeat: 'manual' };
    case 'once': {
      const wall = wallTime(Date.parse(schedule.at), timezone);
      return { ...base, repeat: 'once', at: `${wall.date}T${wall.time}` };
    }
    case 'interval':
      return schedule.minutes === 60
        ? { ...base, repeat: 'hourly' }
        : { ...base, repeat: 'interval', minutes: schedule.minutes };
    case 'daily': {
      const weekdays = schedule.weekdays;
      if (weekdays === undefined || weekdays.length === 7) {
        return { ...base, repeat: 'daily', time: schedule.time };
      }
      if (sameDays(weekdays, WORKDAYS)) {
        return { ...base, repeat: 'weekdays', time: schedule.time };
      }
      return { ...base, repeat: 'weekly', time: schedule.time, weekdays: [...weekdays] };
    }
    case 'monthly':
      return { ...base, repeat: 'monthly', time: schedule.time, day: schedule.day };
  }
}

/** 表单的计划换成 Host 的计划；一次的时刻不合法时 undefined。 */
export function scheduleOfDraft(
  draft: ScheduleDraft,
  timezone: string,
): AutomationSchedule | undefined {
  switch (draft.repeat) {
    case 'manual':
      return { kind: 'manual' };
    case 'once': {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(draft.at);
      if (!match) return undefined;
      const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
      ];
      const at = zonedTimeToUtc({ year, month, day, hour, minute }, timezone);
      return { kind: 'once', at: new Date(at).toISOString() };
    }
    case 'hourly':
      return { kind: 'interval', minutes: 60 };
    case 'interval':
      return { kind: 'interval', minutes: draft.minutes };
    case 'daily':
      return { kind: 'daily', time: draft.time };
    case 'weekdays':
      return { kind: 'daily', time: draft.time, weekdays: [...WORKDAYS] };
    case 'weekly': {
      if (draft.weekdays.length === 0) return undefined;
      const weekdays = WEEK_ORDER.filter((day) => draft.weekdays.includes(day)).sort();
      return weekdays.length === 7
        ? { kind: 'daily', time: draft.time }
        : { kind: 'daily', time: draft.time, weekdays };
    }
    case 'monthly':
      return { kind: 'monthly', time: draft.time, day: draft.day };
  }
}

// ---- 时区 ----

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsIn(ms: number, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function asUtc(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

/** 时区里的墙上时间换成 UTC 毫秒（与 Host 的 schedule.ts 同样处理夏令时：重复的取第一次，跳过的落到之后）。 */
export function zonedTimeToUtc(clock: WallClock, timezone: string): number {
  const target = asUtc(clock);
  const candidates = [-86_400_000, 0, 86_400_000].map((shift) => {
    const offset = asUtc(partsIn(target + shift, timezone)) - (target + shift);
    return target - offset;
  });
  const exact = candidates
    .filter((candidate) => asUtc(partsIn(candidate, timezone)) === target)
    .sort((a, b) => a - b);
  return exact[0] ?? Math.max(...candidates);
}

/** 某个时刻在时区里的日期（`YYYY-MM-DD`）与时刻（`HH:MM`）。 */
export function wallTime(ms: number, timezone: string): { date: string; time: string } {
  const clock = partsIn(ms, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`,
    time: `${pad(clock.hour)}:${pad(clock.minute)}`,
  };
}

/** 时区的显示名：`Asia/Shanghai` → `Shanghai`（城市名，下划线换空格）。 */
export function timezoneLabel(timezone: string): string {
  const city = timezone.split('/').pop() ?? timezone;
  return city.replaceAll('_', ' ');
}

// ---- 写法 ----

/** 星期几的短名（按界面语言）。2026-10-18 是星期日。 */
export function weekdayName(day: number, width: 'short' | 'long' = 'short'): string {
  return new Intl.DateTimeFormat(currentLocale(), { weekday: width, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 9, 18 + day)),
  );
}

function intervalText(minutes: number): string {
  if (minutes === 60) return t('automations.schedule.hourly');
  if (minutes % 1440 === 0) return t('automations.schedule.everyDays', { n: minutes / 1440 });
  if (minutes % 60 === 0) return t('automations.schedule.everyHours', { n: minutes / 60 });
  return t('automations.schedule.everyMinutes', { n: minutes });
}

/** 列表与详情里的计划：“每天 09:00”“工作日 09:00”“每周一、周三 09:00”“每月 1 日 09:00”“每 30 分钟”。 */
export function scheduleText(schedule: AutomationSchedule, timezone: string): string {
  switch (schedule.kind) {
    case 'manual':
      return t('automations.schedule.manual');
    case 'once':
      return t('automations.schedule.once', {
        at: formatMoment(Date.parse(schedule.at), timezone),
      });
    case 'interval':
      return intervalText(schedule.minutes);
    case 'daily': {
      const { weekdays, time } = schedule;
      if (weekdays === undefined || weekdays.length === 7) {
        return t('automations.schedule.daily', { time });
      }
      if (sameDays(weekdays, WORKDAYS)) return t('automations.schedule.weekdays', { time });
      const days = WEEK_ORDER.filter((day) => weekdays.includes(day))
        .map((day) => weekdayName(day))
        .join(t('common.listSeparator'));
      return t('automations.schedule.weekly', { days, time });
    }
    case 'monthly':
      return t('automations.schedule.monthly', { day: schedule.day, time: schedule.time });
  }
}

/** 某个时刻的写法（按时区）：今天、明天写“今天 09:00”，一周内写星期，再远写日期。 */
export function formatMoment(ms: number, timezone: string, now = Date.now()): string {
  const { date, time } = wallTime(ms, timezone);
  const today = wallTime(now, timezone).date;
  const tomorrow = wallTime(now + 86_400_000, timezone).date;
  if (date === today) return t('automations.moment.today', { time });
  if (date === tomorrow) return t('automations.moment.tomorrow', { time });
  const locale = currentLocale();
  const within = ms > now && ms - now < 6 * 86_400_000;
  const day = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    ...(within
      ? { weekday: 'short' }
      : {
          month: 'short',
          day: 'numeric',
          ...(date.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }),
        }),
  }).format(new Date(ms));
  return `${day} ${time}`;
}

// ---- 列表 ----

/** 列表的分组：即将执行（按下一次运行的先后）、手动、已暂停、已完成（一次的已经运行过）。 */
export type AutomationGroup = 'upcoming' | 'manual' | 'paused' | 'finished';
export const GROUP_ORDER: readonly AutomationGroup[] = ['upcoming', 'manual', 'paused', 'finished'];

export function groupOf(automation: Automation): AutomationGroup {
  if (!automation.enabled) return 'paused';
  if (automation.nextRunAt !== undefined) return 'upcoming';
  return automation.schedule.kind === 'manual' ? 'manual' : 'finished';
}

export function groupAutomations(
  automations: readonly Automation[],
): { group: AutomationGroup; automations: Automation[] }[] {
  const groups = new Map<AutomationGroup, Automation[]>();
  for (const automation of automations) {
    const group = groupOf(automation);
    groups.set(group, [...(groups.get(group) ?? []), automation]);
  }
  const upcoming = groups.get('upcoming');
  upcoming?.sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''));
  return GROUP_ORDER.flatMap((group) => {
    const list = groups.get(group);
    return list ? [{ group, automations: list }] : [];
  });
}

/** 标题、指令里有搜索词（不分大小写）。 */
export function matchesQuery(automation: Automation, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    automation.title.toLowerCase().includes(needle) ||
    automation.prompt.toLowerCase().includes(needle)
  );
}

/** 行上的状态：运行中、等待处理（审批或提问）优先，其余看分组。 */
export type AutomationState =
  | 'running'
  | 'waiting'
  | 'scheduled'
  | 'manual'
  | 'paused'
  | 'finished';

export function stateOf(automation: Automation): AutomationState {
  const status = automation.lastRun?.status;
  if (status === 'running' || status === 'waiting') return status;
  const group = groupOf(automation);
  return group === 'upcoming' ? 'scheduled' : group;
}

export function isRunActive(run: AutomationRun | undefined): boolean {
  return run?.status === 'running' || run?.status === 'waiting';
}

// ---- 提醒 ----

/**
 * 一次运行的状态变了，要不要发系统通知：`waiting`（等审批或回答）与 `failed` 除了“从不”都提醒；`completed` 在“每次”时提醒，
 * “重要更新”时 Agent 没标记无事可报才提醒；其余（运行中、跳过、取消）不提醒。
 */
export function shouldNotify(notify: AutomationNotify, run: AutomationRun): boolean {
  if (notify === 'never') return false;
  switch (run.status) {
    case 'waiting':
    case 'failed':
      return true;
    case 'completed':
      return notify === 'always' || (notify === 'important' && run.quiet !== true);
    default:
      return false;
  }
}

// ---- 表单 ----

export interface AutomationDraft {
  title: string;
  prompt: string;
  schedule: ScheduleDraft;
  timezone: string;
  /** undefined：不在项目中。 */
  workspaceId?: string;
  model?: ModelChoice;
  permissionMode: PermissionMode;
  newSessionEachRun: boolean;
  notify: AutomationNotify;
  enabled: boolean;
}

export function draftOfAutomation(automation: Automation, now: number): AutomationDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    schedule: draftOfSchedule(automation.schedule, automation.timezone, now),
    timezone: automation.timezone,
    ...(automation.workspaceId !== undefined && { workspaceId: automation.workspaceId }),
    ...(automation.modelId !== undefined && {
      model: {
        providerId: automation.providerId,
        modelId: automation.modelId,
        ...(automation.reasoningEffort !== undefined && {
          reasoningEffort: automation.reasoningEffort,
        }),
      },
    }),
    permissionMode: automation.permissionMode,
    newSessionEachRun: automation.newSessionEachRun,
    notify: automation.notify,
    enabled: automation.enabled,
  };
}

/** 表单还缺什么（按钮置灰用）；undefined 表示能保存。 */
export function draftProblem(
  draft: AutomationDraft,
): 'title' | 'prompt' | 'schedule' | 'model' | undefined {
  if (draft.title.trim() === '') return 'title';
  if (draft.prompt.trim() === '') return 'prompt';
  if (draft.model === undefined) return 'model';
  const schedule = scheduleOfDraft(draft.schedule, draft.timezone);
  if (schedule === undefined) return 'schedule';
  return undefined;
}

export function createParams(
  draft: AutomationDraft,
): MethodParams<'automation.create'> | undefined {
  const schedule = scheduleOfDraft(draft.schedule, draft.timezone);
  if (schedule === undefined || draft.model === undefined) return undefined;
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    schedule,
    timezone: draft.timezone,
    enabled: draft.enabled,
    ...(draft.workspaceId !== undefined && { workspaceId: draft.workspaceId as never }),
    providerId: draft.model.providerId as never,
    modelId: draft.model.modelId,
    ...(draft.model.reasoningEffort !== undefined && {
      reasoningEffort: draft.model.reasoningEffort,
    }),
    permissionMode: draft.permissionMode,
    newSessionEachRun: draft.newSessionEachRun,
    notify: draft.notify,
  };
}

/** 编辑：整份表单写回（项目、模型档位清掉时传 null）。 */
export function updateParams(
  automation: Automation,
  draft: AutomationDraft,
): MethodParams<'automation.update'> | undefined {
  const params = createParams(draft);
  if (params === undefined) return undefined;
  return {
    automationId: automation.id,
    title: params.title,
    prompt: params.prompt,
    schedule: params.schedule,
    timezone: draft.timezone,
    enabled: draft.enabled,
    workspaceId: params.workspaceId ?? null,
    providerId: params.providerId,
    modelId: params.modelId ?? null,
    reasoningEffort: params.reasoningEffort ?? null,
    permissionMode: draft.permissionMode,
    newSessionEachRun: draft.newSessionEachRun,
    notify: draft.notify,
  };
}
