// 按文件暂存与提交（0.67.0，`git.status` / `git.stage` / `git.unstage` / `git.commit`，Host 功能 `git_commit`，ADR-0009）。
//
// - 读状态用 git-diff.ts 的 safeConfig（不执行仓库配置里的命令），整个仓库的索引都看：目录是子目录时，目录外暂存的内容也列出来
//   （`outside`），因为提交会把它们一起带上。
// - 写操作只由用户发起：带上读状态时的 HEAD 与索引指纹（`expected`），同一个索引上的写操作在 Host 里排队，排到时先核对，不同就回
//   GIT_STATE_CHANGED。暂存只 `git add` 用户点的那几个文件，用用户平常的配置（过滤器照常，暂存的内容与终端里 `git add` 的相同）。
// - “谁暂存的”记在内存里：索引文件 → 仓库内路径 → 经 Wevir 暂存时的条目（模式与 blob）。索引里的条目与记下的不同、或根本没记，就是
//   `external`；提交要用户明确勾选才带上它们。Host 重启后记录丢失，之前暂存的都算 `external`（宁可多问一次）。
// - 提交见 commit.ts：钩子、签名照常，失败时不回滚。

import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CodeState,
  GitCommitOutcome,
  GitExpectedState,
  GitFileSide,
  GitStatusFile,
  GitStatusResult,
  GitVerificationSummary,
  VerificationRun,
} from '@wevir/protocol';
import { GIT_STATUS_MAX_FILES } from '@wevir/protocol';
import { HostError } from '../errors.js';
import {
  emptyTree,
  isSafeRelativePath,
  parseNumstat,
  type RepoInfo,
  repoInfo,
  runGit,
} from '../git-diff.js';
import { readCodeState, sameCodeState } from '../verification/code-state.js';
import { COMMIT_TIMEOUT_MS, diagnoseCommit, runCommit } from './commit.js';

/** 读状态时最多数这么多未跟踪文件。 */
const UNTRACKED_MAX_FILES = 10_000;
/** 读状态期间索引变了时重读几次。 */
const STATUS_ATTEMPTS = 3;

/** 一个会话的检查与它最近的验证记录（验证记录的代码状态与现在比）。 */
export interface GitVerificationSource {
  checks: readonly { id: string; name: string }[];
  runs: readonly VerificationRun[];
}

export interface GitServiceOptions {
  /** 会话的检查与验证记录；没有验证功能或没给会话时省略。 */
  verification?: (sessionId: string) => Promise<GitVerificationSource | undefined>;
  commitTimeoutMs?: number;
}

export interface GitCommitInput {
  message: string;
  expected: GitExpectedState;
  includeExternal?: boolean;
}

/** 仓库与这个目录在仓库里的位置。 */
interface Repo extends RepoInfo {
  /** 目录相对仓库根目录的前缀（`sub/dir/`，根目录是空字符串）。 */
  prefix: string;
  /** 索引文件（worktree 各有一份）。 */
  indexPath: string;
  gitDir: string;
}

/** 索引里的一个条目：`模式 blob`；冲突的路径另记。 */
interface IndexRead {
  token: string;
  entries: Map<string, string>;
  conflicted: Set<string>;
}

interface RepoState {
  repo: Repo;
  head: string | null;
  index: IndexRead;
  files: GitStatusFile[];
  stagedTree?: string;
  operation?: string;
}

const NOT_REPO: GitStatusResult = { repo: false };
const DELETED = 'deleted';

