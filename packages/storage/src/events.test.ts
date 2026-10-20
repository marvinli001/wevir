import { describe, expect, it } from 'vitest';
import type { EventRecord } from './events.js';
import { seedSession, T0, useTempStorage } from './test-utils.js';

function event(seq: number, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    sessionId: 'ses_01',
    seq,
    ts: T0,
    type: 'usage.updated',
    source: 'engine',
    payload: { contextUsed: seq, contextSize: 262144 },
    ...overrides,
  };
}

describe('events', () => {
  const { storage } = useTempStorage();

  it('追加与按 seq 读取，payload 原样往返', () => {
    const s = storage();
    seedSession(s);
    const created = event(1, {
      type: 'session.created',
      source: 'host',
      payload: { workspaceId: 'ws_01', cwd: '/项目', nested: { list: [1, 'двa', null] } },
    });
    s.events.insert(created);
    s.events.insert(event(2));
    s.events.insert(event(3));

    expect(s.events.list('ses_01')).toEqual([created, event(2), event(3)]);
    expect(s.events.list('ses_01', { afterSeq: 1 })).toEqual([event(2), event(3)]);
    expect(s.events.list('ses_01', { afterSeq: 1, limit: 1 })).toEqual([event(2)]);
    expect(s.events.list('ses_01', { afterSeq: 3 })).toEqual([]);
    expect(s.events.lastSeq('ses_01')).toBe(3);
  });

  it('iterate 逐行读出与 list 相同的事件，中途放弃后可以再读', () => {
    const s = storage();
    seedSession(s);
    for (let seq = 1; seq <= 5; seq++) s.events.insert(event(seq));

    expect([...s.events.iterate('ses_01')]).toEqual(s.events.list('ses_01'));
    expect([...s.events.iterate('ses_01', { afterSeq: 3 })]).toEqual([event(4), event(5)]);
    for (const record of s.events.iterate('ses_01')) {
      if (record.seq === 2) break;
    }
    expect([...s.events.iterate('ses_01', { afterSeq: 4 })]).toEqual([event(5)]);
    s.events.insert(event(6));
    expect(s.events.lastSeq('ses_01')).toBe(6);
  });

  it('没有事件时 lastSeq 为 0', () => {
    const s = storage();
    seedSession(s);
    expect(s.events.lastSeq('ses_01')).toBe(0);
    expect(s.events.list('ses_01')).toEqual([]);
  });

  it('(session_id, seq) 唯一；不同会话可以有相同的 seq', () => {
    const s = storage();
    seedSession(s);
    seedSession(s, { id: 'ses_02', engineSessionId: 'e2' });
    s.events.insert(event(1));
    expect(() => s.events.insert(event(1, { type: 'other' }))).toThrow(
      /UNIQUE constraint failed: events\.session_id, events\.seq/,
    );
    s.events.insert(event(1, { sessionId: 'ses_02' }));
    expect(s.events.list('ses_01')).toEqual([event(1)]);
  });

  it('会话必须存在，seq 从 1 开始', () => {
    const s = storage();
    expect(() => s.events.insert(event(1))).toThrow(/FOREIGN KEY constraint failed/);
    seedSession(s);
    expect(() => s.events.insert(event(0))).toThrow(/CHECK constraint failed/);
  });

  it('读取不跨会话，结果按 seq 排序', () => {
    const s = storage();
    seedSession(s);
    seedSession(s, { id: 'ses_02', engineSessionId: 'e2' });
    s.events.insert(event(2));
    s.events.insert(event(1, { sessionId: 'ses_02' }));
    s.events.insert(event(1));
    expect(s.events.list('ses_01').map((e) => e.seq)).toEqual([1, 2]);
    expect(s.events.lastSeq('ses_02')).toBe(1);
  });
});
