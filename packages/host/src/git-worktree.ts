// 环境会话的 worktree（0.15.0，U22.1，domain-model §3.10）：在工作区所在的 git 仓库里新开一个 worktree 与分支，会话用其中对应
// 工作区的目录。不在不受信任的仓库里执行仓库配置里的命令（钩子照样会跑：post-checkout 是仓库自己的，git 不提供关掉的开关，
// 用 core.hooksPath 指向空目录绕开）。

import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

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