export class GitService {
  readonly #options: GitServiceOptions;
  /** 索引文件 → 仓库内路径 → 经 Wevir 暂存的条目（`模式 blob`，删除是 `deleted`）。 */
  readonly #staged = new Map<string, Map<string, string>>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: GitServiceOptions = {}) {
    this.#options = options;
  }

  async status(dir: string, sessionId?: string): Promise<GitStatusResult> {
    const repo = await openRepo(dir);
    if (!repo) return NOT_REPO;
    try {
      return await this.#statusOf(repo, sessionId);
    } catch {
      return NOT_REPO;
    }
  }

  stage(
    dir: string,
    paths: readonly string[],
    expected: GitExpectedState,
    sessionId?: string,
  ): Promise<GitStatusResult> {
    return this.#write(dir, paths, expected, sessionId, async (repo, state, relative) => {
      await runGit(
        repo.cwd,
        ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
        {
          stdin: `${relative.join('\0')}\0`,
          timeoutMs: COMMIT_TIMEOUT_MS,
        },
      ).catch((error) => {
        throw gitFailure(['paths'], error);
      });
      const after = await readIndex(repo);
      const ledger = this.#ledger(repo);
      for (const path of relative.map((path) => repo.prefix + path)) {
        const entry = after.entries.get(path);
        if (entry !== undefined) ledger.set(path, entry);
        else if (state.head !== null) ledger.set(path, DELETED);
        else ledger.delete(path);
      }
    });
  }

  unstage(
    dir: string,
    paths: readonly string[],
    expected: GitExpectedState,
    sessionId?: string,
  ): Promise<GitStatusResult> {
    return this.#write(dir, paths, expected, sessionId, async (repo, state, relative) => {
      const args =
        state.head === null ? ['rm', '--cached', '-r', '-q', '--ignore-unmatch'] : ['reset', '-q'];
      await runGit(
        repo.cwd,
        ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
        { stdin: `${relative.join('\0')}\0`, timeoutMs: COMMIT_TIMEOUT_MS },
      ).catch((error) => {
        throw gitFailure(['paths'], error);
      });
      const ledger = this.#ledger(repo);
      for (const path of relative) ledger.delete(repo.prefix + path);
    });
  }

  async commit(
    dir: string,
    input: GitCommitInput,
    sessionId?: string,
  ): Promise<{ outcome: GitCommitOutcome; status: GitStatusResult }> {
    const repo = await openRepo(dir);
    if (!repo) throw new HostError('INVALID_PARAMS', 'not a git repository', notRepoIssue());
    return this.#exclusive(repo.indexPath, async () => {
      const state = await readState(repo, this.#ledger(repo));
      assertExpected(state, input.expected);
      const refuse = (reason: string, output?: string) => ({
        kind: 'failed' as const,
        reason,
        ...(output !== undefined && { output }),
      });
      const staged = state.files.filter((file) => file.staged !== undefined);
      const external = staged.filter((file) => file.staged?.by === 'external');
      let outcome: GitCommitOutcome | undefined;
      if (state.operation !== undefined) outcome = refuse('operation_in_progress');
      else if (state.index.conflicted.size > 0) outcome = refuse('unmerged');
      else if (staged.length === 0) outcome = refuse('nothing_staged');
      else if (input.message.trim() === '') outcome = refuse('empty_message');
      else if (external.length > 0 && input.includeExternal !== true) {
        outcome = refuse('external_staged', external.map((file) => file.path).join('\n'));
      }
      if (outcome === undefined) outcome = await this.#runCommit(repo, state, input.message);
      return { outcome, status: await this.#statusOf(repo, sessionId) };
    });
  }

  async #runCommit(repo: Repo, state: RepoState, message: string): Promise<GitCommitOutcome> {
    const run = await runCommit(repo.cwd, message, this.#options.commitTimeoutMs);
    const hooks = run.hooks.map((hook) => hook.name);
    if (run.exitCode !== 0) {
      const { reason, hook } = diagnoseCommit(run);
      return {
        kind: 'failed',
        reason,
        ...(hook !== undefined && { hook }),
        exitCode: run.exitCode,
        ...(run.output !== '' && { output: run.output }),
      };
    }
    // 提交成功：经 Wevir 暂存的都提交了，记录清掉；之后再暂存的另算。
    this.#staged.delete(repo.indexPath);
    const [line, tree] = await Promise.all([
      gitText(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']),
      gitText(repo, ['rev-parse', 'HEAD^{tree}']),
    ]);
    const [commit, parent] = line.trim().split(' ') as [string, string | undefined];
    const treeId = tree.trim();
    const stagedTree = state.stagedTree ?? treeId;
    return {
      kind: 'committed',
      commit,
      parent: parent ?? null,
      tree: treeId,
      stagedTree,
      ...(treeId !== stagedTree && { treeChanged: true as const }),
      ...(hooks.length > 0 && { hooks }),
    };
  }

  /** 暂存与取消暂存：核对 `expected`，路径要在目录里、不能有冲突。 */
  async #write(
    dir: string,
    paths: readonly string[],
    expected: GitExpectedState,
    sessionId: string | undefined,
    apply: (repo: Repo, state: RepoState, relative: string[]) => Promise<void>,
  ): Promise<GitStatusResult> {
    paths.forEach((path, index) => {
      if (!isSafeRelativePath(path)) {
        throw new HostError('INVALID_PARAMS', 'paths must be relative paths inside the directory', {
          issues: [{ path: ['paths', index], message: 'not a relative path inside the directory' }],
        });
      }
    });
    const repo = await openRepo(dir);
    if (!repo) throw new HostError('INVALID_PARAMS', 'not a git repository', notRepoIssue());
    const relative = [...new Set(paths)];
    return this.#exclusive(repo.indexPath, async () => {
      const state = await readState(repo, this.#ledger(repo));
      assertExpected(state, expected);
      const conflicted = relative.filter((path) => state.index.conflicted.has(repo.prefix + path));
      if (conflicted.length > 0) {
        throw new HostError('INVALID_PARAMS', `conflicted: ${conflicted.join(', ')}`, {
          issues: [{ path: ['paths'], message: 'resolve the conflict in a terminal first' }],
        });
      }
      await apply(repo, state, relative);
      return this.#statusOf(repo, sessionId);
    });
  }

  async #statusOf(repo: Repo, sessionId: string | undefined): Promise<GitStatusResult> {
    const [state, codeState] = await Promise.all([
      readState(repo, this.#ledger(repo)),
      readCodeState(repo.cwd),
    ]);
    const verification =
      sessionId === undefined ? undefined : await this.#options.verification?.(sessionId);
    const files = state.files.slice(0, GIT_STATUS_MAX_FILES);
    return {
      repo: true,
      head: state.head,
      ...(repo.branch !== undefined && { branch: repo.branch }),
      index: state.index.token,
      files,
      fileCount: state.files.length,
      ...(state.files.length > files.length && { truncated: true as const }),
      ...(state.stagedTree !== undefined && { stagedTree: state.stagedTree }),
      codeState,
      ...(state.operation !== undefined && { operation: state.operation }),
      ...(verification !== undefined && {
        verification: summarize(verification, codeState, state),
      }),
    };
  }

  #ledger(repo: Repo): Map<string, string> {
    let ledger = this.#staged.get(repo.indexPath);
    if (!ledger) {
      ledger = new Map();
      this.#staged.set(repo.indexPath, ledger);
    }
    return ledger;
  }

  /** 同一个索引上的写操作排队（Host 内）；别的进程照样能改，所以排到时还要核对 `expected`。 */
  #exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    const settled = next.catch(() => {});
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return next;
  }
}

