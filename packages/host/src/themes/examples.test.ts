import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THEME_EXAMPLE_IDS, type ThemeFile } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FileUrls } from '../file-urls.js';
import { useTempDir } from '../test-utils.js';
import { ThemeService } from './service.js';

const temp = useTempDir();
const services: ThemeService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

async function start() {
  const urls = new FileUrls();
  urls.setPort(1234);
  const service = new ThemeService({
    hostId: 'hst_examples',
    directory: join(temp(), 'themes'),
    fileUrls: urls,
    onError: (error) => {
      throw error;
    },
  });
  services.push(service);
  await service.load();
  return service;
}

describe('bundled theme examples', () => {
  it('lists valid read-only examples, ignores user-folder shadows and protects their IDs', async () => {
    const shadow = join(temp(), 'themes', 'tideline');
    await mkdir(shadow, { recursive: true });
    await writeFile(join(shadow, 'theme.json'), 'not a bundled theme');
    const service = await start();
    expect(service.list().themes.map((entry) => entry.id)).toEqual(THEME_EXAMPLE_IDS);
    for (const id of THEME_EXAMPLE_IDS) {
      const example = service.get(id);
      expect(example.readOnly).toBe(true);
      expect(example.theme?.light).toBeDefined();
      expect(example.theme?.dark).toBeDefined();
      expect.soft(example.problems, id).toEqual([]);
      await expect(service.save({ id, theme: example.theme as ThemeFile })).rejects.toThrow(
        'reserved theme ID',
      );
      await expect(service.delete(id)).rejects.toThrow('reserved theme ID');
      await expect(service.create({ id, source: { themeId: 'tideline' } })).rejects.toThrow(
        'reserved theme ID',
      );
      await expect(service.setActive(id)).resolves.toEqual({ activeId: id });
    }
    expect(service.get('tideline').theme?.name).toBe('Tideline');
    expect(service.get('tideline').theme?.backdrop).toBeUndefined();
    expect(service.get('paper-garden').theme?.css).toContain('radial-gradient');
  });

  it('issues snapshotted scene and poster URLs and clones them into an editable user theme', async () => {
    const service = await start();
    await service.setActive('night-orbit');
    const source = service.get('night-orbit');
    expect(source.theme?.backdrop).toMatchObject({ kind: 'scene', glass: true });
    const scene = await readFile(join(source.directory, 'backdrop.html'), 'utf8');
    expect(scene).toContain('background = theme.tokens.background');
    expect(scene).toContain('context.fillRect(0, 0, width, height)');
    expect(scene).not.toContain('clearRect(');
    expect(source.assets.file).toMatch(/\/files\/.+backdrop\.html\?v=.+&theme-scene=1$/);
    expect(source.assets.poster).toMatch(/\/files\/.+poster\.png\?v=/);
    const copy = await service.create({ id: 'my-orbit', source: { themeId: 'night-orbit' } });
    expect(copy.readOnly).toBe(false);
    expect(copy.theme).toEqual(source.theme);
    expect(copy.revision).toBe(source.revision);
    for (const name of ['backdrop.html', 'poster.png']) {
      expect(await readFile(join(copy.directory, name))).toEqual(
        await readFile(join(source.directory, name)),
      );
    }
    expect(copy.assets.file).not.toBe(source.assets.file);
    await service.save({
      id: 'my-orbit',
      theme: { ...(copy.theme as ThemeFile), name: 'My Orbit' },
    });
    expect(service.get('night-orbit').theme?.name).toBe('Night Orbit');
    await expect(service.delete('my-orbit')).resolves.toEqual({ deleted: true });
    expect(service.list().activeId).toBe('night-orbit');
  });
});
