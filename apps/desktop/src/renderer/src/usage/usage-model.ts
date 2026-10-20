// 使用情况页的纯逻辑（0.62.0，Host 功能 `usage_stats`）：功能门控、时间段与分桶的边界、筛选的联动、数字与时间的写法、速度与
// 首字、坐标轴刻度、重读的节流。不碰 DOM 与 Host，组件与测试都用它。
//
// token 用 Anthropic 的口径：`input` 是不含缓存的新增输入，`reasoning` 已含在 `output` 里；Token 总量是四项之和。

import { hostSupports } from '@wevir/client-sdk';
import type {
  HostFeatures,
  ProviderKind,
  ProviderProfile,
  UsageFilter,
  UsageTiming,
  UsageTokens,
} from '@wevir/protocol';
import type { ProviderLogoId } from '@/components/provider-logo';
import { isSourceKind, SOURCES, sourceOf } from '@/data/sources';
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

export function isHourly(range: UsageRange): boolean {
  return range === 'today';
}

// ---- 筛选 ----

/** 页面上的筛选：来源、服务商、模型，各自单选，省略表示全部。 */
export interface UsageSelection {
  source?: ProviderKind;
  providerId?: string;
  model?: string;
}

/** 换来源时清掉服务商与模型。 */
export function selectSource(source: ProviderKind | undefined): UsageSelection {
  return source === undefined ? {} : { source };
}

/** 换服务商时清掉模型。 */
export function selectProvider(
  selection: UsageSelection,
  providerId: string | undefined,
): UsageSelection {
  return {
    ...(selection.source !== undefined && { source: selection.source }),
    ...(providerId !== undefined && { providerId }),
  };
}

export function selectModel(selection: UsageSelection, model: string | undefined): UsageSelection {
  const { model: _previous, ...rest } = selection;
  return model === undefined ? rest : { ...rest, model };
}

export function toFilter(selection: UsageSelection): UsageFilter | undefined {
  const filter: UsageFilter = {
    ...(selection.source !== undefined && { sources: [selection.source] }),
    ...(selection.providerId !== undefined && { providerIds: [selection.providerId] }),
    ...(selection.model !== undefined && { models: [selection.model] }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
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

/** 横轴的标签：按小时是 `HH:mm`，按天是 `MM/DD`（各语言的月日顺序与分隔符）。 */
export function bucketLabel(start: number, range: UsageRange, locale: string): string {
  return dateFormat(locale, isHourly(range) ? HOUR_MINUTE : MONTH_DAY).format(start);
}

/** 悬停提示的标题：按小时是 `07:00 – 08:00`，按天是带星期的日期。 */
export function bucketTitle(start: number, end: number, range: UsageRange, locale: string): string {
  if (isHourly(range)) return dateFormat(locale, HOUR_MINUTE).formatRange(start, end);
  return dateFormat(locale, { ...MONTH_DAY, weekday: 'short' }).format(start);
}

/** 请求记录的时间：今天的只写时分秒，其余加上月日。 */
export function recordTime(at: number, range: UsageRange, locale: string): string {
  const time = { ...HOUR_MINUTE, second: '2-digit' } as const;
  return dateFormat(locale, isHourly(range) ? time : { ...MONTH_DAY, ...time }).format(at);
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
