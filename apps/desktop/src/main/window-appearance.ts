// 窗口的外观（记在桌面端的 userData 里，window-appearance.json）：主题模式、浅色与深色下的窗口底色（设置 → 外观里自定义的
// 背景，没改时是 THEME_BACKGROUND）与半透明侧栏。渲染进程改了就告诉主进程（setThemeSource / setWindowAppearance），下次启动
// 在创建窗口之前读回来：窗口一出现就是对的底色、材质与深浅色，不用等页面加载完再换，启动时不闪默认的底色。

import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WindowAppearanceInput } from '../shared/desktop-api.js';
import {
  isThemeMode,
  type ResolvedTheme,
  THEME_BACKGROUND,
  type ThemeMode,
} from '../shared/theme.js';

export interface WindowAppearance extends WindowAppearanceInput {
  themeMode: ThemeMode;
}

export const WINDOW_APPEARANCE_FILE = 'window-appearance.json';

export const DEFAULT_WINDOW_APPEARANCE: WindowAppearance = Object.freeze({
  themeMode: 'system',
  background: Object.freeze({ ...THEME_BACKGROUND }),
  translucentSidebar: false,
}) as WindowAppearance;

const HEX = /^#[0-9a-f]{6}$/i;

/** 渲染进程送来的底色与半透明侧栏；格式不对时是 undefined。 */
export function parseWindowAppearanceInput(raw: unknown): WindowAppearanceInput | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const background = value.background as Record<string, unknown> | null | undefined;
  if (background === null || typeof background !== 'object') return undefined;
  const pick = (theme: ResolvedTheme) => {
    const color = background[theme];
    return typeof color === 'string' && HEX.test(color) ? color.toLowerCase() : undefined;
  };
  const light = pick('light');
  const dark = pick('dark');
  if (light === undefined || dark === undefined || typeof value.translucentSidebar !== 'boolean') {
    return undefined;
  }
  return { background: { light, dark }, translucentSidebar: value.translucentSidebar };
}

/** 读回文件内容；坏掉的项用默认值。 */
export function parseWindowAppearance(raw: unknown): WindowAppearance {
  if (raw === null || typeof raw !== 'object') return DEFAULT_WINDOW_APPEARANCE;
  const value = raw as Record<string, unknown>;
  const input = parseWindowAppearanceInput(value);
  return {
    themeMode: isThemeMode(value.themeMode) ? value.themeMode : 'system',
    background: input?.background ?? DEFAULT_WINDOW_APPEARANCE.background,
    translucentSidebar: input?.translucentSidebar ?? false,
  };
}

/** 启动时同步读（窗口创建之前）；没有或坏了用默认值。 */
export function loadWindowAppearance(dir: string): WindowAppearance {
  try {
    return parseWindowAppearance(
      JSON.parse(readFileSync(join(dir, WINDOW_APPEARANCE_FILE), 'utf8')),
    );
  } catch {
    return DEFAULT_WINDOW_APPEARANCE;
  }
}

/** 先写临时文件再改名，写到一半退出不会留下坏文件。 */
export async function saveWindowAppearance(dir: string, value: WindowAppearance): Promise<void> {
  const file = join(dir, WINDOW_APPEARANCE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temp, file);
}
