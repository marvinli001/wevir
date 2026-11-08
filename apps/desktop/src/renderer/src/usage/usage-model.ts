// 使用统计页的纯逻辑（0.62.0，Host 功能 `usage_stats`）：功能门控、时间段与分桶的边界、筛选的联动、数字与时间的写法、速度与
// 首字、坐标轴刻度、重读的节流。不碰 DOM 与 Host，组件与测试都用它。
//
// token 用 Anthropic 的口径：`input` 是不含缓存的新增输入，`reasoning` 已含在 `output` 里；Token 总量是四项之和。

import { hostSupports } from '@wevir/client-sdk';
import type {
  AccountState,
  HostFeatures,
  ProviderKind,
  ProviderProfile,
  UsageFilter,
  UsageTiming,
  UsageTokens,
} from '@wevir/protocol';
import type { ProviderLogoId } from '@/components/provider-logo';
import { isSourceKind, pickerOrder, SOURCES, sourceOf, sourceTitle } from '@/data/sources';
import { t } from '@/i18n';
import { providerLogo } from '@/settings/provider-catalog';

// ---- 功能门控 ----

/** 页面能不能用：还没连上（`features` 未知）、Host 没有 `usage_stats`、可用。 */
export type UsageAvailability = 'pending' | 'unsupported' | 'ready';

export function usageAvailability(features: HostFeatures | undefined): UsageAvailability {
  if (features === undefined) return 'pending';
  return hostSupports(features, 'usage_stats') ? 'ready' : 'unsupported';
}

// ---- 时间段与分桶 ----

export const USAGE_RANGES = ['today', '7d', '30d', '90d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_TABS = ['records', 'providers', 'models'] as const;
export type UsageTab = (typeof USAGE_TABS)[number];

export const CHART_METRICS = ['tokens', 'requests', 'cost'] as const;
export type ChartMetric = (typeof CHART_METRICS)[number];

/** 请求记录一页的条数（Host 上限 `USAGE_RECORDS_PAGE_MAX`）。 */
export const RECORDS_PAGE_SIZE = 50;

const HOUR_MS = 3_600_000;

const RANGE_DAYS: Record<Exclude<UsageRange, 'today'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** `at` 所在那天往后 `days` 天的本地零点。`new Date(y, m, d)` 按本地时区换算，跨夏令时也是零点。 */
export function localMidnight(at: Date, days = 0): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days).getTime();
}

/**
 * `usage.summary` 的 `edges`（升序的 Unix 毫秒）：“今天”从本地零点到下一个零点每小时一桶（按实际经过的小时数，夏令时那天是
 * 23 或 25 桶）；其余是到今天为止的 N 天，每天一桶，边界是各天的本地零点。
 */
export function bucketEdges(range: UsageRange, now: Date): number[] {
  if (range === 'today') {
    const start = localMidnight(now);
    const end = localMidnight(now, 1);
    const edges: number[] = [];
    for (let at = start; at < end; at += HOUR_MS) edges.push(at);
    edges.push(end);
    return edges;
  }
  const days = RANGE_DAYS[range];
  return Array.from({ length: days + 1 }, (_, index) => localMidnight(now, index - days + 1));
}

/** 自定义时间段（本地时间选的起止，Unix 毫秒）：省略 `to` 表示结束跟随当前时刻。 */
export interface CustomRange {
  from: number;
  to?: number;
}

/** 页面看的时间段：预设之一，或自定义起止。 */
export type UsageWindow = UsageRange | CustomRange;

/** 分桶的单位。 */
export type BucketUnit = 'hour' | 'day' | 'month' | 'year';

/** 一次查询的时间段：分桶边界与它们的写法。 */
export interface UsagePeriod {
  /** 升序的边界，`buckets[i]` 是 `[edges[i], edges[i + 1])`。 */
  edges: number[];
  unit: BucketUnit;
  /** 预设“今天”：请求记录只写时分秒。 */
  today: boolean;
  /** 按小时分桶但跨了不止一天：横轴与提示带上日期。 */
  spansDays: boolean;
}

/** 自定义时间段按小时分桶的上限（两天），按天分桶的上限（约四个月），按月的上限；再长按年。 */
const MAX_HOURLY_BUCKETS = 48;
const MAX_DAILY_BUCKETS = 120;
const MAX_MONTHLY_BUCKETS = 120;

