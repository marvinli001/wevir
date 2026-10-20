// 行级批注（0.67.0，ADR-0009）在“变更”窗格里的换算：Pierre 的选行（左右侧 + 行号）→ 批注的一侧与行范围；Host 返回的批注 →
// 当前这段 diff 里该画在哪一行。

import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import type { ReviewComment, ReviewSide } from '@wevir/protocol';

export interface ReviewRange {
  side: ReviewSide;
  startLine: number;
  endLine: number;
}

/**
 * 选中的行 → 批注的范围。同一侧照搬；统一视图里从删除的行拖到新增的行（两侧混选）时记在新的一侧：删除那一端换成它在新文件里
 * 对应的位置。
 */
export function toReviewRange(fileDiff: FileDiffMetadata, range: SelectedLineRange): ReviewRange {
  const startSide = range.side ?? 'additions';
  const endSide = range.endSide ?? startSide;
  if (startSide === endSide) {
    return {
      side: startSide === 'deletions' ? 'old' : 'new',
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
    };
  }
  const deleted = startSide === 'deletions' ? range.start : range.end;
  const added = startSide === 'deletions' ? range.end : range.start;
  const mapped = newLineForOldLine(fileDiff, deleted);
  return { side: 'new', startLine: Math.min(mapped, added), endLine: Math.max(mapped, added) };
}

/** 旧文件的第 `line` 行在新文件里对应的行：上下文行是同一行，删除的行是它所在改动块的第一行新增（或之后那一行）。 */
export function newLineForOldLine(fileDiff: FileDiffMetadata, line: number): number {
  let delta = 0;
  for (const hunk of fileDiff.hunks) {
    if (line < hunk.deletionStart) break;
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const segment of hunk.hunkContent) {
      if (segment.type === 'context') {
        if (line < oldLine + segment.lines) return Math.max(1, newLine + (line - oldLine));
        oldLine += segment.lines;
        newLine += segment.lines;
      } else {
        if (line < oldLine + segment.deletions) return Math.max(1, newLine);
        oldLine += segment.deletions;
        newLine += segment.additions;
      }
    }
    delta = newLine - oldLine;
  }
  return Math.max(1, line + delta);
}

/** 当前这段 diff：旧的一侧（`base`）与新的一侧（`head`，省略时是磁盘上的工作树）。 */
export interface DiffView {
  base: string | undefined;
  head: string | undefined;
}

/**
 * 一条批注在这段 diff 里画在哪：新的一侧对着工作树的 diff 用 Host 现算的位置（过期的不画），对着回合快照的 diff 只画在同一个快照上
 * 写的；旧的一侧只画在同一个基线上。
 */
export function placeComment(comment: ReviewComment, view: DiffView): ReviewRange | undefined {
  if (comment.status !== 'pending') return undefined;
  if (comment.side === 'old') {
    if (view.base === undefined || comment.base !== view.base) return undefined;
    return { side: 'old', startLine: comment.startLine, endLine: comment.endLine };
  }
  if (view.head !== undefined) {
    if (comment.head !== view.head) return undefined;
    return { side: 'new', startLine: comment.startLine, endLine: comment.endLine };
  }
  const { anchor } = comment;
  if (anchor.state === 'outdated' || anchor.startLine === undefined) return undefined;
  return {
    side: 'new',
    startLine: anchor.startLine,
    endLine: anchor.endLine ?? anchor.startLine,
  };
}

/** Pierre 的一侧。 */
export function pierreSide(side: ReviewSide): 'deletions' | 'additions' {
  return side === 'old' ? 'deletions' : 'additions';
}

/** 一条批注此刻的行（列表里显示）：新的一侧有位置时用现在的位置。 */
export function currentLines(comment: ReviewComment): { start: number; end: number } {
  if (comment.side === 'new' && comment.anchor.startLine !== undefined) {
    return {
      start: comment.anchor.startLine,
      end: comment.anchor.endLine ?? comment.anchor.startLine,
    };
  }
  return { start: comment.startLine, end: comment.endLine };
}
