import { describe, expect, it } from 'vitest';
import { applySessionsChange, pendingCount, type SessionList, sortSessions } from './sessions';
import { session } from './test-utils';

describe('session list', () => {
  const a = session('ses_a', '2026-10-23T10:00:00.000Z');
  const b = session('ses_b', '2026-10-23T11:00:00.000Z');

  it('applies consecutive changes and keeps newest first', () => {
    const list = { sessions: sortSessions([a, b]), listVersion: 4 };
    expect(list.sessions.map((s) => s.id)).toEqual(['ses_b', 'ses_a']);
    const renamed = { ...a, title: 'renamed', updatedAt: '2026-10-23T12:00:00.000Z' };
    const next = applySessionsChange(list, { listVersion: 5, upserted: [renamed], removed: [] });
    expect(next?.sessions.map((s) => [s.id, s.title])).toEqual([
      ['ses_a', 'renamed'],
      ['ses_b', 'ses_b'],
    ]);
    const removed = applySessionsChange(next as SessionList, {
      listVersion: 6,
      upserted: [],
      removed: ['ses_b'],
    });
    expect(removed?.sessions.map((s) => s.id)).toEqual(['ses_a']);
  });

  it('asks for a re-read when a version is skipped or unknown', () => {
    expect(
      applySessionsChange(
        { sessions: [a], listVersion: 4 },
        { listVersion: 6, upserted: [], removed: [] },
      ),
    ).toBeUndefined();
    expect(
      applySessionsChange(
        { sessions: [a], listVersion: undefined },
        { listVersion: 1, upserted: [], removed: [] },
      ),
    ).toBeUndefined();
  });

  it('counts approvals and questions', () => {
    expect(pendingCount({ pendingApprovalCount: 2, pendingQuestionCount: 1 })).toBe(3);
    expect(pendingCount({})).toBe(0);
  });
});
