// 主题模式（T5.2）。渲染进程的 theme.ts、首帧前脚本 renderer/public/theme-init.js 与主进程共用这里的
// 定义；theme.test.ts 核对首帧前脚本用的是同一个存储 key。不 import 任何包。

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = 'light' | 'dark';

/** localStorage 里的主题模式。首帧前脚本与运行时只读写这一个 key。 */
export const THEME_STORAGE_KEY = 'wevir.theme-mode';

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}
