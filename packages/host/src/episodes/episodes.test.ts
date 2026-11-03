import type { SessionId, WevirEvent, WorkspaceId } from '@wevir/protocol';
import { EpisodeSchema } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { buildRetro } from '../retro/build.js';
import { emptyRetroState, foldRetro } from '../retro/fold.js';
import { buildEpisode, episodeLessons, episodeMarkdown } from './build.js';

const sessionId: SessionId = 'ses_1';
const at = '2026-11-04T00:00:00.000Z';
function fixture() {
  const events: WevirEvent[] = [];
  const push = (type: string, payload: unknown) => {
    events.push({
      type,
      payload,
      sessionId,
      seq: events.length + 1,
      ts: at,
      source: 'host',
    } as WevirEvent);
  };
  push('session.created', { providerId: 'mock', modelId: 'mock' });
  const start = (id: string, text = 'Repair invoiceTotal') => {
    push('user.message', { turnId: id, content: [{ type: 'text', text }] });
    push('turn.started', { turnId: id });
  };
  const finish = (id: string, outcome = 'completed') =>
    push('turn.finished', { turnId: id, outcome });
  const run = (id: string, status: string, turnId?: string) =>
    push('verification.updated', {
      run: {
        id,
        checkId: 'chk_1',
        name: 'lint',
        command: 'npm run lint',
        kind: 'lint',
        status,
        reason: 'Lint service unavailable',
        ...(turnId && { turnId }),
      },
    });
  const edit = (id: string) =>
    push('tool.started', {
      turnId: id,
      toolCallId: `edit${events.length}`,
      toolName: 'edit',
      display: { kind: 'edit', paths: ['src/invoice.js'] },
    });
  const shell = (id: string, text: string, status: string) => {
    const toolCallId = `cmd${events.length}`;
    push('tool.started', {
      turnId: id,
      toolCallId,
      toolName: 'shell',
      display: { kind: 'shell', command: text },
    });
    push('tool.finished', { turnId: id, toolCallId, status });
  };
  const build = () => {
    const state = foldRetro(emptyRetroState(), events);
    const retro = buildRetro({
      sessionId,
      cwd: '/repo',
      state,
      live: { checkedAt: at },
      builtAt: at,
      build: 'full',
    });
    return {
      state,
      retro,
      episode: buildEpisode({
        workspaceId: 'ws_1' as WorkspaceId,
        rootSessionId: sessionId,
        title: 'Invoices',
        createdAt: at,
        state,
        retro,
        events,
      }),
    };
  };
  return { events, push, start, finish, run, edit, shell, build };
}

describe('deterministic episodes', () => {
  it('rebuilds identically and retains provenance, chapters, and open work', () => {
    const f = fixture();
    f.start('trn_1');
    f.edit('trn_1');
    f.push('chapter.marked', { title: 'Invoices', turnId: 'trn_1' });
    f.push('todo.updated', {
      turnId: 'trn_1',
      items: [{ content: 'applyDiscount rounding', status: 'pending' }],
    });
    f.finish('trn_1');
    const first = f.build();
    const second = f.build();
    expect(first.episode).toEqual(second.episode);
    expect(EpisodeSchema.safeParse(first.episode).success).toBe(true);
    const middle = foldRetro(emptyRetroState(), f.events.slice(0, 4));
    expect(foldRetro(middle, f.events.slice(4))).toEqual(first.state);
    expect(first.episode.open[0]?.text).toBe('applyDiscount rounding');
    expect(first.episode.chapters[0]?.ref).toMatchObject({ kind: 'event' });
    expect(episodeMarkdown(first.episode)).toContain('through=e');
  });

  it('pairs failed checks with a later pass and files between them', () => {
    const f = fixture();
    f.start('trn_1');
    f.run('vrn_1', 'failed', 'trn_1');
    f.finish('trn_1');
    f.start('trn_2');
    f.edit('trn_2');
    f.finish('trn_2');
    f.run('vrn_2', 'passed');
    expect(f.build().episode.lessons).toContainEqual(
      expect.objectContaining({
        kind: 'check_recovered',
        sources: ['v:vrn_1', 'v:vrn_2'],
        files: ['src/invoice.js'],
        verified: true,
      }),
    );
    expect(f.build().episode.outcome.comparedToCode).toBe(false);
  });

  it('records unavailable checks without claiming they passed', () => {
    const f = fixture();
    f.start('trn_1');
    f.run('vrn_1', 'environment_unavailable');
    f.finish('trn_1');
    expect(f.build().episode.lessons).toMatchObject([
      { kind: 'check_failed', text: expect.stringContaining('Lint service unavailable') },
    ]);
    expect(f.build().episode.outcome.checks).toBe('environment_unavailable');
  });

  it('pairs normalized Agent commands without treating them as verification', () => {
    const f = fixture();
    f.start('trn_1');
    f.shell('trn_1', ' npm   test ', 'failed');
    f.shell('trn_1', 'npm test', 'completed');
    f.finish('trn_1');
    expect(f.build().episode.lessons).toMatchObject([
      { kind: 'command_recovered', verified: false },
    ]);
    expect(f.build().episode.outcome.checks).toBe('unverified');
  });

  it('records user corrections and denied approvals', () => {
    const f = fixture();
    f.start('trn_1');
    f.push('user.steered', {
      turnId: 'trn_1',
      content: [{ type: 'text', text: '金额一律用整数分' }],
    });
    f.push('approval.requested', {
      approval: {
        id: 'apr_1',
        turnId: 'trn_1',
        detail: { display: { command: 'git push' }, toolName: 'shell' },
      },
    });
    f.push('approval.resolved', {
      approvalId: 'apr_1',
      status: 'denied',
      resolution: { reason: 'user' },
    });
    f.finish('trn_1');
    expect(f.build().episode.lessons.map((lesson) => lesson.text)).toEqual([
      '金额一律用整数分',
      'git push',
    ]);
  });

  it('records guardrail blocks and failed-turn errors, redacting all stored text', () => {
    const f = fixture();
    f.start('trn_1');
    f.push('guardrail.blocked', {
      turnId: 'trn_1',
      guardrailId: 'grd_1',
      command: 'git push',
      reason: 'Denied',
    });
    f.push('engine.error', {
      turnId: 'trn_1',
      message: 'Invalid token sk-abcdefghijklmnopqrstuvwxyz123456',
    });
    f.finish('trn_1', 'failed');
    const { episode } = f.build();
    expect(episode.lessons.map((lesson) => lesson.kind)).toEqual(['guardrail', 'turn_failed']);
    expect(JSON.stringify(episode)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(episode.redactions).toBeGreaterThan(0);
  });

  it('omits undone and rewound turns and their lessons', () => {
    const f = fixture();
    f.start('trn_1');
    f.run('vrn_1', 'failed', 'trn_1');
    f.edit('trn_1');
    f.finish('trn_1');
    f.push('turn.undone', { turnId: 'trn_1' });
    const { state, retro, episode } = f.build();
    expect(episodeLessons(state, retro, f.events)).toEqual([]);
    expect(episode.files).toEqual([]);
    f.push('turn.rewound', { turnId: 'trn_1' });
    expect(f.build().episode.lessons).toEqual([]);
  });
});
