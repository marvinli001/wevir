// 会话在本地 checkout 与 worktree 之间换目录（0.81.0，`session.move`，Host 功能 `session_move`，domain-model §3.36）：照 Codex 的
// handoff_thread。这里只管 git：先把原处现在的样子（HEAD 加没提交的改动与没被忽略的未跟踪文件）写成一个提交、挂在原仓库的
// `refs/wevir/move/<会话 ID>/<ID>` 上留着找回，再把改动搬到新目录、原处回到 HEAD；每一步都能撤回（换引擎失败时 SessionManager 调
// `rollback`）。引擎的事在 SessionManager。所有 git 命令照 git-diff.ts 屏蔽仓库配置里会执行命令的设置。

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { CAPTURE_TIMEOUT_MS, captureBlocker, captureCheckpoint } from './checkpoints.js';
import { GitError, type RepoInfo, repoInfo, runGit, safeConfig } from './git-diff.js';
import { type CreatedWorktree, createWorktree, restoreSnapshot } from './git-worktree.js';

export const MOVE_REF_PREFIX = 'refs/wevir/move';
/** 一次移动里每条 git 命令的时限。 */
const MOVE_TIMEOUT_MS = 60_000;

/** 移动不了的原因：`state` 回 `INVALID_STATE`，其余回 `INVALID_PARAMS`。 */
export class MoveError extends Error {
  constructor(
    readonly kind: 'params' | 'state',
    message: string,
  ) {
    super(message);
    this.name = 'MoveError';
  }
}

export interface PreparedMove {
  /** 新的 cwd。 */
  cwd: string;
  /** 新目录检出的分支；分离 HEAD 时没有。 */
  branch?: string;
  /** 移回本地之前本地 checkout 所在的分支。 */
  previousBranch?: string;
  /** 原处的快照。 */
  ref: string;
  /** 移进 worktree 时新开（或重开）的 worktree。 */
  worktree?: CreatedWorktree;
  /** 撤回已经做的 git 操作（尽力而为，不抛错）。 */
  rollback: () => Promise<void>;
}

