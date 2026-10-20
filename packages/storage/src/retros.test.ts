import { describe, expect, it } from 'vitest';
import { seedSession, T0, T1, useTempStorage } from './test-utils.js';

describe('session_retros', () => {
  const { storage } = useTempStorage();

  it('写入、替换、读回投影与摘要，随会话删除', () => {
    const db = storage();
    seedSession(db, { id: 'ses_1' });
    expect(db.retros.get('ses_1')).toBeUndefined();
    const record = {
      sessionId: 'ses_1',
      schemaVersion: 1,
      throughSeq: 4,
      state: '{"v":1}',
      builtAt: T0,
      updatedAt: T0,
    };
    db.retros.put(record);
    expect(db.retros.get('ses_1')).toEqual(record);
    db.retros.put({ ...record, throughSeq: 9, state: 'not json', updatedAt: T1 });
    expect(db.retros.get('ses_1')).toMatchObject({ throughSeq: 9, state: 'not json', builtAt: T0 });

    db.retros.putSummary({ sessionId: 'ses_1', summary: '{"points":[]}', createdAt: T0 });
    db.retros.putSummary({ sessionId: 'ses_1', summary: '{"points":[1]}', createdAt: T1 });
    expect(db.retros.getSummary('ses_1')).toEqual({
      sessionId: 'ses_1',
      summary: '{"points":[1]}',
      createdAt: T1,
    });

    expect(db.retros.remove('ses_1')).toBe(true);
    expect(db.retros.remove('ses_1')).toBe(false);
    db.retros.put(record);
    db.sessions.remove(['ses_1']);
    expect(db.retros.get('ses_1')).toBeUndefined();
    expect(db.retros.getSummary('ses_1')).toBeUndefined();
  });
});
