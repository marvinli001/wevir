// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/vcs/GitVcsDriver.ts、apps/server/src/orchestration-v2/CheckpointService.ts、apps/server/src/checkpointing/Diffs.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：取自 GitVcsDriver.ts 的 captureCheckpoint（临时的 GIT_INDEX_FILE，先从 HEAD 填好、能复用时复制用户的索引保留
// stat 信息，再 `add -A`、`write-tree`、`commit-tree -p HEAD`、`update-ref`；还没有提交的嵌套仓库让 `add` 失败时排除
// 它们再试一次）、listAuthoredPaths、deleteCheckpointRefs，Diffs.ts 的 isGitImport，CheckpointService.ts 的 ref 命名空间与
// 回合后的文件统计。与 T3 不同：ref 用 Wevir 的命名空间、以回合 ID 命名并分前后两个；统计写进提交说明；sparse checkout
// 不打快照（T3 处理了 cone 模式）；所有 git 命令用 git-diff.ts 的 safeConfig，commit-tree 不签名；listAuthoredPaths 用
// `--diff-merges=off`（T3 的 remerge 会跑仓库配置的合并驱动）；会话关闭时删掉它的 ref，每个会话最多留最近 100 个回合。
//
// 每个回合前后的快照（0.20.0，domain-model §3.13）：回合开始前与结束后，Host 把会话目录现在的样子（含没被忽略的未跟踪
// 文件）写成一个提交，挂在 `refs/wevir/checkpoints/<会话 ID>/<回合 ID>/before` 与 `…/after` 上；一个回合的 diff 是这两个
// 提交之间的 diff（`workspace.diff` 的 `turn`）。不碰用户的索引、工作树与分支，只往仓库里写对象与这些 ref。

import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SessionCheckpointsResult,
  TurnCheckpoint,
  WorkspaceDiffResult,
} from '@wevir/protocol';
import {
  type NumstatEntry,
  parseNumstat,
  type RepoInfo,
  readRange,
  repoInfo,
  runGit,
  shared,
} from './git-diff.js';

export const CHECKPOINT_REF_PREFIX = 'refs/wevir/checkpoints';
/** 每个会话最多留这么多个回合的快照，多了删最早的。 */
export const CHECKPOINT_MAX_TURNS = 100;
/** 一次快照（含它的全部 git 命令）的时限；超时后这个目录在本次 Host 运行内不再打快照。 */
export const CAPTURE_TIMEOUT_MS = 15_000;
/** 未跟踪文件多于这么多或合计大于这么多字节时不打快照（`git add` 会把它们全部写进仓库）。 */
export const CAPTURE_UNTRACKED_MAX_FILES = 5_000;
export const CAPTURE_UNTRACKED_MAX_BYTES = 256 * 1024 * 1024;
/** 还没有提交的嵌套仓库最多排除这么多个（T3 CHECKPOINT_RECOVERY_MAX_CANDIDATES）。 */
const NESTED_REPO_MAX = 64;

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Wevir',
  GIT_AUTHOR_EMAIL: 'checkpoint@wevir.invalid',
  GIT_COMMITTER_NAME: 'Wevir',
  GIT_COMMITTER_EMAIL: 'checkpoint@wevir.invalid',
};

type Stage = 'before' | 'after';

export function checkpointRef(sessionId: string, turnId: string, stage: Stage): string {
  return `${CHECKPOINT_REF_PREFIX}/${sessionId}/${turnId}/${stage}`;
}

export interface TurnCheckpointsOptions {
  /** 会话还开着（没关闭、还在库里）；清理别的会话留下的 ref 时用。 */
  isOpen: (sessionId: string) => boolean;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** 默认 CAPTURE_TIMEOUT_MS（测试改小）。 */
  timeoutMs?: number;
  /** 默认 CHECKPOINT_MAX_TURNS（测试改小）。 */
  maxTurns?: number;
}

