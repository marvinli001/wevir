import { describe, expect, it } from 'vitest';
import type { Storage } from './storage.js';
import { seedSession, T0, T1, T2, useTempStorage } from './test-utils.js';
import type { TuningRunRecord } from './tuning-runs.js';

describe('tuning_runs', () => {
  const { storage } = useTempStorage();

  const run = (id: string, overrides: Partial<TuningRunRecord> = {}): TuningRunRecord => ({
    id,
    workspaceId: 'ws_01',
    sessionId: 'ses_01',
    origin: 'auto',
    usage: { inputTokens: 100, outputTokens: 20 },
    proposals: 1,
    createdAt: T0,
    ...overrides,
  });

  function events(db: Storage, sessionId: string, list: [string, string, unknown][]): void {
    list.forEach(([ts, type, payload], index) => {
      db.events.insert({ sessionId, seq: index + 1, ts, type, source: 'host', payload });
    });
  }

  it('存取、最新一次与按时刻列出', () => {
    const db = storage();
    db.tuningRuns.insert(run('trr_1'));
    db.tuningRuns.insert(
      run('trr_2', {
        origin: 'user',
        usage: undefined,
        proposals: 0,
        reason: 'empty',
        createdAt: T1,
      }),
    );
    db.tuningRuns.insert(
      run('trr_3', { workspaceId: 'ws_02', sessionId: 'ses_02', createdAt: T2 }),
    );
    expect(db.tuningRuns.latest()?.id).toBe('trr_3');
    expect(db.tuningRuns.latest({ workspaceId: 'ws_01' })).toEqual(
      run('trr_2', {
        origin: 'user',
        usage: undefined,
        proposals: 0,
        reason: 'empty',
        createdAt: T1,
      }),
    );
    expect(db.tuningRuns.latest({ workspaceId: 'ws_01', origin: 'auto' })).toEqual(run('trr_1'));
    expect(db.tuningRuns.latest({ sessionId: 'ses_02' })?.id).toBe('trr_3');
    expect(db.tuningRuns.latest({ sessionId: 'ses_x' })).toBeUndefined();
    expect(db.tuningRuns.since(T1).map((r) => r.id)).toEqual(['trr_2', 'trr_3']);
    expect(db.tuningRuns.latest({ workspaceId: 'ws_01' })).not.toHaveProperty('usage');
  });

  it('会话的回合与护栏命中：中断与取消的不算', () => {
    const db = storage();
    seedSession(db, { id: 'ses_a', engineSessionId: 'ses_a' });
    seedSession(db, { id: 'ses_b', engineSessionId: 'ses_b' });
    events(db, 'ses_a', [
      [T0, 'turn.finished', { turnId: 'trn_1', outcome: 'completed', durationMs: 1 }],
      [T0, 'guardrail.blocked', { ruleId: 'grd_1' }],
      [T1, 'turn.finished', { turnId: 'trn_2', outcome: 'failed', durationMs: 1 }],
      [T2, 'turn.finished', { turnId: 'trn_3', outcome: 'cancelled', durationMs: 1 }],
      [T2, 'turn.finished', { turnId: 'trn_4', outcome: 'completed', durationMs: 1 }],
    ]);
    events(db, 'ses_b', [[T0, 'turn.started', { turnId: 'trn_5' }]]);
    const usage = {
      at: 1,
      source: 'openai-compatible',
      providerId: 'prv_1',
      providerName: 'x',
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    db.usage.insert({ ...usage, sessionId: 'ses_a', requestId: 'r1' });
    db.usage.insert({ ...usage, sessionId: 'ses_a', requestId: 'r2' });
    db.usage.insert({ ...usage, sessionId: 'ses_c', requestId: 'r3' });
    const counts = db.tuningRuns.sessionCounts(['ses_a', 'ses_b', 'ses_c']);
    expect(counts.get('ses_a')).toEqual({
      turns: 3,
      failedTurns: 1,
      guardrailHits: 1,
      tokens: 240,
    });
    expect(counts.get('ses_c')).toEqual({
      turns: 0,
      failedTurns: 0,
      guardrailHits: 0,
      tokens: 120,
    });
    expect(counts.has('ses_b')).toBe(false);
    expect(db.tuningRuns.sessionCounts([])).toEqual(new Map());
    expect(db.tuningRuns.turnsSince('ses_a', T0)).toBe(2);
    expect(db.tuningRuns.turnsSince('ses_a', T2)).toBe(0);
    expect(db.tuningRuns.turnsSince('ses_b', T0)).toBe(0);
  });
});
