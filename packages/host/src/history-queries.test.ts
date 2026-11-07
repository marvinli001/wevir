import type { SessionSnapshot, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { HISTORY_EVENT_TYPES, historyItems } from './handoff.js';
import { analyzeSession, RECAP_EVENT_TYPES } from './recap.js';
import { opinionMaterial } from './second-opinion.js';
import { engineSessionsOf } from './session-delete.js';
import { PROGRESS_EVENT_TYPES, sessionProgress } from './session-progress.js';
import { SES, seedSession, T0, TURN, useStorages, useTempDir } from './test-utils.js';
import { USAGE_RECOVERY_EVENT_TYPES, usageRecoveryReports } from './usage-recovery.js';

describe('按需历史与完整历史的对照', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  it('进度、回顾、接力、第二意见、额度报告与删除选择保持相同结果', () => {
    const storage = open(dataDir());
    seedSession(storage);
    const events = new EventStore({ storage });
    const initial = events.snapshot(SES);
    if (initial === undefined) throw new Error('missing fixture snapshot');
    const snapshot: SessionSnapshot = {
      session: {
        ...initial.session,
        id: SES,
        title: 'Task',
        state: 'running',
        activeTurn: { turnId: TURN, startedAt: T0 },
      },
      pendingApprovals: [],
    };
    const append = (type: WevirEvent['type'], payload: Record<string, unknown>) => {
      const seq = storage.events.lastSeq(SES) + 1;
      storage.events.insert({ sessionId: SES, seq, ts: T0, type, source: 'engine', payload });
    };
    const compare = () => {
      const full = events.readSince(SES, 0);
      expect(
        sessionProgress(
          snapshot,
          events.readTypes(SES, PROGRESS_EVENT_TYPES, { turnId: TURN, omitToolOutput: true }),
          Date.parse(T0),
        ),
      ).toEqual(sessionProgress(snapshot, full, Date.parse(T0)));
      expect(analyzeSession(events.readTypes(SES, RECAP_EVENT_TYPES))).toEqual(
        analyzeSession(full),
      );
      expect(
        historyItems(events.readTypes(SES, HISTORY_EVENT_TYPES, { omitToolOutput: true })),
      ).toEqual(historyItems(full));
      const material = (history: WevirEvent[]) =>
        opinionMaterial({
          origin: snapshot,
          events: history,
          focus: undefined,
          requestedBy: 'user',
          files: [],
        });
      expect(material(events.readTypes(SES, ['user.message', 'assistant.message']))).toEqual(
        material(full),
      );
      expect(
        usageRecoveryReports(events.readTypes(SES, USAGE_RECOVERY_EVENT_TYPES), (id) => id),
      ).toEqual(usageRecoveryReports(full, (id) => id));
      const record = storage.sessions.get(SES);
      if (record === undefined) throw new Error('missing fixture session');
      expect(engineSessionsOf(record, events.readTypes(SES, ['session.handoff']))).toEqual(
        engineSessionsOf(record, full),
      );
    };
    append('turn.started', { turnId: 'trn_old' });
    append('assistant.message', {
      turnId: 'trn_old',
      text: 'Previous answer',
      messageId: 'old',
      replaces: [],
    });
    append('turn.finished', { turnId: 'trn_old', outcome: 'completed', durationMs: 1 });
    append('turn.started', { turnId: TURN });
    append('user.message', { turnId: TURN, content: [{ type: 'text', text: 'Task from user' }] });
    append('user.steered', { turnId: TURN, content: [{ type: 'text', text: 'Correction' }] });
    append('tool.started', {
      turnId: TURN,
      toolCallId: 'edit',
      toolName: 'edit',
      display: { kind: 'edit', paths: ['a.ts'] },
    });
    append('tool.updated', {
      turnId: TURN,
      toolCallId: 'edit',
      display: { summary: 'editing', paths: ['b.ts'] },
      output: { text: 'x'.repeat(64 * 1024), truncated: false },
    });
    compare();
    append('tool.finished', {
      turnId: TURN,
      toolCallId: 'edit',
      status: 'completed',
      output: { text: 'done', truncated: false },
    });
    append('todo.updated', { turnId: TURN, items: [{ content: 'Finish', status: 'in_progress' }] });
    append('assistant.delta', {
      turnId: TURN,
      streamId: 'stm_one',
      blockIndex: 0,
      kind: 'reasoning',
      text: 'thinking',
    });
    compare();
    append('review.findings', { turnId: TURN, summary: 'Reviewed', findings: [] });
    append('assistant.message', {
      turnId: TURN,
      text: 'Final answer',
      messageId: 'final',
      replaces: [],
    });
    append('turn.finished', { turnId: TURN, outcome: 'completed', durationMs: 10 });
    for (const type of ['turn.undone', 'turn.redone', 'turn.rewound'] as const) {
      append(type, { turnId: TURN });
      compare();
    }
    const failover = { originTurnId: TURN, attempt: 1 };
    const from = { providerId: 'old', modelId: 'old-model', engineSessionId: 'old-engine' };
    const to = { providerId: 'new', modelId: 'new-model', engineSessionId: 'new-engine' };
    append('routing.decided', { turnId: TURN, ...failover, from, to, skipped: [], at: T0 });
    append('session.handoff', { from, to, reason: 'usage_limit', failover });
    append('session.auto_continue', { turnId: TURN, resumeAt: T0 });
    compare();
    events.close();
  });
});