function errorText(error: unknown): string {
  if (error instanceof GitError && error.stderr !== undefined && error.stderr.trim() !== '') {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function gitIn(repo: RepoInfo, args: readonly string[], okCodes?: number[]) {
  return runGit(repo.toplevel, [...repo.config, ...args], {
    timeoutMs: MOVE_TIMEOUT_MS,
    ...(okCodes !== undefined && { okCodes }),
  });
}

async function commonDir(repo: RepoInfo): Promise<string> {
  const result = await gitIn(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return result.stdout.toString('utf8').trim();
}

/** 仓库的顶层（不是 `dir` 所在的子目录）；不是仓库、还没有提交时抛 `MoveError`。 */
async function topOf(dir: string, label: string): Promise<RepoInfo> {
  const inner = await repoInfo(dir);
  if (inner === undefined) throw new MoveError('params', `${label} is not in a git repository`);
  const top = inner.toplevel === inner.cwd ? inner : await repoInfo(inner.toplevel);
  if (top === undefined) throw new MoveError('params', `${label} is not in a git repository`);
  if (top.head === undefined) throw new MoveError('params', `${label} has no commits yet`);
  return top;
}

/** 把 `repo` 现在的样子写成提交挂在 `ref` 上；返回提交与里面有没有没提交的改动。 */
async function snapshot(
  repo: RepoInfo,
  ref: string,
  sessionId: string,
): Promise<{ commit: string; dirty: boolean }> {
  const blocker = await captureBlocker(repo, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)).catch(
    () => 'capture_failed',
  );
  if (blocker !== undefined) {
    throw new MoveError('state', `cannot snapshot ${repo.toplevel} (${blocker})`);
  }
  const commit = await captureCheckpoint(repo, {
    ref,
    signal: AbortSignal.timeout(MOVE_TIMEOUT_MS),
    message: async () => `Wevir session move\n\nsession ${sessionId}\n`,
  });
  const trees = await gitIn(repo, ['rev-parse', `${commit}^{tree}`, `${repo.head}^{tree}`]);
  const [tree, headTree] = trees.stdout.toString('utf8').trim().split('\n');
  return { commit, dirty: tree !== headTree };
}

/** 工作树回到 HEAD：跟踪文件还原，没被忽略的未跟踪文件删掉（被忽略的留着）。 */
async function cleanToHead(repo: RepoInfo): Promise<void> {
  await gitIn(repo, ['reset', '--hard', '--quiet']);
  await gitIn(repo, ['clean', '-fd', '--quiet']);
}

async function isClean(repo: RepoInfo): Promise<boolean> {
  const status = await gitIn(repo, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  return status.stdout.length === 0;
}

async function branchExists(repo: RepoInfo, branch: string): Promise<boolean> {
  const found = await gitIn(
    repo,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    [0, 1],
  );
  return found.code === 0;
}

async function freeBranch(repo: RepoInfo, base: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!(await branchExists(repo, name))) return name;
  }
}

async function removeWorktreeDir(repo: RepoInfo, root: string): Promise<void> {
  await gitIn(repo, ['worktree', 'remove', '--force', root]).catch(() => {});
  await rm(root, { recursive: true, force: true });
  await gitIn(repo, ['worktree', 'prune']).catch(() => {});
}

// ── 移进 worktree ───────────────────────────────────────────────

export interface ToWorktreeOptions {
  sessionId: string;
  /** 会话现在的目录（项目目录，可以是仓库的子目录）。 */
  cwd: string;
  /** `<worktreesDir>/<会话 ID>`。 */
  dir: string;
  /** worktree 目录名开头的序号。 */
  index: number;
  /** 新分支名（已被占时加 `-2`、`-3`）。 */
  branch: string;
  /** 上一次移回本地时本地换到的分支与之前的分支：本地还在那个分支上时，worktree 重开那个分支、本地换回之前的分支。 */
  roundTrip?: { branch: string; previousBranch: string };
  /** 快照 ref 的最后一段。 */
  refId: string;
}

/**
 * 从项目目录移进 worktree：原处打快照；本地还在上一次移回本地时换到的分支上时，本地清回 HEAD、换回之前的分支，worktree 重开那个分支；
 * 否则从 HEAD 开新分支的 worktree、原处清回 HEAD。快照里有改动时放进 worktree（没提交的照旧没提交）。
 */
export async function prepareToWorktree(options: ToWorktreeOptions): Promise<PreparedMove> {
  const local = await topOf(options.cwd, "the session's folder");
  const ref = `${MOVE_REF_PREFIX}/${options.sessionId}/${options.refId}`;
  const { commit, dirty } = await snapshot(local, ref, options.sessionId);
  const head = local.head as string;
  const tree = `${commit}^{tree}`;
  const roundTrip =
    options.roundTrip !== undefined &&
    local.branch === options.roundTrip.branch &&
    (await branchExists(local, options.roundTrip.previousBranch))
      ? options.roundTrip
      : undefined;

  const done: (() => Promise<void>)[] = [];
  const rollback = async () => {
    for (const step of done.reverse()) await step().catch(() => {});
  };
  try {
    let worktree: CreatedWorktree;
    if (roundTrip !== undefined) {
      await cleanToHead(local);
      done.push(async () => {
        await gitIn(local, ['checkout', '--quiet', roundTrip.branch]);
        if (dirty) await restoreSnapshot(local.toplevel, tree);
      });
      await gitIn(local, ['checkout', '--quiet', roundTrip.previousBranch]);
      const root = join(options.dir, `${options.index}-${basename(local.toplevel)}`);
      await gitIn(local, ['worktree', 'prune']).catch(() => {});
      await gitIn(local, ['worktree', 'add', '--quiet', root, roundTrip.branch]);
      worktree = {
        root,
        path: join(root, relative(local.toplevel, options.cwd)),
        branch: roundTrip.branch,
        repo: local.toplevel,
      };
      done.push(() => removeWorktreeDir(local, root));
    } else {
      const branch = await freeBranch(local, options.branch);
      worktree = await createWorktree({
        workspaceRoot: options.cwd,
        dir: options.dir,
        index: options.index,
        branch,
        commit: head,
      });
      done.push(async () => {
        await removeWorktreeDir(local, worktree.root);
        await gitIn(local, ['branch', '-D', branch]).catch(() => {});
      });
    }
    if (dirty) await restoreSnapshot(worktree.root, tree);
    if (roundTrip === undefined && dirty) {
      done.push(() => restoreSnapshot(local.toplevel, tree));
      await cleanToHead(local);
    }
    return {
      cwd: worktree.path,
      branch: worktree.branch,
      ref,
      worktree,
      rollback,
    };
  } catch (error) {
    await rollback();
    if (error instanceof MoveError) throw error;
    throw new MoveError('state', `cannot move the session into a worktree: ${errorText(error)}`);
  }
}

// ── 移回本地 ─────────────────────────────────────────────────────

export interface ToLocalOptions {
  sessionId: string;
  /** 会话现在的目录（worktree 里，可以是子目录）。 */
  cwd: string;
  /** worktree 的根目录。 */
  root: string;
  /** 项目目录（本地 checkout，可以是仓库的子目录）。 */
  localDir: string;
  refId: string;
}

/**
 * 从 Host 开的 worktree 移回项目目录：本地 checkout 要是干净的、和 worktree 是同一个仓库。worktree 打快照；本地先分离到 worktree 的
 * HEAD、放进改动，再删 worktree，最后本地挂到 worktree 的分支上（分离 HEAD 时照旧分离）。
 */
export async function prepareToLocal(options: ToLocalOptions): Promise<PreparedMove> {
  const worktree = await topOf(options.root, "the session's worktree");
  const local = await topOf(options.localDir, 'the project folder');
  if ((await commonDir(worktree)) !== (await commonDir(local))) {
    throw new MoveError('params', 'the worktree is not a worktree of the project repository');
  }
  if (!(await isClean(local))) {
    throw new MoveError(
      'state',
      'the project folder has uncommitted changes; commit or stash them first',
    );
  }
  const ref = `${MOVE_REF_PREFIX}/${options.sessionId}/${options.refId}`;
  const { commit, dirty } = await snapshot(worktree, ref, options.sessionId);
  const tree = `${commit}^{tree}`;
  const head = worktree.head as string;
  const previous = local.branch ?? (local.head as string);

  const done: (() => Promise<void>)[] = [];
  const rollback = async () => {
    for (const step of done.reverse()) await step().catch(() => {});
  };
  try {
    done.push(async () => {
      await cleanToHead(local);
      await gitIn(local, [
        'checkout',
        '--quiet',
        ...(local.branch === undefined ? ['--detach'] : []),
        previous,
      ]);
    });
    await gitIn(local, ['checkout', '--quiet', '--detach', head]);
    if (dirty) await restoreSnapshot(local.toplevel, tree);
    done.push(async () => {
      await gitIn(local, ['worktree', 'prune']).catch(() => {});
      await gitIn(local, [
        'worktree',
        'add',
        '--quiet',
        ...(worktree.branch === undefined
          ? ['--detach', options.root, head]
          : [options.root, worktree.branch]),
      ]);
      if (dirty) await restoreSnapshot(options.root, tree);
    });
    await removeWorktreeDir(local, options.root);
    if (existsSync(options.root)) throw new MoveError('state', `cannot remove ${options.root}`);
    if (worktree.branch !== undefined) {
      done.push(() => gitIn(local, ['checkout', '--quiet', '--detach', head]).then(() => {}));
      await gitIn(local, ['symbolic-ref', 'HEAD', `refs/heads/${worktree.branch}`]);
    }
    return {
      cwd: join(local.toplevel, relative(options.root, options.cwd)),
      ...(worktree.branch !== undefined && { branch: worktree.branch }),
      ...(local.branch !== undefined && { previousBranch: local.branch }),
      ref,
      rollback,
    };
  } catch (error) {
    await rollback();
    if (error instanceof MoveError) throw error;
    throw new MoveError(
      'state',
      `cannot move the session back to the project folder: ${errorText(error)}`,
    );
  }
}

/** 删掉一家会话的移动快照（`session.delete`）；`dir` 是项目目录。读不了仓库时什么都不做。 */
export async function dropMoveRefs(dir: string, sessionIds: readonly string[]): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const config = await safeConfig(dir);
    for (const sessionId of sessionIds) {
      const { stdout } = await runGit(dir, [
        ...config,
        'for-each-ref',
        '--format=%(refname)',
        `${MOVE_REF_PREFIX}/${sessionId}/`,
      ]);
      const refs = stdout
        .toString('utf8')
        .split('\n')
        .filter((ref) => ref !== '');
      if (refs.length === 0) continue;
      await runGit(dir, [...config, 'update-ref', '--stdin'], {
        stdin: refs.map((ref) => `delete ${ref}\n`).join(''),
      });
    }
  } catch {
    // 尽力而为：ref 留着只占对象库。
  }
}
