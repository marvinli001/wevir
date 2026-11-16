import type { ThemeAccent, ThemeFile, ThemeMode } from './themes.js';

// 与 tokens.css 的两套默认语义色一致；桌面 token 测试核对。
export const DEFAULT_THEME_TOKENS: Record<ThemeMode, Record<string, string>> = {
  light: {
    '--background': '#fcfbfa',
    '--sidebar': '#f7f6f3',
    '--muted': '#f2f1ee',
    '--accent': '#f2f1ee',
    '--secondary': '#f2f1ee',
    '--card': '#ffffff',
    '--popover': '#ffffff',
    '--switch-thumb': '#ffffff',
    '--foreground': '#1a1a17',
    '--soft-foreground': '#45433d',
    '--muted-foreground': '#67635a',
    '--card-foreground': 'var(--foreground)',
    '--popover-foreground': 'var(--foreground)',
    '--secondary-foreground': 'var(--foreground)',
    '--accent-foreground': 'var(--foreground)',
    '--sidebar-foreground': 'var(--foreground)',
    '--sidebar-accent-foreground': 'var(--foreground)',
    '--border': '#e6e4e0',
    '--border-strong': '#d3d1cc',
    '--input': 'var(--border-strong)',
    '--sidebar-border': 'var(--border)',
    '--primary': '#1a1a17',
    '--primary-foreground': '#fcfbfa',
    '--brand': '#9b7840',
    '--running': '#2a63b8',
    '--success': '#2f6b42',
    '--warning': '#94570a',
    '--destructive': '#a23b30',
    '--ring': 'var(--running)',
    '--ring-soft': 'color-mix(in oklab, var(--running) 50%, var(--border-strong))',
    '--sidebar-ring': 'var(--ring)',
    '--highlight': 'var(--running)',
    '--user-bubble': 'var(--muted)',
    '--selected': 'color-mix(in oklab, var(--foreground) 3.5%, transparent)',
    '--selected-border': 'color-mix(in oklab, var(--foreground) 14%, transparent)',
    '--sidebar-accent': 'var(--card)',
    '--card-edge': 'color-mix(in oklab, #1a1a17 9%, transparent)',
    '--overlay': 'color-mix(in oklab, #1a1a17 25%, transparent)',
    '--verified': '#1a8cd8',
    '--verified-foreground': '#ffffff',
    '--official': '#9b7840',
    '--official-foreground': '#ffffff',
    '--diff-added': '#e6f4e9',
    '--diff-added-gutter': '#d9efdd',
    '--diff-added-emphasis': '#cdebd3',
    '--diff-removed': '#fcecea',
    '--diff-removed-gutter': '#f9e1dd',
    '--diff-removed-emphasis': '#f6d3cd',
    '--code-background': '#f2f1ee',
    '--code-keyword': '#2a63b8',
    '--code-string': '#2f6b42',
    '--code-number': '#94570a',
    '--code-title': '#a23b30',
    '--code-comment': 'var(--muted-foreground)',
    '--code-meta': 'var(--soft-foreground)',
    '--chart-1': '#f2b23a',
    '--chart-2': '#7c5cf6',
    '--chart-3': '#3b82f6',
    '--chart-4': '#ef6c3a',
    '--chart-5': '#2fa36b',
    '--chart-6': '#e0457b',
    '--chart-7': '#a8a59d',
    '--chart-8': '#0f9fb3',
    '--terminal-black': '#1a1a17',
    '--terminal-red': '#c4372d',
    '--terminal-green': '#2f7d32',
    '--terminal-yellow': '#8a6a00',
    '--terminal-blue': '#2b5fb8',
    '--terminal-magenta': '#9b3aa6',
    '--terminal-cyan': '#1f7a86',
    '--terminal-white': '#6b6a64',
    '--terminal-bright-black': '#57564f',
    '--terminal-bright-red': '#d9473c',
    '--terminal-bright-green': '#3a9440',
    '--terminal-bright-yellow': '#a07c00',
    '--terminal-bright-blue': '#3a6fd0',
    '--terminal-bright-magenta': '#b04abb',
    '--terminal-bright-cyan': '#2a8f9c',
    '--terminal-bright-white': '#3d3c37',
  },
  dark: {
    '--background': '#101114',
    '--sidebar': '#0c0d10',
    '--muted': '#1d1e23',
    '--accent': '#1d1e23',
    '--secondary': '#1d1e23',
    '--card': '#17181c',
    '--popover': '#17181c',
    '--switch-thumb': '#36383e',
    '--foreground': '#eeede8',
    '--soft-foreground': '#c4c3bd',
    '--muted-foreground': '#9d9e9b',
    '--card-foreground': 'var(--foreground)',
    '--popover-foreground': 'var(--foreground)',
    '--secondary-foreground': 'var(--foreground)',
    '--accent-foreground': 'var(--foreground)',
    '--sidebar-foreground': 'var(--foreground)',
    '--sidebar-accent-foreground': 'var(--foreground)',
    '--border': '#26282d',
    '--border-strong': '#36383e',
    '--input': 'var(--border-strong)',
    '--sidebar-border': 'var(--border)',
    '--primary': '#eeede8',
    '--primary-foreground': '#101114',
    '--brand': '#dfded8',
    '--running': '#8ab4f8',
    '--success': '#86c597',
    '--warning': '#e3a857',
    '--destructive': '#ee8f84',
    '--ring': 'var(--running)',
    '--ring-soft': 'color-mix(in oklab, var(--running) 50%, var(--border-strong))',
    '--sidebar-ring': 'var(--ring)',
    '--highlight': 'var(--running)',
    '--user-bubble': 'var(--muted)',
    '--selected': 'color-mix(in oklab, var(--foreground) 3.5%, transparent)',
    '--selected-border': 'color-mix(in oklab, var(--foreground) 14%, transparent)',
    '--sidebar-accent': 'var(--card)',
    '--card-edge': 'color-mix(in oklab, #eeede8 8%, transparent)',
    '--overlay': 'color-mix(in oklab, #0c0d10 60%, transparent)',
    '--verified': '#1a8cd8',
    '--verified-foreground': '#ffffff',
    '--official': '#9b7840',
    '--official-foreground': '#ffffff',
    '--diff-added': '#15261b',
    '--diff-added-gutter': '#1b3324',
    '--diff-added-emphasis': '#21402b',
    '--diff-removed': '#2a1716',
    '--diff-removed-gutter': '#3a1e1c',
    '--diff-removed-emphasis': '#4a2421',
    '--code-background': '#141519',
    '--code-keyword': '#8ab4f8',
    '--code-string': '#86c597',
    '--code-number': '#e3a857',
    '--code-title': '#ee8f84',
    '--code-comment': 'var(--muted-foreground)',
    '--code-meta': 'var(--soft-foreground)',
    '--chart-1': '#e8b450',
    '--chart-2': '#9d88fa',
    '--chart-3': '#6aa2f8',
    '--chart-4': '#f08a5d',
    '--chart-5': '#4fbf87',
    '--chart-6': '#ea7099',
    '--chart-7': '#5d5f66',
    '--chart-8': '#3dbccb',
    '--terminal-black': '#1e1f24',
    '--terminal-red': '#f2675d',
    '--terminal-green': '#7ccf7f',
    '--terminal-yellow': '#e6c45c',
    '--terminal-blue': '#6fa3f2',
    '--terminal-magenta': '#d68ae0',
    '--terminal-cyan': '#63c7d1',
    '--terminal-white': '#d4d3ce',
    '--terminal-bright-black': '#6e6f76',
    '--terminal-bright-red': '#ff8a80',
    '--terminal-bright-green': '#9be39d',
    '--terminal-bright-yellow': '#f5d77e',
    '--terminal-bright-blue': '#94bcff',
    '--terminal-bright-magenta': '#e8a8f0',
    '--terminal-bright-cyan': '#8fdde5',
    '--terminal-bright-white': '#f4f3ee',
  },
};

