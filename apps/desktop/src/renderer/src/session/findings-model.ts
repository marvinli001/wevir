// 审查发现卡片（0.83.0，`review.findings`）的换算：事件里的发现 + Host 现读的批注 → 每一行此刻的状态、能做什么、跳到哪。

import type { ReviewComment, ReviewCommentId, ReviewFinding } from '@wevir/protocol';

/**
 * 一条发现此刻的状态：`open` 还没处理（存成了批注、没发）；`outdated` 同 `open`，但文件改了、原来那几行找不到了；`sent` 已发给
 * 会话去修；`dismissed` 批注已删；`text` 没存成批注（文件不在目录里、行超出文件），只有文字；`unknown` 批注还没读到。
 */
export type FindingState = 'open' | 'outdated' | 'sent' | 'dismissed' | 'text' | 'unknown';

export interface FindingRow {
  finding: ReviewFinding;
  state: FindingState;
  /** 跳到哪：批注此刻的位置（新的一侧），没有批注时是报出的行。 */
  path?: string;
  line?: number;
  /** 位置的文字：`path:行` 或 `path:起-止`，目录外的原样。 */
  location: string;
  /** 批注针对的那段 diff：“变更”窗格打开这个范围。 */
  scope: 'uncommitted' | 'branch';
}

/** `comments` 是 Host 读到的这个目录里全部批注（含已发送的）；还没读到时 undefined。 */
export function findingRows(
  findings: readonly ReviewFinding[],
  comments: readonly ReviewComment[] | undefined,
): FindingRow[] {
  const byId = new Map<ReviewCommentId, ReviewComment>(
    (comments ?? []).map((comment) => [comment.id, comment]),
  );
  return findings.map((finding) => {
    const comment = finding.commentId === undefined ? undefined : byId.get(finding.commentId);
    const state = stateOf(finding, comment, comments !== undefined);
    const start =
      comment?.anchor.state !== 'outdated'
        ? (comment?.anchor.startLine ?? finding.startLine)
        : finding.startLine;
    const end =
      comment?.anchor.state !== 'outdated'
        ? (comment?.anchor.endLine ?? finding.endLine)
        : finding.endLine;
    const path = finding.path;
    return {
      finding,
      state,
      ...(path !== undefined && { path }),
      ...(start !== undefined && { line: start }),
      location:
        path === undefined
          ? (finding.location ?? '')
          : start === undefined
            ? path
            : end === undefined || end === start
              ? `${path}:${start}`
              : `${path}:${start}-${end}`,
      scope: comment?.source.kind === 'branch' ? 'branch' : 'uncommitted',
    };
  });
}

function stateOf(
  finding: ReviewFinding,
  comment: ReviewComment | undefined,
  loaded: boolean,
): FindingState {
  if (finding.commentId === undefined) return 'text';
  if (!loaded) return 'unknown';
  if (comment === undefined) return 'dismissed';
  if (comment.status === 'sent') return 'sent';
  return comment.anchor.state === 'outdated' ? 'outdated' : 'open';
}

/** 还能发去修的（没发、没删）。 */
export function fixable(row: FindingRow): boolean {
  return row.state === 'open' || row.state === 'outdated';
}
