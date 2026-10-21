import type { ReviewComment, ReviewCommentId, ReviewFinding } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { findingRows, fixable } from './findings-model';

const id = (n: number) => `rvc_01JA2B3C4D5E6F7G8H9JKMNPQ${n}` as ReviewCommentId;

function comment(n: number, patch: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: id(n),
    workspaceId: 'ws_1' as ReviewComment['workspaceId'],
    path: 'a.ts',
    side: 'new',
    startLine: 3,
    endLine: 4,
    source: { kind: 'uncommitted' },
    base: 'a'.repeat(40),
    snippet: 'x',
    body: 'b',
    status: 'pending',
    anchor: { state: 'current', startLine: 3, endLine: 4 },
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...patch,
  };
}

const pinned = (n: number): ReviewFinding => ({
  title: `t${n}`,
  body: '',
  path: 'a.ts',
  startLine: 3,
  endLine: 4,
  commentId: id(n),
});

describe('findingRows', () => {
  it('状态取自批注：没发的、过期的可修；发过的、删掉的不可修；没存成批注的只有文字', () => {
    const findings: ReviewFinding[] = [
      pinned(1),
      pinned(2),
      pinned(3),
      pinned(4),
      { title: 'outside', body: '', location: '/x/b.ts:1-2' },
      { title: 'loose', body: '', path: 'c.ts', startLine: 9, endLine: 9 },
    ];
    const comments = [
      comment(1, { anchor: { state: 'relocated', startLine: 10, endLine: 10 } }),
      comment(2, { status: 'sent' }),
      comment(4, { anchor: { state: 'outdated', reason: 'changed' }, source: { kind: 'branch' } }),
    ];
    const rows = findingRows(findings, comments);
    expect(rows.map((row) => row.state)).toEqual([
      'open',
      'sent',
      'dismissed',
      'outdated',
      'text',
      'text',
    ]);
    expect(rows.map(fixable)).toEqual([true, false, false, true, false, false]);
    // 位置跟着批注挪；过期的用报出时的行。
    expect(rows.map((row) => row.location)).toEqual([
      'a.ts:10',
      'a.ts:3-4',
      'a.ts:3-4',
      'a.ts:3-4',
      '/x/b.ts:1-2',
      'c.ts:9',
    ]);
    expect(rows[0]).toMatchObject({ path: 'a.ts', line: 10, scope: 'uncommitted' });
    expect(rows[3]?.scope).toBe('branch');
    expect(rows[4]).not.toHaveProperty('path');
  });

  it('批注还没读到时存过的是 unknown，不可修', () => {
    const rows = findingRows([pinned(1)], undefined);
    expect(rows[0]?.state).toBe('unknown');
    expect(fixable(rows[0] as never)).toBe(false);
  });
});
