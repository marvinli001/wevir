import { isAbsolute } from 'node:path';
import {
  THEMABLE_TOKENS,
  THEME_ACCENTS,
  THEME_CSS_HOOKS,
  THEME_EXAMPLE_IDS,
  type ThemeFile,
  ThemeFileSchema,
  ThemeIdSchema,
} from '@wevir/protocol';
import { type AppTool, AppToolError, jsonResult } from './app-mcp.js';
import type { HostCall } from './config-tools.js';
import { isHostError } from './errors.js';

export const THEME_TOOLS_INSTRUCTIONS =
  '- wevir_theme_read / wevir_theme_set: only restyle Wevir itself when the user asks; never for a project’s theme.css. Read the guide first.';

export const THEME_GUIDE = `Restyle Wevir only when the user asks to change Wevir itself. A request to edit a project's theme.css, website, or app belongs in that project, not these tools.

Start with colors; add CSS only for changes colors cannot express. Read the current theme or a read-only example (${THEME_EXAMPLE_IDS.join(', ')}) before editing. Usually the agent cannot see the result: change a little, then ask the user to check it. A connected UI is not proof that it rendered the change.

wevir_theme_set({themeId, theme?, files?: {backdrop?, poster?}}) saves and activates on this Host. Without theme it selects an existing ID. With theme the same ID updates it. files contains absolute paths prepared by the agent, copied only to theme.backdrop.file/poster; omit files to reuse already saved assets. Built-in examples are read-only: save a copy under a new ID. User IDs match [a-z0-9][a-z0-9_-]{0,63}; default, system, light, dark, device presets and example IDs are reserved. At most 200 user themes.

theme.json is a strict schemaVersion:1 object: {schemaVersion:1, name, author?, accent?, colorScheme?, light?, dark?, css?, backdrop?}. At least light or dark is required. Each mode is {background?, foreground?, tokens?}. Anchors derive semantic colors, then tokens override them. Colors are #rrggbb or #rrggbbaa. accent accepts a color or ${THEME_ACCENTS.join(', ')}. colorScheme:'light'|'dark' temporarily overrides the device mode. Without that override, a missing mode block leaves device colors in that mode; CSS and backdrop still apply. Fonts, sizes, contrast and the original device mode remain device preferences. Body contrast below 3:1 is rejected; other text/surface pairs below 4.5:1 return problems without blocking save.

Allowed tokens (keys without --): ${THEMABLE_TOKENS.join(', ')}.

Stable CSS selectors:
${THEME_CSS_HOOKS.map((hook) => `${hook.selector}: ${hook.styles}`).join('\n')}

Use semantic var(--token) colors. Some application rules are more specific; use a scoped !important when needed. CSS cannot fetch files: no @import, image-set(), src(), external/relative/file/loopback URLs; url() accepts only data: or #id. Unknown at-rules are removed after CSSOM parsing; do not depend on them. Reduced motion also removes animation*, transition*, scroll-behavior and all declarations, including !important. CSS can hide controls: keep recovery available. --theme-backdrop-image contains the Host-approved image URL for image backgrounds only; --theme-backdrop-opacity is 0..1, --theme-backdrop-blur is px, --theme-backdrop-scrim is 0..1. CSS does not grant access to other local files.

backdrop: {kind:'image'|'video'|'scene', file, poster?, scope?:'conversation'|'window', fit?:'cover'|'contain'|'tile', opacity?:0..1, blur?:0..40, scrim?:0..1, glass?:boolean}. file/poster are single lowercase filenames matching [a-z0-9._-]+, never paths, '.' or '..'. Images: jpg/jpeg/png/webp/avif/gif/apng. Videos: mp4/webm, muted and looping. Scenes: one self-contained backdrop.html. poster must be an image. A project background takes priority. window scope suspends native window material; glass uses the app's controlled translucent surfaces.

Scene code runs only in an opaque-origin iframe with sandbox allow-scripts, no pointer/focus access and strict CSP. It cannot access the parent DOM/storage, Host APIs, network, subframes or forms. The parent only sends {type:'wevir-theme', mode:'light'|'dark', tokens:{background, foreground, accent, ...}, reducedMotion:boolean, visible:boolean}; token keys omit --. The parent never handles scene messages. Listen for that message, update colors, fit the viewport, cap canvas drawing to 30fps and stop when visible=false. Do not animate inherited custom properties on ancestor elements. Native navigation restrictions unload a scene that navigates away and retain its colors; Chromium may briefly show a blocked error page.

Reduced motion, low GPU or reduced transparency uses the video/scene poster; without a poster only colors remain. Glass becomes opaque. Hidden/minimized windows pause video and stop/unmount scenes. Background failures retain colors and appear in problems. Invalid edited files retain the last valid theme and assets. Limits: theme.json 512 KiB, CSS 50,000 characters, images 16 MiB each, videos 64 MiB, scene HTML 1 MiB. Host validates file extensions, signatures, sizes and rejects symlinks; no extra files or directories are served.

Recovery: wevir_theme_set({themeId:'default'}); Settings > Appearance > restore default theme; native View menu > restore default theme (Cmd/Ctrl+Alt+Shift+0); or CLI: wevir theme clear. All clear this Host's theme selection. Mobile does not apply themes. Font files are unsupported. Diff/file syntax highlighting and Mermaid still follow only light/dark. Official relay web clients cannot load local backdrop assets; colors and restricted CSS remain available.`;