function nextBoundary(at: number, unit: BucketUnit): number {
  const date = new Date(at);
  switch (unit) {
    case 'hour':
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours() + 1,
      ).getTime();
    case 'day':
      return localMidnight(date, 1);
    case 'month':
      return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
    case 'year':
      return new Date(date.getFullYear() + 1, 0, 1).getTime();
  }
}

/** `[from, to)` 按 `unit` 切开：首尾是起止本身，中间是各个整点、零点、月初或年初。 */
export function spanEdges(from: number, to: number, unit: BucketUnit): number[] {
  const edges = [from];
  for (let at = nextBoundary(from, unit); at < to; at = nextBoundary(at, unit)) edges.push(at);
  edges.push(to);
  return edges;
}

/** 自定义时间段的分桶单位：放得下就用最细的。 */
export function spanUnit(from: number, to: number): BucketUnit {
  if (
    to - from <= (MAX_HOURLY_BUCKETS + 1) * HOUR_MS &&
    spanEdges(from, to, 'hour').length - 1 <= MAX_HOURLY_BUCKETS
  )
    return 'hour';
  const days = (to - from) / (24 * HOUR_MS);
  if (days <= MAX_DAILY_BUCKETS) return 'day';
  if (days / 30 <= MAX_MONTHLY_BUCKETS) return 'month';
  return 'year';
}

/** 自定义时间段的实际起止：跟随当前时刻时结束是 `now`；结束不晚于开始时取开始之后一分钟，免得边界不是升序。 */
export function resolveCustom(range: CustomRange, now: Date): { from: number; to: number } {
  const to = range.to ?? now.getTime();
  return { from: range.from, to: Math.max(to, range.from + 60_000) };
}

export function usagePeriod(window: UsageWindow, now: Date): UsagePeriod {
  if (typeof window === 'string') {
    return {
      edges: bucketEdges(window, now),
      unit: window === 'today' ? 'hour' : 'day',
      today: window === 'today',
      spansDays: false,
    };
  }
  const { from, to } = resolveCustom(window, now);
  const unit = spanUnit(from, to);
  return {
    edges: spanEdges(from, to, unit),
    unit,
    today: false,
    spansDays: unit === 'hour' && localMidnight(new Date(from)) !== localMidnight(new Date(to - 1)),
  };
}

/** 时间段的标识：一样的时间段一样，换了才重读。 */
export function windowKey(window: UsageWindow): string {
  return typeof window === 'string' ? window : `${window.from}-${window.to ?? 'now'}`;
}

// ---- 自定义时间段的选择 ----

/** 选择器里正在改的起止：`field` 是日历点下去改哪一头；`live` 时结束跟随当前时刻，日历只改开始。 */
export interface RangeDraft {
  from: number;
  to: number;
  live: boolean;
  field: 'from' | 'to';
}

/** 换成 `day` 那天，时分不变。 */
export function withDay(at: number, day: Date): number {
  const date = new Date(at);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    date.getHours(),
    date.getMinutes(),
  ).getTime();
}

/** 时间框的值 `HH:mm`（本地时间，24 小时制）。 */
export function timeInputValue(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 时间框改了：`H:mm` 或 `HH:mm` 换成那个时分，日期不变；不完整或不合法时返回 undefined。 */
export function parseTimeInput(at: number, value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes).getTime();
}

/** 日历上点了一天：改开始时接着改结束；结束早于开始时把这一天当新的开始。 */
export function pickDay(draft: RangeDraft, day: Date): RangeDraft {
  if (draft.live) return { ...draft, from: withDay(draft.from, day), field: 'from' };
  if (draft.field === 'from') {
    const from = withDay(draft.from, day);
    const to = draft.to < from ? Math.max(withDay(draft.to, day), from) : draft.to;
    return { ...draft, from, to, field: 'to' };
  }
  const to = withDay(draft.to, day);
  if (to < draft.from) return { ...draft, from: withDay(draft.from, day), field: 'to' };
  return { ...draft, to };
}