export const ACCENT_COLORS: Record<
  'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'green' | 'teal',
  Record<ThemeMode, { color: string; text: string }>
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

export const DEFAULT_THEME_COLORS = {
  light: { background: '#fcfbfa', foreground: '#1a1a17' },
  dark: { background: '#101114', foreground: '#eeede8' },
} as const;

function mix(from: string, to: string, percent: number): string {
  return `color-mix(in oklab, ${from}, ${to} ${Math.round(percent * 10) / 10}%)`;
}

export function appearanceColorVariables(
  appearance: {
    accent: ThemeAccent;
    light: { background?: string; foreground?: string };
    dark: { background?: string; foreground?: string };
    contrast: number;
  },
  mode: ThemeMode,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const colors = appearance[mode];
  const custom = colors.background !== undefined || colors.foreground !== undefined;
  const bg = colors.background ?? DEFAULT_THEME_COLORS[mode].background;
  const fg = colors.foreground ?? DEFAULT_THEME_COLORS[mode].foreground;
  if (custom) {
    const card = mode === 'light' ? mix(bg, '#ffffff', 60) : mix(bg, fg, 3.5);
    const muted = mix(bg, fg, mode === 'light' ? 5 : 6);
    Object.assign(vars, {
      '--background': bg,
      '--foreground': fg,
      '--sidebar': mode === 'light' ? mix(bg, fg, 2.5) : mix(bg, '#000000', 25),
      '--card': card,
      '--popover': card,
      '--switch-thumb': mode === 'light' ? card : mix(bg, fg, 17),
      '--muted': muted,
      '--accent': muted,
      '--secondary': muted,
      '--code-background': mode === 'light' ? muted : mix(bg, fg, 2),
    });
  }
  if (custom || appearance.contrast !== 50) {
    const k = (appearance.contrast - 50) / 50;
    Object.assign(vars, {
      '--border': mix(bg, fg, 10 * (1 + 0.6 * k)),
      '--border-strong': mix(bg, fg, 18 * (1 + 0.5 * k)),
      '--muted-foreground': mix(bg, fg, 66 + (k < 0 ? 6 : 12) * k),
      '--soft-foreground': mix(bg, fg, 81 + (k < 0 ? 5 : 10) * k),
    });
  }
  if (appearance.accent !== 'ink') {
    const accent = appearance.accent;
    const surface = accent.startsWith('#')
      ? compositeThemeColor(accent, compositeThemeColor(bg, DEFAULT_THEME_COLORS[mode].background))
      : '';
    const { color, text } = accent.startsWith('#')
      ? {
          color: accent,
          text:
            colorContrast('#ffffff', surface) >= colorContrast('#0c0d10', surface)
              ? '#ffffff'
              : '#0c0d10',
        }
      : ACCENT_COLORS[accent as keyof typeof ACCENT_COLORS][mode];
    Object.assign(vars, {
      '--primary': color,
      '--primary-foreground': text,
      '--highlight': color,
      '--user-bubble': `color-mix(in oklab, ${color} ${mode === 'light' ? 12 : 18}%, var(--muted))`,
    });
  } else if (custom) {
    vars['--primary'] = fg;
    vars['--primary-foreground'] = bg;
  }
  return vars;
}

