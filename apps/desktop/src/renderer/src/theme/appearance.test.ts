import type { ThemeFile } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from '../../../shared/theme.js';
import { cacheCustomTheme } from './custom-theme-model';

const h = vi.hoisted(() => ({ native: vi.fn(), window: vi.fn() }));
vi.mock('@/platform/platform', () => ({
  platformApi: () => ({
    setThemeSource: h.native,
    setWindowAppearance: h.window,
    getWindowChrome: () => ({ material: true }),
  }),
}));
vi.mock('@/host/error-text', () => ({ describeError: (reason: Error) => reason.message }));

let values: Map<string, string>;
let attributes: Set<string>;
let storage: Map<string, string>;
let root: {
  dataset: Record<string, string>;
  style: { setProperty: ReturnType<typeof vi.fn>; removeProperty: (name: string) => void };
  setAttribute: (name: string) => void;
  removeAttribute: (name: string) => void;
  toggleAttribute: (name: string, value: boolean) => void;
};

beforeEach(() => {
  vi.resetModules();
  h.native.mockReset().mockResolvedValue(undefined);
  h.window.mockReset().mockResolvedValue(undefined);
  values = new Map();
  storage = new Map([[THEME_STORAGE_KEY, 'light']]);
  attributes = new Set();
  root = {
    dataset: { theme: 'light' },
    style: {
      setProperty: vi.fn((name: string, value: string) => values.set(name, value)),
      removeProperty: (name: string) => {
        values.delete(name);
      },
    },
    setAttribute: (name) => {
      attributes.add(name);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
    toggleAttribute: (name, value) => {
      if (value) attributes.add(name);
      else attributes.delete(name);
    },
  };
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
    getComputedStyle: () => ({ colorScheme: root.dataset.theme }),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const mode = await import('./theme');
  const appearance = await import('./appearance');
  const { customThemeStore } = await import('./custom-theme');
  mode.bootstrapTheme();
  appearance.bootstrapAppearance();
  const activate = (theme: ThemeFile) =>
    customThemeStore.set({
      theme: cacheCustomTheme(
        {
          id: 'fixture',
          revision: '1',
          theme,
          assets: {},
          directory: '/themes',
          problems: [],
          readOnly: false,
        },
        'host_fixture',
      ),
      activeId: 'fixture',
      problems: [],
    });
  const clear = () => customThemeStore.set({ theme: null, activeId: null, problems: [] });
  return { mode, appearance, activate, clear, customThemeStore };
}

describe('theme and appearance application', () => {
  it('bootstraps the cached scheme and background before sending any native defaults', async () => {
    const theme = cacheCustomTheme(
      {
        id: 'fixture',
        revision: '1',
        readOnly: false,
        directory: '/themes',
        assets: {},
        problems: [],
        theme: {
          schemaVersion: 1,
          name: 'Cached',
          colorScheme: 'dark',
          dark: { background: '#002b36' },
        },
      },
      'host_fixture',
    );
    storage.set(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(theme));
    await setup();
    expect(root.dataset.theme).toBe('dark');
    expect(values.get('--background')).toBe('#002b36');
    expect(h.native).toHaveBeenCalledExactlyOnceWith('dark');
    expect(h.window).toHaveBeenCalledExactlyOnceWith({
      background: { light: '#fcfbfa', dark: '#002b36' },
      translucentWindow: true,
    });
    expect(storage.get(THEME_STORAGE_KEY)).toBe('light');
  });

  it('merges colors without changing fonts or saved mode, mirrors native appearance, and removes orphan variables', async () => {
    storage.set(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        light: { background: '#faf4ed' },
        dark: {},
        uiFont: 'system',
        uiFontSize: 16,
        codeFontSize: 15,
      }),
    );
    const { mode, appearance, activate, clear } = await setup();
    const notifications: (string | undefined)[] = [];
    const stop = appearance.subscribeAppearance(() =>
      notifications.push(values.get('--background')),
    );
    activate({
      schemaVersion: 1,
      name: 'Forced dark',
      colorScheme: 'dark',
      dark: { background: '#002b36', foreground: '#eee8d5', tokens: { 'terminal-red': '#ff3366' } },
    });
    expect(root.dataset.theme).toBe('dark');
    expect(h.native).toHaveBeenLastCalledWith('dark');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('light');
    expect(values.get('--font-ui')).toContain('system-ui');
    expect(values.get('--text-code')).toBe('15px');
    expect(values.get('--terminal-red')).toBe('#ff3366');
    expect(notifications.at(-1)).toBe('#002b36');
    expect(h.window).toHaveBeenLastCalledWith({
      background: { light: '#faf4ed', dark: '#002b36' },
      translucentWindow: true,
    });
    clear();
    expect(root.dataset.theme).toBe('light');
    expect(mode.resolvedTheme()).toBe('light');
    expect(h.native).toHaveBeenLastCalledWith('light');
    expect(values.has('--terminal-red')).toBe(false);
    expect(values.get('--background')).toBe('#faf4ed');
    expect(values.get('--text-code')).toBe('15px');
    expect(h.window).toHaveBeenLastCalledWith({
      background: { light: '#faf4ed', dark: '#101114' },
      translucentWindow: true,
    });
    clear();
    appearance.appearanceStore.set((current) => ({ ...current, light: {} }));
    expect(values.has('--background')).toBe(false);
    stop();
  });

  it('retains CSS/backdrop without applying absent mode colors and disables transitions for same-mode theme changes', async () => {
    const { activate, appearance, customThemeStore, mode } = await setup();
    activate({
      schemaVersion: 1,
      name: 'Only dark',
      dark: { background: '#002b36' },
      css: 'body { opacity: .5 }',
      backdrop: { kind: 'image', file: 'backdrop.webp' },
    });
    expect(root.dataset.theme).toBe('light');
    expect(values.has('--background')).toBe(false);
    expect(customThemeStore.get().theme?.css).toContain('opacity');
    expect(customThemeStore.get().theme?.backdrop?.file).toBe('backdrop.webp');
    const switching: boolean[] = [];
    root.style.setProperty.mockImplementation((name: string, value: string) => {
      switching.push(attributes.has('data-theme-switching'));
      values.set(name, value);
    });
    activate({ schemaVersion: 1, name: 'Light', light: { background: '#faf4ed' } });
    expect(switching.every(Boolean)).toBe(true);
    expect(attributes.has('data-theme-switching')).toBe(false);
    const notifications: (string | undefined)[] = [];
    const stop = appearance.subscribeAppearance(() =>
      notifications.push(values.get('--background')),
    );
    appearance.updateAppearance({ light: { background: '#ffffff' } });
    expect(notifications.at(-1)).toBe('#faf4ed');
    mode.setThemeMode('dark');
    expect(values.has('--background')).toBe(false);
    stop();
  });

  it('restores defaults and retains a visible application error after a failed variable write', async () => {
    const { activate, customThemeStore } = await setup();
    root.style.setProperty.mockImplementation((name: string, value: string) => {
      values.set(name, value);
      if (name === '--terminal-blue') throw new Error('Invalid theme variable');
    });
    activate({
      schemaVersion: 1,
      name: 'Broken',
      colorScheme: 'dark',
      dark: { background: '#002b36', tokens: { 'terminal-blue': '#123456' } },
    });
    expect(customThemeStore.get().theme).toBeNull();
    expect(customThemeStore.get().error).toBe('Invalid theme variable');
    expect(root.dataset.theme).toBe('light');
    expect(values.has('--terminal-blue')).toBe(false);
    expect(values.has('--background')).toBe(false);
    expect(h.native).toHaveBeenLastCalledWith('light');
  });
});
