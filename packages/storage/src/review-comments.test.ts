import { describe, expect, it } from 'vitest';
import type { ReviewCommentRecord } from './review-comments.js';
import { T0, T1, T2, useTempStorage } from './test-utils.js';

function comment(patch: Partial<ReviewCommentRecord>): ReviewCommentRecord {
  return {
    id: 'rvc_1',
    workspaceId: 'ws_1',
    dir: '/repo',
    sessionId: 'ses_1',
    path: 'src/a.ts',
    side: 'new',
    startLine: 2,
    endLine: 3,
    source: { kind: 'uncommitted' },
    base: 'a'.repeat(40),
    snippet: 'b\nc',
    contextBefore: 'a',
    contextAfter: 'd',
    body: '改一下',
    status: 'pending',
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

describe('review_comments', () => {
  const { storage } = useTempStorage();

  it('按目录列出、改正文、标为已发送、按会话删除', () => {
    const { reviewComments } = storage();
    reviewComments.insert(comment({}));
    reviewComments.insert(
      comment({
        id: 'rvc_2',
        sessionId: 'ses_2',
        side: 'old',
        head: 'f'.repeat(40),
        branch: 'main',
        previousPath: 'src/old.ts',
        source: { kind: 'turn', turnId: 'trn_1' },
        createdAt: T1,
      }),
    );
    reviewComments.insert(comment({ id: 'rvc_3', dir: '/other', createdAt: T2 }));

    expect(reviewComments.listByDir('/repo').map((row) => row.id)).toEqual(['rvc_1', 'rvc_2']);
    expect(reviewComments.countByDir('/repo')).toBe(2);
    expect(reviewComments.get('rvc_2')).toMatchObject({
      side: 'old',
      head: 'f'.repeat(40),
      branch: 'main',
      previousPath: 'src/old.ts',
      source: { kind: 'turn', turnId: 'trn_1' },
    });

    expect(reviewComments.setBody('rvc_1', '换个写法', T1)).toBe(true);
    expect(reviewComments.markSent('rvc_1', { sessionId: 'ses_9', at: T2, turnId: 'trn_9' })).toBe(
      true,
    );
    expect(reviewComments.get('rvc_1')).toMatchObject({
      body: '换个写法',
      status: 'sent',
      sent: { sessionId: 'ses_9', at: T2, turnId: 'trn_9' },
      updatedAt: T2,
    });
    expect(reviewComments.listByDir('/repo', 'pending').map((row) => row.id)).toEqual(['rvc_2']);

    expect(reviewComments.removeBySessions(['ses_1'])).toBe(2);
    expect(reviewComments.listByDir('/repo').map((row) => row.id)).toEqual(['rvc_2']);
    expect(reviewComments.remove('rvc_2')).toBe(true);
    expect(reviewComments.remove('rvc_2')).toBe(false);
  });

  it('审查发现（0018）：finding 原样存取，用户写的批注没有', () => {
    const { reviewComments } = storage();
    const finding = { title: '越界读取', priority: 1, confidence: 0.6, turnId: 'trn_1' };
    reviewComments.insert(comment({ id: 'rvc_f', finding }));
    reviewComments.insert(comment({ id: 'rvc_u' }));
    expect(reviewComments.get('rvc_f')?.finding).toEqual(finding);
    expect(reviewComments.get('rvc_u')).not.toHaveProperty('finding');
  });
});
