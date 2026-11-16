import { lstat, mkdir, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  THEME_MAX_BYTES,
  THEME_MAX_COUNT,
  type ThemeFile,
  type ThemesUpdated,
} from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FileUrls } from '../file-urls.js';
import { useTempDir } from '../test-utils.js';
import { THEME_SCENE_CSP } from './scene-csp.js';
import { readThemeFile, ThemeService } from './service.js';
import { assetLimit, themeProblems, validateAsset } from './validation.js';

const temp = useTempDir();
const services: ThemeService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
const theme: ThemeFile = {
  schemaVersion: 1,
  name: 'Lagoon',
  dark: { background: '#101820', foreground: '#f1f5f9' },
};
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
async function start() {
  const urls = new FileUrls();
  urls.setPort(1234);
  const service = new ThemeService({
    directory: join(temp(), 'themes'),
    fileUrls: urls,
    onError: (error) => {
      throw error;
    },
  });
  services.push(service);
  await service.load();
  return { service, urls };
}
function changed(service: ThemeService, predicate: (update: ThemesUpdated) => boolean) {
  return new Promise<ThemesUpdated>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error('themes.updated timeout'));
    }, 4000);
    const stop = service.watch((update) => {
      if (!predicate(update)) return;
      clearTimeout(timeout);
      stop();
      resolve(update);
    });
  });
}

