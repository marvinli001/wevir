import type { WevirClient } from '@wevir/client-sdk';
import type { ThemeResult, ThemesUpdated } from '@wevir/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_THEME_STORAGE_KEY } from '../../../shared/theme.js';
import { cacheCustomTheme, parseCachedCustomTheme } from './custom-theme-model';

vi.mock('@/host/error-text', () => ({ describeError: (reason: Error) => reason.message }));

const result = (id = 'lagoon', revision = '1'): ThemeResult => ({
  id,
  revision,
  readOnly: false,
  directory: '/themes',
  assets: { file: `http://127.0.0.1:1234/files/theme/backdrop.webp?v=${revision}` },
  problems: [],
  theme: {
    schemaVersion: 1,
    name: id,
    colorScheme: 'dark',
    dark: { background: '#002b36', foreground: '#eee8d5' },
    css: '.surface-card { opacity: .9 }',
    backdrop: { kind: 'image', file: 'backdrop.webp' },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});

function fakeClient() {
  const states = new Set<(state: { status: string }) => void>();
  const updates = new Set<(update: ThemesUpdated) => void>();
  const client = {
    state: { status: 'connected' },
    hello: { hostId: 'host_fixture', protocolVersion: '0.195.0' },
    supports: vi.fn(() => true),
    can: vi.fn(() => true),
    request: vi.fn<(method: string) => Promise<ThemeResult | { activeId: string | null }>>(
      async (method: string) => (method === 'themes.list' ? { activeId: 'lagoon' } : result()),
    ),
    onStateChange: (listener: (state: { status: string }) => void) => {
      states.add(listener);
      return () => states.delete(listener);
    },
    onThemesUpdated: (listener: (update: ThemesUpdated) => void) => {
      updates.add(listener);
      return () => updates.delete(listener);
    },
  };
  return {
    client,
    bind: async () =>
      (await import('./custom-theme')).bindCustomThemes(client as unknown as WevirClient),
    update: (activeId: string | null) => {
      for (const listener of updates) listener({ activeId, revisions: {} });
    },
    state: (status: string) => {
      client.state = { status };
      for (const listener of states) listener(client.state);
    },
    states,
    updates,
  };
}

describe('custom theme cache', () => {
  it('keeps cached colors but waits for a live Host read before exposing media addresses', async () => {
    window.localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify(cacheCustomTheme(result(), 'host_fixture')),
    );
    const { customThemeStore } = await import('./custom-theme');
    expect(customThemeStore.get().theme?.variables.dark['--background']).toBe('#002b36');
    expect(customThemeStore.get().theme?.assets).toEqual({});
    const cached = cacheCustomTheme(result(), 'host_fixture');
    expect(
      parseCachedCustomTheme({
        ...cached,
        assets: { file: 'http://127.0.0.1:1234/arbitrary-page' },
      }),
    ).toBeUndefined();
  });
  it('keeps parsed mode variables and descriptions without asset bytes, rejecting unsafe cached values', () => {
    const cached = cacheCustomTheme(result(), 'host_fixture');
    expect(parseCachedCustomTheme(JSON.parse(JSON.stringify(cached)))).toEqual(cached);
    expect(cached?.variables.light).toEqual({});
    expect(cached?.variables.dark['--background']).toBe('#002b36');
    expect(cached?.css).toContain('surface-card');
    expect(cached?.backdrop?.kind).toBe('image');
    expect(
      parseCachedCustomTheme({ ...cached, assets: { file: 'data:image/png;base64,AAAA' } }),
    ).toBeUndefined();
    expect(
      parseCachedCustomTheme({
        ...cached,
        variables: { light: {}, dark: { '--background': 'url(https://example.com)' } },
      }),
    ).toBeUndefined();
    expect(
      parseCachedCustomTheme({
        ...cached,
        variables: { light: {}, dark: { '--font-ui': 'Arial' } },
      }),
    ).toBeUndefined();
  });
});

