import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type SessionId,
  THEMABLE_TOKENS,
  THEME_CSS_HOOKS,
  type ThemeFile,
  type ThemeSave,
} from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppTool, AppToolCall } from './app-mcp.js';
import type { HostCall } from './config-tools.js';
import { FileUrls } from './file-urls.js';
import { useTempDir } from './test-utils.js';
import { THEME_GUIDE, ThemeTools } from './theme-tools.js';
import { ThemeService } from './themes/service.js';

const temp = useTempDir();
const services: ThemeService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
const context: AppToolCall = {
  sessionId: 'ses_theme' as SessionId,
  signal: new AbortController().signal,
};
const theme: ThemeFile = {
  schemaVersion: 1,
  name: 'Agent theme',
  light: { background: '#f1f7ec', foreground: '#182717' },
};
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');

async function boot() {
  const root = temp();
  const fileUrls = new FileUrls();
  fileUrls.setPort(1234);
  const service = new ThemeService({
    hostId: 'hst_test',
    directory: join(root, 'themes'),
    fileUrls,
    onError: (error) => {
      throw error;
    },
  });
  services.push(service);
  await service.load();
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'themes.list':
        return Promise.resolve(service.list());
      case 'themes.get':
        return Promise.resolve(service.get(params.id as string));
      case 'themes.save':
        return service.save(params as ThemeSave);
      case 'themes.setActive':
        return service.setActive(params.id as string | null);
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  const uiConnected = vi.fn(() => false);
  const tools = new ThemeTools({ call: call as HostCall, uiConnected }).tools;
  const read = (args: Record<string, unknown> = {}) =>
    (tools[0] as AppTool)
      .call(args, context)
      .then((result) => result.structuredContent as Record<string, unknown>);
  const set = (args: Record<string, unknown>) =>
    (tools[1] as AppTool)
      .call(args, context)
      .then((result) => result.structuredContent as Record<string, unknown>);
  return { root, service, read, set, call, uiConnected };
}

describe('Wevir theme tools', () => {
  it('reads current selection, real built-in examples and the complete on-demand guide', async () => {
    const h = await boot();
    await h.service.save({ id: 'agent', theme });
    await h.service.setActive('agent');
    const result = await h.read({ themeId: 'night-orbit' });
    expect(result).toMatchObject({
      activeId: 'agent',
      directory: h.service.directory,
      current: { id: 'agent', theme },
      requested: { id: 'night-orbit', readOnly: true, theme: { backdrop: { kind: 'scene' } } },
      guide: THEME_GUIDE,
    });
    for (const token of THEMABLE_TOKENS) expect(THEME_GUIDE).toContain(token);
    for (const hook of THEME_CSS_HOOKS) expect(THEME_GUIDE).toContain(hook.selector);
    expect(
      h.call.mock.calls.every(([method]) => ['themes.list', 'themes.get'].includes(method)),
    ).toBe(true);
  });

  it('copies only supplied backdrop and poster files, updates the same ID, switches and clears', async () => {
    const h = await boot();
    const backdrop = join(h.root, 'scene.html');
    const poster = join(h.root, 'poster.png');
    await writeFile(backdrop, '<!doctype html><html><body><canvas></canvas></body></html>');
    await writeFile(poster, png);
    const scene: ThemeFile = {
      ...theme,
      backdrop: { kind: 'scene', file: 'backdrop.html', poster: 'poster.png' },
    };
    expect(
      await h.set({ themeId: 'agent', theme: scene, files: { backdrop, poster } }),
    ).toMatchObject({ activeId: 'agent', uiConnected: false, problems: expect.any(Array) });
    expect(await readFile(join(h.service.directory, 'agent', 'backdrop.html'), 'utf8')).toContain(
      '<canvas>',
    );
    expect(await readFile(join(h.service.directory, 'agent', 'poster.png'))).toEqual(png);
    h.uiConnected.mockReturnValue(true);
    expect(await h.set({ themeId: 'agent', theme: { ...scene, name: 'Updated' } })).toMatchObject({
      activeId: 'agent',
      uiConnected: true,
      theme: { theme: { name: 'Updated' } },
    });
    expect(await h.set({ themeId: 'tideline' })).toMatchObject({
      activeId: 'tideline',
      theme: { readOnly: true },
    });
    expect(await h.set({ themeId: 'default' })).toEqual({
      activeId: null,
      problems: [],
      uiConnected: true,
    });
  });

  it('rejects unknown fields and invalid file mappings without touching the current selection', async () => {
    const h = await boot();
    await h.set({ themeId: 'agent', theme });
    for (const args of [
      { themeId: 'default', theme },
      { themeId: 'agent', extra: true },
      { themeId: 'agent', theme: { ...theme, extra: true } },
      { themeId: 'agent', files: {} },
      { themeId: 'agent', theme, files: { poster: '/tmp/poster.png' } },
      { themeId: 'agent', theme, files: { extra: '/tmp/extra.png' } },
      {
        themeId: 'agent',
        theme: { ...theme, backdrop: { kind: 'image', file: 'backdrop.png' } },
        files: { backdrop: 'relative.png' },
      },
      { themeId: '../escape', theme },
    ])
      await expect(h.set(args)).rejects.toThrow();
    await expect(h.read({ extra: true })).rejects.toThrow('Unknown fields');
    expect(h.service.list().activeId).toBe('agent');
  });

  it('keeps Host asset and contrast validation, including symlink rejection and problems', async () => {
    const h = await boot();
    const file = join(h.root, 'image.png');
    const link = join(h.root, 'link.png');
    await writeFile(file, png);
    await symlink(file, link);
    const image = { ...theme, backdrop: { kind: 'image' as const, file: 'backdrop.png' } };
    await expect(
      h.set({ themeId: 'linked', theme: image, files: { backdrop: link } }),
    ).rejects.toThrow('symbolic links');
    await writeFile(file, 'not a PNG');
    await expect(
      h.set({ themeId: 'bad-image', theme: image, files: { backdrop: file } }),
    ).rejects.toThrow();
    await expect(
      h.set({
        themeId: 'low-contrast',
        theme: { ...theme, light: { background: '#ffffff', foreground: '#eeeeee' } },
      }),
    ).rejects.toThrow('3:1');
    const warning = await h.set({
      themeId: 'warning',
      theme: { ...theme, light: { ...theme.light, tokens: { 'muted-foreground': '#bdc9ba' } } },
    });
    expect(warning.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'warning' })]),
    );
    await expect(h.set({ themeId: 'tideline', theme })).rejects.toThrow('reserved');
  });
});
