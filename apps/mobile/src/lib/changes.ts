// 会话的变更（只读）：`session.get` 取工作区，再读 `workspace.diff` 的 `branch` 一段——分支领先默认分支时是分叉以来加未提交的
// 改动，否则（在默认分支上、找不到默认分支）只有未提交的，同桌面“变更”窗格与 Claude Code 的口径。读到的放在内存里，
// 单个文件的页面直接用，不再读一遍。连接由调用方注入，测试用假的。

import { type WevirClient, WevirRpcError } from '@wevir/client-sdk';
import type { DiffFile, SessionId, WorkspaceDiffResult, WorkspaceId } from '@wevir/protocol';
import type { MessageKey } from '../i18n/zh-CN';
import { type DiffRow, diffRowsByPath } from './diff';

/** 一台电脑上读变更与文件的接口（`WevirClient` 的一部分）。 */
export interface ChangesClient {
  /** 这台设备有 `workspace.read`。 */
  readonly canRead: boolean;
  /** Host 有 `workspace_diff`（0.20.0）。 */
  readonly supportsDiff: boolean;
  /** Host 有 `files_read`（0.102.0）。 */
  readonly supportsFiles: boolean;
  request: WevirClient['request'];
}

export interface Changes {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  diff: WorkspaceDiffResult;
  files: readonly DiffFile[];
  rows: ReadonlyMap<string, DiffRow[]>;
}

export type ChangesProblem =
  /** 设备没有 `workspace.read`，或 Host 回 `DEVICE_FORBIDDEN`。 */
  | 'forbidden'
  /** Host 太旧，没有 `workspace_diff`。 */
  | 'unsupported'
  /** 会话目录不是 git 仓库（或 git 出错、超时）。 */
  | 'not_repo'
  | 'failed';

export class ChangesError extends Error {
  readonly problem: ChangesProblem;
  constructor(problem: ChangesProblem, cause?: unknown) {
    super(problem, { cause });
    this.problem = problem;
  }
}

/** 读不到变更时的说明。 */
export const PROBLEM_TEXT: Record<ChangesProblem, MessageKey> = {
  forbidden: 'changes.forbidden',
  unsupported: 'changes.unsupported',
  not_repo: 'changes.notRepo',
  failed: 'changes.failed',
};

export function problemOf(error: unknown): ChangesProblem {
  if (error instanceof ChangesError) return error.problem;
  if (error instanceof WevirRpcError && error.is('DEVICE_FORBIDDEN')) return 'forbidden';
  return 'failed';
}

const cache = new Map<string, Changes>();
const CACHE_MAX = 8;

export function cachedChanges(key: string): Changes | undefined {
  return cache.get(key);
}

export async function loadChanges(
  client: ChangesClient,
  key: string,
  sessionId: SessionId,
): Promise<Changes> {
  if (!client.canRead) throw new ChangesError('forbidden');
  if (!client.supportsDiff) throw new ChangesError('unsupported');
  try {
    const { session } = await client.request('session.get', { sessionId });
    const diff = await client.request('workspace.diff', {
      workspaceId: session.workspaceId,
      sessionId,
      source: { kind: 'branch' },
    });
    if (!diff.repo) throw new ChangesError('not_repo');
    const changes: Changes = {
      workspaceId: session.workspaceId,
      sessionId,
      diff,
      files: diff.files ?? [],
      rows: diffRowsByPath(diff.patch),
    };
    cache.delete(key);
    cache.set(key, changes);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return changes;
  } catch (error) {
    throw error instanceof ChangesError ? error : new ChangesError(problemOf(error), error);
  }
}

/** 文件状态的一个字母：A 新增、D 删除、R 重命名、C 复制、U 未跟踪、T 类型变了、其余 M。 */
export function statusLetter(status: string): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'untracked':
      return 'U';
    case 'type_changed':
      return 'T';
    default:
      return 'M';
  }
}
