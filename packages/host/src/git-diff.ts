// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/vcs/GitVcsDriverCore.ts、apps/server/src/checkpointing/Diffs.ts、apps/server/src/vcs/GitVcsDriver.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成 Wevir 的协议（0.20.0）与 Node 的 child_process。取自 GitVcsDriverCore.ts 的 prepareReviewIndex /
// prepareUntrackedReviewIndex（复制索引、intent-to-add 未跟踪文件，让对一个提交的 diff 把它们算作新文件）、
// resolveReviewMergeBase、readWorkingTreeReviewFile（新的一侧读磁盘，realpath 后仍要在目录里）与 PATCH_RENDER_PREFIX_ARGS；
// Diffs.ts 的 parseTurnDiffFilesFromNumstat。与 T3 不同：所有命令屏蔽仓库配置里会执行命令的设置（safeConfig，含仓库
// 定义的过滤器）；补丁按文件切开、超过上限的只列出；默认分支只试几个常见的名字；旧的一侧用 `cat-file blob` 读。
//
// 改动的 diff（host-api.md §3.1 的 `workspace.diff` / `workspace.diffFile`）：给桌面端的“变更”窗格读未提交、本分支与
// 回合快照之间的 diff，以及展开未修改的行时一个文件两侧的全文。每次现跑 git，不缓存；同一目录同一段的并发读取共用一次。

import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rm, stat, utimes } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type DiffFile,
  WORKSPACE_DIFF_MAX_FILES,
  type WorkspaceDiffFileResult,
  type WorkspaceDiffResult,
} from '@wevir/protocol';

/** 每条 git 命令的时限。 */
export const GIT_TIMEOUT_MS = 10_000;
/** `patch` 的总长（UTF-16 code unit）与单个文件的上限，超过的文件只列出、不给 diff（`omitted`）。 */
export const DIFF_MAX_LENGTH = 2 * 1024 * 1024;
export const DIFF_FILE_MAX_LENGTH = 512 * 1024;
/** 读 `git diff --patch` 输出的上限，超过就停下，后面的文件按 `over_limit`。 */
const PATCH_READ_MAX_BYTES = 16 * 1024 * 1024;
/** 列表类输出（numstat、ls-files）的上限。 */
const LIST_MAX_BYTES = 32 * 1024 * 1024;
/** 未跟踪文件多于这么多时不算它们的 diff（T3：git add 的耗时随文件数涨得很快）。 */
export const UNTRACKED_MAX_FILES = 5_000;
/** `workspace.diffFile` 一侧全文的上限。 */
export const DIFF_FILE_CONTENTS_MAX_BYTES = 1024 * 1024;

const NOT_REPO: WorkspaceDiffResult = { repo: false };

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

// ── 运行 git ─────────────────────────────────────────────────────────

