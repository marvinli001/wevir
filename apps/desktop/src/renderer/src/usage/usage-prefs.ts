// 使用统计页的本机偏好：上次看的时间段、明细分段与趋势图的指标。只存在本机（lib/store.ts 的 createPersistedStore，读写失败时
// 只在本次运行内生效）。

import { createPersistedStore } from '@/lib/store';
import {
  CHART_METRICS,
  type ChartMetric,
  USAGE_RANGES,
  USAGE_TABS,
  type UsageRange,
  type UsageTab,
} from './usage-model';

export interface UsagePrefs {
  range: UsageRange;
  tab: UsageTab;
  metric: ChartMetric;
}

const pick = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  (values as readonly unknown[]).includes(value) ? (value as T) : fallback;

export const usagePrefs = createPersistedStore<UsagePrefs>(
  'wevir.usage.v1',
  { range: '7d', tab: 'records', metric: 'tokens' },
  (raw) => {
    if (raw === null || typeof raw !== 'object') return undefined;
    const value = raw as Record<string, unknown>;
    return {
      range: pick(USAGE_RANGES, value.range, '7d'),
      tab: pick(USAGE_TABS, value.tab, 'records'),
      metric: pick(CHART_METRICS, value.metric, 'tokens'),
    };
  },
);
