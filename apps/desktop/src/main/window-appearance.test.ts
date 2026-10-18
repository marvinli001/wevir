import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_BACKGROUND } from '../shared/theme.js';
import {
  DEFAULT_WINDOW_APPEARANCE,
  loadWindowAppearance,
  parseWindowAppearance,
  parseWindowAppearanceInput,
  saveWindowAppearance,
  WINDOW_APPEARANCE_FILE,
} from './window-appearance.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-window-appearance-'));
  dirs.push(dir);
  return dir;
}

describe('窗口外观', () => {
  it('默认是跟随系统、tokens.css 的底色、不透明的侧栏', () => {
    expect(DEFAULT_WINDOW_APPEARANCE).toEqual({
      themeMode: 'system',
      background: THEME_BACKGROUND,
      translucentSidebar: false,
    });
  });

  it('渲染进程送来的值要两种底色都是 #rrggbb、半透明侧栏是布尔值', () => {
    expect(
      parseWindowAppearanceInput({
        background: { light: '#FDF6E3', dark: '#002b36' },
        translucentSidebar: true,
      }),
    ).toEqual({ background: { light: '#fdf6e3', dark: '#002b36' }, translucentSidebar: true });
    expect(
      parseWindowAppearanceInput({
        background: { light: 'red', dark: '#000000' },
        translucentSidebar: false,
      }),
    ).toBeUndefined();
    expect(
      parseWindowAppearanceInput({ background: { light: '#ffffff', dark: '#000000' } }),
    ).toBeUndefined();
    expect(parseWindowAppearanceInput(null)).toBeUndefined();
  });

  it('文件坏了或没有时用默认值；写下的能原样读回', async () => {
    const dir = tempDir();
    expect(loadWindowAppearance(dir)).toEqual(DEFAULT_WINDOW_APPEARANCE);
    writeFileSync(join(dir, WINDOW_APPEARANCE_FILE), '{not json');
    expect(loadWindowAppearance(dir)).toEqual(DEFAULT_WINDOW_APPEARANCE);
    expect(parseWindowAppearance({ themeMode: 'sepia' })).toEqual(DEFAULT_WINDOW_APPEARANCE);

    const value = {
      themeMode: 'dark' as const,
      background: { light: '#fdf6e3', dark: '#002b36' },
      translucentSidebar: true,
    };
    await saveWindowAppearance(dir, value);
    expect(loadWindowAppearance(dir)).toEqual(value);
  });
});