export function themeColorVariables(theme: ThemeFile, mode: ThemeMode): Record<string, string> {
  const colors = theme[mode];
  if (colors === undefined) return {};
  return {
    ...appearanceColorVariables(
      {
        accent: theme.accent ?? 'ink',
        light: theme.light ?? {},
        dark: theme.dark ?? {},
        contrast: 50,
      },
      mode,
    ),
    ...Object.fromEntries(
      Object.entries(colors.tokens ?? {}).map(([name, value]) => [`--${name}`, value]),
    ),
  };
}

type Rgb = [number, number, number];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encoded = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const alpha = (hex: string) => (hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1);
export function compositeThemeColor(foreground: string, background: string): string {
  const a = alpha(foreground);
  const bg = rgb(background);
  return toHex(rgb(foreground).map((c, i) => c * a + (bg[i] ?? 0) * (1 - a)) as Rgb);
}
function toHex(channels: Rgb): string {
  return `#${channels
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** WCAG 2，相同公式也用于桌面默认 token 测试。 */
export function colorContrast(foreground: string, background: string): number {
  const fg = compositeThemeColor(foreground, background);
  const luminance = (hex: string) => {
    const [r, g, b] = rgb(hex).map(linear) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(fg),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function oklab(hex: string): Rgb {
  const [r, g, b] = rgb(hex).map(linear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function mixHex(a: string, b: string, weight: number): string {
  const from = oklab(a),
    to = oklab(b);
  const aa = alpha(a) * (1 - weight),
    bb = alpha(b) * weight;
  const opacity = aa + bb;
  if (opacity === 0) return '#00000000';
  const [L, A, B] = from.map((v, i) => (v * aa + (to[i] ?? 0) * bb) / opacity) as Rgb;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const hex = toHex(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map(encoded) as Rgb,
  );
  return opacity < 1
    ? `${hex}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0')}`
    : hex;
}

/** 只展开本模块产生的色值，供 Host 的对比度校验使用。 */
export function resolvedThemeColors(theme: ThemeFile, mode: ThemeMode): Record<string, string> {
  const vars = { ...DEFAULT_THEME_TOKENS[mode], ...themeColorVariables(theme, mode) };
  const resolve = (value: string, depth = 0): string => {
    if (depth > 10) throw new Error('cyclic theme color');
    const expanded = value.replace(/var\((--[\w-]+)\)/g, (_, key: string) =>
      resolve(vars[key] ?? '', depth + 1),
    );
    const mixed =
      /^color-mix\(in oklab, (#[\da-f]{6}(?:[\da-f]{2})?)(?: ([\d.]+)%)?, (#[\da-f]{6}(?:[\da-f]{2})?)(?: ([\d.]+)%)?\)$/i.exec(
        expanded,
      );
    if (!mixed) return expanded;
    return mixHex(mixed[1] ?? '', mixed[3] ?? '', Number(mixed[4] ?? 100 - Number(mixed[2])) / 100);
  };
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, resolve(value)]));
}
