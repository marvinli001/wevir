import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type { ThemeProblem } from '@wevir/protocol';
import { describeError } from '@/host/error-text';
import { createStore } from '@/lib/store';
import { CUSTOM_THEME_STORAGE_KEY } from '../../../shared/theme.js';
import {
  type CachedCustomTheme,
  cacheCustomTheme,
  parseCachedCustomTheme,
} from './custom-theme-model';

export interface CustomThemeState {
  theme: CachedCustomTheme | null;
  activeId: string | null;
  problems: ThemeProblem[];
  error?: string;
}

function readCache(): CachedCustomTheme | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (raw !== null) {
      const parsed = parseCachedCustomTheme(JSON.parse(raw));
      if (parsed) return parsed;
      window.localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    }
  } catch {
    // 不可用或损坏的缓存不阻止启动。
  }
  return null;
}

const cached = readCache();
export const customThemeStore = createStore<CustomThemeState>(
  { theme: cached, activeId: cached?.id ?? null, problems: [] },
  ({ theme }) => {
    try {
      if (theme) window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(theme));
      else window.localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
    } catch {
      // 存不下只影响下一次启动。
    }
  },
);

let restoreHostDefault: (() => void) | undefined;

/** 应用失败先恢复设备外观，保留错误供设置页及恢复入口显示。 */
export function recoverCustomTheme(reason: unknown): void {
  customThemeStore.set({
    theme: null,
    activeId: null,
    problems: [],
    error: describeError(reason),
  });
  restoreHostDefault?.();
}

/** 每个客户端独占一组订阅；断线时保留当前主题，重连后重新取得 Host 的权威状态。 */
export function bindCustomThemes(client: WevirClient): () => void {
  let generation = 0;
  let disposed = false;
  const current = (request: number) =>
    !disposed && generation === request && client.state.status === 'connected';
  const clear = () => {
    customThemeStore.set((state) => ({ ...state, theme: null, activeId: null, problems: [] }));
  };
  const restore = () => {
    generation++;
    if (
      client.state.status === 'connected' &&
      client.supports('themes') &&
      client.can('host.manage')
    )
      void client.request('themes.setActive', { id: null }).catch((reason: unknown) => {
        if (!disposed)
          customThemeStore.set((state) => ({ ...state, error: describeError(reason) }));
      });
  };
  restoreHostDefault = restore;

  const read = async (activeId?: string | null) => {
    const request = ++generation;
    if (client.state.status !== 'connected') return;
    if (!client.supports('themes') || !client.can('session.read')) {
      clear();
      return;
    }
    const hostId = client.hello.hostId;
    const previous = customThemeStore.get().theme;
    if (previous && previous.hostId !== hostId) clear();
    try {
      const id =
        activeId === undefined ? (await client.request('themes.list', {})).activeId : activeId;
      if (!current(request)) return;
      if (id === null) {
        clear();
        return;
      }
      const result = await client.request('themes.get', { id });
      if (!current(request)) return;
      customThemeStore.set({
        theme: cacheCustomTheme(result, hostId),
        activeId: id,
        problems: result.problems,
      });
    } catch (reason) {
      if (!current(request)) return;
      if (isRpcError(reason, 'METHOD_NOT_FOUND')) clear();
      else customThemeStore.set((state) => ({ ...state, error: describeError(reason) }));
    }
  };
  const offUpdates = client.onThemesUpdated((update) => void read(update.activeId));
  const offState = client.onStateChange((state) => {
    generation++;
    if (state.status === 'connected') void read();
  });
  void read();
  return () => {
    disposed = true;
    generation++;
    offUpdates();
    offState();
    if (restoreHostDefault === restore) restoreHostDefault = undefined;
  };
}
