import type { ResolvedTheme } from '../../../shared/theme.js';

// 设置 → 外观的个性化（照 Codex 桌面端的外观页）：强调色、背景与前景、字体、字号、对比度、半透明侧栏。只存在本机
// （appearance.ts 的 localStorage），这里是纯逻辑：默认值、预设主题、解析，以及按当前主题算出要盖到 <html> 上的变量。
// 没改过的项不产生变量，界面照 tokens.css 的「静器」。

export const ACCENTS = ['ink', 'blue', 'purple', 'pink', 'red', 'orange', 'green', 'teal'] as const;
export type AccentId = (typeof ACCENTS)[number];

/** 强调色在浅色、深色下的值与上面文字的颜色（白字对浅色主题的强调色、深字对深色主题的都在 4.5:1 以上）。 */
export const ACCENT_COLORS: Record<
  Exclude<AccentId, 'ink'>,
  Record<ResolvedTheme, { color: string; text: string }>
> = {
  blue: {
    light: { color: '#2563eb', text: '#ffffff' },
    dark: { color: '#6ea8fe', text: '#0c0d10' },
  },
  purple: {
    light: { color: '#7c3aed', text: '#ffffff' },
    dark: { color: '#b39cff', text: '#0c0d10' },
  },
  pink: {
    light: { color: '#c0266d', text: '#ffffff' },
    dark: { color: '#f590c0', text: '#0c0d10' },
  },
  red: {
    light: { color: '#c9302c', text: '#ffffff' },
    dark: { color: '#f78c86', text: '#0c0d10' },
  },
  orange: {
    light: { color: '#b84a0e', text: '#ffffff' },
    dark: { color: '#f6a066', text: '#0c0d10' },
  },
  green: {
    light: { color: '#1d7a3e', text: '#ffffff' },
    dark: { color: '#6fd08c', text: '#0c0d10' },
  },
  teal: {
    light: { color: '#0f766e', text: '#ffffff' },
    dark: { color: '#5fd4c4', text: '#0c0d10' },
  },
};

/** 色板上显示的颜色（选择框里的圆点）：墨色跟着主题是前景色。 */
export function accentSwatch(accent: AccentId, theme: ResolvedTheme): string {
  return accent === 'ink' ? DEFAULT_COLORS[theme].foreground : ACCENT_COLORS[accent][theme].color;
}

/** tokens.css 的 --background 与 --foreground（shared/theme.ts 的 THEME_BACKGROUND 也是这两个底色）。 */
export const DEFAULT_COLORS: Record<ResolvedTheme, { background: string; foreground: string }> = {
  light: { background: '#fcfbfa', foreground: '#1a1a17' },
  dark: { background: '#101114', foreground: '#eeede8' },
};

export interface ThemeColors {
  background?: string;
  foreground?: string;
}

export const UI_FONTS = ['default', 'system'] as const;
export type UiFont = (typeof UI_FONTS)[number];
export const CONTENT_FONTS = ['ui', 'system', 'serif'] as const;
export type ContentFont = (typeof CONTENT_FONTS)[number];
export const CODE_FONTS = ['default', 'system'] as const;
export type CodeFont = (typeof CODE_FONTS)[number];

export interface Appearance {
  accent: AccentId;
  /** 只存改过的颜色；省略的取 DEFAULT_COLORS。 */
  light: ThemeColors;
  dark: ThemeColors;
  uiFont: UiFont;
  contentFont: ContentFont;
  codeFont: CodeFont;
  /** 正文的字号（px），其余字号按比例缩放。 */
  uiFontSize: number;
  /** 消息里代码的字号（px），差异视图小 1 px。 */
  codeFontSize: number;
  /** macOS 的半透明侧栏（窗口的 vibrancy）；其他平台不显示这一项。 */
  translucentSidebar: boolean;
  /** 0–100：分隔线与次要文字离正文色多近，50 是 tokens.css 的原样。 */
  contrast: number;
}

export const UI_FONT_SIZE = { min: 12, max: 18, default: 14 } as const;
export const CODE_FONT_SIZE = { min: 10, max: 16, default: 13 } as const;
export const DEFAULT_CONTRAST = 50;

export const DEFAULT_APPEARANCE: Appearance = Object.freeze({
  accent: 'ink',
  light: Object.freeze({}),
  dark: Object.freeze({}),
  uiFont: 'default',
  contentFont: 'ui',
  codeFont: 'default',
  uiFontSize: UI_FONT_SIZE.default,
  codeFontSize: CODE_FONT_SIZE.default,
  translucentSidebar: false,
  contrast: DEFAULT_CONTRAST,
}) as Appearance;

/** 主题：强调色与两套背景、前景。预设与导入、复制都是这个形状。 */
export interface ThemeSpec {
  accent: AccentId;
  light: ThemeColors;
  dark: ThemeColors;
}

export interface ThemePreset extends ThemeSpec {
  id: string;
  name: string;
}

