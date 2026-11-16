import { extname } from 'node:path';
import {
  colorContrast,
  compositeThemeColor,
  DEFAULT_THEME_COLORS,
  resolvedThemeColors,
  THEME_IMAGE_MAX_BYTES,
  THEME_SCENE_MAX_BYTES,
  THEME_VIDEO_MAX_BYTES,
  type ThemeFile,
  type ThemeProblem,
} from '@wevir/protocol';

export function themeProblems(theme: ThemeFile): ThemeProblem[] {
  const problems: ThemeProblem[] = [];
  for (const mode of ['light', 'dark'] as const) {
    if (!theme[mode]) continue;
    const vars = resolvedThemeColors(theme, mode);
    const base = compositeThemeColor(
      vars['--background'] ?? '',
      DEFAULT_THEME_COLORS[mode].background,
    );
    const fg = vars['--foreground'] ?? '';
    const body = colorContrast(fg, base);
    if (body < 3)
      problems.push({
        path: `${mode}.foreground`,
        message: `foreground on background: ${body.toFixed(2)}:1; minimum 3:1`,
        severity: 'error',
      });
    const pairs = [
      {
        fg: ['foreground', 'soft-foreground', 'muted-foreground'],
        bg: [
          'background',
          'sidebar',
          'card',
          'popover',
          'muted',
          'accent',
          'secondary',
          'sidebar-accent',
          'code-background',
        ],
      },
      { fg: ['primary-foreground'], bg: ['primary'] },
      {
        fg: ['running', 'success', 'warning', 'destructive'],
        bg: ['background', 'sidebar', 'card', 'muted'],
      },
      {
        fg: [
          'code-keyword',
          'code-string',
          'code-number',
          'code-title',
          'code-comment',
          'code-meta',
        ],
        bg: ['code-background'],
      },
      {
        fg: ['foreground', 'muted-foreground', 'success', 'destructive'],
        bg: [
          'diff-added',
          'diff-added-gutter',
          'diff-added-emphasis',
          'diff-removed',
          'diff-removed-gutter',
          'diff-removed-emphasis',
        ],
      },
    ];
    for (const pair of pairs)
      for (const foreground of pair.fg)
        for (const background of pair.bg) {
          const ink = vars[`--${foreground}`] ?? '';
          const surface = vars[`--${background}`] ?? '';
          if (
            !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(ink) ||
            !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(surface)
          )
            continue;
          const ratio = colorContrast(ink, compositeThemeColor(surface, base));
          if (ratio < 4.5)
            problems.push({
              path: `${mode}.tokens.${foreground}`,
              message: `${foreground} on ${background}: ${ratio.toFixed(2)}:1; recommended 4.5:1`,
              severity: 'warning',
            });
        }
  }
  return problems;
}

export function assetLimit(name: string): number {
  const extension = extname(name);
  if (['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.apng'].includes(extension))
    return THEME_IMAGE_MAX_BYTES;
  if (['.mp4', '.webm'].includes(extension)) return THEME_VIDEO_MAX_BYTES;
  if (name === 'backdrop.html') return THEME_SCENE_MAX_BYTES;
  throw new Error(`${name}: unsupported asset type`);
}

export function validateAsset(
  name: string,
  data: Buffer,
  kind?: 'image' | 'video' | 'scene',
): void {
  const extension = extname(name);
  const ascii = (start: number, end: number) => data.toString('ascii', start, end);
  let type: 'image' | 'video' | 'scene' | undefined;
  if (
    ['.jpg', '.jpeg'].includes(extension) &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    type = 'image';
  if (
    ['.png', '.apng'].includes(extension) &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    type = 'image';
  if (extension === '.gif' && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) type = 'image';
  if (extension === '.webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') type = 'image';
  if (
    extension === '.avif' &&
    ascii(4, 8) === 'ftyp' &&
    /avif|avis/.test(ascii(8, Math.min(data.length, 64)))
  )
    type = 'image';
  if (
    extension === '.mp4' &&
    ascii(4, 8) === 'ftyp' &&
    /isom|iso[2-9]|mp4[12]|avc1|M4V |dash/.test(ascii(8, Math.min(data.length, 64)))
  )
    type = 'video';
  if (
    extension === '.webm' &&
    data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    data.subarray(0, 4096).includes(Buffer.from('webm'))
  )
    type = 'video';
  if (name === 'backdrop.html') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<html\b/i.test(text))
      type = 'scene';
  }
  if (type === undefined || (kind !== undefined && type !== kind))
    throw new Error(`${name}: file header does not match ${kind ?? extension}`);
  if (data.length > assetLimit(name))
    throw new Error(`${name}: asset exceeds ${assetLimit(name)} bytes`);
}
