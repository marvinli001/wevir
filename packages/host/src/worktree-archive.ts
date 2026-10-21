// 归档时的 worktree 快照与恢复（0.81.0，Host 功能 `worktree_archive`，domain-model §3.36）：照 Codex 的 archive_worktree /
// restore_worktree。归档一个会话时，Host 把它（连同子会话）开的每个 worktree 现在的样子（HEAD 加上没提交的改动与没被忽略的未跟踪
// 文件，checkpoints.ts 的 captureCheckpoint）写成一个提交，挂在原仓库的 `refs/wevir/worktree-archive/<会话 ID>/<序号>` 上，然后删掉
// worktree 目录（分支留着）；取消归档或恢复会话时在原来的路径重开 worktree、把快照的文件放回去。快照的记录在
// `<worktreesDir>/<会话 ID>/archive.json`。所有 git 命令照 git-diff.ts 屏蔽仓库配置里会执行命令的设置。

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SessionWorktreeArchive, WorktreeArchiveReason } from '@wevir/protocol';
import { CAPTURE_TIMEOUT_MS, captureBlocker, captureCheckpoint } from './checkpoints.js';
import { GitError, repoInfo, runGit, safeConfig } from './git-diff.js';
import { restoreSnapshot } from './git-worktree.js';

export const WORKTREE_ARCHIVE_REF_PREFIX = 'refs/wevir/worktree-archive';
/** 记录快照的文件，在 `<worktreesDir>/<会话 ID>/` 下。 */
export const ARCHIVE_MANIFEST = 'archive.json';
/** 归档一个 worktree（判断、快照、删除）与恢复一个 worktree 的时限。 */
export const WORKTREE_ARCHIVE_TIMEOUT_MS = 60_000;

/** 一个已经归档（目录已删）的 worktree。 */
export interface ArchivedWorktree {
  /** worktree 的根目录（恢复时还开在这里）。 */
  root: string;
  workspaceId: string;
  /** 会话记录里的分支名。 */
  branch: string;
  /** 归档时 worktree 检出的分支；分离 HEAD 时没有。 */
  checkedOut?: string;
  /** 原仓库的 git 目录（`--git-common-dir`）。 */
  commonDir: string;
  /** 归档时的 HEAD。 */
  head: string;
  /** 快照提交（父提交是 `head`）。 */
  snapshot: string;
  ref: string;
  /** 快照里有没提交的改动（快照的树与 HEAD 的树不同）。 */
  dirty: boolean;
  archivedAt: string;
}

interface Manifest {
  version: 1;
  worktrees: ArchivedWorktree[];
}

/** 会话的一个 worktree 根目录（session-delete.ts 的 `worktreeRoots`）。 */
export interface WorktreeRootRef {
  sessionId: string;
  workspaceId: string;
  branch: string;
  root: string;
}

function manifestPath(worktreesDir: string, sessionId: string): string {
  return join(worktreesDir, sessionId, ARCHIVE_MANIFEST);
}

/** 读一个会话的快照记录；没有或读不了时是空的。 */
export async function readArchived(
  worktreesDir: string,
  sessionId: string,
): Promise<ArchivedWorktree[]> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(worktreesDir, sessionId), 'utf8')) as
      | Partial<Manifest>
      | undefined;
    return Array.isArray(parsed?.worktrees) ? parsed.worktrees : [];
  } catch {
    return [];
  }
}

