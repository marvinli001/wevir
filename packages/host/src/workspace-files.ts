// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/workspace/WorkspaceEntries.ts、WorkspaceFileSystem.ts、WorkspaceSearchIndex.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写，不用 Effect 与 fff（见下）。
//
// 工作区的文件（host-api.md §3.1 的 `workspace.files` / `workspace.listDir` / `workspace.readFile`，0.22.0；0.32.0 起还有
// `workspace.writeFile` 与 `workspace.fileUrl` 用的 statWorkspaceFile）：给桌面端输入框的 @ 提及与文件窗格找文件、列目录、读写内容。做法参照 T3 Code 的 WorkspaceEntries / WorkspaceFileSystem（MIT，ec1313c）：
// 名字搜索在一份按目录缓存的文件索引上做（T3 用 fff，Wevir 在 git 仓库里用 `git ls-files`，否则自己遍历，最多 25 000 项），
// 读文件限 1 MiB、含 NUL 字节算二进制，路径 realpath 之后仍要在目录里。图片按扩展名给 base64，供窗格预览。
//
// git 命令照 git-diff.ts 的规矩：不执行仓库配置里的命令（safeConfig），去掉 GIT_* 环境变量，限时。

import type { Dirent } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  type PreviewImageMimeType,
  type RankedSearchResult,
  scoreQueryMatch,
  WORKSPACE_LIST_DIR_MAX_ENTRIES,
  WORKSPACE_READ_IMAGE_MAX_BYTES,
  WORKSPACE_READ_TEXT_MAX_BYTES,
  WORKSPACE_WRITE_TEXT_MAX_BYTES,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceFilesResult,
  type WorkspaceListDirResult,
  type WorkspaceReadFileResult,
  type WorkspaceWriteFileResult,
} from '@wevir/protocol';
import { type RepoInfo, repoInfo, runGit } from './git-diff.js';

/** 索引最多收这么多项（文件与文件夹合计）。 */
export const FILE_INDEX_MAX_ENTRIES = 25_000;
/** 索引用多久：过期后下一次搜索重新建（同时只建一次）。 */
const INDEX_TTL_MS = 5_000;
/** 最多缓存几个目录的索引。 */
const INDEX_CACHE_SIZE = 8;
/** 不是 git 仓库时遍历目录的时限。 */
const WALK_TIMEOUT_MS = 10_000;
/** `workspace.files` 的默认条数。 */
export const DEFAULT_FILES_LIMIT = 50;

/** 不是 git 仓库时不进去的目录（依赖、版本库与缓存）。 */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'target',
]);

const IMAGE_TYPES: Record<string, PreviewImageMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

export interface FileIndexSnapshot {
  /** 相对目录的路径，`/` 分隔。 */
  files: string[];
  directories: string[];
  /** 到上限没有列全。 */
  truncated: boolean;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 文件路径的各级父目录。 */
function parentDirectories(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let index = file.lastIndexOf('/');
    while (index > 0) {
      const parent = file.slice(0, index);
      if (directories.has(parent)) break;
      directories.add(parent);
      index = parent.lastIndexOf('/');
    }
  }
  return [...directories];
}

/** git 仓库：跟踪的加上没被忽略的未跟踪文件（相对 `repo.cwd`）。 */
async function listGitFiles(repo: RepoInfo): Promise<FileIndexSnapshot> {
  const { stdout, truncated } = await runGit(
    repo.cwd,
    [
      ...repo.config,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--deduplicate',
    ],
    { maxBytes: 16 * 1024 * 1024, overflow: 'truncate' },
  );
  const all = stdout.toString('utf8').split('\0');
  // 截断时最后一项可能只有半截。
  if (truncated) all.pop();
  const files = all.filter((path) => path !== '');
  const limited = files.length > FILE_INDEX_MAX_ENTRIES;
  const kept = limited ? files.slice(0, FILE_INDEX_MAX_ENTRIES) : files;
  const directories = parentDirectories(kept);
  return { files: kept, directories, truncated: truncated || limited };
}

/** 不是 git 仓库：逐层遍历，跳过依赖与版本库目录、符号链接，到上限或超时就停。 */
async function walkFiles(root: string): Promise<FileIndexSnapshot> {
  const files: string[] = [];
  const directories: string[] = [];
  const deadline = Date.now() + WALK_TIMEOUT_MS;
  let truncated = false;
  let queue = [''];
  while (queue.length > 0 && !truncated) {
    const next: string[] = [];
    for (const dir of queue) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length + directories.length >= FILE_INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
          directories.push(path);
          next.push(path);
        } else if (entry.isFile()) {
          files.push(path);
        }
      }
      if (truncated) break;
    }
    queue = next;
  }
  return { files, directories, truncated };
}

