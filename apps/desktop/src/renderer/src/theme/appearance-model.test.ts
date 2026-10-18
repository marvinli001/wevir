import { describe, expect, it } from 'vitest';
import {
  ACCENT_COLORS,
  appearanceVariables,
  applyTheme,
  DEFAULT_APPEARANCE,
  DEFAULT_COLORS,
  exportTheme,
  matchPreset,
  parseAppearance,
  parseHexColor,
  parseTheme,
  THEME_PRESETS,
} from './appearance-model';

function preset(id: string) {
  const found = THEME_PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('外观', () => {
  it('默认外观不产生任何变量，界面照 tokens.css', () => {
    expect(appearanceVariables(DEFAULT_APPEARANCE, 'light')).toEqual({});
    expect(appearanceVariables(DEFAULT_APPEARANCE, 'dark')).toEqual({});
  });

  it('默认颜色与 tokens.css 的 --background 一致', async () => {
    const { THEME_BACKGROUND } = await import('../../../shared/theme.js');
    expect(DEFAULT_COLORS.light.background).toBe(THEME_BACKGROUND.light);
    expect(DEFAULT_COLORS.dark.background).toBe(THEME_BACKGROUND.dark);
  });

  it('强调色上的文字达到 4.5:1，强调色在画布上达到 3:1', () => {
    for (const accent of Object.values(ACCENT_COLORS)) {
      for (const theme of ['light', 'dark'] as const) {
        const { color, text } = accent[theme];
        expect(contrast(color, text)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color, DEFAULT_COLORS[theme].background)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('只改当前主题的颜色：另一个主题不受影响', () => {
    const appearance = { ...DEFAULT_APPEARANCE, dark: { background: '#002b36' } };
    expect(appearanceVariables(appearance, 'light')).toEqual({});
    const vars = appearanceVariables(appearance, 'dark');
    expect(vars['--background']).toBe('#002b36');
    expect(vars['--foreground']).toBe(DEFAULT_COLORS.dark.foreground);
    expect(vars['--card']).toContain('#002b36');
    expect(vars['--primary']).toBe(DEFAULT_COLORS.dark.foreground);
  });

  it('对比度只改分隔线与次要文字；强调色只改主色；字号与字体各自一个变量', () => {
    const vars = appearanceVariables(
      {
        ...DEFAULT_APPEARANCE,
        contrast: 80,
        accent: 'blue',
        uiFontSize: 16,
        codeFontSize: 14,
        codeFont: 'system',
        contentFont: 'serif',
      },
      'light',
    );
    expect(Object.keys(vars).sort()).toEqual(
      [
        '--border',
        '--border-strong',
        '--muted-foreground',
        '--soft-foreground',
        '--primary',
        '--primary-foreground',
        '--font-scale',
        '--text-code',
        '--font-code',
        '--font-content',
      ].sort(),
    );
    expect(vars['--primary']).toBe(ACCENT_COLORS.blue.light.color);
    expect(vars['--font-scale']).toBe(String(16 / 14));
    expect(vars['--text-code']).toBe('14px');
  });

  it('预设：Wevir 是默认值；选了预设认得出来，改一处就是自定义', () => {
    expect(matchPreset(DEFAULT_APPEARANCE)?.id).toBe('wevir');
    for (const candidate of THEME_PRESETS) {
      expect(matchPreset(applyTheme(DEFAULT_APPEARANCE, candidate))?.id).toBe(candidate.id);
    }
    const nord = applyTheme(DEFAULT_APPEARANCE, preset('nord'));
    expect(matchPreset({ ...nord, accent: 'red' })).toBeUndefined();
  });

  it('复制出去的主题能原样导入；不合格式的认不出', () => {
    const solarized = applyTheme(DEFAULT_APPEARANCE, preset('solarized'));
    const parsed = parseTheme(exportTheme(solarized));
    expect(parsed).toEqual({ accent: 'blue', light: solarized.light, dark: solarized.dark });
    expect(parseTheme(exportTheme(DEFAULT_APPEARANCE))).toEqual({
      accent: 'ink',
      light: {},
      dark: {},
    });
    expect(parseTheme('not json')).toBeUndefined();
    expect(parseTheme('{"accent":"gold"}')).toBeUndefined();
    expect(parseTheme('{"light":{"background":"red"}}')).toBeUndefined();
  });

  it('解析存下的外观：坏掉的项回落到默认，字号夹在范围里', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(
      parseAppearance({
        accent: 'nope',
        uiFontSize: 40,
        codeFontSize: 3,
        contrast: 120,
        light: { background: '#FCFBFA', foreground: '#123456' },
        translucentSidebar: 'yes',
      }),
    ).toEqual({
      ...DEFAULT_APPEARANCE,
      uiFontSize: 18,
      codeFontSize: 10,
      contrast: 100,
      light: { foreground: '#123456' },
    });
  });

  it('十六进制颜色的输入', () => {
    expect(parseHexColor('#ABC')).toBe('#aabbcc');
    expect(parseHexColor(' 1a1c1f ')).toBe('#1a1c1f');
    expect(parseHexColor('#12345')).toBeUndefined();
    expect(parseHexColor('red')).toBeUndefined();
  });
});
