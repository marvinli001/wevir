import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanLogs, measureStorage } from './storage.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wevir-storage-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function file(path: string, bytes: number): Promise<void> {
  const full = join(home, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, Buffer.alloc(bytes));
}

const bytesOf = (usage: Awaited<ReturnType<typeof measureStorage>>) =>
  Object.fromEntries(usage.categories.map(({ id, bytes }) => [id, bytes]));

describe('measureStorage', () => {
  it('sorts the data directory into categories that add up to the total', async () => {
    await file('wevir.db', 100);
    await file('wevir.db-wal', 10);
    await file('history/s1.json', 5);
    await file('chats/s1/notes.md', 7);
    await file('images/a.png', 20);
    await file('worktrees/s1/repo/file.ts', 300);
    await file('engines/codex/state_5.sqlite', 400);
    await file('logs/host.log', 3);
    await file('office/engine/versions/0.2.0/node_modules/kit/engine.bin', 70);
    await file('office/pdf/abc.pdf', 5);
    await file('plugins/registry.json', 2);
    await file('settings.json', 1);
    await file('desktop/Cache/Cache_Data/data_0', 50);
    await file('desktop/Code Cache/js/index', 30);
    await file('desktop/GraphiteDawnCache/data_3', 11);
    await file('desktop/Local Storage/leveldb/000003.log', 4);
    await file('desktop/Partitions/wevir-browser/Cache/Cache_Data/data_1', 60);
    await file('desktop/Partitions/wevir-browser/Cookies', 8);
    await file('desktop/Partitions/wevir-browser/Local Storage/leveldb/1.log', 9);
    await file('desktop/Partitions/other/Cookies', 6);

    const usage = await measureStorage(home);
    expect(usage.root).toBe(home);
    expect(bytesOf(usage)).toEqual({
      sessions: 142,
      worktrees: 300,
      engines: 470,
      cache: 140,
      browser: 17,
      logs: 3,
      other: 29,
    });
    expect(usage.total).toBe(1101);
    expect(usage.categories.map((category) => category.id)).toEqual([
      'sessions',
      'worktrees',
      'engines',
      'cache',
      'browser',
      'logs',
      'other',
    ]);
  });

  it('does not follow symbolic links and counts a missing directory as empty', async () => {
    await file('outside/big.bin', 1000);
    await mkdir(join(home, 'worktrees'), { recursive: true });
    await symlink(join(home, 'outside'), join(home, 'worktrees', 'link'));
    const usage = await measureStorage(home);
    expect(bytesOf(usage).worktrees).toBeLessThan(1000);
    const missing = await measureStorage(join(home, 'nope'));
    expect(missing.total).toBe(0);
  });
});

describe('cleanLogs', () => {
  it('empties the live log and removes everything else', async () => {
    await file('logs/host.log', 30);
    await file('logs/host.log.1', 30);
    await file('logs/old/trace.txt', 30);
    await cleanLogs(home);
    expect(await readdir(join(home, 'logs'))).toEqual(['host.log']);
    expect((await readFile(join(home, 'logs/host.log'))).length).toBe(0);
  });

  it('does nothing when there is no log directory', async () => {
    await expect(cleanLogs(home)).resolves.toBeUndefined();
  });
});
