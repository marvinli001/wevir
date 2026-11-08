// 使用统计页的数据（0.62.0）：`usage.summary`（合计、分桶、按服务商与模型、筛选菜单的选项、价格表状态）与当前一页
// `usage.records`。时间段是预设或自定义起止，分桶边界每次查询按当时的时刻算（见 usage-model.ts 的 usagePeriod）。换时间段或筛选时两者都重读，翻页只重读记录；页面打开期间有变化时两者都重读，至少隔 2 秒。重读时先留着上次的
// 结果，不闪“正在加载”。连接断开、重连期间发起的请求由 client-sdk 排队。

import type { WevirClient } from '@wevir/client-sdk';
import type { UsageFilter, UsageRecord, UsageSummaryResult } from '@wevir/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createThrottle,
  RECORDS_PAGE_SIZE,
  toFilter,
  type UsagePeriod,
  type UsageSelection,
  type UsageWindow,
  usagePeriod,
  windowKey,
} from './usage-model';

export interface Loadable<T> {
  data?: T;
  error?: unknown;
  loading: boolean;
}

export interface SummaryData {
  filter?: UsageFilter;
  /** 这次查询的时间段，`result.buckets[i]` 是 `[period.edges[i], period.edges[i + 1])`。 */
  period: UsagePeriod;
  result: UsageSummaryResult;
}

export interface RecordsData {
  precision?: UsageFilter['precision'];
  records: UsageRecord[];
  total: number;
  page: number;
}

export interface UsageData {
  summary: Loadable<SummaryData>;
  records: Loadable<RecordsData>;
  /** 正在从 models.dev 重新取价格表。 */
  refreshingPricing: boolean;
  reload(): void;
  /** 先刷新价格表（失败不报错，看 `pricing.lastError`），再重读。 */
  refreshPricing(): Promise<void>;
}

/** 有变化时重读的最小间隔。 */
const RELOAD_INTERVAL_MS = 2000;

export function useUsage(
  client: WevirClient,
  window: UsageWindow,
  selection: UsageSelection,
  page: number,
): UsageData {
  const [summary, setSummary] = useState<Loadable<SummaryData>>({ loading: true });
  const [records, setRecords] = useState<Loadable<RecordsData>>({ loading: true });
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const { providerId, model, precision } = selection;
  const filter = useMemo(
    () =>
      toFilter({
        ...(providerId !== undefined && { providerId }),
        ...(model !== undefined && { model }),
        ...(precision !== undefined && { precision }),
      }),
    [providerId, model, precision],
  );
  const range = windowKey(window);
  const query = useRef({ window, filter, page });
  query.current = { window, filter, page };
  const summarySeq = useRef(0);
  const recordsSeq = useRef(0);

  const loadSummary = useCallback(() => {
    const id = ++summarySeq.current;
    const { window, filter } = query.current;
    const period = usagePeriod(window, new Date());
    setSummary((current) => ({ ...current, loading: true }));
    client
      .request('usage.summary', { edges: period.edges, ...(filter !== undefined && { filter }) })
      .then(
        (result) => {
          if (id === summarySeq.current)
            setSummary({
              data: { period, result, ...(filter !== undefined && { filter }) },
              loading: false,
            });
        },
        (error: unknown) => {
          if (id === summarySeq.current)
            setSummary((current) => ({ ...current, error, loading: false }));
        },
      );
  }, [client]);

  const loadRecords = useCallback(() => {
    const id = ++recordsSeq.current;
    const { window, filter, page } = query.current;
    const { edges } = usagePeriod(window, new Date());
    setRecords((current) =>
      current.data?.precision !== filter?.precision
        ? { loading: true }
        : { ...current, loading: true },
    );
    client
      .request('usage.records', {
        from: edges[0] ?? 0,
        to: edges.at(-1) ?? 0,
        ...(filter !== undefined && { filter }),
        offset: page * RECORDS_PAGE_SIZE,
        limit: RECORDS_PAGE_SIZE,
      })
      .then(
        ({ records, total }) => {
          if (id === recordsSeq.current) {
            setRecords({
              data: {
                records,
                total,
                page,
                ...(filter?.precision !== undefined && { precision: filter.precision }),
              },
              loading: false,
            });
          }
        },
        (error: unknown) => {
          if (id === recordsSeq.current) {
            setRecords((current) => ({ ...current, error, loading: false }));
          }
        },
      );
  }, [client]);

  const reload = useCallback(() => {
    loadSummary();
    loadRecords();
  }, [loadSummary, loadRecords]);

  // 换时间段或筛选：两者都重读。
  // biome-ignore lint/correctness/useExhaustiveDependencies: range 与 filter 经 query 读到。
  useEffect(() => {
    loadSummary();
  }, [loadSummary, range, filter]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: range、filter 与 page 经 query 读到。
  useEffect(() => {
    loadRecords();
  }, [loadRecords, range, filter, page]);

  // `usage.changed` 与每次重连之后（client-sdk 的 onUsageChanged）：重读页面上的，至少隔 2 秒。
  useEffect(() => {
    const throttle = createThrottle(reload, RELOAD_INTERVAL_MS);
    const stop = client.onUsageChanged(() => throttle.trigger());
    return () => {
      stop();
      throttle.cancel();
    };
  }, [client, reload]);

  const refreshPricing = useCallback(async () => {
    setRefreshingPricing(true);
    try {
      await client.request('usage.pricing', { refresh: true });
    } finally {
      setRefreshingPricing(false);
      reload();
    }
  }, [client, reload]);

  return { summary, records, refreshingPricing, reload, refreshPricing };
}
