import { describe, expect, it } from 'vitest';
import type { Storage } from './storage.js';
import { seedSession, T0, T1, useTempStorage } from './test-utils.js';

const T2 = '2026-10-13T00:00:02.000Z';

describe('inbox', () => {
  const { storage } = useTempStorage();

  function events(db: Storage, sessionId: string, list: [string, string, unknown][]): void {
    list.forEach(([ts, type, payload], index) => {
      db.events.insert({ sessionId, seq: index + 1, ts, type, source: 'host', payload });
    });
  }

  it('收起记录：重复收起不变，只留给出的那些', () => {
    const db = storage();
    db.inbox.dismiss('turn_failed:trn_1', T0);
    db.inbox.dismiss('turn_failed:trn_1', T1);
    db.inbox.dismiss('automation:arn_1', T1);
    expect(db.inbox.dismissed()).toEqual(new Set(['turn_failed:trn_1', 'automation:arn_1']));
    expect(db.inbox.retainDismissals(new Set(['automation:arn_1']))).toBe(1);
    expect(db.inbox.dismissed()).toEqual(new Set(['automation:arn_1']));
  });

  it('失败回合：只取之后没有新回合的，按时间过滤', () => {
    const db = storage();
    seedSession(db, { id: 'ses_failed', engineSessionId: 'ses_failed' });
    events(db, 'ses_failed', [
      [T0, 'turn.started', { turnId: 'trn_1' }],
      [T0, 'turn.finished', { turnId: 'trn_1', outcome: 'failed', durationMs: 1 }],
      [T1, 'turn.started', { turnId: 'trn_2' }],
      [T2, 'turn.finished', { turnId: 'trn_2', outcome: 'failed', durationMs: 1 }],
    ]);
    seedSession(db, { id: 'ses_retried', engineSessionId: 'ses_retried' });
    events(db, 'ses_retried', [
      [T0, 'turn.started', { turnId: 'trn_3' }],
      [T0, 'turn.finished', { turnId: 'trn_3', outcome: 'failed', durationMs: 1 }],
      [T1, 'turn.started', { turnId: 'trn_4' }],
    ]);
    seedSession(db, { id: 'ses_ok', engineSessionId: 'ses_ok' });
    events(db, 'ses_ok', [
      [T0, 'turn.started', { turnId: 'trn_5' }],
      [T1, 'turn.finished', { turnId: 'trn_5', outcome: 'completed', durationMs: 1 }],
    ]);
    expect(db.inbox.failedTurns({ since: T0 })).toEqual([
      { sessionId: 'ses_failed', turnId: 'trn_2', finishedAt: T2 },
    ]);
    expect(db.inbox.failedTurns({ since: '2026-10-14T00:00:00.000Z' })).toEqual([]);
  });

  it('未答的提问：按问题 ID 对上结束事件', () => {
    const db = storage();
    seedSession(db, { id: 'ses_asking', engineSessionId: 'ses_asking' });
    events(db, 'ses_asking', [
      [T0, 'question.requested', { question: { id: 'qst_1' } }],
      [T0, 'question.requested', { question: { id: 'qst_2' } }],
      [T1, 'question.resolved', { questionId: 'qst_1', status: 'answered' }],
    ]);
    seedSession(db, { id: 'ses_answered', engineSessionId: 'ses_answered' });
    events(db, 'ses_answered', [
      [T0, 'question.requested', { question: { id: 'qst_3' } }],
      [T1, 'question.resolved', { questionId: 'qst_3', status: 'cancelled' }],
    ]);
    expect(db.inbox.sessionsWithPendingQuestions()).toEqual(['ses_asking']);
  });
});