export interface GitRunOptions {
  /** 额外的环境变量（GIT_INDEX_FILE 等），加在 gitEnv() 上。 */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** 超过 `maxBytes`：`error`（默认）抛错；`truncate` 停下 git，结果带 `truncated`。 */
  overflow?: 'error' | 'truncate';
  /** 当作成功的退出码，默认只有 0。 */
  okCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface GitRunResult {
  code: number;
  stdout: Buffer;
  truncated: boolean;
}

/** 跑一条 git 命令（`args` 里不含 safeConfig，调用方自己加）。退出码不在 `okCodes` 里、超时、被中止都抛 GitError。 */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  const maxBytes = options.maxBytes ?? LIST_MAX_BYTES;
  return new Promise((done, fail) => {
    if (options.signal?.aborted) {
      fail(new GitError('git aborted'));
      return;
    }
    const child = spawn('git', args, {
      cwd,
      env: { ...gitEnv(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let overflowed = false;
    let stopped: 'timeout' | 'abort' | undefined;
    let stderr = '';
    const stop = (why: 'timeout' | 'abort') => {
      stopped = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? GIT_TIMEOUT_MS);
    const onAbort = () => stop('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated || overflowed) return;
      const room = maxBytes - size;
      if (chunk.length <= room) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      if (options.overflow === 'truncate') {
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        truncated = true;
      } else {
        overflowed = true;
      }
      child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fail(new GitError(`git ${args.find((arg) => !arg.startsWith('-')) ?? ''}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const name = commandName(args);
      if (stopped) {
        fail(new GitError(`git ${name} ${stopped === 'timeout' ? 'timed out' : 'aborted'}`));
      } else if (overflowed) {
        fail(new GitError(`git ${name} output exceeds ${maxBytes} bytes`));
      } else if (!truncated && !(options.okCodes ?? [0]).includes(code ?? -1)) {
        fail(new GitError(`git ${name} exited with ${code}`, code ?? undefined, stderr.trim()));
      } else {
        done({ code: code ?? -1, stdout: Buffer.concat(chunks), truncated });
      }
    });
    child.stdin.end(options.stdin ?? '');
  });
}

/** 命令名：跳过 `-c 键=值` 与别的全局选项。 */
function commandName(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '-c') index += 1;
    else if (!arg.startsWith('-')) return arg;
  }
  return '';
}

/** 继承 Host 的环境（PATH、HOME 找全局配置），去掉会把 git 指到别处的 GIT_* 变量（同 git-status.ts）。 */
export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    // 不拿可选的索引锁、不弹凭据提示、输出不翻译。
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * 不在不受信任的仓库里执行仓库配置里的命令：fsmonitor 钩子、外部 diff（另在 diff 的参数里
 * `--no-ext-diff`、`--no-textconv`）、钩子（`update-ref` 会跑 reference-transaction）、自动 gc 与维护、提交签名
 * （`commit-tree` 认 `commit.gpgSign`）；不用 untracked cache（它会写索引）；路径不转义非 ASCII 字符。
 */
const BASE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'diff.external=',
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'core.quotePath=false',
];

/**
 * 加上仓库自己（local、worktree 两级）定义的过滤器的屏蔽：`git diff`、`git add` 读工作树文件时会跑 `filter.<名字>.clean`，
 * 仓库配置能借此执行任意命令。全局与系统配置里的（git-lfs 之类，用户自己装的）照常用；仓库改写了同名的也屏蔽。名字里有
 * `=` 或换行（`-c` 表达不了）时抛错，按读不了处理。git-status.ts 也用它（时限传它自己的）。
 */
export async function safeConfig(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string[]> {
  const { stdout } = await runGit(
    cwd,
    [...BASE_CONFIG, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'],
    { okCodes: [0, 1], timeoutMs },
  );
  const names = new Set<string>();
  for (const line of stdout.toString('utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const scope = line.slice(0, tab);
    const key = line.slice(tab + 1);
    if (scope === 'global' || scope === 'system') continue;
    const name = key.slice('filter.'.length, key.lastIndexOf('.'));
    if (name === '') continue;
    if (name.includes('=') || name.includes('\n')) throw new GitError('unsafe filter name');
    names.add(name);
  }
  const overrides: string[] = [];
  for (const name of names) {
    for (const [field, value] of [
      ['clean', ''],
      ['smudge', ''],
      ['process', ''],
      ['required', 'false'],
    ] as const) {
      overrides.push('-c', `filter.${name}.${field}=${value}`);
    }
  }
  return [...BASE_CONFIG, ...overrides];
}

/** 渲染用的 diff 参数：固定 `a/`、`b/` 前缀（仓库的 diff.noprefix 之类会让解析认不出文件名），路径相对当前目录。 */
const DIFF_ARGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  '--relative',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

// ── 仓库 ─────────────────────────────────────────────────────────────

export interface RepoInfo {
  /** 目录的 realpath。 */
  cwd: string;
  toplevel: string;
  /** HEAD 的提交；还没有提交时没有。 */
  head?: string;
  branch?: string;
  config: string[];
}

/**
 * 目录所在的仓库；不是仓库、没有 git、出错时是 undefined。仓库配置的 `core.worktree` 把工作树指到别处（目录不在工作树里）也
 * 算不是。
 */
export async function repoInfo(dir: string): Promise<RepoInfo | undefined> {
  try {
    const cwd = await realpath(dir);
    const config = await safeConfig(cwd);
    const top = await runGit(cwd, [...config, 'rev-parse', '--show-toplevel']);
    const toplevel = await realpath(top.stdout.toString('utf8').trim());
    if (!within(toplevel, cwd)) return undefined;
    const [head, branch] = await Promise.all([
      runGit(cwd, [...config, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
        okCodes: [0, 1],
      }),
      runGit(cwd, [...config, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] }),
    ]);
    const headSha = head.code === 0 ? head.stdout.toString('utf8').trim() : '';
    const branchName = branch.code === 0 ? branch.stdout.toString('utf8').trim() : '';
    return {
      cwd,
      toplevel,
      ...(headSha !== '' && { head: headSha }),
      ...(branchName !== '' && { branch: branchName }),
      config,
    };
  } catch {
    return undefined;
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function git(repo: RepoInfo, args: readonly string[], options?: GitRunOptions) {
  return runGit(repo.cwd, [...repo.config, ...args], options);
}

async function gitText(repo: RepoInfo, args: readonly string[], options?: GitRunOptions) {
  return (await git(repo, args, options)).stdout.toString('utf8');
}

/** 空树的 ID（还没有提交时旧的一侧）；SHA-256 仓库与 SHA-1 不同，问 git。 */
export async function emptyTree(repo: RepoInfo): Promise<string> {
  return (await gitText(repo, ['hash-object', '-t', 'tree', '--stdin'])).trim();
}

/**
 * 本分支比较的默认分支：远端 origin 的 HEAD 指向的分支，再试本地的 main、master 与 origin/main、origin/master。T3 的
 * resolveBaseBranchForNoUpstream 还看 gh 记下的 merge-base 与上游分支，Wevir 只取这几个常见的。
 */
async function defaultBranch(repo: RepoInfo): Promise<string | undefined> {
  const origin = await git(
    repo,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    {
      okCodes: [0, 1, 128],
    },
  );
  const candidates = [
    ...(origin.code === 0 ? [origin.stdout.toString('utf8').trim()] : []),
    'main',
    'master',
    'origin/main',
    'origin/master',
  ];
  for (const candidate of candidates) {
    if (candidate === '' || candidate.startsWith('-')) continue;
    const found = await git(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      okCodes: [0, 1],
    });
    if (found.code === 0) return candidate;
  }
  return undefined;
}

/**
 * 代码审查（0.24.0，`session.review`）的仓库与基础分支：目录不是 git 仓库时 `undefined`；`baseBranch` 是 `branch` 比较的默认分支
 * （同 `readBranch`），还没有提交或找不到时省略。
 */
export async function reviewRepo(dir: string): Promise<{ baseBranch?: string } | undefined> {
  const repo = await repoInfo(dir);
  if (!repo) return undefined;
  if (repo.head === undefined) return {};
  try {
    const baseBranch = await defaultBranch(repo);
    return baseBranch === undefined ? {} : { baseBranch };
  } catch {
    return {};
  }
}

// ── 解析 ─────────────────────────────────────────────────────────────

export interface NumstatEntry {
  path: string;
  previousPath?: string;
  added?: number;
  removed?: number;
}

/** `diff --numstat -z`（跟踪重命名）：`增\t删\t路径\0`，重命名是 `增\t删\t\0旧\0新\0`；二进制文件的增删是 `-`。（T3 Diffs.ts） */
export function parseNumstat(output: string): NumstatEntry[] {
  const records = output.split('\0');
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;
    let path = record.slice(counts[0].length);
    let previousPath: string | undefined;
    if (path === '') {
      previousPath = records[index + 1];
      path = records[index + 2] ?? '';
      index += 2;
    }
    if (path === '') continue;
    entries.push({
      path,
      ...(previousPath !== undefined && previousPath !== '' && { previousPath }),
      ...(counts[1] !== '-' && { added: Number(counts[1]) }),
      ...(counts[2] !== '-' && { removed: Number(counts[2]) }),
    });
  }
  return entries;
}

const STATUS_NAMES: Record<string, string> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type_changed',
};

/** `diff --name-status -z`（跟踪重命名）：`字母\0路径\0`，重命名与复制是 `R100\0旧\0新\0`。按新路径。 */
export function parseNameStatus(output: string): Map<string, string> {
  const parts = output.split('\0');
  const statuses = new Map<string, string>();
  for (let index = 0; index < parts.length; ) {
    const code = parts[index] ?? '';
    if (code === '') {
      index += 1;
      continue;
    }
    const letter = code.charAt(0);
    const twoPaths = letter === 'R' || letter === 'C';
    const path = parts[index + (twoPaths ? 2 : 1)];
    if (path !== undefined && path !== '') statuses.set(path, STATUS_NAMES[letter] ?? 'modified');
    index += twoPaths ? 3 : 2;
  }
  return statuses;
}

/**
 * 一次 `diff --raw --numstat -z` 的输出拆回单独跑 `--name-status -z` 与 `--numstat -z` 时的两份，交给上面两个解析：一次 diff 代替两次。
 * raw 的记录都在前面，每条是 `:旧模式 新模式 旧对象 新对象 状态\0路径\0`，重命名与复制带两个路径；之后是 numstat 的记录。
 */
export function splitRawNumstat(output: string): { nameStatus: string; numstat: string } {
  const parts = output.split('\0');
  const nameStatus: string[] = [];
  let index = 0;
  while (index < parts.length && (parts[index] as string).startsWith(':')) {
    const meta = parts[index] as string;
    const status = meta.slice(meta.lastIndexOf(' ') + 1);
    const paths = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    nameStatus.push(status, ...parts.slice(index + 1, index + 1 + paths));
    index += 1 + paths;
  }
  return {
    nameStatus: nameStatus.length === 0 ? '' : `${nameStatus.join('\0')}\0`,
    numstat: parts.slice(index).join('\0'),
  };
}

/** 按 `diff --git ` 开头的行把补丁切成每个文件一段。 */
export function splitPatch(patch: string): string[] {
  const chunks: string[] = [];
  let start = patch.startsWith('diff --git ') ? 0 : patch.indexOf('\ndiff --git ');
  if (start < 0) return chunks;
  if (start > 0) start += 1;
  while (start < patch.length) {
    const next = patch.indexOf('\ndiff --git ', start);
    const end = next < 0 ? patch.length : next + 1;
    chunks.push(patch.slice(start, end));
    start = end;
  }
  return chunks;
}

/** 一段补丁说的是哪个文件（新的路径）。认 `rename to` / `copy to`、`+++ b/`、`--- a/`，都没有时（二进制、只改了权限）看头一行。 */
export function chunkPath(chunk: string): string | undefined {
  const lines = chunk.split('\n');
  let minus: string | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('rename to ')) return unquote(line.slice('rename to '.length));
    if (line.startsWith('copy to ')) return unquote(line.slice('copy to '.length));
    if (line.startsWith('+++ ')) {
      const target = unquote(line.slice(4));
      if (target.startsWith('b/')) return target.slice(2);
    }
    if (line.startsWith('--- ')) {
      const source = unquote(line.slice(4));
      if (source.startsWith('a/')) minus = source.slice(2);
    }
  }
  if (minus !== undefined) return minus;
  const header = (lines[0] ?? '').slice('diff --git '.length);
  if (header.startsWith('"')) {
    const [, second] = splitQuotedPair(header);
    return second?.startsWith('b/') ? second.slice(2) : undefined;
  }
  // 不是重命名时两边相同：`a/P b/P`。
  const length = (header.length - 5) / 2;
  if (!Number.isInteger(length) || length <= 0) return undefined;
  const path = header.slice(2, 2 + length);
  return header === `a/${path} b/${path}` ? path : undefined;
}

/** git 给含特殊字符的路径加的 C 风格引号。 */
function unquote(value: string): string {
  const trimmed = value.replace(/\t$/, '');
  if (!trimmed.startsWith('"')) return trimmed;
  return splitQuotedPair(trimmed)[0] ?? trimmed;
}

function splitQuotedPair(value: string): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  let index = 0;
  while (index < value.length && out.length < 2) {
    if (value[index] === ' ') {
      index += 1;
      continue;
    }
    if (value[index] !== '"') {
      const end = value.indexOf(' ', index);
      out.push(value.slice(index, end < 0 ? value.length : end));
      index = end < 0 ? value.length : end;
      continue;
    }
    const bytes: number[] = [];
    index += 1;
    while (index < value.length && value[index] !== '"') {
      const char = value[index] as string;
      if (char !== '\\') {
        bytes.push(...Buffer.from(char, 'utf8'));
        index += 1;
        continue;
      }
      const next = value[index + 1] ?? '';
      const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += 4;
        continue;
      }
      const escapes: Record<string, number> = {
        n: 10,
        t: 9,
        r: 13,
        '"': 34,
        '\\': 92,
        a: 7,
        b: 8,
        f: 12,
        v: 11,
      };
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 2;
    }
    out.push(Buffer.from(bytes).toString('utf8'));
    index += 1;
  }
  return out;
}

// ── 未跟踪文件进临时索引（T3 prepareReviewIndex） ─────────────────────────

interface ReviewIndex {
  /** 给 diff 命令的环境；没有要加的未跟踪文件时不需要临时索引。 */
  env?: Record<string, string>;
  /** 加进临时索引、在 diff 里算作新文件的未跟踪文件。 */
  untracked: Set<string>;
  /** 太多没有加的未跟踪文件。 */
  skipped: string[];
  cleanup(): Promise<void>;
}

async function prepareReviewIndex(repo: RepoInfo): Promise<ReviewIndex> {
  const listed = await gitText(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listed.split('\0').filter((path) => path !== '');
  const none: ReviewIndex = { untracked: new Set(), skipped: [], cleanup: async () => {} };
  if (paths.length === 0) return none;
  if (paths.length > UNTRACKED_MAX_FILES) return { ...none, skipped: paths };

  // 暂存区里删掉、磁盘上还在的文件也列为未跟踪；加成 intent-to-add 会把“删除”变成“修改”，保持删除。
  const stagedDeletions = new Set<string>();
  if (repo.head !== undefined) {
    const deleted = await gitText(repo, [
      'diff',
      '--cached',
      '--relative',
      '--name-only',
      '--diff-filter=D',
      '-z',
      'HEAD',
      '--',
    ]);
    for (const path of deleted.split('\0')) if (path !== '') stagedDeletions.add(path);
  }
  const toAdd = paths.filter((path) => !stagedDeletions.has(path));
  if (toAdd.length === 0) return none;

  const dir = await mkdtemp(join(tmpdir(), 'wevir-diff-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const indexFile = join(dir, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    const indexPath = (
      await gitText(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    ).trim();
    const source = await stat(indexPath).catch(() => undefined);
    const tempIndex = ['-c', 'core.splitIndex=false', '-c', 'splitIndex.sharedIndexExpire=never'];
    if (source) {
      await copyFile(indexPath, indexFile);
      // 保留原索引的时间（取整到秒，不让前一秒改的文件变成“racy”），git 照样会重新检查它之后改过的文件。
      const seconds = Math.max(0, Math.floor(source.mtimeMs / 1000));
      await utimes(indexFile, seconds, seconds);
    } else {
      await git(repo, ['read-tree', '--empty'], { env });
    }
    await git(repo, [...tempIndex, 'update-index', '--no-split-index'], { env });
    await git(
      repo,
      [
        ...tempIndex,
        '--literal-pathspecs',
        'add',
        '--intent-to-add',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      { env, stdin: `${toAdd.join('\0')}\0` },
    );
    return { env, untracked: new Set(toAdd), skipped: [], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// ── 读 diff ─────────────────────────────────────────────────────────

export interface DiffRange {
  /** 旧的一侧：提交或树。 */
  from: string;
  /** 新的一侧的提交；省略时是工作树（含未跟踪文件），`cached` 时是暂存区。 */
  to?: string;
  /** 新的一侧是暂存区（0.67.0，`staged`）：`git diff --cached`，不加未跟踪文件。 */
  cached?: boolean;
  /** 只留下这些文件（回合 diff 滤掉 git 带进来的）；undefined 是全部。 */
  keep?: (entry: NumstatEntry) => boolean;
}

export interface DiffPayload {
  patch: string;
  files: DiffFile[];
  fileCount: number;
  added: number;
  removed: number;
  truncated?: true;
}

/** 两侧之间的 diff：文件与统计来自 numstat 与 name-status，补丁按文件切开，超过上限的只列出。 */
export async function readRange(repo: RepoInfo, range: DiffRange): Promise<DiffPayload> {
  const index =
    range.to === undefined && range.cached !== true ? await prepareReviewIndex(repo) : undefined;
  try {
    const revs =
      range.cached === true
        ? ['--cached', range.from]
        : range.to === undefined
          ? [range.from]
          : [range.from, range.to];
    const env = index?.env;
    const options = env ? { env } : {};
    const { numstat, nameStatus } = splitRawNumstat(
      // 一次跑出两份，上限也按两份算。
      await gitText(repo, ['diff', '--raw', '--numstat', '-z', ...DIFF_ARGS, ...revs, '--'], {
        ...options,
        maxBytes: LIST_MAX_BYTES * 2,
      }),
    );
    const statuses = parseNameStatus(nameStatus);
    const entries = parseNumstat(numstat).filter((entry) => range.keep?.(entry) ?? true);
    const files: DiffFile[] = entries.map((entry) => {
      const status = index?.untracked.has(entry.path)
        ? 'untracked'
        : (statuses.get(entry.path) ?? 'modified');
      return {
        path: entry.path,
        ...(entry.previousPath !== undefined && { previousPath: entry.previousPath }),
        status,
        ...(entry.added !== undefined && { added: entry.added }),
        ...(entry.removed !== undefined && { removed: entry.removed }),
        ...(entry.added === undefined && entry.removed === undefined && { binary: true as const }),
      };
    });
    for (const path of index?.skipped ?? []) {
      files.push({ path, status: 'untracked', omitted: 'over_limit' });
    }

    let patch = '';
    if (entries.length > 0) {
      const result = await git(repo, ['diff', '--patch', ...DIFF_ARGS, ...revs, '--'], {
        ...options,
        maxBytes: PATCH_READ_MAX_BYTES,
        overflow: 'truncate',
      });
      patch = selectChunks(result.stdout.toString('utf8'), result.truncated, files);
    }
    const truncated =
      files.length > WORKSPACE_DIFF_MAX_FILES || files.some((file) => file.omitted !== undefined);
    return {
      patch,
      files: files.slice(0, WORKSPACE_DIFF_MAX_FILES),
      fileCount: files.length,
      added: files.reduce((total, file) => total + (file.added ?? 0), 0),
      removed: files.reduce((total, file) => total + (file.removed ?? 0), 0),
      ...(truncated && { truncated: true as const }),
    };
  } finally {
    await index?.cleanup();
  }
}

/**
 * 按上限挑出补丁里的段：属于 `files` 的才留，单个文件超过 DIFF_FILE_MAX_LENGTH 的标 `too_large`，累计超过 DIFF_MAX_LENGTH
 * 之后（以及读补丁时被截断的最后一段之后）的标 `over_limit`。原地给 `files` 写 `omitted`。
 */
function selectChunks(patch: string, readTruncated: boolean, files: DiffFile[]): string {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const chunks = splitPatch(patch);
  const seen = new Set<DiffFile>();
  const kept: string[] = [];
  let total = 0;
  chunks.forEach((chunk, position) => {
    const path = chunkPath(chunk);
    const file = path === undefined ? undefined : byPath.get(path);
    if (!file) return;
    seen.add(file);
    if (file.omitted !== undefined) return;
    const last = readTruncated && position === chunks.length - 1;
    if (last || total + chunk.length > DIFF_MAX_LENGTH) {
      file.omitted = 'over_limit';
    } else if (chunk.length > DIFF_FILE_MAX_LENGTH) {
      file.omitted = 'too_large';
    } else {
      kept.push(chunk);
      total += chunk.length;
    }
  });
  // 补丁里没读到的（读到上限停下了）。
  if (readTruncated) {
    for (const file of files)
      if (!seen.has(file) && file.omitted === undefined) file.omitted = 'over_limit';
  }
  return kept.join('');
}

// ── workspace.diff ──────────────────────────────────────────────────

const inFlight = new Map<string, Promise<WorkspaceDiffResult>>();

/** 同一个键（目录与那一段）同时只读一份，并发的调用共用结果。 */
export function shared(
  key: string,
  read: () => Promise<WorkspaceDiffResult>,
): Promise<WorkspaceDiffResult> {
  const running = inFlight.get(key);
  if (running) return running;
  const promise = read().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** `uncommitted`：工作树加暂存区对 HEAD（还没有提交时对空树），含未跟踪文件。 */
export function readUncommitted(dir: string): Promise<WorkspaceDiffResult> {
  return shared(`uncommitted\0${dir}`, async () => {
    const repo = await repoInfo(dir);
    if (!repo) return NOT_REPO;
    try {
      const base = repo.head ?? (await emptyTree(repo));
      const diff = await readRange(repo, { from: base });
      return { repo: true, base, ...branchOf(repo), ...diff };
    } catch {
      return NOT_REPO;
    }
  });
}

/** `staged`（0.67.0）：暂存区对 HEAD（还没有提交时对空树），不含未跟踪文件。 */
export function readStaged(dir: string): Promise<WorkspaceDiffResult> {
  return shared(`staged\0${dir}`, async () => {
    const repo = await repoInfo(dir);
    if (!repo) return NOT_REPO;
    try {
      const base = repo.head ?? (await emptyTree(repo));
      const diff = await readRange(repo, { from: base, cached: true });
      return { repo: true, base, ...branchOf(repo), ...diff };
    } catch {
      return NOT_REPO;
    }
  });
}

/** `branch`：工作树对默认分支与 HEAD 的 merge-base。找不到默认分支或没有共同的提交时同 `uncommitted`。 */
export function readBranch(dir: string): Promise<WorkspaceDiffResult> {
  return shared(`branch\0${dir}`, async () => {
    const repo = await repoInfo(dir);
    if (!repo) return NOT_REPO;
    try {
      const { base, baseRef } = await branchBase(repo);
      const diff = await readRange(repo, { from: base });
      return {
        repo: true,
        base,
        ...(baseRef !== undefined && { baseRef }),
        ...branchOf(repo),
        ...diff,
      };
    } catch {
      return NOT_REPO;
    }
  });
}

/** `branch` 的旧的一侧：默认分支与 HEAD 的 merge-base；找不到默认分支或没有共同的提交时是 HEAD（还没有提交时是空树）。 */
async function branchBase(repo: RepoInfo): Promise<{ base: string; baseRef?: string }> {
  if (repo.head !== undefined) {
    const candidate = await defaultBranch(repo);
    if (candidate !== undefined) {
      const merge = await git(repo, ['merge-base', candidate, 'HEAD'], { okCodes: [0, 1] });
      const sha = merge.stdout.toString('utf8').trim();
      if (merge.code === 0 && sha !== '') return { base: sha, baseRef: candidate };
    }
  }
  return { base: repo.head ?? (await emptyTree(repo)) };
}

/**
 * `uncommitted` 或 `branch` 那段 diff 的旧的一侧（0.83.0，审查发现存成批注时用），不读 diff 本身。不是 git 仓库或读不了时
 * undefined。
 */
export async function diffBase(
  dir: string,
  kind: 'uncommitted' | 'branch',
): Promise<{ base: string; branch?: string } | undefined> {
  const repo = await repoInfo(dir);
  if (!repo) return undefined;
  try {
    const base =
      kind === 'branch' ? (await branchBase(repo)).base : (repo.head ?? (await emptyTree(repo)));
    return { base, ...branchOf(repo) };
  } catch {
    return undefined;
  }
}

function branchOf(repo: RepoInfo): { branch?: string } {
  return repo.branch === undefined ? {} : { branch: repo.branch };
}

// ── workspace.diffFile ──────────────────────────────────────────────

export interface DiffFileRequest {
  oldRev?: string;
  oldPath?: string;
  newRev?: string;
  newPath?: string;
}

/** 路径要是相对的、`/` 分隔、不往上走。 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.includes('\0') || path.includes('\\') || isAbsolute(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * 一个文件两侧的全文。旧的一侧与有 `newRev` 的新的一侧用 `cat-file blob <rev>:./<路径>`（不经 textconv 与过滤器），没有
 * `newRev` 的新的一侧读磁盘：realpath 后仍要在目录里、是普通文件。超过 1 MiB、含 NUL 字节、不存在时回 `unavailable`。
 */
export async function readDiffFile(
  dir: string,
  request: DiffFileRequest,
): Promise<WorkspaceDiffFileResult | undefined> {
  const repo = await repoInfo(dir);
  if (!repo) return undefined;
  const sides: Promise<string | Unavailable>[] = [];
  if (request.oldPath !== undefined && request.oldRev !== undefined) {
    sides.push(readBlob(repo, request.oldRev, request.oldPath));
  } else sides.push(Promise.resolve(''));
  if (request.newPath !== undefined) {
    sides.push(
      request.newRev === undefined
        ? readDisk(repo.cwd, request.newPath)
        : readBlob(repo, request.newRev, request.newPath),
    );
  } else sides.push(Promise.resolve(''));
  const [oldSide, newSide] = (await Promise.all(sides)) as [
    string | Unavailable,
    string | Unavailable,
  ];
  for (const side of [oldSide, newSide]) {
    if (typeof side !== 'string') return { unavailable: side.unavailable };
  }
  return {
    ...(request.oldPath !== undefined && { oldContents: oldSide as string }),
    ...(request.newPath !== undefined && { newContents: newSide as string }),
  };
}

interface Unavailable {
  unavailable: 'too_large' | 'binary' | 'not_found';
}

async function readBlob(repo: RepoInfo, rev: string, path: string): Promise<string | Unavailable> {
  const object = `${rev}:./${path}`;
  const size = await git(repo, ['cat-file', '-s', object], { okCodes: [0, 128] });
  if (size.code !== 0) return { unavailable: 'not_found' };
  if (Number(size.stdout.toString('utf8').trim()) > DIFF_FILE_CONTENTS_MAX_BYTES) {
    return { unavailable: 'too_large' };
  }
  const { stdout } = await git(repo, ['cat-file', 'blob', object], {
    maxBytes: DIFF_FILE_CONTENTS_MAX_BYTES,
  });
  return stdout.includes(0) ? { unavailable: 'binary' } : stdout.toString('utf8');
}

async function readDisk(root: string, path: string): Promise<string | Unavailable> {
  const requested = resolve(root, path);
  if (!within(root, requested)) return { unavailable: 'not_found' };
  try {
    const target = await realpath(requested);
    if (!within(root, target)) return { unavailable: 'not_found' };
    const info = await stat(target);
    if (!info.isFile()) return { unavailable: 'not_found' };
    if (info.size > DIFF_FILE_CONTENTS_MAX_BYTES) return { unavailable: 'too_large' };
    const bytes = await readFile(target);
    return bytes.includes(0) ? { unavailable: 'binary' } : bytes.toString('utf8');
  } catch {
    return { unavailable: 'not_found' };
  }
}
