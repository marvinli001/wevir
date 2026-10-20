import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkUserEntries } from './private-home.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('linkUserEntries', () => {
  it('链用户有的条目；私有目录里的真文件不动；用户删掉的条目去掉旧链接', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wevir-private-home-'));
    dirs.push(root);
    const user = path.join(root, 'user');
    const own = path.join(root, 'account');
    mkdirSync(path.join(user, 'skills'), { recursive: true });
    writeFileSync(path.join(user, 'CLAUDE.md'), '# mine');
    writeFileSync(path.join(user, 'settings.json'), '{}');
    mkdirSync(own, { recursive: true });
    writeFileSync(path.join(own, 'agents'), 'own file');
    symlinkSync(path.join(user, 'commands'), path.join(own, 'commands'));

    await linkUserEntries({
      privateDir: own,
      userDir: user,
      entries: ['CLAUDE.md', 'skills', 'agents', 'commands'],
    });
    expect(readlinkSync(path.join(own, 'CLAUDE.md'))).toBe(path.join(user, 'CLAUDE.md'));
    expect(readlinkSync(path.join(own, 'skills'))).toBe(path.join(user, 'skills'));
    expect((await lstat(path.join(own, 'agents'))).isSymbolicLink()).toBe(false);
    await expect(lstat(path.join(own, 'commands'))).rejects.toThrow();
    await expect(lstat(path.join(own, 'settings.json'))).rejects.toThrow();

    rmSync(path.join(user, 'skills'), { recursive: true });
    await linkUserEntries({ privateDir: own, userDir: user, entries: ['skills'] });
    await expect(lstat(path.join(own, 'skills'))).rejects.toThrow();
  });
});