// ── 读仓库 ─────────────────────────────────────────────────────────────

async function openRepo(dir: string): Promise<Repo | undefined> {
  const info = await repoInfo(dir);
  if (!info) return undefined;
  try {
    const [prefix, indexPath, gitDir] = await Promise.all([
      gitText(info, ['rev-parse', '--show-prefix']),
      gitText(info, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
      gitText(info, ['rev-parse', '--absolute-git-dir']),
    ]);
    return {
      ...info,
      prefix: prefix.replace(/\n$/, ''),
      indexPath: indexPath.trim(),
      gitDir: gitDir.trim(),
    };
  } catch {
    return undefined;
  }
}

async function gitText(repo: RepoInfo, args: readonly string[], cwd = repo.cwd): Promise<string> {
  return (await runGit(cwd, [...repo.config, ...args])).stdout.toString('utf8');
}

/** 索引的条目与指纹（整个仓库）。 */
async function readIndex(repo: Repo): Promise<IndexRead> {
  const { stdout } = await runGit(repo.toplevel, [...repo.config, 'ls-files', '--stage', '-z']);
  const token = createHash('sha256').update(stdout).digest('hex');
  const entries = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const record of stdout.toString('utf8').split('\0')) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s.exec(record);
    if (!match) continue;
    const [, mode, blob, stage, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (stage === '0') entries.set(path, `${mode} ${blob}`);
    else conflicted.add(path);
  }
  return { token, entries, conflicted };
}