/** 一周从哪天开始（0 是星期日），按语言的习惯；取不到时从星期日开始。 */
export function firstDayOfWeek(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    return firstDay === undefined ? 0 : firstDay % 7;
  } catch {
    return 0;
  }
}

/** 月历的 6 行 × 7 天：从 `month` 那月 1 日所在的一周开始。 */
export function calendarDays(month: Date, firstDay: number): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - firstDay + 7) % 7;
  return Array.from(
    { length: 42 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index),
  );
}

// ---- 筛选 ----

/** 页面上的筛选：服务商（模型服务里添加的一个订阅或 API 连接）与模型，各自单选，省略表示全部。 */
export interface UsageSelection {
  precision?: UsageFilter['precision'];
  providerId?: string;
  model?: string;
}

/** 换服务商时清掉模型，精度沿用（新服务商没有这种精度时页面再换），免得换一次读两遍。 */
export function selectProvider(
  selection: UsageSelection,
  providerId: string | undefined,
): UsageSelection {
  return {
    ...(selection.precision !== undefined && { precision: selection.precision }),
    ...(providerId !== undefined && { providerId }),
  };
}

export function selectModel(selection: UsageSelection, model: string | undefined): UsageSelection {
  const { model: _previous, ...rest } = selection;
  return model === undefined ? rest : { ...rest, model };
}

