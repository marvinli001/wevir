// 市场条目的安装状态（0.99.0）：等待、按进度下载、发布，列表重读完才去掉；停止的不报错，失败原样抛出。
import type { MarketInstallProgress, MethodResult } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { installFraction, marketInstalls } from './market-install';
import type { MarketSource } from './use-market';

const result = {
  plugin: { name: 'Notes' },
  ignored: [],
} as unknown as MethodResult<'market.install'>;

/** 假来源：`install` 等外面调 `finish` / `fail`，`emit` 发进度。 */
function fakeSource() {
  const listeners = new Set<(progress: MarketInstallProgress) => void>();
  let settle:
    | { resolve: (value: typeof result) => void; reject: (error: Error) => void }
    | undefined;
  const calls: string[] = [];
  const source: MarketSource = {
    index: () => Promise.reject(new Error('unused')),
    install: (entry) => {
      calls.push(`install ${entry}`);
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    cancelInstall: async (entry) => {
      calls.push(`cancel ${entry}`);
      settle?.reject(new Error('cancelled'));
    },
    onInstallProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (phase: MarketInstallProgress['phase'], receivedBytes: number) => {
    for (const listener of listeners)
      listener({ entry: 'notes', phase, receivedBytes, totalBytes: 200 });
  };
  return {
    source,
    calls,
    emit,
    finish: () => settle?.resolve(result),
    fail: (message: string) => settle?.reject(new Error(message)),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('marketInstalls', () => {
  it('等待 → 下载 → 发布；列表重读完才去掉，期间来的旧进度不倒退', async () => {
    const fake = fakeSource();
    const store = marketInstalls(fake.source);
    let refreshed!: () => void;
    const pending = store.start(
      'notes',
      undefined,
      () =>
        new Promise((resolve) => {
          refreshed = () => resolve();
        }),
    );
    expect(store.get('notes')?.phase).toBe('pending');
    const fraction = () => {
      const state = store.get('notes');
      return state && installFraction(state);
    };
    expect(fraction()).toBeUndefined();
    fake.emit('download', 50);
    expect(fraction()).toBe(0.25);
    fake.finish();
    await tick();
    expect(store.get('notes')).toEqual({ phase: 'install', receivedBytes: 200, totalBytes: 200 });
    fake.emit('download', 100);
    expect(store.get('notes')?.phase).toBe('install');
    refreshed();
    await expect(pending).resolves.toEqual({ status: 'installed', result });
    expect(store.get('notes')).toBeUndefined();
  });

  it('同一条目不重复发请求；停止后返回 cancelled，不抛错', async () => {
    const fake = fakeSource();
    const store = marketInstalls(fake.source);
    const first = store.start('notes', undefined, async () => {});
    await expect(store.start('notes', undefined, async () => {})).resolves.toEqual({
      status: 'cancelled',
    });
    store.cancel('notes');
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    expect(fake.calls).toEqual(['install notes', 'cancel notes']);
    expect(store.get('notes')).toBeUndefined();
  });

  it('失败原样抛出，状态去掉', async () => {
    const fake = fakeSource();
    const store = marketInstalls(fake.source);
    const pending = store.start('notes', undefined, async () => {});
    fake.fail('HTTP 503');
    await expect(pending).rejects.toThrow('HTTP 503');
    expect(store.get('notes')).toBeUndefined();
  });
});
