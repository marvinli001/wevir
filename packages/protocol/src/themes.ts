import { z } from 'zod';
import { HostIdSchema } from './common.js';

export const THEME_MAX_BYTES = 512 * 1024;
export const THEME_CSS_MAX_LENGTH = 50_000;
export const THEME_MAX_COUNT = 200;
export const THEME_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const THEME_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const THEME_SCENE_MAX_BYTES = 1024 * 1024;

export const THEME_ACCENTS = [
  'ink',
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'green',
  'teal',
] as const;
export const THEME_PRESET_IDS = ['wevir', 'solarized', 'nord', 'gruvbox', 'rose'] as const;
export const THEME_EXAMPLE_IDS = ['tideline', 'paper-garden', 'night-orbit'] as const;
export const RESERVED_THEME_IDS = [
  'default',
  'system',
  'light',
  'dark',
  ...THEME_PRESET_IDS,
  ...THEME_EXAMPLE_IDS,
] as const;

export const THEMABLE_TOKENS = [
  'background',
  'sidebar',
  'muted',
  'accent',
  'secondary',
  'card',
  'popover',
  'switch-thumb',
  'foreground',
  'soft-foreground',
  'muted-foreground',
  'card-foreground',
  'popover-foreground',
  'secondary-foreground',
  'accent-foreground',
  'sidebar-foreground',
  'sidebar-accent-foreground',
  'border',
  'border-strong',
  'input',
  'sidebar-border',
  'primary',
  'primary-foreground',
  'brand',
  'running',
  'success',
  'warning',
  'destructive',
  'ring',
  'ring-soft',
  'sidebar-ring',
  'highlight',
  'user-bubble',
  'selected',
  'selected-border',
  'sidebar-accent',
  'card-edge',
  'overlay',
  'verified',
  'verified-foreground',
  'official',
  'official-foreground',
  'diff-added',
  'diff-added-gutter',
  'diff-added-emphasis',
  'diff-removed',
  'diff-removed-gutter',
  'diff-removed-emphasis',
  'code-background',
  'code-keyword',
  'code-string',
  'code-number',
  'code-title',
  'code-comment',
  'code-meta',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
  'terminal-black',
  'terminal-red',
  'terminal-green',
  'terminal-yellow',
  'terminal-blue',
  'terminal-magenta',
  'terminal-cyan',
  'terminal-white',
  'terminal-bright-black',
  'terminal-bright-red',
  'terminal-bright-green',
  'terminal-bright-yellow',
  'terminal-bright-blue',
  'terminal-bright-magenta',
  'terminal-bright-cyan',
  'terminal-bright-white',
] as const;
export type ThemableToken = (typeof THEMABLE_TOKENS)[number];
export type ThemeMode = 'light' | 'dark';
export const ThemeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const ThemeColorSchema = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
export const ThemeAssetNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9._-]+$/)
  .refine((s) => s !== '.' && s !== '..');
export const ThemeAccentSchema = z.union([z.enum(THEME_ACCENTS), ThemeColorSchema]);
export type ThemeAccent = z.infer<typeof ThemeAccentSchema>;

export const ThemeColorsSchema = z.strictObject({
  background: ThemeColorSchema.optional(),
  foreground: ThemeColorSchema.optional(),
  tokens: z.partialRecord(z.enum(THEMABLE_TOKENS), ThemeColorSchema).optional(),
});
export const ThemeBackdropSchema = z.strictObject({
  kind: z.enum(['image', 'video', 'scene']),
  file: ThemeAssetNameSchema,
  poster: ThemeAssetNameSchema.optional(),
  scope: z.enum(['conversation', 'window']).optional(),
  fit: z.enum(['cover', 'contain', 'tile']).optional(),
  opacity: z.number().min(0).max(1).optional(),
  blur: z.number().min(0).max(40).optional(),
  scrim: z.number().min(0).max(1).optional(),
  glass: z.boolean().optional(),
});
export const ThemeFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1).max(200),
    author: z.string().max(200).optional(),
    colorScheme: z.enum(['light', 'dark']).optional(),
    accent: ThemeAccentSchema.optional(),
    light: ThemeColorsSchema.optional(),
    dark: ThemeColorsSchema.optional(),
    css: z.string().max(THEME_CSS_MAX_LENGTH).optional(),
    backdrop: ThemeBackdropSchema.optional(),
  })
  .refine((theme) => theme.light !== undefined || theme.dark !== undefined, {
    path: ['light'],
    message: 'light or dark is required',
  });
