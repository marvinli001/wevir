import type { ChatMessage, ChatPart } from '@wevir/client-sdk';
import type { QuestionRequest, Session, TurnId, WevirEvent } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SessionActivityTracker } from '@/data/session-activity';
import { agentRun, formatClock } from './agent-status-model';

const T1 = 'trn_1' as TurnId;
const T2 = 'trn_2' as TurnId;
const TS = '2026-10-15T08:00:00.000Z';

const assistant = (turnId: TurnId, parts: ChatPart[]): ChatMessage => ({
  id: `a:${turnId}`,
  role: 'assistant',
  turnId,
  parts,
  seqRange: [2, 3],
  startedAt: TS,
});
const tool = (
  id: string,
  kind: 'read' | 'edit' | 'shell',
  status: 'running' | 'completed' | 'failed' | 'awaiting_approval',
  extra: Record<string, unknown> = {},
): ChatPart => ({
  type: 'tool',
  key: `t:${id}`,
  toolCallId: id,
  toolName: kind,
  display: kind === 'shell' ? { kind, command: 'pnpm test' } : { kind, paths: [`/w/src/${id}.ts`] },
  status,
  input: {},
  startedAt: TS,
  ...(status !== 'running' &&
    status !== 'awaiting_approval' && { finishedAt: '2026-10-15T08:00:01.900Z' }),
  ...extra,
});
const text = (state: 'streaming' | 'done'): ChatPart => ({
  type: 'text',
  key: 'x',
  text: 'hi',
  state,
});

function transcript(
  messages: ChatMessage[],
  activeTurnId: TurnId | undefined,
  pendingQuestions: QuestionRequest[] = [],
) {
  return { messages, activeTurnId, pendingQuestions };
}

describe('agentRun', () => {
  it('没有进行中的回合时没有状态', () => {
    expect(agentRun(transcript([assistant(T1, [tool('a', 'read', 'completed')])], undefined))).toBe(
      undefined,
    );
  });

  it('只看进行中的回合：做完的几步带用时，当前动作是还在跑的工具', () => {
    const run = agentRun(
      transcript(
        [
          assistant(T1, [tool('old', 'read', 'completed')]),
          assistant(T2, [
            tool('a', 'read', 'completed'),
            tool('b', 'edit', 'failed'),
            tool('c', 'shell', 'running'),
          ]),
        ],
        T2,
      ),
      '/w',
    );
    expect(run?.turnId).toBe(T2);
    expect(run?.startedAt).toBe(TS);
    expect(run?.steps.map((step) => [step.target, step.tone, step.durationMs])).toEqual([
      ['a.ts', 'done', 1900],
      ['b.ts', 'failed', 1900],
    ]);
    expect(run?.current).toMatchObject({ target: 'pnpm test', tone: 'running' });
  });

  it('等审批的工具与等回答优先；都没有时看最后一段是在回复还是在思考', () => {
    const waiting = agentRun(
      transcript(
        [assistant(T1, [tool('a', 'shell', 'awaiting_approval'), tool('b', 'read', 'running')])],
        T1,
      ),
    );
    expect(waiting?.current).toMatchObject({ tone: 'awaiting', target: 'pnpm test' });
    const question = agentRun(
      transcript([assistant(T1, [tool('a', 'read', 'running')])], T1, [{} as QuestionRequest]),
    );
    expect(question?.current.tone).toBe('awaiting');
    const writing = agentRun(transcript([assistant(T1, [text('streaming')])], T1));
    const thinking = agentRun(transcript([assistant(T1, [text('done')])], T1));
    expect(writing?.current.label).not.toBe(thinking?.current.label);
  });
});

describe('formatClock', () => {
  it('分:秒，超过一小时带小时', () => {
    expect(formatClock(7_400)).toBe('0:07');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('SessionActivityTracker', () => {
  const session = { id: 'ses_1', cwd: '/w' } as Pick<Session, 'id' | 'cwd'>;
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>) =>
    ({ type, payload, sessionId: session.id, seq: ++seq, ts: TS }) as unknown as WevirEvent;

  it('跟着事件换当前动作，只在变了时通知，回合结束时清掉', () => {
    const tracker = new SessionActivityTracker();
    const listener = vi.fn();
    tracker.subscribe(session.id as Session['id'], listener);
    tracker.apply(
      event('tool.started', {
        turnId: T1,
        toolCallId: 'a',
        toolName: 'read',
        display: { kind: 'read', paths: ['/w/a.ts'] },
      }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toBeUndefined();

    tracker.apply(event('turn.started', { turnId: T1 }), session);
    const thinking = tracker.get(session.id as Session['id']);
    expect(thinking).toMatchObject({ tone: 'running', steps: 0 });
    tracker.apply(
      event('tool.started', {
        turnId: T1,
        toolCallId: 'a',
        toolName: 'read',
        display: { kind: 'read', paths: ['/w/a.ts'] },
      }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toMatchObject({ target: 'a.ts', steps: 0 });
    const calls = listener.mock.calls.length;
    tracker.apply(
      event('assistant.delta', {
        turnId: T1,
        streamId: 's',
        blockIndex: 0,
        kind: 'text',
        text: 'x',
      }),
      session,
    );
    expect(listener.mock.calls.length).toBe(calls);

    tracker.apply(
      event('tool.finished', { turnId: T1, toolCallId: 'a', status: 'completed' }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toMatchObject({
      label: thinking?.label,
      steps: 1,
    });
    tracker.apply(
      event('turn.finished', { turnId: T1, outcome: 'completed', durationMs: 10 }),
      session,
    );
    expect(tracker.get(session.id as Session['id'])).toBeUndefined();
  });
});
