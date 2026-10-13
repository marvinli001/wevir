import { useSyncExternalStore } from 'react';

/** 进程内的小状态容器，经 useSyncExternalStore 给组件订阅。界面偏好、右栏标签这类不经 Host 的状态用它。 */
export interface Store<T> {
  get(): T;
  set(next: T | ((current: T) => T)): void;
  subscribe(listener: () => void): () => void;
  use(): T;
}

export function createStore<T>(initial: T, onChange?: (state: T) => void): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (current: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      onChange?.(state);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    use: () => useSyncExternalStore(store.subscribe, store.get),
  };
  return store;
}

/**
 * 存在 localStorage 里的 Store，只放本机的界面偏好（不放令牌等敏感信息）。读不到或格式不对时用
 * `fallback`；localStorage 不可用时只在本次运行内生效。
 */
export function createPersistedStore<T>(
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | undefined,
): Store<T> {
  let initial = fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) initial = parse(JSON.parse(raw)) ?? fallback;
  } catch {
    // 用 fallback。
  }
  return createStore(initial, (state) => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // 存不下就只对本次运行生效。
    }
  });
}