interface CaptureStats {
  fileCount: number;
  added: number;
  removed: number;
}

/**
 * 回合快照。SessionManager 在回合开始、交给引擎之前 `await beforeTurn`，`turn.finished` 时 `afterTurn`（不等）；同一个会话的
 * 快照与读取按顺序来，读回合 diff 前先等这个会话还没打完的快照。所有方法都不抛错：打不了快照只记告警，这个回合没有 diff。
 */
export class TurnCheckpoints {
  readonly #options: TurnCheckpointsOptions;
  /** 每个会话最后一个快照的 promise（永不 reject）。 */
  readonly #tails = new Map<string, Promise<void>>();
  /** 超时过的目录，本次运行内不再打快照。 */
  readonly #slow = new Set<string>();
  /** 清理过别的会话留下的 ref 的仓库（git 公共目录）。 */
  readonly #swept = new Set<string>();
  readonly #aborts = new Set<AbortController>();
  #disposed = false;

  constructor(options: TurnCheckpointsOptions) {
    this.#options = options;
  }

  /** 回合开始前的快照；打完（或放弃）才返回。 */
  beforeTurn(sessionId: string, cwd: string, turnId: string): Promise<void> {
    return this.#enqueue(sessionId, () => this.#capture(sessionId, cwd, turnId, 'before'));
  }

  /** 回合结束后的快照；排在这个会话前面的快照之后，不等。 */
  afterTurn(sessionId: string, cwd: string, turnId: string): void {
    void this.#enqueue(sessionId, () => this.#capture(sessionId, cwd, turnId, 'after'));
  }