export function toFilter(selection: UsageSelection): UsageFilter | undefined {
  const filter: UsageFilter = {
    ...(selection.precision !== undefined && { precision: selection.precision }),
    ...(selection.providerId !== undefined && { providerIds: [selection.providerId] }),
    ...(selection.model !== undefined && { models: [selection.model] }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

/**
 * 筛选里列出的服务商：模型服务里添加的连接，顺序同模型选择；停用的只在这段时间有用量时列出。用量随连接删除，所以不列已删的。
 */
export function filterProviders(
  providers: readonly ProviderProfile[],
  used: readonly { id: string }[],
): ProviderProfile[] {
  const ids = new Set(used.map((provider) => provider.id));
  return pickerOrder(
    providers.filter((provider) => provider.enabled !== false || ids.has(provider.id)),
  );
}

/** 服务商的名字：订阅来源用来源名（同模型选择，多个账号时带标签或序号），API 连接用它的显示名。 */
export function providerTitle(
  provider: ProviderProfile,
  accounts?: readonly AccountState[],
): string {
  const source = sourceOf(provider);
  return source === undefined
    ? provider.displayName
    : sourceTitle(provider, accounts, t(source.name));
}

export function isFiltered(selection: UsageSelection): boolean {
  return toFilter(selection) !== undefined;
}

export function pageCount(total: number, size = RECORDS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

// ---- token 与速度 ----

/** Token 总量：新增输入、输出、缓存写入、缓存命中之和（推理已在输出里）。 */
export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** 缓存命中率 = 缓存命中 / 输入侧的全部（新增输入 + 缓存命中 + 缓存写入）；没有输入时没有。 */
export function cacheHitRate(tokens: UsageTokens): number | undefined {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt === 0 ? undefined : tokens.cacheRead / prompt;
}

/** 太短的请求算出来的速度没有意义：耗时不到 1 秒或输出不到 200 token 的不算。 */
const MIN_SPEED_DURATION_MS = 1000;
const MIN_SPEED_OUTPUT = 200;

/** 输出速度（token / 秒）。 */
export function speedOf(outputTokens: number, durationMs: number | undefined): number | undefined {
  if (durationMs === undefined || durationMs < MIN_SPEED_DURATION_MS) return undefined;
  if (outputTokens < MIN_SPEED_OUTPUT) return undefined;
  return outputTokens / (durationMs / 1000);
}

/** 一组请求的速度：有耗时的请求的输出之和 / 耗时之和。 */
export function timingSpeed(timing: UsageTiming): number | undefined {
  return speedOf(timing.outputTokens, timing.durationMs);
}

/** 平均首字（毫秒）。 */
export function averageFirstToken(timing: UsageTiming): number | undefined {
  return timing.firstTokenCount === 0 ? undefined : timing.firstTokenMs / timing.firstTokenCount;
}

// ---- 数字的写法 ----

const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

/** 完整的整数，按语言分组（`228,123,456`、`228 123 456`）。 */
export function formatInteger(value: number, locale: string): string {
  return numberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/**
 * token 数的约数：中文、日文是万 / 亿（繁体萬 / 億，日文億），韩文만 / 억，其余 K / M / B 这类。都是 Intl 的紧凑写法，
 * 各语言的输出由测试逐一核对过。
 */
export function formatTokensApprox(value: number, locale: string): string {
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

/** 完整数字旁边的“≈ 2.28 亿”：一万以下、或约数与完整写法一样（德语百万以下）时不需要，返回 undefined。 */
export function approxNote(value: number, locale: string): string | undefined {
  if (value < 10_000) return undefined;
  const approx = formatTokensApprox(value, locale);
  return approx === formatInteger(value, locale) ? undefined : approx;
}

/** 放得下就写完整的整数，太长时写约数（完整值放在提示里）。 */
export function formatTokensFit(value: number, locale: string, maxLength = 11): string {
  const full = formatInteger(value, locale);
  return full.length <= maxLength ? full : formatTokensApprox(value, locale);
}

/** 坐标轴刻度：紧凑写法，最多一位小数。 */
export function formatAxis(value: number, locale: string): string {
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** 美元成本：1 美元以上两位小数，以下最多四位；比 0.0001 还小（但不是 0）的写“< $0.0001”。 */
export function formatCost(usd: number, locale: string): string {
  const currency = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' } as const;
  if (usd > 0 && usd < 0.0001) {
    return `< ${numberFormat(locale, { ...currency, maximumFractionDigits: 4 }).format(0.0001)}`;
  }
  const options: Intl.NumberFormatOptions =
    usd < 1
      ? { ...currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }
      : { ...currency, minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return numberFormat(locale, options).format(usd);
}

/** 成本轴的刻度：不补零（`$0`、`$0.02`、`$40`）。 */
export function formatCostAxis(usd: number, locale: string): string {
  return numberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: usd < 1 ? 4 : 2,
  }).format(usd);
}

/** 单价（美元 / 百万 token），最多四位小数。 */
export function formatUnitPrice(usd: number, locale: string): string {
  return numberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(usd);
}

export function formatPercent(ratio: number, locale: string): string {
  return numberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio);
}

/** 秒数（首字、短的耗时），最多一位小数：`1.2 s`、`1.2秒`。 */
export function formatSeconds(ms: number, locale: string): string {
  return numberFormat(locale, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'short',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms / 1000);
}

/** 速度：`42 tok/s`（取整）；没有时 undefined。 */
export function formatSpeed(
  tokensPerSecond: number | undefined,
  locale: string,
): string | undefined {
  if (tokensPerSecond === undefined) return undefined;
  const value = numberFormat(locale, { maximumFractionDigits: 0 }).format(tokensPerSecond);
  return t('usage.speedValue', { value });
}

/** 缺的值显示成一道横线。 */
export const MISSING = '—';

// ---- 时间的写法 ----

const dates = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dates.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    dates.set(key, format);
  }
  return format;
}

const HOUR_MINUTE = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
const MONTH_DAY = { month: '2-digit', day: '2-digit' } as const;

type PeriodScale = Pick<UsagePeriod, 'unit' | 'today' | 'spansDays'>;

const BUCKET_FORMAT: Record<BucketUnit, Intl.DateTimeFormatOptions> = {
  hour: HOUR_MINUTE,
  day: MONTH_DAY,
  month: { year: 'numeric', month: '2-digit' },
  year: { year: 'numeric' },
};

function bucketFormat(scale: PeriodScale): Intl.DateTimeFormatOptions {
  return scale.unit === 'hour' && scale.spansDays
    ? { ...MONTH_DAY, ...HOUR_MINUTE }
    : BUCKET_FORMAT[scale.unit];
}

/** 横轴的标签：按小时是 `HH:mm`（跨天时带月日），按天是 `MM/DD`（各语言的月日顺序与分隔符），按月是年月，按年是年。 */
export function bucketLabel(start: number, scale: PeriodScale, locale: string): string {
  return dateFormat(locale, bucketFormat(scale)).format(start);
}

/** 横轴标签之间至少留的宽度：带月日的小时标签更长。 */
export function labelSpacing(scale: PeriodScale): number {
  return scale.unit === 'hour' && scale.spansDays ? 88 : 56;
}

/** 悬停提示的标题：按小时是 `07:00 – 08:00`，按天是带星期的日期，按月、按年是起止（首尾两桶可能不满）。 */
export function bucketTitle(
  start: number,
  end: number,
  scale: PeriodScale,
  locale: string,
): string {
  if (scale.unit === 'hour') return dateFormat(locale, bucketFormat(scale)).formatRange(start, end);
  if (scale.unit === 'day')
    return dateFormat(locale, { ...MONTH_DAY, weekday: 'short' }).format(start);
  return dateFormat(locale, { year: 'numeric', ...MONTH_DAY }).formatRange(start, end - 1);
}

/** 请求记录的时间：“今天”只写时分秒，其余加上月日。 */
export function recordTime(at: number, scale: PeriodScale, locale: string): string {
  const time = { ...HOUR_MINUTE, second: '2-digit' } as const;
  return dateFormat(locale, scale.today ? time : { ...MONTH_DAY, ...time }).format(at);
}

/** 自定义时间段的写法：`10/09 22:31 – 11/08 22:31`，跟随当前时刻时结束写“现在”；跨年时带年份。 */
export function customRangeLabel(range: CustomRange, locale: string, now = new Date()): string {
  const end = range.to ?? now.getTime();
  const year = new Date(range.from).getFullYear();
  const withYear = year !== new Date(end).getFullYear() || year !== now.getFullYear();
  const options: Intl.DateTimeFormatOptions = {
    ...(withYear && { year: 'numeric' }),
    ...MONTH_DAY,
    ...HOUR_MINUTE,
  };
  const format = dateFormat(locale, options);
  if (range.to === undefined) return `${format.format(range.from)} – ${t('usage.range.now')}`;
  return format.formatRange(range.from, range.to);
}

/** 详情里的完整时间。 */
export function fullTime(at: number, locale: string): string {
  return dateFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(at);
}

/** 横轴每隔几桶写一个标签，标签之间至少 `spacing` px。 */
export function labelStride(count: number, width: number, spacing = 56): number {
  if (count <= 0 || width <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / spacing))));
}

