import { describe, expect, it } from 'vitest';
import type { EpisodeRecord } from './episodes.js';
import { seedSession, T0, useTempStorage } from './test-utils.js';

describe('episode source deletion', () => {
  const { storage } = useTempStorage();

  it('atomically deletes ordinary records, tombstones, and cached bodies while retaining pins', () => {
    const db = storage();
    for (const id of ['ordinary', 'tombstone', 'pinned', 'unrelated']) {
      const session = seedSession(db, { id: `ses_${id}`, engineSessionId: id });
      const record: EpisodeRecord = {
        id: `ep_${id}`,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        rootSessionId: session.id,
        schemaVersion: 1,
        throughSeq: 0,
        digest: '{}',
        overrides: '{"title":"User edit"}',
        pinned: id === 'pinned',
        excluded: false,
        revision: id,
        createdAt: T0,
        updatedAt: T0,
        ...(id === 'tombstone' && { deletedAt: T0 }),
      };
      db.episodes.put(record);
    }
    const pinned = db.episodes.get('ep_pinned');
    const unrelated = db.episodes.get('ep_unrelated');
    db.contextIndex.sync(
      'ws_01',
      ['ordinary', 'pinned', 'unrelated'].map((id) => ({
        ref: `ep:ep_${id}#open`,
        kind: 'episode',
        workspaceId: 'ws_01',
        title: id,
        body: `Cached ${id}`,
        revision: id,
        updatedAt: T0,
        state: 'active',
        paths: [],
      })),
    );
    const ids = ['ses_ordinary', 'ses_tombstone', 'ses_pinned'];
    expect(() =>
      db.transaction(() => {
        db.sessions.remove(ids);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.episodes.get('ep_ordinary')).toBeDefined();
    expect(db.episodes.get('ep_tombstone')).toBeDefined();
    expect(db.db.prepare('SELECT body FROM context_docs').all()).toHaveLength(3);

    db.transaction(() => db.sessions.remove(ids));
    expect(db.episodes.get('ep_ordinary')).toBeUndefined();
    expect(db.episodes.get('ep_tombstone')).toBeUndefined();
    expect(db.episodes.get('ep_pinned')).toEqual(pinned);
    expect(db.episodes.get('ep_unrelated')).toEqual(unrelated);
    expect(db.db.prepare('SELECT body FROM context_docs').all()).toEqual([
      { body: 'Cached unrelated' },
    ]);
  });
});
