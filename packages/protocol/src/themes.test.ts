import { describe, expect, it } from 'vitest';
import {
  appearanceColorVariables,
  colorContrast,
  resolvedThemeColors,
  themeColorVariables,
} from './theme-colors.js';
import {
  THEME_CSS_MAX_LENGTH,
  ThemeAssetNameSchema,
  ThemeFileSchema,
  ThemeIdSchema,
} from './themes.js';

const valid = { schemaVersion: 1, name: 'Lagoon', dark: {} };
describe('theme.json', () => {
  it.each<[unknown, string]>([
    [{ ...valid, schemaVersion: 2 }, 'schemaVersion'],
    [{ ...valid, surprise: true }, 'surprise'],
    [{ ...valid, dark: { surprise: true } }, 'surprise'],
    [{ ...valid, dark: { tokens: { surprise: '#ffffff' } } }, 'surprise'],
    [{ ...valid, dark: { foreground: 'red' } }, 'foreground'],
    [{ ...valid, dark: { tokens: { background: '#fff' } } }, 'background'],
    [{ schemaVersion: 1, name: 'Empty' }, 'light'],
    [{ ...valid, css: 'a'.repeat(THEME_CSS_MAX_LENGTH + 1) }, 'css'],
    [{ ...valid, backdrop: { kind: 'image', file: '../a.png' } }, 'file'],
    ...['opacity', 'scrim'].flatMap((key) =>
      [-0.1, 1.1].map((value): [unknown, string] => [
        { ...valid, backdrop: { kind: 'image', file: 'a.png', [key]: value } },
        key,
      ]),
    ),
    ...[-1, 41].map((blur): [unknown, string] => [
      { ...valid, backdrop: { kind: 'image', file: 'a.png', blur } },
      'blur',
    ]),
  ])('rejects invalid fields with their names (%s)', (input, field) => {
    const result = ThemeFileSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(String(field));
  });
  it('accepts hex alpha, a named accent and either mode', () => {
    expect(
      ThemeFileSchema.parse({
        ...valid,
        accent: '#123456',
        dark: { background: '#010203ee', tokens: { 'terminal-red': '#abcdef' } },
      }).accent,
    ).toBe('#123456');
    expect(ThemeFileSchema.safeParse({ ...valid, accent: 'teal', light: {} }).success).toBe(true);
  });
  it.each(['../escape', 'A', '', '-bad', 'a'.repeat(65)])('rejects ID %s', (id) =>
    expect(ThemeIdSchema.safeParse(id).success).toBe(false),
  );
  it('bounds IDs and confines asset names to one filename', () => {
    expect(ThemeIdSchema.safeParse('a'.repeat(64)).success).toBe(true);
    for (const name of ['../a', '..', '.', 'a/b', 'a\\b', 'A.png', 'a\u0000.png'])
      expect(ThemeAssetNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('theme colors', () => {
  it('uses the same WCAG formula and composites alpha', () => {
    expect(colorContrast('#000000', '#ffffff')).toBe(21);
    expect(colorContrast('#00000000', '#ffffff')).toBe(1);
    expect(colorContrast('#777777', '#ffffff')).toBeCloseTo(4.478, 2);
  });
  it('does not apply colors for a missing mode', () =>
    expect(themeColorVariables(ThemeFileSchema.parse(valid), 'light')).toEqual({}));
  it('derives anchors and lets individual tokens win', () => {
    const theme = ThemeFileSchema.parse({
      ...valid,
      accent: '#55ccee',
      dark: { background: '#102030', foreground: '#eeeeee', tokens: { primary: '#00aacc' } },
    });
    expect(themeColorVariables(theme, 'dark')).toMatchObject({
      '--background': '#102030',
      '--primary': '#00aacc',
    });
    const colors = resolvedThemeColors(theme, 'dark');
    expect(colors['--muted-foreground']).toMatch(/^#[0-9a-f]{6}$/);
    expect(
      appearanceColorVariables({ accent: 'blue', light: {}, dark: {}, contrast: 50 }, 'dark')[
        '--primary'
      ],
    ).toBe('#6ea8fe');
  });
});
