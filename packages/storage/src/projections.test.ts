import { describe, expect, it } from 'vitest';
import { seedSession, useTempStorage } from './test-utils.js';

describe('projections', () => {
  const { storage } = useTempStorage();

  it('写入替换旧的检查点；删会话时一起删掉', () => {
    const db = storage();
    seedSession(db, { id: 'ses_a', engineSessionId: 'ses_a' });
    expect(db.projections.get('ses_a')).toBeUndefined();
    db.projections.put('ses_a', { seq: 3, code: 'v1', data: new Uint8Array([1, 2, 3]) });
    db.projections.put('ses_a', { seq: 7, code: 'v2', data: new Uint8Array([4]) });
    expect(db.projections.get('ses_a')).toEqual({
      seq: 7,
      code: 'v2',
      data: new Uint8Array([4]),
    });

    expect(db.sessions.remove(['ses_a'])).toBe(1);
    expect(db.projections.get('ses_a')).toBeUndefined();
  });

  it('恢复候选包含未知、过期和待处理的会话，已归档的也参与', () => {
    const db = storage();
    for (const id of ['ses_a', 'ses_b', 'ses_c', 'ses_d']) {
      seedSession(db, { id, engineSessionId: id });
      db.sessions.setArchived(id, '2026-11-07T00:00:00.000Z');
    }
    db.projections.putRecovery('ses_a', { seq: 0, code: 'v1', required: false });
    db.projections.putRecovery('ses_b', { seq: 0, code: 'v1', required: true });
    db.projections.putRecovery('ses_c', { seq: 0, code: 'old', required: false });
    expect(db.projections.recoveryCandidates('v1').sort()).toEqual(['ses_b', 'ses_c', 'ses_d']);
    db.sessions.update('ses_a', { lastSeq: 1 });
    expect(db.projections.recoveryCandidates('v1')).toContain('ses_a');
    db.sessions.remove(['ses_b']);
    expect(db.projections.recoveryCandidates('v1')).not.toContain('ses_b');
  });
});
