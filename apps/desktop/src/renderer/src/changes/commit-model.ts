// 提交区的纯逻辑（0.67.0，ADR-0009）：按暂存与否分组、其他已暂存内容、验证记录与失败原因的文案。

import type {
  GitCommitOutcome,
  GitStatusFile,
  GitStatusResult,
  VerificationStatus,
} from '@wevir/protocol';
import { t } from '@/i18n';

export interface CommitGroups {
  /** 目录里已暂存的（可取消暂存）。 */
  staged: GitStatusFile[];
  /** 目录里没暂存的改动、未跟踪与冲突的文件（可暂存，冲突的除外）。 */
  unstaged: GitStatusFile[];
  /** 不是经 Wevir 暂存的已暂存内容（含目录外的）：要勾选才一起提交。 */
  external: GitStatusFile[];
}

export function groupFiles(status: GitStatusResult | undefined): CommitGroups {
  const files = status?.files ?? [];
  return {
    staged: files.filter((file) => file.staged !== undefined && file.outside !== true),
    unstaged: files.filter(
      (file) => (file.unstaged !== undefined || file.conflicted === true) && file.outside !== true,
    ),
    external: files.filter((file) => file.staged?.by === 'external'),
  };
}

/** 能不能点“提交”（失败的原因由 Host 判断，这里只挡明显不行的）。 */
export function canCommit(
  status: GitStatusResult | undefined,
  groups: CommitGroups,
  message: string,
  includeExternal: boolean,
): boolean {
  if (status?.repo !== true || status.operation !== undefined || message.trim() === '') {
    return false;
  }
  if (status.files?.some((file) => file.conflicted === true)) return false;
  if (groups.external.length > 0 && !includeExternal) return false;
  return groups.staged.length > 0 || groups.external.length > 0;
}

/** 文件在索引里的情况（diff 文件头的勾选框）：全部暂存、部分暂存、没暂存、冲突（不能暂存）。 */
export type StageState = 'staged' | 'partial' | 'unstaged' | 'conflicted';

export function stageState(file: GitStatusFile | undefined): StageState | undefined {
  if (file === undefined || file.outside === true) return undefined;
  if (file.conflicted === true) return 'conflicted';
  if (file.staged !== undefined) return file.unstaged !== undefined ? 'partial' : 'staged';
  return file.unstaged !== undefined ? 'unstaged' : undefined;
}

/** 目录里有改动的文件数（暂存与否都算一次，目录外的不算）。 */
export function changedCount(groups: CommitGroups): number {
  return new Set([...groups.staged, ...groups.unstaged].map((file) => file.path)).size;
}

/** 文件一侧的状态字母（列表里用）。 */
export function statusLetter(file: GitStatusFile, side: 'staged' | 'unstaged'): string {
  if (file.conflicted === true) return '!';
  const status = side === 'staged' ? file.staged?.status : file.unstaged?.status;
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'untracked':
      return 'U';
    case 'type_changed':
      return 'T';
    default:
      return 'M';
  }
}

export type CheckTone = 'passed' | 'failed' | 'stale' | 'running' | 'not_run';

/** 验证记录在提交区只分五种：通过、失败、过期、运行中、未运行（取消的也算未运行）。 */
export function checkTone(status: VerificationStatus): CheckTone {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timed_out':
    case 'environment_unavailable':
      return 'failed';
    case 'stale':
      return 'stale';
    case 'running':
      return 'running';
    default:
      return 'not_run';
  }
}

export function checkLabel(tone: CheckTone): string {
  switch (tone) {
    case 'passed':
      return t('commit.check.passed');
    case 'failed':
      return t('commit.check.failed');
    case 'stale':
      return t('commit.check.stale');
    case 'running':
      return t('commit.check.running');
    case 'not_run':
      return t('commit.check.notRun');
  }
}

export function operationLabel(operation: string): string {
  switch (operation) {
    case 'merge':
      return t('commit.operation.merge');
    case 'rebase':
      return t('commit.operation.rebase');
    case 'cherry_pick':
      return t('commit.operation.cherryPick');
    case 'revert':
      return t('commit.operation.revert');
    default:
      return t('commit.operation.other');
  }
}

/** 提交失败的标题。 */
export function failureLabel(outcome: Extract<GitCommitOutcome, { kind: 'failed' }>): string {
  switch (outcome.reason) {
    case 'hook_failed':
      return t('commit.failed.hook', { hook: outcome.hook ?? 'hook' });
    case 'signing_failed':
      return t('commit.failed.signing');
    case 'identity_missing':
      return t('commit.failed.identity');
    case 'index_locked':
      return t('commit.failed.indexLocked');
    case 'empty_message':
      return t('commit.failed.emptyMessage');
    case 'unmerged':
      return t('commit.failed.unmerged');
    case 'nothing_staged':
      return t('commit.failed.nothingStaged');
    case 'external_staged':
      return t('commit.failed.external');
    case 'operation_in_progress':
      return t('commit.failed.operation');
    case 'timed_out':
      return t('commit.failed.timedOut');
    default:
      return t('commit.failed.git');
  }
}
