import { type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs';
import type { ReviewComment } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { currentLines, newLineForOldLine, placeComment, toReviewRange } from './review-model';

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,6 @@
 one
-two
-three
+TWO
+THREE
+extra
 four
 five
@@ -10,3 +11,2 @@
 ten
-eleven
 twelve
`;

function fileDiff(): FileDiffMetadata {
  const file = parsePatchFiles(PATCH)[0]?.files[0];
  if (!file) throw new Error('no file');
  return file;
}

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function comment(patch: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'rvc_1',
    workspaceId: 'ws_1',
    path: 'a.ts',
    side: 'new',
    startLine: 2,
    endLine: 3,
    source: { kind: 'uncommitted' },
    base: BASE,
    snippet: 'TWO\nTHREE',
    body: 'x',
    status: 'pending',
    anchor: { state: 'current', startLine: 2, endLine: 3 },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...patch,
  };
}

describe('toReviewRange', () => {
  it('同一侧照搬，倒着选也按从小到大', () => {
    expect(toReviewRange(fileDiff(), { start: 4, side: 'additions', end: 2 })).toEqual({
      side: 'new',
      startLine: 2,
      endLine: 4,
    });
    expect(
      toReviewRange(fileDiff(), { start: 2, side: 'deletions', end: 3, endSide: 'deletions' }),
    ).toEqual({ side: 'old', startLine: 2, endLine: 3 });
  });

  it('从删除的行拖到新增的行记在新的一侧', () => {
    expect(
      toReviewRange(fileDiff(), { start: 2, side: 'deletions', end: 4, endSide: 'additions' }),
    ).toEqual({ side: 'new', startLine: 2, endLine: 4 });
  });
});

describe('newLineForOldLine', () => {
  it('上下文、删除的行、两个改动块之间与之后', () => {
    const diff = fileDiff();
    expect(newLineForOldLine(diff, 1)).toBe(1);
    expect(newLineForOldLine(diff, 3)).toBe(2);
    expect(newLineForOldLine(diff, 4)).toBe(5);
    expect(newLineForOldLine(diff, 8)).toBe(9);
    expect(newLineForOldLine(diff, 11)).toBe(12);
    expect(newLineForOldLine(diff, 13)).toBe(13);
  });
});

describe('placeComment', () => {
  const working = { base: BASE, head: undefined };

  it('工作树的 diff 用现在的位置，过期与已发送的不画', () => {
    expect(
      placeComment(comment({ anchor: { state: 'relocated', startLine: 5, endLine: 6 } }), working),
    ).toEqual({ side: 'new', startLine: 5, endLine: 6 });
    expect(
      placeComment(comment({ anchor: { state: 'outdated', reason: 'changed' } }), working),
    ).toBe(undefined);
    expect(placeComment(comment({ status: 'sent' }), working)).toBeUndefined();
  });

  it('快照上的 diff 只画同一个快照上写的；旧的一侧要同一个基线', () => {
    expect(placeComment(comment({ head: HEAD }), { base: BASE, head: HEAD })).toEqual({
      side: 'new',
      startLine: 2,
      endLine: 3,
    });
    expect(placeComment(comment({}), { base: BASE, head: HEAD })).toBeUndefined();
    expect(placeComment(comment({ side: 'old' }), working)).toEqual({
      side: 'old',
      startLine: 2,
      endLine: 3,
    });
    expect(placeComment(comment({ side: 'old' }), { base: HEAD, head: undefined })).toBeUndefined();
  });
});

describe('currentLines', () => {
  it('新的一侧有位置时用现在的位置', () => {
    expect(
      currentLines(comment({ anchor: { state: 'relocated', startLine: 8, endLine: 9 } })),
    ).toEqual({ start: 8, end: 9 });
    expect(currentLines(comment({ anchor: { state: 'outdated' } }))).toEqual({ start: 2, end: 3 });
  });
});
