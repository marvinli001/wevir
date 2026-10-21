// 插件市场的数据（plugin-market.md §9）：索引是 `market.index`（Host 默认用一小时内的缓存，刷新按钮带 `refresh`），条目里的
// README 与图标是 `market.file`（0.94.0，Host 有 `market_files` 时）。同一个来源上次读到的索引先显示，来回进出详情页不闪骨架。
// 开发时 `VITE_WEVIR_FAKE_MARKET=1` 换成 dev-fixture.ts 的假来源；正式构建里 `import.meta.env.DEV` 是 false，连同它的 chunk 一起
// 被摇掉。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describe } from '@/host/host-connection';

export type MarketIndexResult = MethodResult<'market.index'>;

/** 市场数据从哪来：Host，或开发用的假来源。 */
export interface MarketSource {
  index(refresh: boolean): Promise<MarketIndexResult>;
  /** 条目文件的字节（base64）；Host 没有 `market_files` 时没有，图标用占位块、详情用描述。 */
  file?: (entry: string, path: string) => Promise<string>;
}

const FAKE_MARKET = import.meta.env.DEV && Boolean(import.meta.env.VITE_WEVIR_FAKE_MARKET);

const hostSources = new WeakMap<WevirClient, MarketSource>();
let fakeSource: Promise<MarketSource> | undefined;

function hostSource(client: WevirClient): MarketSource {
  let source = hostSources.get(client);
  if (source === undefined) {
    const files = hostSupports(client.hello.features, 'market_files');
    source = {
      index: (refresh) => client.request('market.index', refresh ? { refresh: true } : {}),
      ...(files && {
        file: async (entry: string, path: string) =>
          (await client.request('market.file', { entry, path })).data,
      }),
    };
    hostSources.set(client, source);
  }
  return source;
}

/** 当前的来源；开发用的假来源要先异步加载，这期间是 undefined。 */
export function useMarketSource(client: WevirClient): MarketSource | undefined {
  const [fake, setFake] = useState<MarketSource>();
  useEffect(() => {
    if (!FAKE_MARKET) return;
    fakeSource ??= import('./dev-fixture').then((module) => module.fakeMarketSource);
    let current = true;
    void fakeSource.then((source) => current && setFake(source));
    return () => {
      current = false;
    };
  }, []);
  return FAKE_MARKET ? fake : hostSource(client);
}

export type MarketState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | {
      status: 'ready';
      result: MarketIndexResult;
      refreshing: boolean;
      /** 刷新失败的原因（Host 回了缓存并带 `error`，或这次请求失败）；刷新按钮旁的警告点显示它。 */
      warning?: string;
    };

const cache = new WeakMap<MarketSource, MarketIndexResult>();

const ready = (result: MarketIndexResult, refreshing = false): MarketState => ({
  status: 'ready',
  result,
  refreshing,
  ...(result.error !== undefined && { warning: result.error }),
});

export interface MarketData {
  state: MarketState;
  /** 刷新按钮与失败后的“重试”：强制重新读取。 */
  refresh(): void;
}

export function useMarket(source: MarketSource | undefined): MarketData {
  const [state, setState] = useState<MarketState>(() => {
    const cached = source && cache.get(source);
    return cached ? ready(cached) : { status: 'loading' };
  });

  const load = useCallback(
    (refresh: boolean, isCurrent: () => boolean = () => true) => {
      if (source === undefined) return;
      // 打开页面时的读取不转圈（多半是 Host 的缓存），只有刷新按钮转。
      setState((current) =>
        current.status !== 'ready'
          ? { status: 'loading' }
          : refresh
            ? { ...current, refreshing: true }
            : current,
      );
      source.index(refresh).then(
        (result) => {
          cache.set(source, result);
          if (isCurrent()) setState(ready(result));
        },
        (reason: unknown) => {
          if (!isCurrent()) return;
          const error = describe(reason);
          // 已经显示着索引的留着它，只亮警告点。
          setState((current) =>
            current.status === 'ready'
              ? { ...current, refreshing: false, warning: error }
              : { status: 'error', error },
          );
        },
      );
    },
    [source],
  );

  useEffect(() => {
    if (source === undefined) return;
    const cached = cache.get(source);
    setState(cached ? ready(cached) : { status: 'loading' });
    let current = true;
    load(false, () => current);
    return () => {
      current = false;
    };
  }, [source, load]);

  const refresh = useCallback(() => load(true), [load]);
  return useMemo(() => ({ state, refresh }), [state, refresh]);
}

// ---- 条目文件 ----

/** 读过的文件，键是 `<commit>:<条目>/<路径>`（同一提交的文件不会变）；失败的不留，下次再读。 */
const files = new Map<string, Promise<string>>();

export type MarketFileState =
  | { status: 'loading' }
  | { status: 'ready'; data: string }
  | { status: 'missing' };

/** 条目里的一个文件（base64）。`path` 省略或来源读不了文件时是 `missing`。 */
export function useMarketFile(
  source: MarketSource | undefined,
  commit: string,
  entry: string,
  path: string | undefined,
): MarketFileState {
  const key = path === undefined ? undefined : `${commit}:${entry}/${path}`;
  const read = source?.file;
  const [state, setState] = useState<MarketFileState>({ status: 'loading' });
  useEffect(() => {
    if (key === undefined || path === undefined || read === undefined) {
      setState({ status: 'missing' });
      return;
    }
    let promise = files.get(key);
    if (promise === undefined) {
      promise = read(entry, path);
      files.set(key, promise);
      promise.catch(() => files.delete(key));
    }
    let current = true;
    setState({ status: 'loading' });
    promise.then(
      (data) => current && setState({ status: 'ready', data }),
      () => current && setState({ status: 'missing' }),
    );
    return () => {
      current = false;
    };
  }, [key, read, entry, path]);
  return state;
}
