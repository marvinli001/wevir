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
});