describe('Host themes', () => {
  it('keeps playback diagnostics separate from validation and ignores stale revisions', async () => {
    const { service } = await start();
    const source = join(temp(), 'backdrop.png');
    await writeFile(source, png);
    const saved = await service.save({
      id: 'lagoon',
      theme: { ...theme, backdrop: { kind: 'image', file: 'backdrop.png' } },
      assets: [{ name: 'backdrop.png', sourcePath: source }],
    });
    const updates: ThemesUpdated[] = [];
    service.watch((update) => updates.push(update));
    const status = { revision: saved.revision, asset: 'file' as const, status: 'failed' as const };
    expect(service.get('lagoon', status).problems).toContainEqual(
      expect.objectContaining({ path: 'backdrop.file', severity: 'error' }),
    );
    expect(service.list().themes[0]?.problems).toContainEqual(
      expect.objectContaining({ path: 'backdrop.file' }),
    );
    expect(updates).toEqual([]);
    await expect(service.setActive('lagoon')).resolves.toEqual({ activeId: 'lagoon' });
    expect(() => service.get('lagoon', { ...status, asset: 'poster' })).toThrow(
      'asset does not exist',
    );
    expect(
      service
        .get('lagoon', { ...status, status: 'loaded' })
        .problems.some((p) => p.path === 'backdrop.file'),
    ).toBe(false);
    service.get('lagoon', status);
    const changed = await service.save({
      id: 'lagoon',
      theme: { ...(saved.theme as ThemeFile), name: 'Revised' },
    });
    expect(changed.revision).not.toBe(saved.revision);
    expect(service.get('lagoon', status).problems.some((p) => p.path === 'backdrop.file')).toBe(
      false,
    );
    expect(
      service
        .get('lagoon', { ...status, revision: changed.revision })
        .problems.some((p) => p.path === 'backdrop.file'),
    ).toBe(true);
    expect(
      service
        .get('lagoon', { ...status, status: 'loaded' })
        .problems.some((p) => p.path === 'backdrop.file'),
    ).toBe(true);
  });
  it('reports remote CSS at save time while leaving manual files to the client guard', async () => {
    const { service } = await start();
    await service.save({ id: 'lagoon', theme });
    const css = 'body { background-image: url(http://127.0.0.1:1234/leak) }';
    await expect(service.save({ id: 'lagoon', theme: { ...theme, css } })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringContaining('css:'),
    });
    expect(service.get('lagoon').theme).toEqual(theme);
    const updated = changed(service, () => service.get('lagoon').theme?.css === css);
    await writeFile(
      join(service.directory, 'lagoon', 'theme.json'),
      JSON.stringify({ ...theme, css }),
    );
    await updated;
    expect(service.get('lagoon').theme?.css).toBe(css);
  });
  it('saves atomically, persists selection only through setActive and clears it on delete', async () => {
    const { service } = await start();
    const saved = await service.save({ id: 'lagoon', theme });
    expect(saved.theme).toEqual(theme);
    expect(service.list().activeId).toBeNull();
    const path = join(service.directory, 'lagoon', 'theme.json');
    const previous = await open(path, 'r');
    await service.save({ id: 'lagoon', theme: { ...theme, name: 'Changed' } });
    expect(JSON.parse(await previous.readFile('utf8')).name).toBe('Lagoon');
    await previous.close();
    expect(
      (await readdir(join(service.directory, 'lagoon'))).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
    expect((await lstat(path)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
    await service.setActive('lagoon');
    expect(JSON.parse(await readFile(join(service.directory, '.active.json'), 'utf8'))).toEqual({
      id: 'lagoon',
    });
    expect(await service.delete('lagoon')).toEqual({ deleted: true });
    expect(service.list().activeId).toBeNull();
    await expect(service.setActive('missing')).rejects.toThrow('missing');
  });
  it('watches manual edits, retains the last good theme and assets, then recovers', async () => {
    const { service } = await start();
    const source = join(temp(), 'source.png');
    await writeFile(source, png);
    const withImage = { ...theme, backdrop: { kind: 'image', file: 'a.png' } } as ThemeFile;
    await service.save({
      id: 'lagoon',
      theme: withImage,
      assets: [{ name: 'a.png', sourcePath: source }],
    });
    await service.setActive('lagoon');
    const old = service.get('lagoon');
    const update = changed(service, (u) => u.revisions.lagoon !== old.revision);
    await writeFile(join(service.directory, 'lagoon', 'theme.json'), '{broken');
    await update;
    expect(service.get('lagoon')).toMatchObject({
      theme: withImage,
      problems: [{ severity: 'error', path: 'theme.json' }],
    });
    expect(service.get('lagoon').assets.file).toContain('/a.png?v=');
    expect(service.list().activeId).toBe('lagoon');
    const recovery = changed(service, () => service.get('lagoon').theme?.name === 'Recovered');
    await writeFile(
      join(service.directory, 'lagoon', 'theme.json'),
      JSON.stringify({ ...withImage, name: 'Recovered' }),
    );
    await recovery;
    expect(service.get('lagoon').problems.every((p) => p.severity === 'warning')).toBe(true);
    const brokenAsset = changed(service, () =>
      service.get('lagoon').problems.some((p) => p.severity === 'error'),
    );
    await writeFile(join(service.directory, 'lagoon', 'a.png'), 'not an image');
    await brokenAsset;
    expect(service.get('lagoon').theme?.name).toBe('Recovered');
  });
  it('loads a manually created invalid theme and watches its repair', async () => {
    const { service } = await start();
    const announced = changed(service, (update) => update.revisions.broken !== undefined);
    await mkdir(join(service.directory, 'broken'));
    await writeFile(join(service.directory, 'broken', 'theme.json'), '{}');
    await announced;
    expect(service.get('broken').theme).toBeUndefined();
    const repaired = changed(service, () => service.get('broken').theme !== undefined);
    await writeFile(join(service.directory, 'broken', 'theme.json'), JSON.stringify(theme));
    await repaired;
  });
  it.each(['.wall.png', 'a.tmp-b.png'])('hot reloads the permitted asset name %s', async (name) => {
    const { service } = await start();
    const source = join(temp(), 'source.png');
    await writeFile(source, png);
    await service.save({
      id: 'lagoon',
      theme: { ...theme, backdrop: { kind: 'image', file: name } },
      assets: [{ name, sourcePath: source }],
    });
    const revision = service.get('lagoon').revision;
    const update = changed(service, (event) => event.revisions.lagoon !== revision);
    await writeFile(
      join(service.directory, 'lagoon', name),
      Buffer.concat([png, Buffer.from([1])]),
    );
    await update;
    expect(service.get('lagoon').problems.some((problem) => problem.severity === 'error')).toBe(
      false,
    );
  });
  it('rejects reserved IDs, traversal, links, wrong headers and excess bytes before changing a good theme', async () => {
    const { service } = await start();
    for (const id of ['default', 'system', 'light', 'dark', 'wevir', 'tideline', '../escape'])
      await expect(service.save({ id, theme })).rejects.toThrow();
    await service.save({ id: 'lagoon', theme });
    const source = join(temp(), 'source.png');
    await writeFile(source, 'bad');
    await expect(
      service.save({
        id: 'lagoon',
        theme: { ...theme, backdrop: { kind: 'image', file: 'a.png' } },
        assets: [{ name: 'a.png', sourcePath: source }],
      }),
    ).rejects.toThrow('header');
    const link = join(temp(), 'linked.png');
    await symlink(source, link);
    await expect(
      service.save({ id: 'lagoon', theme, assets: [{ name: 'a.png', sourcePath: link }] }),
    ).rejects.toThrow('symbolic');
    const folder = join(service.directory, 'linked');
    await symlink(
      join(service.directory, 'lagoon'),
      folder,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(service.save({ id: 'linked', theme })).rejects.toThrow('symbolic');
    expect(service.get('lagoon').theme).toEqual(theme);
    await writeFile(source, Buffer.alloc(THEME_MAX_BYTES + 1));
    await expect(readThemeFile(source, THEME_MAX_BYTES)).rejects.toThrow('exceeds');
  });
  it('caps the number of examined themes, including invalid folders', async () => {
    const { service } = await start();
    await Promise.all(
      Array.from({ length: THEME_MAX_COUNT }, (_, i) =>
        mkdir(join(service.directory, `theme-${i}`)),
      ),
    );
    await expect(service.save({ id: 'extra', theme })).rejects.toThrow('maximum 200');
  });
  it('uses strict sandbox headers and serves only explicitly granted theme assets', async () => {
    const { service, urls } = await start();
    const source = join(temp(), 'backdrop.html');
    await writeFile(
      source,
      '<!doctype html><html><body><script>fetch("https://example.com")</script></body></html>',
    );
    await service.save({
      id: 'scene',
      theme: { ...theme, backdrop: { kind: 'scene', file: 'backdrop.html' } },
      assets: [{ name: 'backdrop.html', sourcePath: source }],
    });
    const server = createServer((req, res) => {
      if (!urls.handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      urls.setPort(address.port);
      const url = service.get('scene').assets.file as string;
      const response = await fetch(url);
      expect(response.headers.get('content-security-policy')).toBe(THEME_SCENE_CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).not.toContain('wevir-preview');
      expect((await fetch(url.replace('backdrop.html', 'theme.json'))).status).toBe(404);
      expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe('theme validation', () => {
  it('refuses body contrast under 3:1 and warns without refusing other pairs under 4.5:1', () => {
    expect(
      themeProblems({ ...theme, dark: { background: '#111111', foreground: '#222222' } }),
    ).toContainEqual(expect.objectContaining({ severity: 'error', path: 'dark.foreground' }));
    expect(
      themeProblems({ ...theme, dark: { tokens: { 'muted-foreground': '#111111' } } }),
    ).toContainEqual(
      expect.objectContaining({ severity: 'warning', path: 'dark.tokens.muted-foreground' }),
    );
  });
  it.each([
    ['x.jpg', Buffer.from([255, 216, 255]), 'image'],
    ['x.png', png, 'image'],
    ['x.apng', png, 'image'],
    ['x.gif', Buffer.from('GIF89a'), 'image'],
    ['x.webp', Buffer.from('RIFF0000WEBP'), 'image'],
    ['x.avif', Buffer.from('0000ftypavif'), 'image'],
    ['x.mp4', Buffer.from('0000ftypisom'), 'video'],
    ['x.webm', Buffer.concat([Buffer.from([26, 69, 223, 163]), Buffer.from('webm')]), 'video'],
    ['backdrop.html', Buffer.from('<html></html>'), 'scene'],
  ] as const)('checks %s by extension and header', (name, data, kind) => {
    expect(() => validateAsset(name, data, kind)).not.toThrow();
    expect(() => validateAsset(name, Buffer.from('invalid'), kind)).toThrow();
    expect(() => validateAsset(name, data, kind === 'image' ? 'video' : 'image')).toThrow();
    const oversized = Buffer.alloc(assetLimit(name) + 1);
    data.copy(oversized);
    expect(() => validateAsset(name, oversized, kind)).toThrow('exceeds');
  });
  it('refuses unrecognized assets', () => {
    for (const name of ['a.svg', 'a.js', 'scene.html', 'a.css'])
      expect(() => assetLimit(name)).toThrow();
  });
});
