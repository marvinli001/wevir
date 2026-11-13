import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { sha256 } from './crypto.js';
import {
  captureWorkspaceTree,
  restoreWorkspaceTree,
  validateWorkspacePaths,
  workspaceGit,
  workspaceLayers,
} from './workspace-git.js';

const temp = useTempDir();
async function repo() {
  const cwd = await mkdtemp(join(temp(), 'source-'));
  await workspaceGit(cwd, ['init', '--template=', '--initial-branch=main']);
  await writeFile(join(cwd, 'mixed.txt'), 'base\n');
  await writeFile(join(cwd, 'remove.txt'), 'removed\n');
  await writeFile(join(cwd, 'old.txt'), 'renamed\n');
  await writeFile(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(cwd, '.env'), 'SYNTHETIC_EXCLUDED=1\n');
  await workspaceGit(cwd, ['add', '.']);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@localhost',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'synthetic base',
    ],
    { cwd, stdio: 'ignore' },
  );
  return cwd;
}
const metadata = (captured: Awaited<ReturnType<typeof captureWorkspaceTree>>) => ({
  schema: 'wevir-workspace-snapshot/1' as const,
  projectId: 'project_fixture',
  source: {
    hostId: 'host_fixture',
    deviceId: 'device_fixture',
    sessionId: 'ses_fixture' as const,
    streamId: 'stream_fixture',
  },
  throughSeq: 1,
  sourceHead: captured.sourceHead,
  base: 'bounded-tree' as const,
  statusHash: captured.statusHash,
  selectedUntracked: ['selected.txt'],
  ruleVersions: [],
  capturedAt: '2026-11-13T00:00:00.000Z',
});

describe('workspace snapshots preserve Git layers without execution', () => {
  it('restores staged, unstaged, selected untracked, deletion, rename and binary without the source base', async () => {
    const source = await repo();
    await writeFile(join(source, 'mixed.txt'), 'staged\n');
    await rename(join(source, 'old.txt'), join(source, 'new.txt'));
    await rm(join(source, 'remove.txt'));
    await writeFile(join(source, 'binary.bin'), Buffer.from([0, 3, 128, 255]));
    await workspaceGit(source, ['add', '-A']);
    await writeFile(join(source, 'mixed.txt'), 'working\n');
    await writeFile(join(source, 'selected.txt'), 'selected\n');
    await writeFile(join(source, 'omitted.txt'), 'not selected\n');
    await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'node_modules/excluded.txt'), 'excluded\n');
    const captured = await captureWorkspaceTree(source, ['selected.txt']);
    expect(captured.exclusions).toEqual(['.env']);
    expect(captured.files.some((file) => /env|node_modules|omitted/.test(file.path))).toBe(false);
    const target = await mkdtemp(join(temp(), 'target-'));
    const restored = await restoreWorkspaceTree(target, captured.files, metadata(captured));
    expect(restored.requiresTrust).toEqual([]);
    expect(await readFile(join(target, 'mixed.txt'), 'utf8')).toBe('working\n');
    expect((await workspaceGit(target, ['show', ':mixed.txt'])).toString()).toBe('staged\n');
    expect((await workspaceGit(target, ['show', 'HEAD:mixed.txt'])).toString()).toBe('base\n');
    expect(await readFile(join(target, 'selected.txt'), 'utf8')).toBe('selected\n');
    await expect(readFile(join(target, 'omitted.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(target, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(target, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, 'binary.bin'))).toEqual(Buffer.from([0, 3, 128, 255]));
    expect(
      (await workspaceGit(target, ['diff', '--cached', '--name-status', '-M'])).toString(),
    ).toContain('R100\told.txt\tnew.txt');
    expect((await workspaceGit(target, ['diff', '--name-only'])).toString()).toBe('mixed.txt\n');
  });

  it('never invokes source filters/fsmonitor or restored hooks and marks executable configuration for approval', async () => {
    const source = await repo(),
      marker = join(temp(), 'executed');
    const script = join(temp(), 'forbidden.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    await chmod(script, 0o700);
    execFileSync('git', ['config', 'filter.forbidden.clean', script], { cwd: source });
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: source });
    await writeFile(join(source, '.gitattributes'), '*.txt filter=forbidden\n');
    await mkdir(join(source, '.claude'));
    await writeFile(
      join(source, '.claude/settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: script }] } }),
    );
    const captured = await captureWorkspaceTree(source, [
      '.gitattributes',
      '.claude/settings.json',
    ]);
    const target = await mkdtemp(join(temp(), 'target-'));
    const restored = await restoreWorkspaceTree(target, captured.files, {
      ...metadata(captured),
      selectedUntracked: ['.gitattributes', '.claude/settings.json'],
    });
    expect(restored.requiresTrust).toEqual(['.claude/settings.json', '.gitattributes']);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed files during capture and unselected/unsafe/symlink/case-colliding content', async () => {
    const source = await repo();
    let guards = 0;
    await expect(
      captureWorkspaceTree(source, [], () => {
        if (++guards === 10)
          execFileSync('git', ['update-index', '--force-remove', 'mixed.txt'], { cwd: source });
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    for (const path of [
      '../escape',
      '/absolute',
      '.git/config',
      'a/../../escape',
      'C:/path',
      'nul.txt',
      'trailing.',
    ])
      expect(() => validateWorkspacePaths([path])).toThrow();
    expect(() => validateWorkspacePaths(['case.txt', 'CASE.txt'])).toThrow();
    expect(() => validateWorkspacePaths(['Case/first.txt', 'case/second.txt'])).toThrow();
    expect(() => validateWorkspacePaths(['file', 'file/child'])).toThrow();
    await symlink(join(source, 'binary.bin'), join(source, 'link'));
    await expect(captureWorkspaceTree(source, ['link'])).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    await expect(captureWorkspaceTree(source, ['missing.txt'])).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    const file = {
      path: 'worktree/unsafe',
      bytes: Buffer.from('safe'),
      sha256: sha256('different'),
      executable: false,
    };
    expect(() => workspaceLayers([file])).toThrow();
  });
});
