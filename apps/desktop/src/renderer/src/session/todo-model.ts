// 实时清单与“这一轮”回顾（U20，desktop-tokens.md §25）的纯逻辑：最近一个回合的清单、进度、收起规则与回顾的素材。

import type { ChatMessage, Transcript } from '@wevir/client-sdk';
import type { TodoItem, TurnId } from '@wevir/protocol';
import { groupWork, tallyWork, workSummary } from './tool-model';

export type TodoStatus = 'completed' | 'in_progress' | 'pending';

/** `TodoItem.status` 是引擎原值（已见 pending / in_progress / completed），认不出的按未开始算。 */
export function todoStatus(item: Pick<TodoItem, 'status'>): TodoStatus {
  const status = item.status.toLowerCase().replace(/[-\s]/g, '_');
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'in_progress' || status === 'inprogress' || status === 'active') {
    return 'in_progress';
  }
  return 'pending';
}

export interface TurnTodos {
  turnId: TurnId;
  items: readonly TodoItem[];
  /** 这个回合还在进行。 */
  active: boolean;
}

function lastTurnId(messages: readonly ChatMessage[]): TurnId | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as ChatMessage;
    if (message.role !== 'system') return message.turnId;
  }
  return undefined;
}

/** 会话最近一个回合的清单；那个回合没有清单（或清单是空的）时是 undefined，更早回合的清单不算。 */
export function latestTodos(
  transcript: Pick<Transcript, 'messages' | 'activeTurnId'>,
): TurnTodos | undefined {
  const turnId = lastTurnId(transcript.messages);
  if (turnId === undefined) return undefined;
  for (const message of transcript.messages) {
    if (message.role === 'system' || message.turnId !== turnId) continue;
    const part = message.parts.find((candidate) => candidate.type === 'todo');
    if (part?.type === 'todo' && part.items.length > 0) {
      return { turnId, items: part.items, active: transcript.activeTurnId === turnId };
    }
  }
  return undefined;
}

export interface TodoProgress {
  done: number;
  total: number;
  /** 进行中的第一项。 */
  current: TodoItem | undefined;
}

export function todoProgress(items: readonly TodoItem[]): TodoProgress {
  return {
    done: items.filter((item) => todoStatus(item) === 'completed').length,
    total: items.length,
    current: items.find((item) => todoStatus(item) === 'in_progress'),
  };
}

/** 清单卡片默认收起：回合结束且全部完成，或会话在等用户（审批、提问）时。用户点过的照用户的。 */
export function todoCollapsedByDefault(todos: TurnTodos, waiting: boolean): boolean {
  if (waiting) return true;
  const { done, total } = todoProgress(todos.items);
  return !todos.active && done === total;
}

/** 回顾的素材：有清单时是进度，没有时是这一轮最近一个工作组的摘要；都没有时是 undefined。 */
export type Recap = { kind: 'todos'; progress: TodoProgress } | { kind: 'work'; summary: string };

export function turnRecap(
  transcript: Pick<Transcript, 'messages' | 'activeTurnId'>,
): Recap | undefined {
  const todos = latestTodos(transcript);
  if (todos) return { kind: 'todos', progress: todoProgress(todos.items) };
  const turnId = lastTurnId(transcript.messages);
  if (turnId === undefined) return undefined;
  const parts = transcript.messages.flatMap((message) =>
    message.role === 'assistant' && message.turnId === turnId ? message.parts : [],
  );
  const work = groupWork(parts).findLast((item) => item.kind === 'work');
  if (work?.kind !== 'work') return undefined;
  const summary = workSummary(tallyWork(work.entries, transcript.activeTurnId === turnId));
  return summary === '' ? undefined : { kind: 'work', summary };
}