  /** 会话关闭：删掉它的全部快照。 */
  dropSession(sessionId: string, cwd: string): void {
    void this.#enqueue(sessionId, async () => {
      const repo = await repoInfo(cwd);
      if (!repo) return;
      await deleteRefs(repo, await listRefs(repo, `${CHECKPOINT_REF_PREFIX}/${sessionId}/`));
    });
  }

  /** 等这个会话排着的快照打完。 */
  async settled(sessionId: string): Promise<void> {
    await this.#tails.get(sessionId);
  }

  /** `session.checkpoints`：有快照的回合，从早到晚。 */
  async list(sessionId: string, cwd: string): Promise<SessionCheckpointsResult> {
    await this.settled(sessionId);
    const repo = await repoInfo(cwd);
    if (!repo) return { repo: false, turns: [] };
    const { stdout } = await runGit(repo.cwd, [
      ...repo.config,
      'for-each-ref',
      '--format=%(refname)%00%(contents:subject)',
      `${CHECKPOINT_REF_PREFIX}/${sessionId}/`,
    ]);
    const turns = new Map<string, TurnCheckpoint>();
    for (const line of stdout.toString('utf8').split('\n')) {
      const [ref = '', subject = ''] = line.split('\0');
      const match = /\/(trn_[0-9A-Z]{26})\/(before|after)$/.exec(ref);
      if (!match) continue;
      const turnId = match[1] as TurnCheckpoint['turnId'];
      const turn = turns.get(turnId) ?? { turnId };
      if (match[2] === 'after') Object.assign(turn, parseStats(subject));
      turns.set(turnId, turn);
    }
    return {
      repo: true,
      turns: [...turns.values()].sort((a, b) => (a.turnId < b.turnId ? -1 : 1)),
    };
  }

  /** `workspace.diff` 的 `turn`：回合前后的快照之间；还没有回合后的快照时对现在的工作树（`live`）。 */
  async diff(sessionId: string, cwd: string, turnId: string): Promise<WorkspaceDiffResult> {
    await this.settled(sessionId);
    return shared(`turn\0${cwd}\0${sessionId}\0${turnId}`, async () => {
      const repo = await repoInfo(cwd);
      if (!repo) return { repo: false };
      try {
        const [before, after] = await Promise.all([
          resolveRef(repo, checkpointRef(sessionId, turnId, 'before')),
          resolveRef(repo, checkpointRef(sessionId, turnId, 'after')),
        ]);
        if (before === undefined) return { repo: true, unavailable: 'no_checkpoint' };
        const authored = after === undefined ? null : await listAuthoredPaths(repo, before, after);
        const diff = await readRange(repo, {
          from: before,
          ...(after !== undefined && { to: after }),
          ...(authored !== null && { keep: (entry) => !isGitImport(entry, authored) }),
        });
        return {
          repo: true,
          base: before,
          ...(repo.branch !== undefined && { branch: repo.branch }),
          ...(after === undefined ? { live: true as const } : { head: after }),
          ...diff,
        };
      } catch {
        return { repo: false };
      }
    });
  }

  /** Host 退出：停下进行中的 git，之后的调用什么都不做。 */
  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#aborts) controller.abort();
  }

  #enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => (this.#disposed ? undefined : task()))
      .catch((error: unknown) => {
        this.#options.onWarning?.('checkpoint failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.#tails.set(sessionId, next);
    void next.then(() => {
      if (this.#tails.get(sessionId) === next) this.#tails.delete(sessionId);
    });
    return next;
  }

  async #capture(sessionId: string, cwd: string, turnId: string, stage: Stage): Promise<void> {
    if (this.#slow.has(cwd) || !existsSync(cwd)) return;
    const controller = new AbortController();
    this.#aborts.add(controller);
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.timeoutMs ?? CAPTURE_TIMEOUT_MS,
    );
    try {
      const repo = await repoInfo(cwd);
      if (!repo) return;
      const signal = controller.signal;
      await this.#sweep(repo, signal);
      const skip = await captureBlocker(repo, signal);
      if (skip !== undefined) {
        this.#options.onWarning?.('checkpoint skipped', { sessionId, turnId, stage, reason: skip });
        return;
      }
      const ref = checkpointRef(sessionId, turnId, stage);
      const before =
        stage === 'after'
          ? await resolveRef(repo, checkpointRef(sessionId, turnId, 'before'))
          : undefined;
      await captureCheckpoint(repo, {
        ref,
        signal,
        message: (tree) =>
          before === undefined
            ? Promise.resolve(commitMessage(sessionId, turnId, stage))
            : turnStats(repo, before, tree, signal).then((stats) =>
                commitMessage(sessionId, turnId, stage, stats),
              ),
      });
      if (stage === 'after') {
        await pruneSession(repo, sessionId, this.#options.maxTurns ?? CHECKPOINT_MAX_TURNS);
      }
    } catch (error) {
      if (controller.signal.aborted && !this.#disposed) {
        this.#slow.add(cwd);
        this.#options.onWarning?.('checkpoint timed out; disabled for this directory', {
          sessionId,
          cwd,
        });
        return;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.#aborts.delete(controller);
    }
  }

  /** 每个仓库第一次打快照时，删掉已关闭、已不在库里的会话留下的 ref（关闭时目录已不在、Host 中途退出时会留下）。 */
  async #sweep(repo: RepoInfo, signal: AbortSignal): Promise<void> {
    const common = (
      await runGit(
        repo.cwd,
        [...repo.config, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        {
          signal,
        },
      )
    ).stdout
      .toString('utf8')
      .trim();
    if (this.#swept.has(common)) return;
    this.#swept.add(common);
    const refs = await listRefs(repo, `${CHECKPOINT_REF_PREFIX}/`);
    const stale = refs.filter((ref) => {
      const sessionId = ref.slice(CHECKPOINT_REF_PREFIX.length + 1).split('/')[0] ?? '';
      return !this.#options.isOpen(sessionId);
    });
    await deleteRefs(repo, stale);
  }
}

// ── 打快照（T3 captureCheckpoint） ───────────────────────────────────

/** 打不了快照的原因：sparse checkout、未跟踪文件太多或太大。 */
async function captureBlocker(repo: RepoInfo, signal: AbortSignal): Promise<string | undefined> {
  const sparse = await runGit(
    repo.cwd,
    [...repo.config, 'config', '--bool', 'core.sparseCheckout'],
    {
      okCodes: [0, 1],
      signal,
    },
  );
  if (sparse.stdout.toString('utf8').trim() === 'true') return 'sparse_checkout';
  const listed = await runGit(
    repo.cwd,
    [...repo.config, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
    { signal },
  );
  const paths = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');
  if (paths.length > CAPTURE_UNTRACKED_MAX_FILES) return 'too_many_untracked';
  let bytes = 0;
  for (const path of paths) {
    if (path.endsWith('/')) continue;
    bytes += (await stat(join(repo.cwd, path)).catch(() => undefined))?.size ?? 0;
    if (bytes > CAPTURE_UNTRACKED_MAX_BYTES) return 'untracked_too_large';
  }
  return undefined;
}

interface CaptureInput {
  ref: string;
  signal: AbortSignal;
  /** 提交说明；拿到写好的树之后再定（回合后的快照要写统计）。 */
  message: (tree: string) => Promise<string>;
}

/** 会话目录现在的样子写成一个提交（父提交是 HEAD），挂到 `ref` 上。只在临时索引上操作。 */
export async function captureCheckpoint(repo: RepoInfo, input: CaptureInput): Promise<string> {
  const { signal } = input;
  const dir = await mkdtemp(join(tmpdir(), 'wevir-checkpoint-'));
  const indexFile = join(dir, 'index');
  const env = { ...AUTHOR, GIT_INDEX_FILE: indexFile };
  const indexConfig = ['-c', 'core.splitIndex=false', '-c', 'splitIndex.sharedIndexExpire=never'];
  const run = (args: readonly string[], options: { stdin?: string; okCodes?: number[] } = {}) =>
    runGit(repo.cwd, [...repo.config, ...indexConfig, ...args], { env, signal, ...options });
  try {
    if (repo.head !== undefined) {
      if (!(await reuseIndex(repo, indexFile, run))) {
        await rm(indexFile, { force: true });
        await run(['read-tree', repo.head]);
      }
    }
    const stage = (exclusions: readonly string[]) => run(['add', '-A', '--', '.', ...exclusions]);
    try {
      await stage([]);
    } catch (error) {
      // 还没有提交的嵌套仓库 git 加不进来：失败之后才去找它们，平常的快照不多扫一遍文件。
      const exclusions = await nestedRepoExclusions(repo, signal);
      if (exclusions.length === 0) throw error;
      await stage(exclusions);
    }
    const tree = (await run(['write-tree'])).stdout.toString('utf8').trim();
    if (tree === '') throw new Error('git write-tree returned no tree');
    const message = await input.message(tree);
    const commit = (
      await run([
        'commit-tree',
        '--no-gpg-sign',
        tree,
        ...(repo.head !== undefined ? ['-p', repo.head] : []),
        '-m',
        message,
      ])
    ).stdout
      .toString('utf8')
      .trim();
    if (commit === '') throw new Error('git commit-tree returned no commit');
    await run(['update-ref', input.ref, commit]);
    return commit;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type IndexRun = (
  args: readonly string[],
  options?: { stdin?: string; okCodes?: number[] },
) => Promise<{ stdout: Buffer }>;

/**
 * 复制用户的索引再按 HEAD 重置，保留与 HEAD 一致的文件的 stat 信息，`add -A` 不必重新读这些文件（T3 的 reusedIndex）。
 * 有 assume-unchanged / skip-worktree 这类手动标记的文件时（`ls-files -v` 的小写或 S）不复用，标记会让 `add` 漏掉改动。
 */
async function reuseIndex(repo: RepoInfo, indexFile: string, run: IndexRun): Promise<boolean> {
  try {
    const indexPath = (
      await runGit(repo.cwd, [
        ...repo.config,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      ])
    ).stdout
      .toString('utf8')
      .trim();
    const source = await stat(indexPath);
    // 比原索引早一点，即使取整进了一位也保住 git 的 racy 检查。
    const seconds = Math.floor((source.mtimeMs - 1) / 1000);
    if (seconds <= 0) return false;
    await copyFile(indexPath, indexFile);
    await run(['read-tree', '--reset', 'HEAD']);
    // read-tree 会重写索引，写完再把时间改回去。
    await utimes(indexFile, seconds, seconds);
    const listed = (await run(['ls-files', '-v', '-z'])).stdout;
    let recordStart = true;
    for (const byte of listed) {
      if (recordStart && ((byte >= 97 && byte <= 122) || byte === 83)) return false;
      recordStart = byte === 0;
    }
    return true;
  } catch {
    return false;
  }
}

/** 未跟踪的目录里还没有提交的嵌套仓库，排除掉（T3 的 embedded repository 恢复）。 */
async function nestedRepoExclusions(repo: RepoInfo, signal: AbortSignal): Promise<string[]> {
  const listed = await runGit(
    repo.cwd,
    [...repo.config, 'ls-files', '--others', '--exclude-standard', '--directory', '-z', '--', '.'],
    { signal },
  );
  const candidates = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.endsWith('/'));
  if (candidates.length > NESTED_REPO_MAX) return [];
  const exclusions: string[] = [];
  for (const entry of candidates) {
    const nested = join(repo.cwd, entry);
    if (!existsSync(join(nested, '.git'))) continue;
    // 认子目录自己的仓库，不继承 Host 的 GIT_* 绑定（runGit 已去掉）。
    const head = await runGit(
      nested,
      [...repo.config, 'rev-parse', '--verify', '--quiet', 'HEAD'],
      {
        okCodes: [0, 1, 128],
        signal,
      },
    );
    if (head.code !== 0) exclusions.push(`:(exclude,literal)${entry}`);
  }
  return exclusions;
}

function commitMessage(
  sessionId: string,
  turnId: string,
  stage: Stage,
  stats?: CaptureStats,
): string {
  const subject =
    stats === undefined
      ? `wevir checkpoint ${stage}`
      : `wevir checkpoint ${stage} files=${stats.fileCount} added=${stats.added} removed=${stats.removed}`;
  return `${subject}\n\nWevir-Session: ${sessionId}\nWevir-Turn: ${turnId}\n`;
}

function parseStats(subject: string): Partial<CaptureStats> {
  const match = /files=(\d+) added=(\d+) removed=(\d+)/.exec(subject);
  if (!match) return {};
  return { fileCount: Number(match[1]), added: Number(match[2]), removed: Number(match[3]) };
}

/** 回合后的快照写进提交说明的统计：同 `workspace.diff` 的 `turn`，滤掉 git 带进来的文件。 */
async function turnStats(
  repo: RepoInfo,
  before: string,
  afterTree: string,
  signal: AbortSignal,
): Promise<CaptureStats> {
  const authored = await listAuthoredPaths(repo, before, afterTree, signal);
  const { stdout } = await runGit(
    repo.cwd,
    [
      ...repo.config,
      'diff',
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--relative',
      before,
      afterTree,
      '--',
    ],
    { signal },
  );
  const files = parseNumstat(stdout.toString('utf8')).filter(
    (entry) => authored === null || !isGitImport(entry, authored),
  );
  return {
    fileCount: files.length,
    added: files.reduce((total, file) => total + (file.added ?? 0), 0),
    removed: files.reduce((total, file) => total + (file.removed ?? 0), 0),
  };
}

// ── 回合里 git 带进来的文件（T3 listAuthoredPaths / isGitImport） ───────────

/**
 * 回合里 HEAD 动过（pull、merge、rebase、提交）时，回合本身写过的文件：两头没提交的改动，退掉的提交，以及回合开始之后
 * 才提交的提交里的文件。回合开始前就有的提交（pull 带进来的）不算。HEAD 没动、或两头有一头没有提交时是 null（没有带进来的）。
 * `to` 可以是回合后快照的提交，也可以是它的树（还没写提交时），这时 HEAD 取现在的。
 */
export async function listAuthoredPaths(
  repo: RepoInfo,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const run = (args: readonly string[]) =>
    runGit(repo.cwd, [...repo.config, ...args], signal ? { signal } : {});
  const fromInfo = (await run(['log', '-1', '--format=%P %ct', from])).stdout
    .toString('utf8')
    .trim();
  const [startHead = '', capturedAt = ''] = fromInfo.split(' ');
  const toType = (await run(['cat-file', '-t', to])).stdout.toString('utf8').trim();
  const endHead =
    toType === 'commit'
      ? (await run(['log', '-1', '--format=%P', to])).stdout.toString('utf8').trim()
      : (repo.head ?? '');
  if (startHead === '' || endHead === '' || startHead === endHead) return null;

  const names = (args: readonly string[]) =>
    run([...args, '--name-only', '-z', '--no-renames', '--no-ext-diff', '--relative']).then(
      (result) => result.stdout.toString('utf8').split('\0'),
    );
  // 合并提交不展开（`--diff-merges=off`）：T3 用 remerge，它会跑仓库配置的合并驱动。
  const lists = await Promise.all([
    names(['diff', startHead, from]),
    names(['diff', endHead, to]),
    names(['log', '--format=', '--diff-merges=off', `${endHead}..${startHead}`]),
    names([
      'log',
      '--format=',
      '--diff-merges=off',
      `--since=@${capturedAt}`,
      `${startHead}..${endHead}`,
    ]),
  ]);
  return new Set(lists.flat().filter((path) => path !== ''));
}

/** git 带进来、回合本身没碰过的文件；重命名的两边有一边写过就留着。 */
export function isGitImport(entry: NumstatEntry, authored: ReadonlySet<string>): boolean {
  return (
    !authored.has(entry.path) &&
    (entry.previousPath === undefined || !authored.has(entry.previousPath))
  );
}

// ── ref ─────────────────────────────────────────────────────────────

async function resolveRef(repo: RepoInfo, ref: string): Promise<string | undefined> {
  const result = await runGit(
    repo.cwd,
    [...repo.config, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { okCodes: [0, 1] },
  );
  const sha = result.stdout.toString('utf8').trim();
  return result.code === 0 && sha !== '' ? sha : undefined;
}

async function listRefs(repo: RepoInfo, prefix: string): Promise<string[]> {
  const { stdout } = await runGit(repo.cwd, [
    ...repo.config,
    'for-each-ref',
    '--format=%(refname)',
    prefix,
  ]);
  return stdout
    .toString('utf8')
    .split('\n')
    .filter((ref) => ref !== '');
}

async function deleteRefs(repo: RepoInfo, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return;
  await runGit(repo.cwd, [...repo.config, 'update-ref', '--stdin'], {
    stdin: refs.map((ref) => `delete ${ref}\n`).join(''),
  });
}

/** 一个会话的快照多于 `maxTurns` 个回合时，删最早的（回合 ID 是 ULID，按字典序就是按时间）。 */
async function pruneSession(repo: RepoInfo, sessionId: string, maxTurns: number): Promise<void> {
  const refs = await listRefs(repo, `${CHECKPOINT_REF_PREFIX}/${sessionId}/`);
  const turns = [...new Set(refs.map((ref) => ref.split('/').at(-2) ?? ''))].sort();
  const drop = new Set(turns.slice(0, Math.max(0, turns.length - maxTurns)));
  await deleteRefs(
    repo,
    refs.filter((ref) => drop.has(ref.split('/').at(-2) ?? '')),
  );
}
