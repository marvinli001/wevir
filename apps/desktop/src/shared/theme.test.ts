import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  isThemeMode,
  THEME_BACKGROUND,
  THEME_STORAGE_KEY,
} from './theme.js';

const THEME_INIT = readFileSync(
  new URL('../renderer/public/theme-init.js', import.meta.url),
  'utf8',
);

/** 在只有 localStorage、matchMedia、document 的沙箱里执行首帧前脚本，返回它写进 data-theme 的值与 <html> 的底色。 */
function runThemeInit(options: {
  stored?: Record<string, string>;
  systemDark: boolean;
  storageThrows?: boolean;
}): {
  theme: string | undefined;
  background: string | undefined;
  properties: Record<string, string>;
  readKeys: string[];
} {
  const readKeys: string[] = [];
  const dataset: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const style: { backgroundColor?: string; setProperty: (name: string, value: string) => void } = {
    setProperty: (name, value) => {
      properties[name] = value;
    },
  };
  runInNewContext(THEME_INIT, {
    localStorage: {
      getItem(key: string) {
        if (options.storageThrows) throw new Error('SecurityError');
        readKeys.push(key);
        return options.stored?.[key] ?? null;
      },
    },
    matchMedia: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && options.systemDark,
    }),
    document: { documentElement: { dataset, style } },
  });
  return { theme: dataset.theme, background: style.backgroundColor, properties, readKeys };
}

describe('首帧前脚本 theme-init.js', () => {
  it('读的是运行时同一个存储 key', () => {
    expect(runThemeInit({ systemDark: false }).readKeys).toEqual([
      THEME_STORAGE_KEY,
      APPEARANCE_STORAGE_KEY,
    ]);
  });

  it('dark / light 照用，跟随系统或没有存过时看 prefers-color-scheme', () => {
    const stored = (mode: string) => ({ [THEME_STORAGE_KEY]: mode });
    expect(runThemeInit({ stored: stored('dark'), systemDark: false }).theme).toBe('dark');
    expect(runThemeInit({ stored: stored('light'), systemDark: true }).theme).toBe('light');
    expect(runThemeInit({ stored: stored('system'), systemDark: true }).theme).toBe('dark');
    expect(runThemeInit({ stored: stored('system'), systemDark: false }).theme).toBe('light');
    expect(runThemeInit({ systemDark: true }).theme).toBe('dark');
    // 不认识的值与 theme.ts 一样按跟随系统处理。
    expect(isThemeMode('sepia')).toBe(false);
    expect(runThemeInit({ stored: stored('sepia'), systemDark: true }).theme).toBe('dark');
  });

  it('localStorage 不可用时按亮色渲染', () => {
    expect(runThemeInit({ systemDark: true, storageThrows: true }).theme).toBe('light');
  });

  it('首帧的底色是解析出的主题的 THEME_BACKGROUND', () => {
    expect(runThemeInit({ systemDark: true }).background).toBe(THEME_BACKGROUND.dark);
    expect(runThemeInit({ systemDark: false }).background).toBe(THEME_BACKGROUND.light);
    expect(runThemeInit({ systemDark: true, storageThrows: true }).background).toBe(
      THEME_BACKGROUND.light,
    );
  });

  it('自定义了当前主题的背景时，首帧与启动画面用它；只改了另一个主题时不受影响', () => {
    const appearance = JSON.stringify({
      dark: { background: '#002b36', foreground: '#eee8d5' },
      light: { background: 'red' },
    });
    const dark = runThemeInit({
      stored: { [APPEARANCE_STORAGE_KEY]: appearance },
      systemDark: true,
    });
    expect(dark.background).toBe('#002b36');
    expect(dark.properties).toEqual({
      '--splash-custom-bg': '#002b36',
      '--splash-custom-mark': 'color-mix(in oklab, #002b36, #eee8d5 14%)',
    });
    // 不是 #rrggbb 的值不认。
    const light = runThemeInit({
      stored: { [APPEARANCE_STORAGE_KEY]: appearance },
      systemDark: false,
    });
    expect(light.background).toBe(THEME_BACKGROUND.light);
    expect(light.properties).toEqual({});
    expect(
      runThemeInit({ stored: { [APPEARANCE_STORAGE_KEY]: '{bad' }, systemDark: true }).background,
    ).toBe(THEME_BACKGROUND.dark);
  });
});
