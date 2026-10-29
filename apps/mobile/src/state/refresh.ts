// 下拉刷新：转圈至少半秒（离线时重连是立刻返回的，不至于一闪而过），出错也收起。

import { useCallback, useState } from 'react';

const MIN_SPIN_MS = 500;

export function usePullToRefresh(refresh: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    const spin = new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS));
    void Promise.all([refresh().catch(() => {}), spin]).finally(() => setRefreshing(false));
  }, [refresh]);
  return { refreshing, onRefresh };
}
