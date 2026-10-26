import type { Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { threadSessions } from './session-threads';

const session = (id: string, extra: Partial<Session> = {}) => ({ id, ...extra }) as Session;
const ids = (threads: ReturnType<typeof threadSessions>) =>
  threads.map((thread) => [thread.session.id, thread.children.map((child) => child.id)]);

describe('threadSessions', () => {
  it('agent 开的与从建议开的会话归到开出它的会话下面，孙会话归到最上面那个', () => {
    const list = [
      session('ses_c', { openedBy: { sessionId: 'ses_a' } } as Partial<Session>),
      session('ses_b'),
      session('ses_a'),
      session('ses_d', {
        origin: { kind: 'suggested_task', sessionId: 'ses_a', taskId: 'tsk_1' },
      } as Partial<Session>),
      session('ses_e', { openedBy: { sessionId: 'ses_c' } } as Partial<Session>),
    ];
    expect(ids(threadSessions(list))).toEqual([
      ['ses_b', []],
      ['ses_a', ['ses_c', 'ses_d', 'ses_e']],
    ]);
  });

  it('开出它的会话不在列表里时单独一行；互相指着的不会死循环', () => {
    const list = [
      session('ses_x', { openedBy: { sessionId: 'ses_gone' } } as Partial<Session>),
      session('ses_p', { openedBy: { sessionId: 'ses_q' } } as Partial<Session>),
      session('ses_q', { openedBy: { sessionId: 'ses_p' } } as Partial<Session>),
    ];
    const threads = threadSessions(list);
    expect(threads[0]).toEqual({ session: list[0], children: [] });
    expect(threads.flatMap((thread) => [thread.session, ...thread.children])).toHaveLength(3);
  });
});