async function writeArchived(
  worktreesDir: string,
  sessionId: string,
  worktrees: readonly ArchivedWorktree[],
): Promise<void> {
  const path = manifestPath(worktreesDir, sessionId);
  if (worktrees.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(worktreesDir, sessionId), { recursive: true });
  const manifest: Manifest = { version: 1, worktrees: [...worktrees] };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

/** 快照的 ref：根目录名开头的序号（`<序号>-<仓库目录名>`），认不出时用它在会话里的位置。 */
function archiveRef(sessionId: string, root: string, fallback: number): string {
  const index = /^(\d+)-/.exec(basename(root))?.[1] ?? String(fallback);
  return `${WORKTREE_ARCHIVE_REF_PREFIX}/${sessionId}/${index}`;
}

function outcome(
  worktree: Pick<WorktreeRootRef, 'workspaceId' | 'branch' | 'root'>,
  status: SessionWorktreeArchive['status'],
  extra: { reason?: WorktreeArchiveReason; ref?: string; message?: string } = {},
): SessionWorktreeArchive {
  return {
    workspaceId: worktree.workspaceId as SessionWorktreeArchive['workspaceId'],
    branch: worktree.branch,
    path: worktree.root,
    status,
    ...(extra.reason !== undefined && { reason: extra.reason }),
    ...(extra.ref !== undefined && { ref: extra.ref }),
    ...(extra.message !== undefined && { message: extra.message.slice(0, 500) }),
  };
}

/** git 的原文：GitError 带 stderr 时用它。 */
function errorText(error: unknown): string {
  if (error instanceof GitError && error.stderr !== undefined && error.stderr.trim() !== '') {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/** worktree 的原仓库的 git 目录；读不了时 undefined。 */
async function commonDirOf(root: string, config: readonly string[]): Promise<string | undefined> {
  try {
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

// ── 归档 ─────────────────────────────────────────────────────────

/**
 * 归档一个会话的一家的 worktree（会话已关闭）：每个还在的 worktree 打快照、记下、删目录。打不了快照（不是仓库了、sparse checkout、
 * 未跟踪文件太多或太大、git 出错）的留着不动（`kept`）。已经归档过的（目录不在、记录里有）照旧是 `archived`。
 */
export async function archiveWorktrees(
  worktreesDir: string,
  roots: readonly WorktreeRootRef[],
  now: string,
): Promise<SessionWorktreeArchive[]> {
  const results: SessionWorktreeArchive[] = [];
  const bySession = new Map<string, WorktreeRootRef[]>();
  for (const root of roots)
    bySession.set(root.sessionId, [...(bySession.get(root.sessionId) ?? []), root]);
  for (const [sessionId, members] of bySession) {
    const archived = await readArchived(worktreesDir, sessionId);
    for (const [index, worktree] of members.entries()) {
      const previous = archived.find((entry) => entry.root === worktree.root);
      if (!existsSync(worktree.root)) {
        results.push(
          previous !== undefined
            ? outcome(worktree, 'archived', { ref: previous.ref })
            : outcome(worktree, 'missing'),
        );
        continue;
      }
      const result = await archiveOne(sessionId, worktree, index + 1, now);
      if ('entry' in result) {
        // 先记下再删目录：中途出错时目录还在，下次恢复看到目录在就只清掉这条记录。
        const next = [...archived.filter((entry) => entry.root !== worktree.root), result.entry];
        archived.splice(0, archived.length, ...next);
        await writeArchived(worktreesDir, sessionId, archived);
        await removeWorktreeDir(result.entry.commonDir, worktree.root);
        results.push(outcome(worktree, 'archived', { ref: result.entry.ref }));
      } else {
        results.push(result.outcome);
      }
    }
  }
  return results;
}

async function archiveOne(
  sessionId: string,
  worktree: WorktreeRootRef,
  fallback: number,
  now: string,
): Promise<{ entry: ArchivedWorktree } | { outcome: SessionWorktreeArchive }> {
  const keep = (reason: WorktreeArchiveReason, message?: string) => ({
    outcome: outcome(worktree, 'kept', { reason, ...(message !== undefined && { message }) }),
  });
  const repo = await repoInfo(worktree.root);
  if (repo === undefined || repo.toplevel !== repo.cwd) return keep('not_a_repository');
  if (repo.head === undefined) return keep('no_commits');
  const commonDir = await commonDirOf(repo.cwd, repo.config);
  if (commonDir === undefined) return keep('repository_missing');
  const signal = AbortSignal.timeout(WORKTREE_ARCHIVE_TIMEOUT_MS);
  try {
    const blocker = await captureBlocker(repo, AbortSignal.timeout(CAPTURE_TIMEOUT_MS));
    if (blocker !== undefined) return keep(blocker as WorktreeArchiveReason);
    const ref = archiveRef(sessionId, worktree.root, fallback);
    const snapshot = await captureCheckpoint(repo, {
      ref,
      signal,
      message: async () =>
        `Wevir worktree archive\n\nsession ${sessionId}\nbranch ${worktree.branch}\n`,
    });
    const trees = await runGit(repo.cwd, [
      ...repo.config,
      'rev-parse',
      `${snapshot}^{tree}`,
      `${repo.head}^{tree}`,
    ]);
    const [snapshotTree, headTree] = trees.stdout.toString('utf8').trim().split('\n');
    return {
      entry: {
        root: worktree.root,
        workspaceId: worktree.workspaceId,
        branch: worktree.branch,
        ...(repo.branch !== undefined && { checkedOut: repo.branch }),
        commonDir,
        head: repo.head,
        snapshot,
        ref,
        dirty: snapshotTree !== headTree,
        archivedAt: now,
      },
    };
  } catch (error) {
    return keep('git_error', errorText(error));
  }
}

/** 在原仓库里 `worktree remove --force` 与 `prune`，再删目录（分支不动）。 */
async function removeWorktreeDir(commonDir: string, root: string): Promise<void> {
  const config = await safeConfig(commonDir).catch(() => undefined);
  if (config !== undefined) {
    await runGit(commonDir, [...config, 'worktree', 'remove', '--force', root]).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
  if (config !== undefined) {
    await runGit(commonDir, [...config, 'worktree', 'prune']).catch(() => {});
  }
}

// ── 恢复 ─────────────────────────────────────────────────────────

/**
 * 恢复一个会话的一家归档时删掉的 worktree：在原来的路径重开（检出归档时的分支；分支不在了从归档时的 HEAD 重建），分支没动过时把快照
 * 的文件放回去（没提交的改动照旧是没提交的、新文件是未跟踪的；暂存区不恢复）。分支之后有了新提交时只检出分支，快照留在 ref 上
 * （`restored`，`reason: 'branch_moved'`）。恢复不了的（原仓库不在、分支在别处检出、路径被占）记录与 ref 都留着，下次再试。
 */
export async function restoreWorktrees(
  worktreesDir: string,
  sessionIds: readonly string[],
): Promise<SessionWorktreeArchive[]> {
  const results: SessionWorktreeArchive[] = [];
  for (const sessionId of sessionIds) {
    const archived = await readArchived(worktreesDir, sessionId);
    if (archived.length === 0) continue;
    const left: ArchivedWorktree[] = [];
    for (const entry of archived) {
      const result = await restoreOne(entry);
      results.push(result);
      if (result.status === 'failed') left.push(entry);
    }
    await writeArchived(worktreesDir, sessionId, left);
  }
  return results;
}

async function restoreOne(entry: ArchivedWorktree): Promise<SessionWorktreeArchive> {
  const fail = (reason: WorktreeArchiveReason, message?: string) =>
    outcome(entry, 'failed', {
      reason,
      ref: entry.ref,
      ...(message !== undefined && { message }),
    });
  if (existsSync(entry.root)) {
    // 目录已经在（用户自己恢复了，或归档中途出错没删掉）：只清掉记录。
    return outcome(entry, 'restored', { reason: 'path_exists', ref: entry.ref });
  }
  if (!existsSync(entry.commonDir)) return fail('repository_missing');
  let config: string[];
  try {
    config = await safeConfig(entry.commonDir);
  } catch (error) {
    return fail('repository_missing', errorText(error));
  }
  const git = (args: readonly string[], okCodes?: number[]) =>
    runGit(entry.commonDir, [...config, ...args], {
      timeoutMs: WORKTREE_ARCHIVE_TIMEOUT_MS,
      ...(okCodes !== undefined && { okCodes }),
    });
  const exists = await git(['cat-file', '-e', `${entry.snapshot}^{commit}`], [0, 1, 128]).catch(
    () => undefined,
  );
  if (exists?.code !== 0) return fail('snapshot_missing');

  await git(['worktree', 'prune']).catch(() => {});
  let tip: string | undefined;
  if (entry.checkedOut !== undefined) {
    const found = await git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${entry.checkedOut}^{commit}`],
      [0, 1],
    ).catch(() => undefined);
    if (found?.code === 0) tip = found.stdout.toString('utf8').trim();
  }
  const add =
    entry.checkedOut === undefined
      ? ['worktree', 'add', '--detach', entry.root, entry.head]
      : tip === undefined
        ? ['worktree', 'add', '-b', entry.checkedOut, entry.root, entry.head]
        : ['worktree', 'add', entry.root, entry.checkedOut];
  try {
    await git(add);
  } catch (error) {
    await rm(entry.root, { recursive: true, force: true }).catch(() => {});
    await git(['worktree', 'prune']).catch(() => {});
    const message = errorText(error);
    return fail(
      /already (checked out|used by worktree)/i.test(message) ? 'branch_checked_out' : 'git_error',
      message,
    );
  }
  if (tip !== undefined && tip !== entry.head) {
    return outcome(entry, 'restored', { reason: 'branch_moved', ref: entry.ref });
  }
  try {
    if (entry.dirty) await restoreSnapshot(entry.root, `${entry.snapshot}^{tree}`);
  } catch (error) {
    return outcome(entry, 'restored', {
      reason: 'git_error',
      ref: entry.ref,
      message: errorText(error),
    });
  }
  await git(['update-ref', '-d', entry.ref]).catch(() => {});
  return outcome(entry, 'restored');
}

// ── 删除会话时 ───────────────────────────────────────────────────

/**
 * 删除会话时处理归档的 worktree（目录已不在）：删快照的 ref，分支用 `branch -d` 删（没合并的 git 不删，返回在 `keptBranches`）。原
 * 仓库不在时什么都不做。
 */
export async function dropArchived(
  worktreesDir: string,
  sessionIds: readonly string[],
): Promise<{ keptBranches: string[] }> {
  const keptBranches: string[] = [];
  for (const sessionId of sessionIds) {
    for (const entry of await readArchived(worktreesDir, sessionId)) {
      if (existsSync(entry.root) || !existsSync(entry.commonDir)) continue;
      const config = await safeConfig(entry.commonDir).catch(() => undefined);
      if (config === undefined) continue;
      await runGit(entry.commonDir, [...config, 'update-ref', '-d', entry.ref]).catch(() => {});
      const branch = entry.checkedOut ?? entry.branch;
      const found = await runGit(
        entry.commonDir,
        [...config, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { okCodes: [0, 1] },
      ).catch(() => undefined);
      if (found?.code !== 0) continue;
      const deleted = await runGit(entry.commonDir, [...config, 'branch', '-d', branch], {
        okCodes: [0, 1],
      }).catch(() => undefined);
      if (deleted?.code !== 0) keptBranches.push(branch);
    }
  }
  return { keptBranches };
}

/** 删掉一个会话留在 worktree 的原仓库里的快照 ref（恢复后分支动过、留着的那些）；读不了仓库时什么都不做。 */
export async function dropArchiveRefs(root: string, sessionId: string): Promise<void> {
  if (!existsSync(root)) return;
  try {
    const config = await safeConfig(root);
    const commonDir = await commonDirOf(root, config);
    if (commonDir === undefined) return;
    const { stdout } = await runGit(commonDir, [
      ...config,
      'for-each-ref',
      '--format=%(refname)',
      `${WORKTREE_ARCHIVE_REF_PREFIX}/${sessionId}/`,
    ]);
    const refs = stdout
      .toString('utf8')
      .split('\n')
      .filter((ref) => ref !== '');
    if (refs.length === 0) return;
    await runGit(commonDir, [...config, 'update-ref', '--stdin'], {
      stdin: refs.map((ref) => `delete ${ref}\n`).join(''),
    });
  } catch {
    // 尽力而为：ref 留着只占对象库。
  }
}
