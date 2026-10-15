// 工作区目录的 git 状态（0.13.0，U18，host-api.md §3.1 的 `workspace.git`）：当前分支与相对 HEAD 的改动，给桌面端
// 会话侧栏的“环境”与“变更”卡片。每次现跑只读的 git 命令，不缓存；同一个目录同时只跑一份，并发的调用共用结果。

import { execFile } from 'node:child_process';
import {
  type GitFileChange,
  WORKSPACE_GIT_MAX_FILES,
  type WorkspaceGitResult,
} from '@wevir/protocol';

/** 每条 git 命令的时限；超时按“不是仓库”处理。 */
const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 不在不受信任的仓库里执行仓库配置里的命令：关掉 fsmonitor 钩子与外部 diff（`--no-ext-diff`、`--no-textconv` 在
 * diff 的参数里），也不用 untracked cache（它会写索引）。
 */
const SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'diff.external=',
];
const DIFF_ARGS = ['--no-renames', '--no-ext-diff', '--no-textconv', '--relative'];

const NOT_REPO: WorkspaceGitResult = { repo: false };

const inFlight = new Map<string, Promise<WorkspaceGitResult>>();

/** `root` 是工作区目录的 realpath。不是仓库、没有 git、出错或超时都是 `{ repo: false }`，不抛错。 */
export function readGitStatus(root: string): Promise<WorkspaceGitResult> {
  const running = inFlight.get(root);
  if (running) return running;
  const promise = read(root).finally(() => inFlight.delete(root));
  inFlight.set(root, promise);
  return promise;
}

async function read(root: string): Promise<WorkspaceGitResult> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return NOT_REPO;

  const [branch, head] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(root, ['rev-parse', '--verify', '--quiet', '--short', 'HEAD']),
  ]);
  const hasHead = head !== undefined && head.trim() !== '';
  // 还没有提交时（新仓库、孤立分支）只能比较暂存区。
  const base = hasHead ? ['HEAD', '--'] : ['--cached', '--'];
  const [numstat, nameStatus, untracked] = await Promise.all([
    git(root, ['diff', '--numstat', '-z', ...DIFF_ARGS, ...base]),
    git(root, ['diff', '--name-status', '-z', ...DIFF_ARGS, ...base]),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (numstat === undefined || nameStatus === undefined || untracked === undefined) return NOT_REPO;

  const lines = parseNumstat(numstat);
  const statuses = parseNameStatus(nameStatus);
  const tracked: GitFileChange[] = lines.map(({ path, added, removed }) => ({
    path,
    status: statuses.get(path) ?? 'modified',
    ...(added !== undefined && { added }),
    ...(removed !== undefined && { removed }),
  }));
  const others: GitFileChange[] = splitZ(untracked).map((path) => ({ path, status: 'untracked' }));
  const all = [...tracked, ...others];
  const branchName = branch?.trim();
  return {
    repo: true,
    ...(branchName ? { branch: branchName } : hasHead && { detachedAt: head.trim() }),
    added: sum(tracked, 'added'),
    removed: sum(tracked, 'removed'),
    fileCount: all.length,
    files: all.slice(0, WORKSPACE_GIT_MAX_FILES),
    ...(all.length > WORKSPACE_GIT_MAX_FILES && { truncated: true }),
  };
}

/** 跑一条 git 命令，成功时是 stdout，失败（退出码非 0、没有 git、超时）时是 undefined。 */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        env: gitEnv(),
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/** 继承 Host 的环境（PATH、HOME 找全局配置），去掉会把 git 指到别处的 GIT_* 变量。 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    // 不拿索引锁、不弹凭据提示、输出不翻译。
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

function splitZ(output: string): string[] {
  return output.split('\0').filter((part) => part !== '');
}

/** `diff --numstat -z`（不跟踪重命名）：每项 `增\t删\t路径\0`，二进制文件的增删是 `-`。 */
export function parseNumstat(output: string): { path: string; added?: number; removed?: number }[] {
  return splitZ(output).flatMap((record) => {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
    if (!match) return [];
    const [, added, removed, path] = match as unknown as [string, string, string, string];
    return [
      {
        path,
        ...(added !== '-' && { added: Number(added) }),
        ...(removed !== '-' && { removed: Number(removed) }),
      },
    ];
  });
}

const STATUS_NAMES: Record<string, string> = { A: 'added', D: 'deleted', M: 'modified' };

/** `diff --name-status -z`：`字母\0路径\0` 交替；类型变化（T）等按修改算。 */
export function parseNameStatus(output: string): Map<string, string> {
  const parts = splitZ(output);
  const statuses = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const letter = (parts[index] as string).charAt(0);
    statuses.set(parts[index + 1] as string, STATUS_NAMES[letter] ?? 'modified');
  }
  return statuses;
}

function sum(files: readonly GitFileChange[], key: 'added' | 'removed'): number {
  return files.reduce((total, file) => total + (file[key] ?? 0), 0);
}