/** 预设主题。Wevir 是 tokens.css 的原样；其余取自各配色方案公开的色值。 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'wevir', name: 'Wevir', accent: 'ink', light: {}, dark: {} },
  {
    id: 'solarized',
    name: 'Solarized',
    accent: 'blue',
    light: { background: '#fdf6e3', foreground: '#073642' },
    dark: { background: '#002b36', foreground: '#eee8d5' },
  },
  {
    id: 'nord',
    name: 'Nord',
    accent: 'teal',
    light: { background: '#eceff4', foreground: '#2e3440' },
    dark: { background: '#2e3440', foreground: '#eceff4' },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    accent: 'orange',
    light: { background: '#fbf1c7', foreground: '#3c3836' },
    dark: { background: '#282828', foreground: '#ebdbb2' },
  },
  {
    id: 'rose',
    name: 'Rosé',
    accent: 'pink',
    light: { background: '#faf4ed', foreground: '#575279' },
    dark: { background: '#191724', foreground: '#e0def4' },
  },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** 用户输入的颜色：`#abc`、`abc`、`#aabbcc`、`AABBCC` 都认，统一成小写的 `#rrggbb`；认不出时是 undefined。 */
export function parseHexColor(input: string): string | undefined {
  let value = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(value)) value = [...value].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(value) ? `#${value}` : undefined;
}

/** 去掉与默认值相同的颜色，统一成小写：同样的颜色只有一种存法，预设才认得出来。 */
export function normalizeColors(theme: ResolvedTheme, colors: ThemeColors): ThemeColors {
  const out: ThemeColors = {};
  for (const key of ['background', 'foreground'] as const) {
    const value = colors[key]?.toLowerCase();
    if (value !== undefined && isHexColor(value) && value !== DEFAULT_COLORS[theme][key]) {
      out[key] = value;
    }
  }
  return out;
}

function sameColors(a: ThemeColors, b: ThemeColors): boolean {
  return a.background === b.background && a.foreground === b.foreground;
}

/** 当前的强调色与颜色正好是哪个预设；改过之后是 undefined（界面上写“自定义”）。 */
export function matchPreset(
  appearance: Pick<Appearance, keyof ThemeSpec>,
): ThemePreset | undefined {
  return THEME_PRESETS.find(
    (preset) =>
      preset.accent === appearance.accent &&
      sameColors(
        normalizeColors('light', preset.light),
        normalizeColors('light', appearance.light),
      ) &&
      sameColors(normalizeColors('dark', preset.dark), normalizeColors('dark', appearance.dark)),
  );
}

export function applyTheme(appearance: Appearance, theme: ThemeSpec): Appearance {
  return {
    ...appearance,
    accent: theme.accent,
    light: normalizeColors('light', theme.light),
    dark: normalizeColors('dark', theme.dark),
  };
}

/** 复制出去的主题：颜色写全（含默认的），别人导入时不依赖 Wevir 的默认值。 */
export function exportTheme(appearance: Appearance): string {
  const full = (theme: ResolvedTheme) => ({
    background: appearance[theme].background ?? DEFAULT_COLORS[theme].background,
    foreground: appearance[theme].foreground ?? DEFAULT_COLORS[theme].foreground,
  });
  return JSON.stringify(
    { accent: appearance.accent, light: full('light'), dark: full('dark') },
    null,
    2,
  );
}

/** 粘贴进来的主题（exportTheme 的格式；缺的项按默认）；不是这个格式时是 undefined。 */
export function parseTheme(text: string): ThemeSpec | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const accent = record.accent ?? 'ink';
  if (!(ACCENTS as readonly unknown[]).includes(accent)) return undefined;
  const colors = (theme: ResolvedTheme): ThemeColors | undefined => {
    const value = record[theme] ?? {};
    if (typeof value !== 'object' || value === null) return undefined;
    const { background, foreground } = value as Record<string, unknown>;
    if (background !== undefined && !isHexColor(background)) return undefined;
    if (foreground !== undefined && !isHexColor(foreground)) return undefined;
    return normalizeColors(theme, {
      ...(background !== undefined && { background }),
      ...(foreground !== undefined && { foreground }),
    });
  };
  const light = colors('light');
  const dark = colors('dark');
  if (!light || !dark) return undefined;
  return { accent: accent as AccentId, light, dark };
}

