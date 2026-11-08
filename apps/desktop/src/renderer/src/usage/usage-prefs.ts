// 使用统计页的本机偏好：上次看的时间段（预设或自定义起止）、明细分段与趋势图的指标。只存在本机（lib/store.ts 的
// createPersistedStore，读写失败时只在本次运行内生效）。

import { createPersistedStore } from '@/lib/store';
import {
  CHART_METRICS,
  type ChartMetric,
  type CustomRange,
  USAGE_RANGES,
  USAGE_TABS,
  type UsageRange,
  type UsageTab,
  type UsageWindow,
} from './usage-model';

export interface UsagePrefs {
  range: UsageRange | 'custom';
  /** 上次用的自定义时间段；`range` 是 `custom` 时看它。 */
  custom?: CustomRange;
  tab: UsageTab;
  metric: ChartMetric;
}

const pick = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  (values as readonly unknown[]).includes(value) ? (value as T) : fallback;

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseCustom(raw: unknown): CustomRange | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { from, to } = raw as Record<string, unknown>;
  if (!isTime(from)) return undefined;
  if (to === undefined) return { from };
  return isTime(to) && to > from ? { from, to } : undefined;
}

export const usagePrefs = createPersistedStore<UsagePrefs>(
  'wevir.usage.v1',
  { range: '7d', tab: 'records', metric: 'tokens' },
  (raw) => {
    if (raw === null || typeof raw !== 'object') return undefined;
    const value = raw as Record<string, unknown>;
    const custom = parseCustom(value.custom);
    return {
      range:
        value.range === 'custom' && custom !== undefined
          ? 'custom'
          : pick(USAGE_RANGES, value.range, '7d'),
      ...(custom !== undefined && { custom }),
      tab: pick(USAGE_TABS, value.tab, 'records'),
      metric: pick(CHART_METRICS, value.metric, 'tokens'),
    };
  },
);

/** 偏好里的时间段：自定义但没有起止时回到近 7 天。 */
export function prefsWindow(prefs: UsagePrefs): UsageWindow {
  if (prefs.range !== 'custom') return prefs.range;
  return prefs.custom ?? '7d';
}
