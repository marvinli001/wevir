// 市场条目的安装状态（0.99.0，plugin-market.md §9）：按来源一份，列表行与详情页共用，进出详情页时圆环接着转。请求发出后先是
// `pending`（还没收到进度），然后按 `market.installProgress` 走 `download`（字节）与 `install`（发布事务）；请求结束、插件列表
// 重读完才去掉，按钮直接从圆环变成“已安装”。

import type { MethodResult } from '@wevir/protocol';
import { useCallback, useSyncExternalStore } from 'react';
import type { MarketSource } from './use-market';

export interface InstallState {
  phase: 'pending' | 'download' | 'install';
  receivedBytes: number;
  totalBytes: number;
}

/** 圆环填到多少（0–1）；`undefined` 是不定进度（等待与发布时转圈）。 */
export function installFraction(state: InstallState): number | undefined {
  if (state.phase !== 'download' || state.totalBytes === 0) return undefined;
  return Math.min(1, state.receivedBytes / state.totalBytes);
}

export type InstallOutcome =
  | { status: 'installed'; result: MethodResult<'market.install'> }
  | { status: 'cancelled' };

class MarketInstalls {
  readonly #source: MarketSource;
  readonly #states = new Map<string, InstallState>();
  readonly #cancelled = new Set<string>();
  readonly #listeners = new Set<() => void>();

  constructor(source: MarketSource) {
    this.#source = source;
    // 来源跟客户端同寿，订阅不退。只认这个窗口发起的安装。
    source.onInstallProgress?.(({ entry, phase, receivedBytes, totalBytes }) => {
      const current = this.#states.get(entry);
      // 请求已结束、正在等列表重读的不再倒退回下载。
      if (current === undefined || (current.phase === 'install' && phase === 'download')) return;
      this.#set(entry, { phase, receivedBytes, totalBytes });
    });
  }

  get(entry: string): InstallState | undefined {
    return this.#states.get(entry);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * 装一个条目；`afterInstall`（重读插件列表）完成前圆环停在发布阶段。同一条目已在装时不再发请求，返回 cancelled
   * 以外的结果由第一次的调用方处理。失败原样抛出。
   */
  async start(
    entry: string,
    inputs: Record<string, string> | undefined,
    afterInstall: () => Promise<void>,
  ): Promise<InstallOutcome> {
    const install = this.#source.install;
    if (install === undefined || this.#states.has(entry)) return { status: 'cancelled' };
    this.#cancelled.delete(entry);
    this.#set(entry, { phase: 'pending', receivedBytes: 0, totalBytes: 0 });
    try {
      const result = await install(entry, inputs);
      const state = this.#states.get(entry);
      this.#set(entry, {
        phase: 'install',
        receivedBytes: state?.totalBytes ?? 0,
        totalBytes: state?.totalBytes ?? 0,
      });
      await afterInstall().catch(() => {});
      return { status: 'installed', result };
    } catch (error) {
      if (this.#cancelled.has(entry)) return { status: 'cancelled' };
      throw error;
    } finally {
      this.#cancelled.delete(entry);
      this.#set(entry, undefined);
    }
  }

  cancel(entry: string): void {
    if (!this.#states.has(entry)) return;
    this.#cancelled.add(entry);
    void this.#source.cancelInstall?.(entry).catch(() => {});
  }

  #set(entry: string, state: InstallState | undefined): void {
    if (state === undefined) this.#states.delete(entry);
    else this.#states.set(entry, state);
    for (const listener of [...this.#listeners]) listener();
  }
}

const stores = new WeakMap<MarketSource, MarketInstalls>();

export function marketInstalls(source: MarketSource): MarketInstalls {
  let store = stores.get(source);
  if (store === undefined) {
    store = new MarketInstalls(source);
    stores.set(source, store);
  }
  return store;
}

const noop = () => () => {};

/** 一个条目当前的安装状态；没在装时是 undefined。 */
export function useInstallState(
  source: MarketSource | undefined,
  entry: string,
): InstallState | undefined {
  const store = source && marketInstalls(source);
  const subscribe = store?.subscribe ?? noop;
  const get = useCallback(() => store?.get(entry), [store, entry]);
  return useSyncExternalStore(subscribe, get);
}
