import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import {
  compareProtocolVersions,
  type ThemeBackdropStatus,
  type ThemeProblem,
} from '@wevir/protocol';
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
  failedAssets?: Partial<Record<'file' | 'poster', string>>;
}

function readCache(): CachedCustomTheme | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (raw !== null) {
      const parsed = parseCachedCustomTheme(JSON.parse(raw));
      if (parsed) return { ...parsed, assets: {} };
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
let reportBackdrop: ((theme: CachedCustomTheme, status: ThemeBackdropStatus) => void) | undefined;

export function reportThemeBackdrop(
  theme: CachedCustomTheme,
  asset: 'file' | 'poster',
  url: string,
  status: 'loaded' | 'failed',
): void {
  const state = customThemeStore.get();
  if (
    state.theme?.hostId !== theme.hostId ||
    state.theme.id !== theme.id ||
    state.theme.revision !== theme.revision ||
    state.theme.assets[asset] !== url
  )
    return;
  if (status === 'failed') {
    if (state.failedAssets?.[asset] === url) return;
    customThemeStore.set({ ...state, failedAssets: { ...state.failedAssets, [asset]: url } });
  } else if (
    state.failedAssets?.[asset] === url ||
    !state.problems.some((problem) => problem.path === `backdrop.${asset}`)
  )
    return;
  reportBackdrop?.(theme, { revision: theme.revision, asset, status });
}

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
  let diagnosis = 0;
  const renewedFailures = new Set<string>();
  const current = (request: number) =>
    !disposed && generation === request && client.state.status === 'connected';
  const clear = () => {
    customThemeStore.set((state) => ({
      ...state,
      theme: null,
      activeId: null,
      problems: [],
      failedAssets: undefined,
    }));
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

  const read = async (activeId?: string | null, retryAssets = false) => {
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
      if (previous?.id !== id || previous.revision !== result.revision) renewedFailures.clear();
      customThemeStore.set({
        theme: cacheCustomTheme(result, hostId),
        activeId: id,
        problems: result.problems,
        failedAssets:
          !retryAssets && previous?.id === id && previous.revision === result.revision
            ? customThemeStore.get().failedAssets
            : undefined,
      });
    } catch (reason) {
      if (!current(request)) return;
      if (isRpcError(reason, 'METHOD_NOT_FOUND')) clear();
      else customThemeStore.set((state) => ({ ...state, error: describeError(reason) }));
    }
  };
  const report = (theme: CachedCustomTheme, status: ThemeBackdropStatus) => {
    if (client.state.status !== 'connected') return;
    const request = generation;
    const order = ++diagnosis;
    const key = `${theme.id}:${theme.revision}:${status.asset}`;
    const renew = status.status === 'failed' && !renewedFailures.has(key);
    renewedFailures.add(key);
    const canReport =
      client.can('host.manage') &&
      compareProtocolVersions(client.hello.protocolVersion, '0.195.0') >= 0;
    void client
      .request('themes.get', {
        id: theme.id,
        ...(canReport && { backdropStatus: status }),
      })
      .then((result) => {
        if (!current(request) || diagnosis !== order) return;
        const state = customThemeStore.get();
        if (
          state.theme?.hostId !== theme.hostId ||
          state.theme.id !== theme.id ||
          state.theme.revision !== theme.revision
        )
          return;
        customThemeStore.set({
          ...state,
          ...(renew && { theme: cacheCustomTheme(result, theme.hostId) }),
          problems: result.problems,
        });
      })
      .catch(() => undefined);
  };
  reportBackdrop = report;
  const renew = () => {
    if (document.visibilityState !== 'visible' || !customThemeStore.get().theme?.backdrop) return;
    renewedFailures.clear();
    void read(undefined, true);
  };
  const timer = setInterval(renew, 20 * 60 * 1000);
  document.addEventListener('visibilitychange', renew);
  const offUpdates = client.onThemesUpdated((update) => void read(update.activeId));
  const offState = client.onStateChange((state) => {
    generation++;
    if (state.status === 'connected') void read(undefined, true);
  });
  void read();
  return () => {
    disposed = true;
    generation++;
    offUpdates();
    offState();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', renew);
    if (reportBackdrop === report) reportBackdrop = undefined;
    if (restoreHostDefault === restore) restoreHostDefault = undefined;
  };
}