function knownKeys(args: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(args).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new AppToolError(`Unknown fields: ${unknown.join(', ')}.`);
}

function themeId(value: unknown): string {
  const parsed = ThemeIdSchema.safeParse(value);
  if (!parsed.success) throw new AppToolError(`themeId: ${parsed.error.message}`);
  return parsed.data;
}

export interface ThemeToolsOptions {
  call: HostCall;
  uiConnected: () => boolean;
}

export class ThemeTools {
  readonly tools: AppTool[];

  constructor(options: ThemeToolsOptions) {
    const host: HostCall = async (method, params) => {
      try {
        return await options.call(method, params);
      } catch (error) {
        if (isHostError(error)) throw new AppToolError(`${error.code}: ${error.message}`);
        throw error;
      }
    };
    this.tools = [
      {
        name: 'wevir_theme_read',
        title: 'Read Wevir themes',
        description:
          'Only for user-requested changes to Wevir itself, never a project’s theme.css. Read the current Host theme, list, directory and styling guide; themeId also includes that theme.json.',
        inputSchema: {
          type: 'object',
          properties: { themeId: { type: 'string' } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        call: async (args) => {
          knownKeys(args, ['themeId']);
          const selected = args.themeId === undefined ? undefined : themeId(args.themeId);
          const list = await host('themes.list', {});
          const current =
            list.activeId === null ? null : await host('themes.get', { id: list.activeId });
          return jsonResult({
            ...list,
            current,
            guide: THEME_GUIDE,
            ...(selected !== undefined && {
              requested: selected === 'default' ? null : await host('themes.get', { id: selected }),
            }),
          });
        },
      },
      {
        name: 'wevir_theme_set',
        title: 'Set Wevir theme',
        description:
          'Only restyle Wevir itself when the user asks, never a project’s theme.css. Read wevir_theme_read first. With theme, save/update this ID and copy absolute files.backdrop/poster paths, then activate; otherwise select an existing ID. default restores device appearance.',
        inputSchema: {
          type: 'object',
          properties: {
            themeId: { type: 'string' },
            theme: {
              type: 'object',
              description: 'Strict schemaVersion 1 theme.json; read the guide for fields.',
            },
            files: {
              type: 'object',
              properties: { backdrop: { type: 'string' }, poster: { type: 'string' } },
              additionalProperties: false,
            },
          },
          required: ['themeId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        call: async (args) => {
          knownKeys(args, ['themeId', 'theme', 'files']);
          const id = themeId(args.themeId);
          let theme: ThemeFile | undefined;
          if (args.theme !== undefined) {
            const parsed = ThemeFileSchema.safeParse(args.theme);
            if (!parsed.success) throw new AppToolError(`theme: ${parsed.error.message}`);
            theme = parsed.data;
          }
          let files: Record<string, unknown> | undefined;
          if (args.files !== undefined) {
            if (!args.files || typeof args.files !== 'object' || Array.isArray(args.files))
              throw new AppToolError('files must be an object.');
            files = args.files as Record<string, unknown>;
            knownKeys(files, ['backdrop', 'poster']);
          }
          if (id === 'default') {
            if (theme !== undefined || files !== undefined)
              throw new AppToolError('default cannot include theme or files.');
            return jsonResult({
              ...(await host('themes.setActive', { id: null })),
              problems: [],
              uiConnected: options.uiConnected(),
            });
          }
          if (files !== undefined && theme === undefined)
            throw new AppToolError('files requires theme.');
          if (theme !== undefined) {
            const assets: Array<{ name: string; sourcePath: string }> = [];
            for (const key of ['backdrop', 'poster'] as const) {
              const sourcePath = files?.[key];
              if (sourcePath === undefined) continue;
              if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath))
                throw new AppToolError(`files.${key}: absolute path required.`);
              const name = key === 'backdrop' ? theme.backdrop?.file : theme.backdrop?.poster;
              if (name === undefined)
                throw new AppToolError(
                  `files.${key} requires theme.backdrop.${key === 'backdrop' ? 'file' : 'poster'}.`,
                );
              assets.push({ name, sourcePath });
            }
            await host('themes.save', { id, theme, ...(assets.length > 0 && { assets }) });
          }
          const selection = await host('themes.setActive', { id });
          const result = await host('themes.get', { id });
          return jsonResult({
            ...selection,
            theme: result,
            problems: result.problems,
            uiConnected: options.uiConnected(),
          });
        },
      },
    ];
  }
}
