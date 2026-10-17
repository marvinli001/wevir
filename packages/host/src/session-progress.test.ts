import type { SessionSnapshot, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { PROGRESS_FILES_MAX, PROGRESS_RECENT_MAX, sessionProgress } from './session-progress.js';

const T0 = '2026-10-17T00:00:00.000Z';
const NOW = Date.parse('2026-10-17T00:00:30.000Z');

let seq = 0;
function event(type: string, payload: Record<string, unknown>): WevirEvent {
  seq += 1;
  return { seq, sessionId: 'ses_1', ts: T0, type, source: 'engine', payload } as WevirEvent;
}

function snapshot(extra: Partial<SessionSnapshot> = {}, active = true): SessionSnapshot {
  return {
    session: {
      id: 'ses_1',
      state: 'running',
      ...(active && { activeTurn: { turnId: 'trn_1', startedAt: T0 } }),
    },
    pendingApprovals: [],
    ...extra,
  } as unknown as SessionSnapshot;
}

const started = (id: string, name: string, kind: string, paths: string[] = [], summary?: string) =>
  event('tool.started', {
    turnId: 'trn_1',
    toolCallId: id,
    toolName: name,
    display: { kind, paths, ...(summary !== undefined && { summary }) },
  });
const finished = (id: string, status = 'completed') =>
  event('tool.finished', { turnId: 'trn_1', toolCallId: id, status });

describe('sessionProgress', () => {
  it('没有进行中的回合时没有进度', () => {
    expect(sessionProgress(snapshot({}, false), [], NOW)).toBeUndefined();
  });

  it('正在跑的工具、结束的工具、改过的文件、清单与最近的回答', () => {
    const events = [
      event('turn.started', { turnId: 'trn_1' }),
      started('t1', 'edit', 'edit', ['a.ts', 'b.ts'], 'a.ts'),
      finished('t1'),
      started('t2', 'edit', 'edit', ['c.ts']),
      finished('t2', 'failed'),
      started('t3', 'shell', 'shell', [], 'pnpm test'),
      event('todo.updated', {
        turnId: 'trn_1',
        toolCallId: 'p',
        items: [
          { content: 'one', status: 'completed' },
          { content: 'two', status: 'in_progress' },
          { content: 'three', status: 'pending' },
        ],
      }),
      event('assistant.message', {
        turnId: 'trn_1',
        messageId: 'm',
        text: ' halfway there ',
        replaces: [],
      }),
    ];
    const progress = sessionProgress(
      snapshot({ usage: { contextUsed: 1, contextSize: 2, totalTokens: 99 } }),
      events,
      NOW,
    );
    expect(progress).toMatchObject({
      turnId: 'trn_1',
      elapsedMs: 30_000,
      doing: 'running shell: pnpm test',
      toolsFinished: 2,
      recent: ['edit: a.ts', 'edit (failed)'],
      // 失败的编辑不算改过。
      changedFiles: ['a.ts', 'b.ts'],
      todos: { done: 1, total: 3, current: 'two' },
      totalTokens: 99,
      lastText: 'halfway there',
    });
    expect(progress).not.toHaveProperty('waitingForUser');
  });

  it('其他回合的事件和旧回合的清单不算', () => {
    const events = [
      event('turn.started', { turnId: 'trn_0' }),
      event('todo.updated', {
        turnId: 'trn_0',
        toolCallId: 'p',
        items: [{ content: 'old', status: 'completed' }],
      }),
      event('turn.finished', { turnId: 'trn_0', outcome: 'completed', durationMs: 1 }),
      event('turn.started', { turnId: 'trn_1' }),
    ];
    const progress = sessionProgress(snapshot(), events, NOW);
    expect(progress).toMatchObject({ doing: 'working', toolsFinished: 0, changedFiles: [] });
    expect(progress).not.toHaveProperty('todos');
  });

  it('等审批或回答时说明在等用户；停止中', () => {
    const approval = {
      id: 'apr_1',
      detail: { toolName: 'write', display: { kind: 'write', summary: 'notes.md' } },
    };
    expect(
      sessionProgress(snapshot({ pendingApprovals: [approval] as never }), [], NOW),
    ).toMatchObject({ doing: 'waiting for the user to approve notes.md', waitingForUser: true });
    const question = {
      id: 'qst_1',
      questions: [{ id: 'q', question: 'Which database?', options: [] }],
    };
    expect(
      sessionProgress(snapshot({ pendingQuestions: [question] as never }), [], NOW),
    ).toMatchObject({
      doing: 'waiting for the user to answer: Which database?',
      waitingForUser: true,
    });
    const stopping = snapshot();
    (stopping.session as { state: string }).state = 'cancelling';
    expect(sessionProgress(stopping, [], NOW)?.doing).toBe('stopping');
  });

  it('列表有上限：最近几个工具、改过的文件', () => {
    const events = [event('turn.started', { turnId: 'trn_1' })];
    for (let index = 0; index < PROGRESS_FILES_MAX + 5; index += 1) {
      events.push(started(`t${index}`, 'edit', 'edit', [`f${index}.ts`]), finished(`t${index}`));
    }
    const progress = sessionProgress(snapshot(), events, NOW);
    expect(progress?.recent).toHaveLength(PROGRESS_RECENT_MAX);
    expect(progress?.changedFiles).toHaveLength(PROGRESS_FILES_MAX);
    expect(progress?.toolsFinished).toBe(PROGRESS_FILES_MAX + 5);
  });

  it('流式中的文字与思考', () => {
    const delta = (kind: string) =>
      event('assistant.delta', { turnId: 'trn_1', streamId: 's', blockIndex: 0, kind, text: 'x' });
    expect(sessionProgress(snapshot(), [delta('text')], NOW)?.doing).toBe('writing its answer');
    expect(sessionProgress(snapshot(), [delta('reasoning')], NOW)?.doing).toBe('thinking');
  });
});
