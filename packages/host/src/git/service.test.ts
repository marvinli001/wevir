// 暂存与提交（0.67.0，`git.*`）：对着真实的 git 在临时目录里建仓库。HOME 换成空目录，不读维护者的全局配置（签名、钩子目录）。

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CodeState,
  type GitExpectedState,
  type GitStatusResult,
  MethodSchemas,
  type VerificationRun,
} from '@wevir/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHostError } from '../errors.js';
import { readStaged, readUncommitted } from '../git-diff.js';
import { useTempDir } from '../test-utils.js';
import { readCodeState } from '../verification/code-state.js';
import { parseTrace2 } from './commit.js';
import { GitService, type GitVerificationSource, summarize } from './service.js';

const tempDir = useTempDir();

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'EMAIL']) saved[key] = process.env[key];
  const home = join(execFileSync('mktemp', ['-d']).toString().trim());
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  delete process.env.EMAIL;
});
afterAll(() => {
  const home = process.env.HOME;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

/** 外部进程（终端、别的工具）跑的 git。 */
function sh(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function write(dir: string, path: string, text: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** 有一次提交的仓库：a.txt、b.txt、sub/c.txt；身份写在仓库自己的配置里。 */
function repo(options: { commit?: boolean } = {}): string {
  const dir = join(tempDir(), 'repo');
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Tester');
  sh(dir, 'config', 'user.email', 'tester@example.com');
  write(dir, 'a.txt', 'a1\n');
  write(dir, 'b.txt', 'b1\n');
  write(dir, 'sub/c.txt', 'c1\n');
  if (options.commit !== false) {
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

function hook(dir: string, name: string, script: string) {
  const path = join(dir, '.git', 'hooks', name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

const expectedOf = (status: GitStatusResult): GitExpectedState => ({
  head: status.head ?? null,
  index: status.index as string,
});

const fileOf = (status: GitStatusResult, path: string) =>
  status.files?.find((file) => file.path === path);

const head = (dir: string) => sh(dir, 'rev-parse', 'HEAD').trim();

const validStatus = (status: unknown) =>
  expect(MethodSchemas['git.status'].result.safeParse(status).error?.issues).toBeUndefined();

async function stateChanged(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(isHostError(error, 'GIT_STATE_CHANGED')).toBe(true);
  return error as { data: GitExpectedState };
}

describe('git.status', () => {
  it('不是仓库时是 repo: false', async () => {
    expect(await new GitService().status(tempDir())).toEqual({ repo: false });
  });

  it('列出暂存、未暂存与未跟踪；之前就暂存的标 external；读状态不碰索引', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    sh(dir, 'add', 'b.txt');
    write(dir, 'new.txt', 'n\n');
    const indexBefore = readFileSync(join(dir, '.git', 'index'));

    const status = await new GitService().status(dir);
    validStatus(status);
    expect(status.head).toBe(head(dir));
    expect(status.branch).toBe('main');
    expect(fileOf(status, 'a.txt')).toEqual({
      path: 'a.txt',
      unstaged: { status: 'modified', added: 1, removed: 1 },
    });
    expect(fileOf(status, 'b.txt')).toEqual({
      path: 'b.txt',
      staged: { status: 'modified', added: 1, removed: 1, by: 'external' },
    });
    expect(fileOf(status, 'new.txt')).toEqual({
      path: 'new.txt',
      unstaged: { status: 'untracked' },
    });
    expect(readFileSync(join(dir, '.git', 'index'))).toEqual(indexBefore);
    expect(status.stagedTree).toBe(sh(dir, 'write-tree').trim());
  });

  it('目录是子目录时，目录外暂存的内容也列出来（outside），路径相对仓库根目录', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    sh(dir, 'add', 'a.txt');
    write(dir, 'sub/c.txt', 'c2\n');
    const status = await new GitService().status(join(dir, 'sub'));
    expect(status.files).toEqual([
      {
        path: 'a.txt',
        staged: { status: 'modified', added: 1, removed: 1, by: 'external' },
        outside: true,
      },
      { path: 'c.txt', unstaged: { status: 'modified', added: 1, removed: 1 } },
    ]);
  });

  it('进行中的合并与冲突', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'other');
    write(dir, 'a.txt', 'other\n');
    sh(dir, 'commit', '-q', '-am', 'other');
    sh(dir, 'checkout', '-q', 'main');
    write(dir, 'a.txt', 'main\n');
    sh(dir, 'commit', '-q', '-am', 'main');
    expect(() => sh(dir, 'merge', '-q', 'other')).toThrow();
    const git = new GitService();
    const status = await git.status(dir);
    validStatus(status);
    expect(status.operation).toBe('merge');
    expect(fileOf(status, 'a.txt')).toEqual({ path: 'a.txt', conflicted: true });
    expect(status.stagedTree).toBeUndefined();
    const stage = git.stage(dir, ['a.txt'], expectedOf(status));
    await expect(stage).rejects.toThrow(/conflicted/);
    const commit = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(commit.outcome).toEqual({ kind: 'failed', reason: 'operation_in_progress' });
  });
});

describe('git.stage / git.unstage', () => {
  it('只暂存点的文件，标 wevir；取消暂存放回 HEAD；staged diff 与列表一致', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    rmSync(join(dir, 'sub', 'c.txt'));
    write(dir, 'new.txt', 'n\n');
    const git = new GitService();
    let status = await git.status(dir);
    status = await git.stage(dir, ['a.txt', 'sub/c.txt', 'new.txt'], expectedOf(status));
    validStatus(status);
    expect(fileOf(status, 'a.txt')?.staged?.by).toBe('wevir');
    expect(fileOf(status, 'sub/c.txt')?.staged).toEqual({
      status: 'deleted',
      added: 0,
      removed: 1,
      by: 'wevir',
    });
    expect(fileOf(status, 'new.txt')?.staged?.status).toBe('added');
    expect(fileOf(status, 'b.txt')).toEqual({
      path: 'b.txt',
      unstaged: { status: 'modified', added: 1, removed: 1 },
    });

    const staged = await readStaged(dir);
    expect(staged.base).toBe(status.head);
    expect(staged.files?.map((file) => file.path).sort()).toEqual([
      'a.txt',
      'new.txt',
      'sub/c.txt',
    ]);
    expect(staged.patch).toContain('+a2');
    expect(staged.patch).not.toContain('b2');

    status = await git.unstage(dir, ['a.txt', 'sub/c.txt'], expectedOf(status));
    expect(fileOf(status, 'a.txt')).toEqual({
      path: 'a.txt',
      unstaged: { status: 'modified', added: 1, removed: 1 },
    });
    expect(fileOf(status, 'sub/c.txt')?.unstaged?.status).toBe('deleted');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a2\n');
  });

  it('还没有提交的仓库：暂存、取消暂存、首个提交', async () => {
    const dir = repo({ commit: false });
    const git = new GitService();
    let status = await git.status(dir);
    expect(status.head).toBeNull();
    status = await git.stage(dir, ['a.txt', 'b.txt'], expectedOf(status));
    status = await git.unstage(dir, ['b.txt'], expectedOf(status));
    expect(fileOf(status, 'a.txt')?.staged).toEqual({
      status: 'added',
      added: 1,
      removed: 0,
      by: 'wevir',
    });
    expect(fileOf(status, 'b.txt')).toEqual({ path: 'b.txt', unstaged: { status: 'untracked' } });
    const staged = await readStaged(dir);
    expect(staged.files?.map((file) => file.path)).toEqual(['a.txt']);

    const { outcome } = await git.commit(dir, { message: 'first', expected: expectedOf(status) });
    expect(outcome).toMatchObject({ kind: 'committed', parent: null, commit: head(dir) });
    expect(sh(dir, 'ls-tree', '--name-only', 'HEAD').trim()).toBe('a.txt');
  });

  it('不在目录里的路径、被忽略的文件', async () => {
    const dir = repo();
    write(dir, '.gitignore', 'ignored.log\n');
    write(dir, 'ignored.log', 'x\n');
    const git = new GitService();
    const status = await git.status(dir);
    await expect(git.stage(dir, ['../x'], expectedOf(status))).rejects.toThrow(/relative paths/);
    await expect(git.stage(dir, ['ignored.log'], expectedOf(status))).rejects.toThrow(/ignored/);
  });

  it('别的进程在读状态之后改了索引：GIT_STATE_CHANGED，带现在的 HEAD 与索引，什么都没动', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    const git = new GitService();
    const status = await git.status(dir);
    sh(dir, 'add', 'b.txt');
    const error = await stateChanged(git.stage(dir, ['a.txt'], expectedOf(status)));
    const now = await git.status(dir);
    expect(error.data).toEqual(expectedOf(now));
    expect(fileOf(now, 'a.txt')?.staged).toBeUndefined();
  });
});

describe('git.commit', () => {
  it('只提交暂存的；提交的树就是暂存的树，父提交是读状态时的 HEAD', async () => {
    const dir = repo();
    const before = head(dir);
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    const git = new GitService();
    let status = await git.status(dir);
    status = await git.stage(dir, ['a.txt'], expectedOf(status));
    const stagedTree = status.stagedTree;
    const result = await git.commit(dir, {
      message: 'Change a\n\nBody.',
      expected: expectedOf(status),
    });
    expect(MethodSchemas['git.commit'].result.safeParse(result).error).toBeUndefined();
    expect(result.outcome).toEqual({
      kind: 'committed',
      commit: head(dir),
      parent: before,
      tree: stagedTree,
      stagedTree,
    });
    expect(sh(dir, 'log', '-1', '--format=%B').trim()).toBe('Change a\n\nBody.');
    expect(result.status.head).toBe(head(dir));
    expect(fileOf(result.status, 'b.txt')?.unstaged?.status).toBe('modified');
    expect(fileOf(result.status, 'a.txt')).toBeUndefined();
  });

  it('之前就暂存的内容不跟着提交，除非明确带上；带上之后一起提交', async () => {
    const dir = repo();
    const before = head(dir);
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    sh(dir, 'add', 'b.txt');
    const git = new GitService();
    let status = await git.status(dir);
    status = await git.stage(dir, ['a.txt'], expectedOf(status));
    const indexBefore = status.index;

    const refused = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(refused.outcome).toEqual({ kind: 'failed', reason: 'external_staged', output: 'b.txt' });
    expect(head(dir)).toBe(before);
    expect(refused.status.index).toBe(indexBefore);

    // 在 Wevir 里点一下“暂存”也算认下了这个文件。
    const adopted = await git.stage(dir, ['b.txt'], expectedOf(status));
    expect(fileOf(adopted, 'b.txt')?.staged?.by).toBe('wevir');
    await git.unstage(dir, ['b.txt'], expectedOf(adopted));
    sh(dir, 'add', 'b.txt');
    status = await git.status(dir);
    expect(fileOf(status, 'b.txt')?.staged?.by).toBe('external');

    const result = await git.commit(dir, {
      message: 'both',
      expected: expectedOf(status),
      includeExternal: true,
    });
    expect(result.outcome.kind).toBe('committed');
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });

  it('读状态之后别的进程又暂存了：GIT_STATE_CHANGED，HEAD 不变', async () => {
    const dir = repo();
    const before = head(dir);
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    sh(dir, 'add', 'b.txt');
    await stateChanged(git.commit(dir, { message: 'x', expected: expectedOf(status) }));
    expect(head(dir)).toBe(before);
  });

  it('并行会话共用一个目录：别处重新暂存过的文件算 external；同时的两次写操作，第二次按过时的状态被拒', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    const git = new GitService();
    const first = await git.status(dir, 'ses_A');
    const [one, two] = await Promise.allSettled([
      git.stage(dir, ['a.txt'], expectedOf(first), 'ses_A'),
      git.stage(dir, ['b.txt'], expectedOf(first), 'ses_B'),
    ]);
    // 谁先排到不一定（两次都要先找仓库），但只有一次成功，另一次按过时的状态被拒。
    const outcomes = [one, two].map((result) =>
      result.status === 'fulfilled' ? 'ok' : isHostError(result.reason, 'GIT_STATE_CHANGED'),
    );
    expect(outcomes.sort()).toEqual(['ok', true].sort());

    // 另一个会话的 Agent 改了 a.txt，在终端里又 git add 了一次：内容不再是 Wevir 暂存的那份。
    write(dir, 'a.txt', 'a3\n');
    sh(dir, 'add', 'a.txt');
    let status = await git.status(dir, 'ses_B');
    expect(fileOf(status, 'a.txt')?.staged?.by).toBe('external');
    status = await git.stage(dir, ['b.txt'], expectedOf(status), 'ses_B');
    const refused = await git.commit(dir, { message: 'x', expected: expectedOf(status) }, 'ses_B');
    expect(refused.outcome).toMatchObject({
      kind: 'failed',
      reason: 'external_staged',
      output: 'a.txt',
    });
  });

  it('同一仓库的两个 worktree 各有各的索引与记录', async () => {
    const dir = repo();
    const other = join(tempDir(), 'wt');
    sh(dir, 'worktree', 'add', '-q', '-b', 'side', other);
    write(dir, 'a.txt', 'main\n');
    write(other, 'a.txt', 'side\n');
    const git = new GitService();
    await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const sideStatus = await git.status(other);
    expect(fileOf(sideStatus, 'a.txt')).toEqual({
      path: 'a.txt',
      unstaged: { status: 'modified', added: 1, removed: 1 },
    });
    const committed = await git.commit(other, {
      message: 'nothing',
      expected: expectedOf(sideStatus),
    });
    expect(committed.outcome).toEqual({ kind: 'failed', reason: 'nothing_staged' });
  });

  it('pre-commit 钩子失败：HEAD 与索引不变，报出钩子名与输出', async () => {
    const dir = repo();
    const before = head(dir);
    hook(dir, 'pre-commit', 'echo "lint: a.txt is not formatted" >&2\nexit 3');
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(result.outcome).toMatchObject({
      kind: 'failed',
      reason: 'hook_failed',
      hook: 'pre-commit',
      exitCode: 1,
    });
    expect(result.outcome.kind === 'failed' && result.outcome.output).toContain('not formatted');
    expect(head(dir)).toBe(before);
    expect(result.status.index).toBe(status.index);
    expect(fileOf(result.status, 'a.txt')?.staged?.by).toBe('wevir');
  });

  it('commit-msg 钩子失败', async () => {
    const dir = repo();
    hook(
      dir,
      'commit-msg',
      'grep -q "^feat" "$1" || { echo "subject must start with feat" >&2; exit 1; }',
    );
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const result = await git.commit(dir, { message: 'fix a', expected: expectedOf(status) });
    expect(result.outcome).toMatchObject({
      kind: 'failed',
      reason: 'hook_failed',
      hook: 'commit-msg',
    });
    const ok = await git.commit(dir, { message: 'feat: a', expected: expectedOf(result.status) });
    expect(ok.outcome).toMatchObject({ kind: 'committed', hooks: ['commit-msg'] });
  });

  it('钩子改了暂存区：提交成功，标出提交的树与暂存的树不同', async () => {
    const dir = repo();
    hook(dir, 'pre-commit', 'echo formatted > a.txt && git add a.txt');
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(result.outcome).toMatchObject({
      kind: 'committed',
      stagedTree: status.stagedTree,
      treeChanged: true,
      hooks: ['pre-commit'],
    });
    expect(sh(dir, 'show', 'HEAD:a.txt')).toBe('formatted\n');
  });

  it('签名失败（gpg.program=false）：不跳过签名，HEAD 与索引不变', async () => {
    const dir = repo();
    const before = head(dir);
    sh(dir, 'config', 'commit.gpgSign', 'true');
    sh(dir, 'config', 'gpg.program', 'false');
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(result.outcome).toMatchObject({ kind: 'failed', reason: 'signing_failed' });
    expect(result.outcome.kind === 'failed' && result.outcome.output).toMatch(/gpg failed to sign/);
    expect(head(dir)).toBe(before);
    expect(result.status.index).toBe(status.index);
  });

  it('没有身份：identity_missing', async () => {
    const dir = repo();
    sh(dir, 'config', '--unset', 'user.email');
    sh(dir, 'config', '--unset', 'user.name');
    sh(dir, 'config', 'user.useConfigOnly', 'true');
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(result.outcome).toMatchObject({ kind: 'failed', reason: 'identity_missing' });
    expect(result.status.index).toBe(status.index);
  });

  it('索引被锁：index_locked，不删别人的锁', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService();
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(result.outcome).toMatchObject({ kind: 'failed', reason: 'index_locked' });
    expect(readFileSync(join(dir, '.git', 'index.lock'), 'utf8')).toBe('');
  });

  it('空说明、没有暂存的内容', async () => {
    const dir = repo();
    const git = new GitService();
    let status = await git.status(dir);
    expect((await git.commit(dir, { message: 'x', expected: expectedOf(status) })).outcome).toEqual(
      {
        kind: 'failed',
        reason: 'nothing_staged',
      },
    );
    write(dir, 'a.txt', 'a2\n');
    status = await git.stage(dir, ['a.txt'], expectedOf(status));
    expect(
      (await git.commit(dir, { message: ' \n', expected: expectedOf(status) })).outcome,
    ).toEqual({
      kind: 'failed',
      reason: 'empty_message',
    });
  });

  it('超时：停下 git 与钩子，报 timed_out', async () => {
    const dir = repo();
    const before = head(dir);
    hook(dir, 'pre-commit', 'sleep 30');
    write(dir, 'a.txt', 'a2\n');
    const git = new GitService({ commitTimeoutMs: 500 });
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)));
    const started = Date.now();
    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.outcome).toMatchObject({ kind: 'failed', reason: 'timed_out' });
    expect(head(dir)).toBe(before);
  });
});