/** HEAD、索引与文件的状态；读的期间索引变了就重读。 */
async function readState(repo: Repo, ledger: Map<string, string>): Promise<RepoState> {
  for (let attempt = 1; ; attempt += 1) {
    const index = await readIndex(repo);
    const head = await readHead(repo);
    const files = await readFiles(repo, head, index, ledger);
    const [stagedTree, operation, again] = await Promise.all([
      index.conflicted.size > 0 ? undefined : writeStagedTree(repo),
      readOperation(repo),
      readIndex(repo),
    ]);
    if (again.token === index.token || attempt >= STATUS_ATTEMPTS) {
      return {
        repo,
        head,
        index,
        files,
        ...(stagedTree !== undefined && { stagedTree }),
        ...(operation !== undefined && { operation }),
      };
    }
  }
}

async function readHead(repo: Repo): Promise<string | null> {
  const result = await runGit(
    repo.cwd,
    [...repo.config, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    { okCodes: [0, 1] },
  );
  const head = result.code === 0 ? result.stdout.toString('utf8').trim() : '';
  return head === '' ? null : head;
}

const STATUS_NAMES: Record<string, string> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'type_changed',
  U: 'conflicted',
};

const DIFF_ARGS = ['--no-renames', '--no-ext-diff', '--no-textconv', '-z'];

/** 一段 diff 的每个文件：状态与增删行数（仓库内路径）。 */
async function readSide(repo: Repo, revs: readonly string[]): Promise<Map<string, GitFileSide>> {
  const [names, numstat] = await Promise.all([
    gitText(repo, ['diff', '--name-status', ...DIFF_ARGS, ...revs, '--'], repo.toplevel),
    gitText(repo, ['diff', '--numstat', ...DIFF_ARGS, ...revs, '--'], repo.toplevel),
  ]);
  const sides = new Map<string, GitFileSide>();
  const parts = names.split('\0');
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const letter = (parts[index] as string).charAt(0);
    const path = parts[index + 1] as string;
    if (path !== '') sides.set(path, { status: STATUS_NAMES[letter] ?? 'modified' });
  }
  for (const entry of parseNumstat(numstat)) {
    const side = sides.get(entry.path);
    if (!side) continue;
    if (entry.added !== undefined) side.added = entry.added;
    if (entry.removed !== undefined) side.removed = entry.removed;
  }
  return sides;
}

async function readFiles(
  repo: Repo,
  head: string | null,
  index: IndexRead,
  ledger: Map<string, string>,
): Promise<GitStatusFile[]> {
  const base = head ?? (await emptyTree(repo));
  const [staged, unstaged, untracked] = await Promise.all([
    readSide(repo, ['--cached', base]),
    readSide(repo, []),
    gitText(repo, ['ls-files', '--others', '--exclude-standard', '-z'], repo.toplevel),
  ]);
  const paths = new Set([...staged.keys(), ...unstaged.keys(), ...index.conflicted]);
  const others = untracked
    .split('\0')
    .filter((path) => path !== '')
    .slice(0, UNTRACKED_MAX_FILES);
  for (const path of others) paths.add(path);
  const untrackedSet = new Set(others);

  // 记下的与索引里的不同（之后又被别处改过、取消过）就不再算经 Wevir 暂存的。
  for (const [path, entry] of ledger) {
    if ((index.entries.get(path) ?? DELETED) !== entry) ledger.delete(path);
  }
  const files: GitStatusFile[] = [];
  for (const path of [...paths].sort()) {
    const inside = path.startsWith(repo.prefix);
    const stagedSide = index.conflicted.has(path) ? undefined : staged.get(path);
    const unstagedSide = untrackedSet.has(path) ? { status: 'untracked' } : unstaged.get(path);
    const conflicted = index.conflicted.has(path);
    if (!inside && stagedSide === undefined && !conflicted) continue;
    files.push({
      path: inside ? path.slice(repo.prefix.length) : path,
      ...(stagedSide !== undefined && {
        staged: { ...stagedSide, by: ledger.has(path) ? 'wevir' : 'external' },
      }),
      ...(unstagedSide !== undefined && !conflicted && { unstaged: unstagedSide }),
      ...(conflicted && { conflicted: true as const }),
      ...(!inside && { outside: true as const }),
    });
  }
  return files;
}