/** 纵轴的刻度：从 0 到不小于 `max` 的“整”数（1、2、2.5、5 乘 10 的幂），`count` 段。 */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let index = 0; index * step <= top + step * 1e-9; index++) {
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return ticks;
}

// ---- 来源 ----

export interface SourceDisplay {
  name: string;
  logo: ProviderLogoId | undefined;
}

/** 来源的名称与标志：订阅来源用软件名与软件标志（同模型选择），API 类按种类。 */
export function sourceDisplay(kind: ProviderKind): SourceDisplay {
  if (isSourceKind(kind)) {
    const source = SOURCES[kind];
    return { name: t(source.name), logo: source.logo };
  }
  switch (kind) {
    case 'deepseek-official':
      return { name: t('provider.catalog.deepseek'), logo: 'deepseek' };
    case 'google-vertex':
      return { name: t('usage.source.vertex'), logo: 'vertex' };
    default:
      return { name: t('usage.source.openaiCompatible'), logo: undefined };
  }
}

/** 一个服务商的标志：Provider 还在时同模型选择（订阅软件标志，或按地址认出的服务），删了时按来源。 */
export function providerLogoOf(
  providerId: string,
  source: ProviderKind,
  providers: readonly ProviderProfile[],
): ProviderLogoId | undefined {
  const profile = providers.find((provider) => provider.id === providerId);
  if (profile !== undefined) return sourceOf(profile)?.logo ?? providerLogo(profile);
  return sourceDisplay(source).logo;
}

// ---- 重读的节流 ----

export interface Throttle {
  /** 要重读：离上一次已过 `intervalMs` 就马上读，否则排到那时读一次（期间的多次合成一次）。 */
  trigger(): void;
  cancel(): void;
}

export function createThrottle(
  run: () => void,
  intervalMs: number,
  now: () => number = Date.now,
): Throttle {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    last = now();
    run();
  };
  return {
    trigger() {
      if (timer !== undefined) return;
      const wait = last + intervalMs - now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
