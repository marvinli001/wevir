// 插件页的数据（0.42.0）：`plugins.list` 经 client-sdk 的 `watchPlugins`，页面打开期间跟着 `plugins.changed`（连接状态与工具列表也在
// 这里更新）。同一个客户端上次读到的结果先显示再刷新，来回切页面时不闪“正在加载”。

import type { WevirClient } from '@wevir/client-sdk';
import type { Plugin, PluginsList } from '@wevir/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';

export type PluginsState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; list: PluginsList; plugins: readonly Plugin[] };

const cache = new WeakMap<WevirClient, PluginsList>();

const ready = (list: PluginsList): PluginsState => ({
  status: 'ready',
  list,
  plugins: list.plugins ?? [],
});

export interface PluginsData {
  state: PluginsState;
  /** 方法的结果立即合进当前列表（重读的结果随后到，覆盖它）。 */
  apply(update: (list: PluginsList) => PluginsList): void;
  /** 立即重读（装、删这类改变成员的操作之后，不等通知）。 */
  refresh(): Promise<void>;
}

export function usePlugins(): PluginsData {
  const { client } = useHostConnection();
  const [state, setState] = useState<PluginsState>({ status: 'loading' });

  useEffect(() => {
    if (!client) return;
    const cached = cache.get(client);
    setState(cached ? ready(cached) : { status: 'loading' });
    return client.watchPlugins(
      (list) => {
        cache.set(client, list);
        setState(ready(list));
      },
      // 读失败时已经显示着上次结果的就留着它。
      (error) =>
        setState((current) => (current.status === 'ready' ? current : { status: 'error', error })),
    );
  }, [client]);

  const apply = useCallback(
    (update: (list: PluginsList) => PluginsList) => {
      setState((current) => {
        if (current.status !== 'ready') return current;
        const list = update(current.list);
        if (client) cache.set(client, list);
        return ready(list);
      });
    },
    [client],
  );

  const refresh = useCallback(async () => {
    if (!client) return;
    const list = await client.request('plugins.list');
    cache.set(client, list);
    setState(ready(list));
  }, [client]);

  return useMemo(() => ({ state, apply, refresh }), [state, apply, refresh]);
}
