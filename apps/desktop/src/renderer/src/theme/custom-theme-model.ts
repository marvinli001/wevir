import {
  THEMABLE_TOKENS,
  ThemeFileSchema,
  ThemeIdSchema,
  type ThemeResult,
  themeColorVariables,
} from '@wevir/protocol';

export interface CachedCustomTheme {
  version: 1;
  hostId: string;
  id: string;
  name: string;
  revision: string;
  variables: Record<'light' | 'dark', Record<string, string>>;
  colorScheme?: 'light' | 'dark';
  css?: string;
  backdrop?: NonNullable<ThemeResult['theme']>['backdrop'];
  assets: ThemeResult['assets'];
  readOnly: boolean;
  directory: string;
}

export function cacheCustomTheme(result: ThemeResult, hostId: string): CachedCustomTheme | null {
  const { theme } = result;
  if (!theme) return null;
  return {
    version: 1,
    hostId,
    id: result.id,
    name: theme.name,
    revision: result.revision,
    variables: {
      light: themeColorVariables(theme, 'light'),
      dark: themeColorVariables(theme, 'dark'),
    },
    colorScheme: theme.colorScheme,
    css: theme.css,
    backdrop: theme.backdrop,
    assets: result.assets,
    readOnly: result.readOnly,
    directory: result.directory,
  };
}

const names = THEMABLE_TOKENS.join('|');
const color = `(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|var\\(--(?:${names})\\))`;
const cachedColor = new RegExp(
  `^(?:${color}|color-mix\\(in oklab, ${color}(?: [\\d.]+%)?, ${color}(?: [\\d.]+%)?\\))$`,
  'i',
);
const tokens = new Set(THEMABLE_TOKENS.map((name) => `--${name}`));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 缓存只接受颜色变量；CSS 与背景描述留待各自的运行时守卫处理。 */
export function parseCachedCustomTheme(raw: unknown): CachedCustomTheme | undefined {
  if (!record(raw) || raw.version !== 1 || !ThemeIdSchema.safeParse(raw.id).success)
    return undefined;
  if (
    typeof raw.hostId !== 'string' ||
    typeof raw.revision !== 'string' ||
    typeof raw.directory !== 'string' ||
    typeof raw.readOnly !== 'boolean' ||
    !record(raw.variables) ||
    !record(raw.assets)
  )
    return undefined;
  for (const mode of ['light', 'dark']) {
    const variables = raw.variables[mode];
    if (
      !record(variables) ||
      !Object.entries(variables).every(
        ([name, value]) => tokens.has(name) && typeof value === 'string' && cachedColor.test(value),
      )
    )
      return undefined;
  }
  for (const value of Object.values(raw.assets)) {
    if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return undefined;
  }
  const description = ThemeFileSchema.safeParse({
    schemaVersion: 1,
    name: raw.name,
    light: {},
    colorScheme: raw.colorScheme,
    css: raw.css,
    backdrop: raw.backdrop,
  });
  if (!description.success) return undefined;
  return raw as unknown as CachedCustomTheme;
}