describe('状态、diff、验证记录与提交指向同一版本', () => {
  const runOf = (checkId: string, codeState: CodeState, status: VerificationRun['status']) =>
    ({
      id: `vrn_${checkId.slice(4)}`,
      roundId: 'vrd_01JA2B3C4D5E6F7G8H9JKMNPQR',
      checkId,
      checkRevision: 1,
      name: checkId,
      command: 'true',
      cwd: '',
      kind: 'other',
      trigger: 'manual',
      status,
      codeState,
      queuedAt: '2026-10-20T00:00:00.000Z',
      finishedAt: '2026-10-20T00:00:01.000Z',
    }) as VerificationRun;

  it('全部暂存时，验证记录的代码状态就是要提交的树；提交后的树相同', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    const tests = 'chk_01JA2B3C4D5E6F7G8H9JKMNPQ1';
    const lint = 'chk_01JA2B3C4D5E6F7G8H9JKMNPQ2';
    const types = 'chk_01JA2B3C4D5E6F7G8H9JKMNPQ3';
    const verified = await readCodeState(dir);
    const old: CodeState = { kind: 'git', head: head(dir), tree: 'f'.repeat(40) };
    const source: GitVerificationSource = {
      checks: [
        { id: tests, name: 'Tests' },
        { id: lint, name: 'Lint' },
        { id: types, name: 'Types' },
      ],
      runs: [runOf(tests, verified, 'passed'), runOf(lint, old, 'failed')],
    };
    const git = new GitService({ verification: async () => source });
    let status = await git.status(dir, 'ses_A');
    status = await git.stage(dir, ['a.txt'], expectedOf(status), 'ses_A');
    validStatus(status);
    expect(status.codeState).toEqual(verified);
    expect(status.verification).toEqual({
      checks: [
        {
          checkId: tests,
          name: 'Tests',
          status: 'passed',
          runId: `vrn_${tests.slice(4)}`,
          finishedAt: '2026-10-20T00:00:01.000Z',
        },
        {
          checkId: lint,
          name: 'Lint',
          status: 'stale',
          runId: `vrn_${lint.slice(4)}`,
          finishedAt: '2026-10-20T00:00:01.000Z',
        },
        { checkId: types, name: 'Types', status: 'not_run' },
      ],
      stagedMatchesWorkingTree: true,
    });
    // 写批注、看暂存的 diff 用的基线就是这个 HEAD。
    expect((await readUncommitted(dir)).base).toBe(status.head);
    expect((await readStaged(dir)).base).toBe(status.head);

    const result = await git.commit(dir, { message: 'x', expected: expectedOf(status) }, 'ses_A');
    expect(result.outcome).toMatchObject({ kind: 'committed', tree: status.stagedTree });
    expect(verified.kind === 'git' && verified.tree).toBe(status.stagedTree);
    // 提交之后 HEAD 变了，同一份记录不再算这个代码状态的。
    expect(result.status.verification?.checks[0]?.status).toBe('stale');
  });

  it('还有没暂存的改动时，验证的是工作树，不是这次提交', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'b.txt', 'b2\n');
    const git = new GitService({ verification: async () => ({ checks: [], runs: [] }) });
    const status = await git.stage(dir, ['a.txt'], expectedOf(await git.status(dir)), 'ses_A');
    expect(status.verification).toEqual({ checks: [], stagedMatchesWorkingTree: false });
  });

  it('summarize：运行中与取消的照原样，绑不上代码状态的完成记录算过期', () => {
    const check = 'chk_01JA2B3C4D5E6F7G8H9JKMNPQ1';
    const none: CodeState = { kind: 'none', reason: 'not_git' };
    const summary = summarize(
      { checks: [{ id: check, name: 'x' }], runs: [runOf(check, none, 'passed')] },
      none,
      { head: null },
    );
    expect(summary.checks[0]?.status).toBe('stale');
    const running = summarize(
      { checks: [{ id: check, name: 'x' }], runs: [runOf(check, none, 'running')] },
      none,
      { head: null },
    );
    expect(running.checks[0]?.status).toBe('running');
  });
});

describe('parseTrace2', () => {
  it('只看最外层 git 的钩子；别的子进程失败另记', () => {
    const lines = [
      { event: 'version', sid: 'top' },
      {
        event: 'child_start',
        sid: 'top',
        child_id: 0,
        child_class: 'hook',
        hook_name: 'pre-commit',
      },
      {
        event: 'child_start',
        sid: 'top/inner',
        child_id: 0,
        child_class: 'hook',
        hook_name: 'post-x',
      },
      { event: 'child_exit', sid: 'top/inner', child_id: 0, code: 9 },
      { event: 'child_exit', sid: 'top', child_id: 0, code: 0 },
      { event: 'child_start', sid: 'top', child_id: 1, child_class: '?' },
      { event: 'child_exit', sid: 'top', child_id: 1, code: 2 },
    ];
    expect(
      parseTrace2(`${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`),
    ).toEqual({
      hooks: [{ name: 'pre-commit', code: 0 }],
      childFailed: true,
    });
  });
});
