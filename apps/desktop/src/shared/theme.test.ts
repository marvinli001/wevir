import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isThemeMode, THEME_STORAGE_KEY } from './theme.js';

const THEME_INIT = readFileSync(
  new URL('../renderer/public/theme-init.js', import.meta.url),
  'utf8',
);

/** 在只有 localStorage、matchMedia、document 的沙箱里执行首帧前脚本，返回它写进 data-theme 的值。 */
function runThemeInit(options: {
  stored?: Record<string, string>;
  systemDark: boolean;
  storageThrows?: boolean;
}): { theme: string | undefined; readKeys: string[] } {
  const readKeys: string[] = [];
  const dataset: Record<string, string> = {};
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
    document: { documentElement: { dataset } },
  });
  return { theme: dataset.theme, readKeys };
}

describe('首帧前脚本 theme-init.js', () => {
  it('读的是运行时同一个存储 key', () => {
    expect(runThemeInit({ systemDark: false }).readKeys).toEqual([THEME_STORAGE_KEY]);
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
});