describe('Host custom themes', () => {
  it('renews asset URLs while visible and releases the renewal timer and visibility listener', async () => {
    vi.useFakeTimers();
    const host = fakeClient();
    let stop: (() => void) | undefined;
    try {
      stop = await host.bind();
      const { customThemeStore } = await import('./custom-theme');
      await vi.waitFor(() => expect(customThemeStore.get().theme?.id).toBe('lagoon'));
      const refreshed = {
        ...result(),
        assets: { file: 'http://127.0.0.1:1234/files/renewed/backdrop.webp?v=1' },
      };
      host.client.request.mockImplementation(async (method) =>
        method === 'themes.list' ? { activeId: 'lagoon' } : refreshed,
      );
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(customThemeStore.get().theme?.assets).toEqual(refreshed.assets);
      Object.assign(document, { visibilityState: 'hidden' });
      const count = host.client.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(host.client.request.mock.calls).toHaveLength(count);
      Object.assign(document, { visibilityState: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(host.client.request.mock.calls.length).toBeGreaterThan(count);
      stop();
      stop = undefined;
      const stopped = host.client.request.mock.calls.length;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(host.client.request.mock.calls).toHaveLength(stopped);
    } finally {
      stop?.();
      vi.useRealTimers();
    }
  });
  it('falls back locally without retrying the same failed URL and lets a new revision recover', async () => {
    const host = fakeClient();
    const stop = await host.bind();
    const { customThemeStore, reportThemeBackdrop } = await import('./custom-theme');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.id).toBe('lagoon'));
    const theme = customThemeStore.get().theme as NonNullable<
      ReturnType<typeof customThemeStore.get>['theme']
    >;
    const failed = {
      ...result(),
      problems: [{ path: 'backdrop.file', severity: 'error' as const, message: 'Cannot decode' }],
    };
    host.client.request.mockResolvedValue(failed);
    reportThemeBackdrop(theme, 'file', theme.assets.file as string, 'failed');
    await vi.waitFor(() => expect(customThemeStore.get().problems).toEqual(failed.problems));
    const count = host.client.request.mock.calls.length;
    reportThemeBackdrop(theme, 'file', theme.assets.file as string, 'failed');
    expect(host.client.request.mock.calls).toHaveLength(count);
    reportThemeBackdrop(theme, 'file', theme.assets.file as string, 'loaded');
    expect(host.client.request.mock.calls).toHaveLength(count);
    expect(host.client.request).toHaveBeenLastCalledWith('themes.get', {
      id: theme.id,
      backdropStatus: { revision: '1', asset: 'file', status: 'failed' },
    });
    host.client.request.mockResolvedValue(result('lagoon', '2'));
    host.update('lagoon');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.revision).toBe('2'));
    expect(customThemeStore.get().failedAssets).toBeUndefined();
    reportThemeBackdrop(theme, 'file', theme.assets.file as string, 'failed');
    expect(customThemeStore.get().failedAssets).toBeUndefined();
    stop();
  });

  it('does not send diagnostic parameters without management permission', async () => {
    const host = fakeClient();
    host.client.can.mockImplementation((...args: unknown[]) => args[0] !== 'host.manage');
    const stop = await host.bind();
    const { customThemeStore, reportThemeBackdrop } = await import('./custom-theme');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.id).toBe('lagoon'));
    const theme = customThemeStore.get().theme as NonNullable<
      ReturnType<typeof customThemeStore.get>['theme']
    >;
    reportThemeBackdrop(theme, 'file', theme.assets.file as string, 'failed');
    await Promise.resolve();
    expect(host.client.request).toHaveBeenLastCalledWith('themes.get', { id: theme.id });
    expect(customThemeStore.get().failedAssets?.file).toBe(theme.assets.file);
    stop();
  });
  it('loads the active theme, follows notifications, clears on disable, and releases subscriptions', async () => {
    const host = fakeClient();
    const stop = await host.bind();
    const { customThemeStore } = await import('./custom-theme');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.id).toBe('lagoon'));
    expect(
      JSON.parse(window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) ?? 'null').variables.dark[
        '--background'
      ],
    ).toBe('#002b36');
    host.client.request.mockImplementation(async () => result('new-theme', '2'));
    host.update('new-theme');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.revision).toBe('2'));
    host.update(null);
    expect(customThemeStore.get().theme).toBeNull();
    expect(window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
    stop();
    expect(host.states.size + host.updates.size).toBe(0);
  });

  it('ignores a stale list or get after a newer update or disable', async () => {
    const host = fakeClient();
    const list = deferred<{ activeId: string | null }>();
    const get = deferred<ThemeResult>();
    host.client.request.mockImplementation((method: string) =>
      method === 'themes.list' ? list.promise : get.promise,
    );
    const stop = await host.bind();
    const { customThemeStore } = await import('./custom-theme');
    host.update('new-theme');
    get.resolve(result('new-theme'));
    await vi.waitFor(() => expect(customThemeStore.get().theme?.id).toBe('new-theme'));
    list.resolve({ activeId: 'lagoon' });
    await Promise.resolve();
    expect(host.client.request).not.toHaveBeenCalledWith('themes.get', { id: 'lagoon' });
    const pending = deferred<ThemeResult>();
    host.client.request.mockImplementation(() => pending.promise);
    host.update('lagoon');
    host.update(null);
    pending.resolve(result());
    await Promise.resolve();
    expect(customThemeStore.get().theme).toBeNull();
    stop();
  });

  it('keeps the last valid theme while disconnected, refreshes on reconnect, and ignores disposed requests', async () => {
    const host = fakeClient();
    const stop = await host.bind();
    const { customThemeStore } = await import('./custom-theme');
    await vi.waitFor(() => expect(customThemeStore.get().theme).not.toBeNull());
    const pending = deferred<ThemeResult>();
    host.client.request.mockImplementation(() => pending.promise);
    host.update('new-theme');
    host.state('reconnecting');
    pending.resolve(result('new-theme'));
    await Promise.resolve();
    expect(customThemeStore.get().theme?.id).toBe('lagoon');
    host.client.request.mockImplementation(async (method: string) =>
      method === 'themes.list' ? { activeId: 'new-theme' } : result('new-theme', '3'),
    );
    host.state('connected');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.revision).toBe('3'));
    const disposed = deferred<ThemeResult>();
    host.client.request.mockImplementation(() => disposed.promise);
    host.update('lagoon');
    stop();
    disposed.resolve(result());
    await Promise.resolve();
    expect(customThemeStore.get().theme?.revision).toBe('3');
  });

  it('clears cached colors and scheme for an old Host, without requesting unsupported methods', async () => {
    window.localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify(cacheCustomTheme(result(), 'host_fixture')),
    );
    const host = fakeClient();
    host.client.supports.mockReturnValue(false);
    const stop = await host.bind();
    const { customThemeStore } = await import('./custom-theme');
    expect(customThemeStore.get().theme).toBeNull();
    expect(window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
    expect(host.client.request).not.toHaveBeenCalled();
    stop();
  });

  it('keeps a valid snapshot with file errors and exposes errors without applying a never-valid theme', async () => {
    const host = fakeClient();
    const stop = await host.bind();
    const { customThemeStore, recoverCustomTheme } = await import('./custom-theme');
    await vi.waitFor(() => expect(customThemeStore.get().theme).not.toBeNull());
    const bad = {
      ...result(),
      revision: 'bad',
      problems: [{ path: 'theme.json', message: 'Invalid JSON', severity: 'error' as const }],
    };
    host.client.request.mockResolvedValue(bad);
    host.update('lagoon');
    await vi.waitFor(() => expect(customThemeStore.get().theme?.revision).toBe('bad'));
    expect(customThemeStore.get().problems).toEqual(bad.problems);
    host.client.request.mockResolvedValue({ ...bad, theme: undefined });
    host.update('lagoon');
    await vi.waitFor(() => expect(customThemeStore.get().theme).toBeNull());
    expect(customThemeStore.get().problems).toEqual(bad.problems);
    recoverCustomTheme(new Error('CSS application failed'));
    expect(customThemeStore.get().error).toBe('CSS application failed');
    expect(host.client.request).toHaveBeenLastCalledWith('themes.setActive', { id: null });
    host.update(null);
    expect(customThemeStore.get().error).toBe('CSS application failed');
    stop();
  });
});