function clampInt(value: unknown, range: { min: number; max: number; default: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return (values as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** localStorage 里的外观；不认识的项回落到默认值，不让一项坏掉连累别的。 */
export function parseAppearance(raw: unknown): Appearance {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_APPEARANCE;
  const record = raw as Record<string, unknown>;
  const colors = (theme: ResolvedTheme): ThemeColors => {
    const value = record[theme];
    return typeof value === 'object' && value !== null
      ? normalizeColors(theme, value as ThemeColors)
      : {};
  };
  return {
    accent: oneOf(ACCENTS, record.accent, DEFAULT_APPEARANCE.accent),
    light: colors('light'),
    dark: colors('dark'),
    uiFont: oneOf(UI_FONTS, record.uiFont, DEFAULT_APPEARANCE.uiFont),
    contentFont: oneOf(CONTENT_FONTS, record.contentFont, DEFAULT_APPEARANCE.contentFont),
    codeFont: oneOf(CODE_FONTS, record.codeFont, DEFAULT_APPEARANCE.codeFont),
    uiFontSize: clampInt(record.uiFontSize, UI_FONT_SIZE),
    codeFontSize: clampInt(record.codeFontSize, CODE_FONT_SIZE),
    translucentSidebar: record.translucentSidebar === true,
    contrast: clampInt(record.contrast, { min: 0, max: 100, default: DEFAULT_CONTRAST }),
  };
}

export function clampFontSize(value: number, kind: 'ui' | 'code'): number {
  return clampInt(value, kind === 'ui' ? UI_FONT_SIZE : CODE_FONT_SIZE);
}

const SYSTEM_SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const SERIF =
  'ui-serif, "New York", Georgia, "Songti SC", "Noto Serif CJK SC", "Noto Serif SC", serif';

function mix(from: string, to: string, percent: number): string {
  return `color-mix(in oklab, ${from}, ${to} ${Math.round(percent * 10) / 10}%)`;
}

/**
 * 按外观与当前的主题算出要写到 <html> 上的 CSS 变量（覆盖 tokens.css）。都是默认值时是空的。
 *
 * - 改了背景或前景：各层表面由两者混出来，层次同 tokens.css——浅色的侧栏、次表面往前景色偏，卡片往白偏；深色的侧栏往黑偏，
 *   卡片、次表面往前景色偏。
 * - 改了颜色或对比度：分隔线与次要文字按对比度在背景与前景之间取（50 时约等于 tokens.css 的比例）；次要文字最低也有 4.5:1。
 * - 强调色：主按钮、开关、选中项（--primary）。
 */
export function appearanceVariables(
  appearance: Appearance,
  theme: ResolvedTheme,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const custom = appearance[theme];
  const customColors = custom.background !== undefined || custom.foreground !== undefined;
  const bg = custom.background ?? DEFAULT_COLORS[theme].background;
  const fg = custom.foreground ?? DEFAULT_COLORS[theme].foreground;

  if (customColors) {
    vars['--background'] = bg;
    vars['--foreground'] = fg;
    if (theme === 'light') {
      const card = mix(bg, '#ffffff', 60);
      const muted = mix(bg, fg, 5);
      Object.assign(vars, {
        '--sidebar': mix(bg, fg, 2.5),
        '--card': card,
        '--popover': card,
        '--switch-thumb': card,
        '--muted': muted,
        '--accent': muted,
        '--secondary': muted,
        '--code-background': muted,
      });
    } else {
      const card = mix(bg, fg, 3.5);
      const muted = mix(bg, fg, 6);
      Object.assign(vars, {
        '--sidebar': mix(bg, '#000000', 25),
        '--card': card,
        '--popover': card,
        '--switch-thumb': mix(bg, fg, 17),
        '--muted': muted,
        '--accent': muted,
        '--secondary': muted,
        '--code-background': mix(bg, fg, 2),
      });
    }
  }

  if (customColors || appearance.contrast !== DEFAULT_CONTRAST) {
    const k = (appearance.contrast - DEFAULT_CONTRAST) / 50;
    Object.assign(vars, {
      '--border': mix(bg, fg, 10 * (1 + 0.6 * k)),
      '--border-strong': mix(bg, fg, 18 * (1 + 0.5 * k)),
      '--muted-foreground': mix(bg, fg, 66 + (k < 0 ? 6 : 12) * k),
      '--soft-foreground': mix(bg, fg, 81 + (k < 0 ? 5 : 10) * k),
    });
  }

  if (appearance.accent !== 'ink') {
    const { color, text } = ACCENT_COLORS[appearance.accent][theme];
    vars['--primary'] = color;
    vars['--primary-foreground'] = text;
  } else if (customColors) {
    vars['--primary'] = fg;
    vars['--primary-foreground'] = bg;
  }

  if (appearance.uiFont === 'system') vars['--font-ui'] = SYSTEM_SANS;
  if (appearance.codeFont === 'system') vars['--font-code'] = SYSTEM_MONO;
  if (appearance.contentFont === 'system') vars['--font-content'] = SYSTEM_SANS;
  if (appearance.contentFont === 'serif') vars['--font-content'] = SERIF;
  if (appearance.uiFontSize !== UI_FONT_SIZE.default) {
    vars['--font-scale'] = String(appearance.uiFontSize / UI_FONT_SIZE.default);
  }
  if (appearance.codeFontSize !== CODE_FONT_SIZE.default) {
    vars['--text-code'] = `${appearance.codeFontSize}px`;
  }
  return vars;
}
