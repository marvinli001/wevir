// 主题模式（T5.2）。渲染进程的 theme.ts、首帧前脚本 renderer/public/theme-init.js 与主进程共用这里的
// 定义；theme.test.ts 核对首帧前脚本用的是同一个存储 key 与底色。不 import 任何包。

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = 'light' | 'dark';

/** localStorage 里的主题模式。首帧前脚本与运行时只读写这一个 key。 */
export const THEME_STORAGE_KEY = 'wevir.theme-mode';

/**
 * localStorage 里设置 → 外观的个性化（renderer 的 theme/appearance.ts）。首帧前脚本从这里取自定义的背景与前景，启动画面与
 * 首帧的底色就是用户选的颜色。
 */
export const APPEARANCE_STORAGE_KEY = 'wevir.appearance.v1';

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * 窗口与首帧的底色，即 tokens.css 的 --background（U1「静器」：浅色象牙、深色石墨；U17.1 起浅色是乳白，不再等于品牌底色）。主进程的窗口底色用它，
 * 首帧前脚本写的是同样的两个值；renderer 的 styles/tokens.test.ts 核对它与 tokens.css 一致，theme.test.ts 核对首帧前脚本。
 */
export const THEME_BACKGROUND: Record<ResolvedTheme, string> = {
  light: '#fcfbfa',
  dark: '#101114',
};
