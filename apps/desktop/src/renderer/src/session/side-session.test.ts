import { projectTranscript } from '@wevir/client-sdk';
import type { WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { btwQuestion, hasFinishedTurn, sideTitle } from './side-session';

describe('支线（U23.1）', () => {
  it('只认 /btw 前缀加非空的问题，其余照原样发出', () => {
    expect(btwQuestion('/btw 这个函数为什么这么写？')).toBe('这个函数为什么这么写？');
    expect(btwQuestion('  /btw\n多行\n问题  ')).toBe('多行\n问题');
    expect(btwQuestion('/btw')).toBeUndefined();
    expect(btwQuestion('/btw   ')).toBeUndefined();
    expect(btwQuestion('/btwx 不是')).toBeUndefined();
    expect(btwQuestion('顺便 /btw 问一下')).toBeUndefined();
  });

  it('标签标题取问题开头，压成一行', () => {
    expect(sideTitle('为什么\n  这样')).toBe('为什么 这样');
    expect(sideTitle('x'.repeat(50))).toBe(`${'x'.repeat(40)}…`);
  });

  it('有结束的回合才能分支', () => {
    const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
    const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
    const at = (seq: number) => new Date(Date.UTC(2026, 9, 15, 8, 0, seq)).toISOString();
    const events: WevirEvent[] = [
      {
        seq: 1,
        sessionId: SES,
        ts: at(1),
        type: 'session.created',
        source: 'host',
        payload: {
          workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
          cwd: '/w',
          providerId: 'mock',
          modelId: 'm',
        },
      },
      {
        seq: 2,
        sessionId: SES,
        ts: at(2),
        type: 'turn.started',
        source: 'host',
        payload: { turnId: TURN },
      },
    ];
    expect(hasFinishedTurn(projectTranscript(events))).toBe(false);
    events.push({
      seq: 3,
      sessionId: SES,
      ts: at(3),
      type: 'turn.finished',
      source: 'host',
      payload: { turnId: TURN, outcome: 'completed', durationMs: 5 },
    });
    expect(hasFinishedTurn(projectTranscript(events))).toBe(true);
  });
});