export type ThemeFile = z.infer<typeof ThemeFileSchema>;
export type ThemeBackdrop = z.infer<typeof ThemeBackdropSchema>;

export const ThemeProblemSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});
export type ThemeProblem = z.infer<typeof ThemeProblemSchema>;
export const ThemeSummarySchema = z.object({
  id: ThemeIdSchema,
  name: z.string(),
  revision: z.string(),
  readOnly: z.boolean(),
  hasBackdrop: z.boolean(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  swatches: z.array(ThemeColorSchema).optional(),
  problems: z.array(ThemeProblemSchema).optional(),
});
export type ThemeSummary = z.infer<typeof ThemeSummarySchema>;
export const ThemesUpdatedParamsSchema = z.object({
  activeId: ThemeIdSchema.nullable(),
  revisions: z.record(ThemeIdSchema, z.string()),
});
export type ThemesUpdated = z.infer<typeof ThemesUpdatedParamsSchema>;
export const ThemesListResultSchema = z.object({
  themes: z.array(ThemeSummarySchema),
  activeId: ThemeIdSchema.nullable(),
  directory: z.string(),
});
export const ThemeBackdropStatusSchema = z.object({
  revision: z.string().min(1).max(128),
  asset: z.enum(['file', 'poster']),
  status: z.enum(['loaded', 'failed']),
});
export type ThemeBackdropStatus = z.infer<typeof ThemeBackdropStatusSchema>;
export const ThemesGetParamsSchema = z.object({
  id: ThemeIdSchema,
  backdropStatus: ThemeBackdropStatusSchema.optional(),
});
export const ThemesGetResultSchema = z.object({
  id: ThemeIdSchema,
  theme: ThemeFileSchema.optional(),
  revision: z.string(),
  readOnly: z.boolean(),
  problems: z.array(ThemeProblemSchema),
  assets: z.object({ file: z.string().optional(), poster: z.string().optional() }),
  directory: z.string(),
});
export type ThemeResult = z.infer<typeof ThemesGetResultSchema>;
export const ThemesSaveParamsSchema = z.object({
  id: ThemeIdSchema,
  theme: ThemeFileSchema,
  assets: z
    .array(z.object({ name: ThemeAssetNameSchema, sourcePath: z.string().min(1) }))
    .optional(),
});
export type ThemeSave = z.infer<typeof ThemesSaveParamsSchema>;
export const ThemesCreateParamsSchema = z.object({
  id: ThemeIdSchema,
  source: z.union([
    z.strictObject({ path: z.string().min(1) }),
    z.strictObject({ themeId: ThemeIdSchema }),
    z.strictObject({ theme: ThemeFileSchema }),
  ]),
});
export type ThemeCreate = z.infer<typeof ThemesCreateParamsSchema>;
export const ThemesDeleteResultSchema = z.object({ deleted: z.boolean() });
export const ThemesSetActiveParamsSchema = z.object({
  id: ThemeIdSchema.nullable(),
  expected: z.strictObject({ hostId: HostIdSchema, activeId: ThemeIdSchema.nullable() }).optional(),
});
export type ThemeSelection = NonNullable<z.infer<typeof ThemesSetActiveParamsSchema>['expected']>;
export const ThemesSetActiveResultSchema = z.object({ activeId: ThemeIdSchema.nullable() });

export const ThemeMethodSchemas = {
  'themes.list': {
    params: z.object({}),
    result: ThemesListResultSchema,
    permission: 'session.read',
  },
  'themes.get': {
    params: ThemesGetParamsSchema,
    result: ThemesGetResultSchema,
    permission: 'session.read',
  },
  'themes.save': {
    params: ThemesSaveParamsSchema,
    result: ThemesGetResultSchema,
    permission: 'host.manage',
  },
  'themes.create': {
    params: ThemesCreateParamsSchema,
    result: ThemesGetResultSchema,
    permission: 'host.manage',
  },
  'themes.delete': {
    params: z.object({ id: ThemeIdSchema }),
    result: ThemesDeleteResultSchema,
    permission: 'host.manage',
  },
  'themes.setActive': {
    params: ThemesSetActiveParamsSchema,
    result: ThemesSetActiveResultSchema,
    permission: 'host.manage',
  },
} as const;
