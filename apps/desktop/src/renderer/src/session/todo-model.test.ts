import type { ChatMessage, ChatPart } from '@wevir/client-sdk';
import type { TodoItem, TurnId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  latestTodos,
  todoCollapsedByDefault,
  todoProgress,
  todoStatus,
  turnRecap,
} from './todo-model';

const T1 = 'trn_1' as TurnId;
const T2 = 'trn_2' as TurnId;
const TS = '2026-10-15T08:00:00.000Z';

const user = (turnId: TurnId): ChatMessage => ({
  id: `u:${turnId}`,
  role: 'user',
  turnId,
  parts: [{ type: 'text', key: 'x', text: 'go', state: 'done' }],
  seqRange: [1, 1],
  ts: TS,
});
const assistant = (turnId: TurnId, parts: ChatPart[], id = `a:${turnId}`): ChatMessage => ({
  id,
  role: 'assistant',
  turnId,
  parts,
  seqRange: [2, 3],
});
const todo = (...statuses: string[]): ChatPart => ({
  type: 'todo',
  key: 'todo',
  items: statuses.map((status, index) => ({ content: `step ${index + 1}`, status })),
});
const tool = (id: string, kind: 'read' | 'shell'): ChatPart => ({
  type: 'tool',
  key: `t:${id}`,
  toolCallId: id,
  toolName: kind,
  display: { kind },
  status: 'completed',
  input: {},
  startedAt: TS,
});
const items = (...statuses: string[]): TodoItem[] =>
  statuses.map((status, index) => ({ content: `s${index}`, status }));

describe('todoStatus', () => {
  it('认得 Codex 与 dsh 的写法，认不出的按未开始', () => {
    expect(
      ['completed', 'in_progress', 'inProgress', 'pending', 'blocked'].map((status) =>
        todoStatus({ status }),
      ),
    ).toEqual(['completed', 'in_progress', 'in_progress', 'pending', 'pending']);
  });
});

describe('latestTodos', () => {
  it('取最近一个回合的清单；那个回合没有清单时不显示更早回合的', () => {
    const first = [user(T1), assistant(T1, [todo('completed', 'in_progress')])];
    expect(latestTodos({ messages: first, activeTurnId: T1 })).toMatchObject({
      turnId: T1,
      active: true,
      items: [{ status: 'completed' }, { status: 'in_progress' }],
    });
    expect(latestTodos({ messages: [...first, user(T2)], activeTurnId: T2 })).toBeUndefined();
    expect(
      latestTodos({ messages: [user(T1), assistant(T1, [todo()])], activeTurnId: undefined }),
    ).toBeUndefined();
  });

  it('插话分出的后一条助手消息也算同一个回合', () => {
    const messages = [
      user(T1),
      assistant(T1, [tool('a', 'read')], 'a1'),
      assistant(T1, [todo('pending')], 'a2'),
    ];
    expect(latestTodos({ messages, activeTurnId: undefined })?.active).toBe(false);
  });
});

describe('进度与收起', () => {
  it('进度与进行中的那项', () => {
    expect(todoProgress(items('completed', 'in_progress', 'pending'))).toEqual({
      done: 1,
      total: 3,
      current: { content: 's1', status: 'in_progress' },
    });
  });

  it('回合结束且全部完成、或在等用户时收起；结束而没做完时展开', () => {
    const done = { turnId: T1, items: items('completed', 'completed') };
    const partial = { turnId: T1, items: items('completed', 'pending') };
    expect(todoCollapsedByDefault({ ...done, active: false }, false)).toBe(true);
    expect(todoCollapsedByDefault({ ...done, active: true }, false)).toBe(false);
    expect(todoCollapsedByDefault({ ...partial, active: false }, false)).toBe(false);
    expect(todoCollapsedByDefault({ ...partial, active: true }, true)).toBe(true);
  });
});

describe('turnRecap', () => {
  it('有清单时是进度，没有时是最近一个工作组的摘要，都没有时不显示', () => {
    expect(
      turnRecap({
        messages: [user(T1), assistant(T1, [todo('completed', 'in_progress')])],
        activeTurnId: T1,
      }),
    ).toMatchObject({ kind: 'todos', progress: { done: 1, total: 2 } });
    const recap = turnRecap({
      messages: [user(T1), assistant(T1, [tool('a', 'read'), tool('b', 'shell')])],
      activeTurnId: T1,
    });
    expect(recap?.kind).toBe('work');
    expect(recap?.kind === 'work' && recap.summary).toBeTruthy();
    expect(turnRecap({ messages: [user(T1)], activeTurnId: T1 })).toBeUndefined();
  });
});
