import { describe, expect, it } from 'vitest';
import {
  applySessionsChange,
  archivedSessions,
  folderName,
  pendingCount,
  type SessionList,
  sortSessions,
} from './sessions';
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

describe('session list changes from other lists', () => {
  it('drops sessions pushed because the connection also read the archived list', () => {
    const a = session('ses_a', '2026-10-23T10:00:00.000Z');
    const b = session('ses_b', '2026-10-23T11:00:00.000Z');
    const archived = { ...a, archivedAt: '2026-10-23T12:00:00.000Z' };
    const next = applySessionsChange(
      { sessions: [b, a], listVersion: 1 },
      { listVersion: 2, upserted: [archived], removed: [] },
    );
    expect(next?.sessions.map((s) => s.id)).toEqual(['ses_b']);
    const back = applySessionsChange(next as SessionList, {
      listVersion: 3,
      upserted: [a],
      removed: [],
    });
    expect(back?.sessions.map((s) => s.id)).toEqual(['ses_b', 'ses_a']);
  });
});

describe('archived sessions', () => {
  const older = session('ses_old', '2026-10-23T09:00:00.000Z', {
    title: 'Fix login',
    cwd: '/Users/me/wevir',
    archivedAt: '2026-10-24T08:00:00.000Z',
  });
  const newer = session('ses_new', '2026-10-23T08:00:00.000Z', {
    title: 'Docs pass',
    cwd: 'C:\\work\\Notes\\',
    archivedAt: '2026-10-25T08:00:00.000Z',
  });

  it('sorts by the time a session was archived, newest first', () => {
    expect(archivedSessions([older, newer], '').map((s) => s.id)).toEqual(['ses_new', 'ses_old']);
  });

  it('matches the title or the project folder, ignoring case', () => {
    expect(archivedSessions([older, newer], ' LOGIN ').map((s) => s.id)).toEqual(['ses_old']);
    expect(archivedSessions([older, newer], 'notes').map((s) => s.id)).toEqual(['ses_new']);
    expect(archivedSessions([older, newer], 'nothing')).toEqual([]);
  });

  it('names a project after the last folder of its path', () => {
    expect(folderName('/Users/me/wevir/')).toBe('wevir');
    expect(folderName('C:\\work\\Notes')).toBe('Notes');
  });
});
