import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ChecksStore, normalizeRelative } from './checks-store.js';

const workspace = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-checks-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ChecksStore', () => {
  it('saves checks with a revision per edit and keeps them across reloads', async () => {
    const dir = tempDir();
    const store = new ChecksStore({ dir });
    expect(await store.list(workspace)).toEqual({
      checks: [],
      repair: { enabled: false, maxAttempts: 2, maxDurationMs: 1_200_000, maxTokens: 1_000_000 },
    });
    const saved = await store.save(workspace, {
      name: 'test',
      command: 'npm test',
      kind: 'test',
      trigger: 'after_turn',
      paths: ['src/', './test/**/*.js'],
    });
    expect(saved).toMatchObject({
      revision: 1,
      cwd: '',
      paths: ['src/', 'test/**/*.js'],
      source: { kind: 'user' },
    });
    const edited = await store.save(workspace, { ...saved, command: 'npm run test' });
    expect(edited).toMatchObject({
      id: saved.id,
      revision: 2,
      command: 'npm run test',
      createdAt: saved.createdAt,
    });
    await store.setRepair(workspace, { enabled: true, maxAttempts: 3 });

    const file = join(dir, `${workspace}.json`);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = new ChecksStore({ dir });
    const listed = await reloaded.list(workspace);
    expect(listed.checks).toEqual([edited]);
    expect(listed.repair).toMatchObject({ enabled: true, maxAttempts: 3 });
    expect(await reloaded.remove(workspace, saved.id)).toBe(true);
    expect(await reloaded.remove(workspace, saved.id)).toBe(false);
  });

  it('refuses paths outside the session folder and unknown script sources', async () => {
    const store = new ChecksStore({});
    const check = { name: 'x', command: 'x', kind: 'other' as const, trigger: 'manual' as const };
    await expect(store.save(workspace, { ...check, cwd: '../elsewhere' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(store.save(workspace, { ...check, cwd: '/etc' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(store.save(workspace, { ...check, paths: ['../x'] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      store.save(workspace, {
        ...check,
        source: { kind: 'package_script', file: 'package.json', script: 'test' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('treats a broken file as empty', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, `${workspace}.json`), '{not json');
    const warnings: string[] = [];
    const store = new ChecksStore({ dir, onWarning: (message) => warnings.push(message) });
    expect((await store.list(workspace)).checks).toEqual([]);
    expect(warnings).toHaveLength(1);
    // 下一次保存覆盖掉坏文件。
    await store.save(workspace, { name: 'x', command: 'x', kind: 'other', trigger: 'manual' });
    expect(JSON.parse(readFileSync(join(dir, `${workspace}.json`), 'utf8')).checks).toHaveLength(1);
  });
});

describe('normalizeRelative', () => {
  it('normalizes and rejects escapes', () => {
    expect(normalizeRelative('')).toBe('');
    expect(normalizeRelative('./')).toBe('');
    expect(normalizeRelative('packages\\host/')).toBe('packages/host');
    expect(normalizeRelative('a/../b')).toBe('b');
    expect(normalizeRelative('a/../../b')).toBeUndefined();
    expect(normalizeRelative('C:\\x')).toBeUndefined();
  });
});
