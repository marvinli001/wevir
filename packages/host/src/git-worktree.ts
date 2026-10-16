// 环境会话的 worktree（0.15.0，U22.1，domain-model §3.10）：在工作区所在的 git 仓库里新开一个 worktree 与分支，会话用其中对应
// 工作区的目录。不在不受信任的仓库里执行仓库配置里的命令（钩子照样会跑：post-checkout 是仓库自己的，git 不提供关掉的开关，
// 用 core.hooksPath 指向空目录绕开）。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { runGit, safeConfig } from './git-diff.js';

const TIMEOUT_MS = 30_000;

export interface CreatedWorktree {
  /** worktree 的根目录（仓库的顶层）。 */
  root: string;
  /** worktree 里对应工作区的目录（工作区是仓库的子目录时是子目录）。 */
  path: string;
  branch: string;
  /** 原仓库的顶层，删 worktree 时用。 */
  repo: string;
}

export class WorktreeError extends Error {}

function git(cwd: string, args: string[], emptyHooks: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${emptyHooks}`, ...args],
      {
        cwd,
        env: gitEnv(),
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        error ? reject(new WorktreeError((stderr || error.message).trim())) : resolve(stdout),
    );
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

/**
 * 在 `workspaceRoot` 所在的仓库里，从 HEAD 新开分支 `branch` 与 worktree `<dir>/<序号>-<仓库目录名>`。不是 git 仓库、还没有
 * 提交、分支已存在等都抛 `WorktreeError`（说明是 git 的原文）。
 */
export async function createWorktree(options: {
  workspaceRoot: string;
  dir: string;
  index: number;
  branch: string;
}): Promise<CreatedWorktree> {
  const emptyHooks = join(options.dir, '.no-hooks');
  mkdirSync(emptyHooks, { recursive: true });
  let repo: string;
  try {
    repo = (await git(options.workspaceRoot, ['rev-parse', '--show-toplevel'], emptyHooks)).trim();
  } catch {
    throw new WorktreeError(`${options.workspaceRoot} is not inside a git repository`);
  }
  const root = join(options.dir, `${options.index}-${basename(repo)}`);
  await git(repo, ['worktree', 'add', '-b', options.branch, root, 'HEAD'], emptyHooks);
  return {
    root,
    path: join(root, relative(repo, options.workspaceRoot)),
    branch: options.branch,
    repo,
  };
}

/** 建会话失败时撤回：删掉 worktree 与分支（尽力而为）。 */
export async function removeWorktree(created: CreatedWorktree, dir: string): Promise<void> {
  const emptyHooks = join(dir, '.no-hooks');
  await git(created.repo, ['worktree', 'remove', '--force', created.root], emptyHooks).catch(() =>
    rmSync(created.root, { recursive: true, force: true }),
  );
  await git(created.repo, ['worktree', 'prune'], emptyHooks).catch(() => {});
  await git(created.repo, ['branch', '-D', created.branch], emptyHooks).catch(() => {});
}

// ── 删除会话时的 worktree（0.43.0，domain-model §3.20）──────────────────────────
// 这些命令跑在 Host 开的 worktree 与它的原仓库里，照 git-diff.ts 屏蔽仓库配置里会执行命令的设置（过滤器、钩子、fsmonitor）。

/**
 * worktree 有没有没提交的改动：跟踪文件的修改或没被忽略的未跟踪文件（`git status --porcelain` 不空）。目录不在时 `missing`；
 * git 读不了（原仓库没了、不是 worktree）时也算有改动，要 `force` 才删。
 */
export async function worktreeState(root: string): Promise<'clean' | 'dirty' | 'missing'> {
  if (!existsSync(root)) return 'missing';
  try {
    const config = await safeConfig(root);
    const status = await runGit(
      root,
      [
        ...config,
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
        '--ignore-submodules=none',
      ],
      { maxBytes: 4096, overflow: 'truncate' },
    );
    return status.stdout.length > 0 ? 'dirty' : 'clean';
  } catch {
    return 'dirty';
  }
}

/**
 * 删掉会话的一个 worktree：在原仓库里 `worktree remove --force` 与 `worktree prune`，分支用 `branch -d` 删（没合并的 git 不删，
 * 返回 `branchKept`）；git 不行时（原仓库没了）直接删目录。之后目录一定不在。
 */
export async function deleteWorktree(
  root: string,
  branch: string,
): Promise<{ branchKept: boolean }> {
  const common = await gitCommonDir(root);
  const config = common === undefined ? undefined : await safeConfig(common).catch(() => undefined);
  if (common !== undefined && config !== undefined) {
    await runGit(common, [...config, 'worktree', 'remove', '--force', root]).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
  if (common === undefined || config === undefined) return { branchKept: false };
  await runGit(common, [...config, 'worktree', 'prune']).catch(() => {});
  const exists = await runGit(
    common,
    [...config, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { okCodes: [0, 1] },
  ).catch(() => undefined);
  if (exists?.code !== 0) return { branchKept: false };
  const deleted = await runGit(common, [...config, 'branch', '-d', branch], {
    okCodes: [0, 1],
  }).catch(() => undefined);
  return { branchKept: deleted?.code !== 0 };
}

/** worktree 的原仓库的 git 目录（`--git-common-dir`）；读不了时 undefined。 */
async function gitCommonDir(root: string): Promise<string | undefined> {
  if (!existsSync(root)) return undefined;
  try {
    const config = await safeConfig(root);
    const result = await runGit(root, [
      ...config,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const dir = result.stdout.toString('utf8').trim();
    return dir !== '' && existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}