/** 按目录缓存的文件索引：过期后重建，同一个目录同时只建一次。 */
export class FileIndex {
  readonly #cache = new Map<string, { at: number; snapshot: Promise<FileIndexSnapshot> }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** `dir` 要是 realpath。 */
  snapshot(dir: string): Promise<FileIndexSnapshot> {
    const cached = this.#cache.get(dir);
    if (cached && this.#now() - cached.at < INDEX_TTL_MS) return cached.snapshot;
    const snapshot = (async () => {
      const repo = await repoInfo(dir);
      return repo ? listGitFiles(repo) : walkFiles(dir);
    })();
    this.#cache.delete(dir);
    this.#cache.set(dir, { at: this.#now(), snapshot });
    while (this.#cache.size > INDEX_CACHE_SIZE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    // 建失败不留在缓存里，下一次重试。
    snapshot.catch(() => {
      if (this.#cache.get(dir)?.snapshot === snapshot) this.#cache.delete(dir);
    });
    return snapshot;
  }
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function depthOf(path: string): number {
  let depth = 0;
  for (const char of path) if (char === '/') depth += 1;
  return depth;
}

/** 一条路径对查询的分数（越小越好）：名字的匹配优先，其次是整条路径。 */
export function scorePath(path: string, query: string): number | null {
  const lower = path.toLowerCase();
  const scores: number[] = [];
  if (!query.includes('/')) {
    const name = scoreQueryMatch({
      value: basenameOf(lower),
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ['-', '_', '.', ' '],
    });
    if (name !== null) scores.push(name);
  }
  const full = scoreQueryMatch({
    value: lower,
    query,
    exactBase: 10,
    prefixBase: 12,
    boundaryBase: 14,
    includesBase: 16,
    fuzzyBase: 200,
    boundaryMarkers: ['/', '-', '_', '.'],
  });
  if (full !== null) scores.push(full);
  return scores.length === 0 ? null : Math.min(...scores);
}

/** 在索引里按名字找；空查询按层级从浅到深、同一层文件夹在前、再按路径给出前 `limit` 项。 */
export function searchIndex(
  snapshot: FileIndexSnapshot,
  query: string,
  limit: number,
  kind?: WorkspaceEntryKind,
): WorkspaceFilesResult {
  const candidates: WorkspaceEntry[] = [];
  if (kind !== 'file') {
    for (const path of snapshot.directories) candidates.push({ path, kind: 'directory' });
  }
  if (kind !== 'directory') {
    for (const path of snapshot.files) candidates.push({ path, kind: 'file' });
  }
  const normalized = normalizeSearchQuery(query, { trimLeadingPattern: /^@+/ });
  let entries: WorkspaceEntry[];
  let more: boolean;
  if (normalized === '') {
    const sorted = candidates.sort(
      (a, b) =>
        depthOf(a.path) - depthOf(b.path) ||
        (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) ||
        a.path.localeCompare(b.path),
    );
    entries = sorted.slice(0, limit);
    more = sorted.length > limit;
  } else {
    const ranked: RankedSearchResult<WorkspaceEntry>[] = [];
    let matches = 0;
    for (const entry of candidates) {
      const score = scorePath(entry.path, normalized);
      if (score === null) continue;
      matches += 1;
      insertRankedSearchResult(ranked, { item: entry, score, tieBreaker: entry.path }, limit);
    }
    entries = ranked.map((result) => result.item);
    more = matches > limit;
  }
  return {
    entries,
    ...((more || snapshot.truncated) && { truncated: true as const }),
  };
}

/** 被 `.gitignore` 忽略的那些路径（相对 `repo.cwd`）。 */
async function ignoredPaths(repo: RepoInfo, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  try {
    const { stdout } = await runGit(repo.cwd, [...repo.config, 'check-ignore', '-z', '--stdin'], {
      stdin: `${paths.join('\0')}\0`,
      // 1：一个都没被忽略。
      okCodes: [0, 1],
    });
    return new Set(
      stdout
        .toString('utf8')
        .split('\0')
        .filter((path) => path !== ''),
    );
  } catch {
    return new Set();
  }
}

/**
 * 列 `root` 下 `path` 这个目录的直接子项：文件夹在前、再按名字；跳过 `.git`、指到目录外或别的类型的符号链接。目录不存在
 * 或不在 `root` 里时是空表。git 仓库里标出被忽略的项。
 */
export async function listDirectory(root: string, path: string): Promise<WorkspaceListDirResult> {
  const target = resolve(root, path);
  let real: string;
  try {
    real = await realpath(target);
    if (!within(root, real) || !(await stat(real)).isDirectory()) return { entries: [] };
  } catch {
    return { entries: [] };
  }
  let dirents: Dirent[];
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch {
    return { entries: [] };
  }
  const prefix = path === '' ? '' : `${path}/`;
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === '.git') continue;
    let kind: WorkspaceEntryKind | undefined;
    if (dirent.isDirectory()) kind = 'directory';
    else if (dirent.isFile()) kind = 'file';
    else if (dirent.isSymbolicLink()) {
      try {
        const linked = await realpath(join(real, dirent.name));
        if (!within(root, linked)) continue;
        const info = await stat(linked);
        kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined;
      } catch {
        continue;
      }
    }
    if (kind) entries.push({ path: `${prefix}${dirent.name}`, kind });
  }
  entries.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) ||
      basenameOf(a.path).localeCompare(basenameOf(b.path), undefined, { numeric: true }),
  );
  const truncated = entries.length > WORKSPACE_LIST_DIR_MAX_ENTRIES;
  const kept = truncated ? entries.slice(0, WORKSPACE_LIST_DIR_MAX_ENTRIES) : entries;
  const repo = await repoInfo(root);
  if (repo) {
    // check-ignore 的路径相对它的工作目录（会话目录）。
    const base = toPosix(relative(repo.cwd, root));
    const toRepo = (entryPath: string) => (base === '' ? entryPath : `${base}/${entryPath}`);
    const ignored = await ignoredPaths(
      repo,
      kept.map((entry) => toRepo(entry.path)),
    );
    for (const entry of kept) if (ignored.has(toRepo(entry.path))) entry.ignored = true;
  }
  return { entries: kept, ...(truncated && { truncated: true as const }) };
}

