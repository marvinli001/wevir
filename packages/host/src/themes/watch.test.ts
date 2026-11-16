import type { FSWatcher } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileUrls } from '../file-urls.js';
import { useTempDir } from '../test-utils.js';
import { ThemeService } from './service.js';

const temp = useTempDir();
const calls = vi.hoisted(
  () =>
    [] as { path: string; changed: (event: string, name: string) => void; watcher: FSWatcher }[],
);
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...fs,
    watch: (path: string, _options: unknown, changed: (event: string, name: string) => void) => {
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(),
        ref: vi.fn(),
        unref: vi.fn(),
      }) as unknown as FSWatcher;
      calls.push({ path, changed, watcher });
      return watcher;
    },
  };
});

it('reopens a Linux directory watcher after the directory inode is replaced', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const urls = new FileUrls();
  urls.setPort(1234);
  const service = new ThemeService({
    directory: join(temp(), 'themes'),
    fileUrls: urls,
    onError: (error) => {
      throw error;
    },
  });
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await service.load();
    const theme = { schemaVersion: 1 as const, name: 'Original', dark: {} };
    await service.save({ id: 'lagoon', theme });
    const target = join(service.directory, 'lagoon');
    const old = calls.find((call) => call.path === target);
    const root = calls.find((call) => call.path === service.directory);
    expect(old).toBeDefined();
    expect(root).toBeDefined();
    const replacement = join(temp(), 'replacement');
    await mkdir(replacement);
    await writeFile(
      join(replacement, 'theme.json'),
      JSON.stringify({ ...theme, name: 'Replacement' }),
    );
    await rename(target, join(temp(), 'old'));
    await rename(replacement, target);
    root?.changed('rename', 'lagoon');
    await vi.waitFor(() => expect(service.get('lagoon').theme?.name).toBe('Replacement'));
    expect(old?.watcher.close).toHaveBeenCalledOnce();
    const current = calls.filter((call) => call.path === target).at(-1);
    expect(current).not.toBe(old);
    await writeFile(join(target, 'theme.json'), JSON.stringify({ ...theme, name: 'Updated' }));
    current?.changed('change', 'theme.json');
    await vi.waitFor(() => expect(service.get('lagoon').theme?.name).toBe('Updated'));
  } finally {
    await service.close();
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});
