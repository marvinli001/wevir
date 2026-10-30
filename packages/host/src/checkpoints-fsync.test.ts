import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINT_REF_PREFIX,
  canRetryFullFsync,
  captureCheckpoint,
  durableWriteConfig,
  workingTreeHash,
} from './checkpoints.js';
import { GitError, repoInfo, runGit } from './git-diff.js';
import { useTempDir } from './test-utils.js';

vi.mock('./git-diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-diff.js')>();
  return { ...actual, runGit: vi.fn(actual.runGit) };
});

const tempDir = useTempDir();
const run = vi.mocked(runGit);

afterEach(() => {
  run.mockClear();
});

function repo(): string {
  const root = realpathSync(tempDir());
  const sh = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  writeFileSync(join(root, 'a.txt'), 'two\n');
  return root;
}

/** 某条 git 子命令的参数（跳过它前面的 `-c` 设置）。 */
function callsOf(command: string): string[][] {
  return run.mock.calls
    .map(([, args]) => [...args])
    .filter((args) => args.some((arg, index) => arg === command && args[index - 1] !== '-c'));
}

describe('快照落盘', () => {
  it('fsync 写在 batch 前；batch 只在 macOS 与 Windows 上用', () => {
    const base = ['-c', 'core.fsync=objects,reference', '-c', 'core.fsyncMethod=fsync'];
    expect(durableWriteConfig('linux')).toEqual(base);
    expect(durableWriteConfig('darwin')).toEqual([...base, '-c', 'core.fsyncMethod=batch']);
    expect(durableWriteConfig('win32')).toEqual([...base, '-c', 'core.fsyncMethod=batch']);
  });

  it('F_FULLFSYNC 不受支持与写 ref 的锁文件失败时可以重试，别的错误不行', () => {
    expect(
      canRetryFullFsync("error: fsync error on '.git/objects/pack/tmp_x': Operation not supported"),
    ).toBe(true);
    expect(
      canRetryFullFsync(
        "fatal: cannot update ref 'refs/wevir/x': couldn't write '/r/.git/refs/wevir/x.lock'\r",
      ),
    ).toBe(true);
    expect(canRetryFullFsync("error: fsync error on 'x': Input/output error")).toBe(false);
    expect(canRetryFullFsync('fatal: unable to write new index file')).toBe(false);
  });

  it('打快照的命令带落盘设置，git 认得；算树散列的不带', async () => {
    const dir = repo();
    const info = await repoInfo(dir);
    if (!info) throw new Error('not a repo');
    const ref = `${CHECKPOINT_REF_PREFIX}/s/t/before`;
    const commit = await captureCheckpoint(info, {
      ref,
      signal: new AbortController().signal,
      message: async () => 'm',
    });
    const resolved = await runGit(dir, ['rev-parse', ref]);
    expect(resolved.stdout.toString('utf8').trim()).toBe(commit);
    const durable = durableWriteConfig();
    for (const command of ['add', 'write-tree', 'commit-tree', 'update-ref']) {
      const [args] = callsOf(command);
      expect(args, command).toBeDefined();
      const index = (args ?? []).indexOf(command);
      expect(args?.slice(index - durable.length, index), command).toEqual(durable);
    }

    run.mockClear();
    await workingTreeHash(info, new AbortController().signal);
    expect(callsOf('write-tree')).toHaveLength(1);
    expect(callsOf('write-tree')[0]).not.toContain('core.fsync=objects,reference');
  });

  it.runIf(process.platform === 'darwin')(
    'macOS 上 F_FULLFSYNC 不受支持时改用 writeout-only 重试一次',
    async () => {
      const dir = repo();
      const info = await repoInfo(dir);
      if (!info) throw new Error('not a repo');
      const actual = run.getMockImplementation();
      if (!actual) throw new Error('no implementation');
      run.mockImplementation((cwd, args, options) =>
        args.includes('update-ref') && args.includes('core.fsyncMethod=fsync')
          ? Promise.reject(
              new GitError(
                'git update-ref exited with 128',
                128,
                "error: fsync error on '.git/refs/wevir/s/t/before.lock': Operation not supported",
              ),
            )
          : actual(cwd, args, options),
      );
      try {
        const ref = `${CHECKPOINT_REF_PREFIX}/s/t/before`;
        const commit = await captureCheckpoint(info, {
          ref,
          signal: new AbortController().signal,
          message: async () => 'm',
        });
        const updates = callsOf('update-ref');
        expect(updates).toHaveLength(2);
        expect(updates[1]).toContain('core.fsyncMethod=writeout-only');
        expect(updates[1]).not.toContain('core.fsyncMethod=fsync');
        expect(updates[1]).not.toContain('core.fsyncMethod=batch');
        expect((await actual(dir, ['rev-parse', ref])).stdout.toString('utf8').trim()).toBe(commit);
      } finally {
        run.mockImplementation(actual);
      }
    },
  );
});