/** `root` 下 `path` 这个普通文件的 realpath、字节数与修改时间；不存在、不是普通文件或 realpath 在 `root` 之外时是 undefined。 */
export async function statWorkspaceFile(
  root: string,
  path: string,
): Promise<{ real: string; size: number; mtimeMs: number } | undefined> {
  try {
    const real = await realpath(resolve(root, path));
    if (!within(root, real)) return undefined;
    const info = await stat(real);
    if (!info.isFile()) return undefined;
    return { real, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * 读 `root` 下的 `path`：图片（按扩展名）给 base64，其余当 UTF-8 文本；超过上限、含 NUL 字节、不存在、不是普通文件或
 * realpath 在 `root` 之外时给 `unavailable`。读到时带这一版的 `mtimeMs`（0.32.0）。
 */
export async function readWorkspaceFile(
  root: string,
  path: string,
): Promise<WorkspaceReadFileResult> {
  const notFound: WorkspaceReadFileResult = { path, unavailable: 'not_found' };
  const file = await statWorkspaceFile(root, path);
  if (!file) return notFound;
  const { real, size, mtimeMs } = file;
  const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
  const limit = mimeType ? WORKSPACE_READ_IMAGE_MAX_BYTES : WORKSPACE_READ_TEXT_MAX_BYTES;
  if (size > limit) return { path, size, unavailable: 'too_large' };
  let bytes: Buffer;
  try {
    bytes = await readFile(real);
  } catch {
    return notFound;
  }
  if (bytes.length > limit) return { path, size: bytes.length, unavailable: 'too_large' };
  if (mimeType) {
    return {
      path,
      size: bytes.length,
      mtimeMs,
      image: { mimeType, data: bytes.toString('base64') },
    };
  }
  if (bytes.includes(0)) return { path, size: bytes.length, unavailable: 'binary' };
  return { path, size: bytes.length, mtimeMs, text: bytes.toString('utf8') };
}

/** `workspace.writeFile` 拒绝写的原因（host-methods 把它换成 `INVALID_PARAMS`）。 */
export class WriteRejected extends Error {}

/**
 * 把 `text` 写回 `root` 下已有的普通文件 `path`（0.32.0，文件窗格的编辑）。带 `expectedMtimeMs` 时，磁盘上的修改时间与它不同
 * （或文件已删除）就不写，回 `conflict`。原地写，保留权限与硬链接；不新建文件。
 */
export async function writeWorkspaceFile(
  root: string,
  path: string,
  text: string,
  expectedMtimeMs: number | undefined,
): Promise<WorkspaceWriteFileResult> {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > WORKSPACE_WRITE_TEXT_MAX_BYTES) throw new WriteRejected('text is too large');
  const file = await statWorkspaceFile(root, path);
  if (!file) {
    if (expectedMtimeMs !== undefined) return { path, conflict: true };
    throw new WriteRejected('path is not an existing file inside the directory');
  }
  if (expectedMtimeMs !== undefined && file.mtimeMs !== expectedMtimeMs) {
    return { path, size: file.size, mtimeMs: file.mtimeMs, conflict: true };
  }
  // r+ 不新建也不换 inode；先写再截断，免得中途失败留下空文件。
  const handle = await open(file.real, 'r+');
  try {
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    const info = await handle.stat();
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}
