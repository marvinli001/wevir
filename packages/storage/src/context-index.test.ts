import { describe, expect, it } from 'vitest';
import { type ContextDocRecord, createContextIndexRepository } from './context-index.js';
import { seedSession, useTempStorage } from './test-utils.js';

const fixture = (index: number): ContextDocRecord => ({
  ref: `mem:project/note-${index}@ws_1`,
  kind: 'memory',
  workspaceId: 'ws_1',
  title: '额度',
  body: '额度 integer cents',
  revision: `${index}`,
  updatedAt: `2026-11-04T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
  state: 'active',
  paths: ['src/a.ts'],
});

describe('derived context index', () => {
  const { storage } = useTempStorage();
  it('caps short-term scans and exposes the examined count', () => {
    const db = storage();
    const docs = Array.from({ length: 5001 }, (_, index) => fixture(index));
    db.transaction(() => db.contextIndex.sync('ws_1', docs));
    const found = db.contextIndex.query({
      workspaceIds: ['ws_1'],
      kinds: ['memory'],
      includeInvalid: false,
      terms: [{ text: '额度', indexable: false }],
    });
    expect(found.docs).toHaveLength(5000);
    expect(found.scan).toEqual({ reason: 'short_term', examined: 5000, limit: 5000 });
  });

  it('rebuilds on version changes and does not retain excluded/disabled hits', () => {
    const db = storage();
    db.contextIndex.sync('ws_1', [
      fixture(1),
      { ...fixture(2), state: 'disabled' },
      { ...fixture(3), state: 'excluded' },
    ]);
    expect(
      db.contextIndex.query({
        workspaceIds: ['ws_1'],
        kinds: ['memory'],
        includeInvalid: true,
        terms: [{ text: 'integer', indexable: true }],
      }).docs,
    ).toHaveLength(1);
    db.db.prepare("UPDATE context_meta SET value='0' WHERE key='version'").run();
    const rebuilt = createContextIndexRepository(db.db);
    expect(
      rebuilt.query({
        workspaceIds: ['ws_1'],
        kinds: ['memory'],
        includeInvalid: true,
        terms: [{ text: '额度', indexable: false }],
      }).docs,
    ).toEqual([]);
  });

  it('erases cached bodies in the source deletion transaction', () => {
    const db = storage();
    seedSession(db, { id: 'ses_1' });
    db.contextIndex.sync('ws_1', [{ ...fixture(1), ref: 'ep:ep_1#open', kind: 'episode' }]);
    db.transaction(() => db.sessions.remove(['ses_1']));
    expect(db.db.prepare('SELECT body FROM context_docs').all()).toEqual([]);
  });
});