/** 暂存区写成的树：在索引的副本上 `write-tree`（它会往索引里写 cache-tree，不碰用户的索引）。 */
async function writeStagedTree(repo: Repo): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'wevir-staged-'));
  try {
    const indexFile = join(dir, 'index');
    const exists = await stat(repo.indexPath).catch(() => undefined);
    const env = { GIT_INDEX_FILE: indexFile };
    if (exists) await copyFile(repo.indexPath, indexFile);
    else await runGit(repo.toplevel, [...repo.config, 'read-tree', '--empty'], { env });
    const tree = await runGit(
      repo.toplevel,
      [...repo.config, '-c', 'core.splitIndex=false', 'write-tree'],
      { env },
    );
    const id = tree.stdout.toString('utf8').trim();
    return id === '' ? undefined : id;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 进行中的合并、变基、拣选、还原（看 git 目录里的标记文件）。 */
async function readOperation(repo: Repo): Promise<string | undefined> {
  const marks: [string, string][] = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry_pick'],
    ['REVERT_HEAD', 'revert'],
  ];
  for (const [name, operation] of marks) {
    if (await stat(join(repo.gitDir, name)).catch(() => undefined)) return operation;
  }
  return undefined;
}

function assertExpected(state: RepoState, expected: GitExpectedState): void {
  if (state.head === expected.head && state.index.token === expected.index) return;
  throw new HostError('GIT_STATE_CHANGED', 'the repository changed since its status was read', {
    head: state.head,
    index: state.index.token,
  });
}

/**
 * 每项检查最近的一条记录：代码状态与现在相同时是它的状态，不同时（或绑不上代码状态）是 `stale`，没有记录是 `not_run`。排队中、
 * 运行中、取消与未运行的照原样。
 */
export function summarize(
  source: GitVerificationSource,
  codeState: CodeState,
  state: Pick<RepoState, 'head' | 'stagedTree'>,
): GitVerificationSummary {
  const finalStatuses = new Set(['passed', 'failed', 'timed_out', 'environment_unavailable']);
  const checks = source.checks.map((check) => {
    let latest: VerificationRun | undefined;
    for (const run of source.runs) {
      if (run.checkId !== check.id) continue;
      if (!latest || runTime(run) >= runTime(latest)) latest = run;
    }
    if (!latest)
      return {
        checkId: check.id as VerificationRun['checkId'],
        name: check.name,
        status: 'not_run' as const,
      };
    const status =
      finalStatuses.has(latest.status) && sameCodeState(latest.codeState, codeState) !== true
        ? ('stale' as const)
        : latest.status;
    return {
      checkId: latest.checkId,
      name: check.name,
      status,
      runId: latest.id,
      ...(latest.finishedAt !== undefined && { finishedAt: latest.finishedAt }),
    };
  });
  return {
    checks,
    stagedMatchesWorkingTree:
      codeState.kind === 'git' &&
      state.stagedTree !== undefined &&
      codeState.head === state.head &&
      codeState.tree === state.stagedTree,
  };
}

function runTime(run: VerificationRun): string {
  return run.finishedAt ?? run.startedAt ?? run.queuedAt;
}

function notRepoIssue() {
  return { issues: [{ path: [] as string[], message: 'not a git repository' }] };
}

/** `git add` / `reset` 失败（路径被忽略、不存在等）：参数问题，带上 git 的说明。 */
function gitFailure(path: string[], error: unknown): HostError {
  const detail =
    error instanceof Error &&
    'stderr' in error &&
    typeof error.stderr === 'string' &&
    error.stderr !== ''
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return new HostError('INVALID_PARAMS', detail, { issues: [{ path, message: detail }] });
}
