// 汇总与请求记录使用同一组筛选和时间边界，收齐后一起替换。翻页复用汇总，通知与手动刷新重读两者。

import type { WevirClient } from '@wevir/client-sdk';
import type { UsageRecord, UsageSummaryResult } from '@wevir/protocol';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  createThrottle,
  RECORDS_PAGE_SIZE,
  toFilter,
  type UsagePeriod,
  type UsageSelection,
  type UsageWindow,
  usagePeriod,
} from './usage-model';

export interface SummaryData {
  period: UsagePeriod;
  result: UsageSummaryResult;
}

interface UsageSnapshot extends SummaryData {
  records: UsageRecord[];
  total: number;
  page: number;
}

interface UsageState {
  data?: UsageSnapshot;
  error?: unknown;
  loading: boolean;
}

export function useUsage(client: WevirClient, window: UsageWindow, selection: UsageSelection) {
  const query = useMemo(
    () => ({ client, window, filter: toFilter(selection) }),
    [client, window, selection],
  );
  const [pagination, setPagination] = useState<{ query: typeof query; page: number }>();
  const page = pagination?.query === query ? pagination.page : 0;
  const [revision, reload] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<UsageState>({ loading: true });
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const summary = useRef<{
    query: typeof query;
    revision: number;
    period: UsagePeriod;
    result: Promise<UsageSummaryResult>;
  }>(undefined);

  useEffect(() => {
    let active = true;
    const { client, window, filter } = query;
    const params = filter === undefined ? {} : { filter };
    if (summary.current?.query !== query || summary.current.revision !== revision) {
      const period = usagePeriod(window, new Date());
      summary.current = {
        query,
        revision,
        period,
        result: client.request('usage.summary', { ...params, edges: period.edges }),
      };
    }
    const { period, result } = summary.current;
    setState((previous) => ({ ...previous, error: undefined, loading: true }));
    const records = client.request('usage.records', {
      ...params,
      from: period.edges[0] ?? 0,
      to: period.edges.at(-1) ?? 0,
      offset: page * RECORDS_PAGE_SIZE,
      limit: RECORDS_PAGE_SIZE,
    });
    Promise.all([result, records]).then(
      ([result, records]) => {
        if (active) setState({ data: { period, result, ...records, page }, loading: false });
      },
      (error: unknown) => {
        if (active) setState((previous) => ({ ...previous, error, loading: false }));
      },
    );
    return () => {
      active = false;
    };
  }, [query, revision, page]);

  useEffect(() => {
    const throttle = createThrottle(reload, 2000);
    const stop = client.onUsageChanged(() => throttle.trigger());
    return () => {
      stop();
      throttle.cancel();
    };
  }, [client]);

  const refreshPricing = useCallback(async () => {
    setRefreshingPricing(true);
    try {
      await client.request('usage.pricing', { refresh: true });
    } finally {
      setRefreshingPricing(false);
      reload();
    }
  }, [client]);

  return {
    ...state,
    setPage: (page: number) => setPagination({ query, page }),
    reload,
    refreshingPricing,
    refreshPricing,
  };
}
