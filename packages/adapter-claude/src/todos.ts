// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts（`claudeTodoSteps`、`applyClaudeTaskTool`、`claudeUserInputQuestions`、`claudeSdkUserInputAnswers`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：输出 Wevir 的 `TodoItem` 与 `UserQuestion`（状态保留 Claude 的原值，问题带 `allowOther`）。
//
// Claude 的清单与提问（claude-event-mapping.md §5.4、§5.5）：旧版用 TodoWrite（每次给完整列表），Claude 5 用 TaskCreate /
// TaskUpdate / TaskList（逐条改，ID 由 Claude 在 TaskCreate 的结果里给）；AskUserQuestion 的输入是一组问题，回答按问题原文
// 回给它。

import type { TodoItem, UserQuestion } from '@wevir/runtime-adapter';

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function str(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : undefined;
}

/** TodoWrite 的输入 → 完整的清单。不是清单时 undefined。 */
export function todoWriteItems(input: unknown): TodoItem[] | undefined {
  const todos = field(input, 'todos');
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((todo) => {
    const content = str(todo, 'content');
    if (content === undefined) return [];
    const status = field(todo, 'status');
    return [{ content, status: typeof status === 'string' ? status : 'pending' }];
  });
}

/** 一个会话的 Claude 任务清单：Claude 的任务 ID → 条目，按建立的顺序。 */
export type TaskList = ReadonlyMap<string, TodoItem>;

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/**
 * 把一次成功的 TaskCreate / TaskUpdate / TaskList 用到清单上（T3 的 `applyClaudeTaskTool`）：`deleted` 状态删掉这一条，
 * TaskList 换掉整张。不是这三种工具、或清单没变时 undefined。
 */
export function applyTaskTool(
  tasks: TaskList,
  toolName: string,
  input: unknown,
  result: unknown,
): TaskList | undefined {
  if (toolName === 'TaskList') {
    const listed = field(result, 'tasks');
    if (!Array.isArray(listed)) return undefined;
    const next = new Map<string, TodoItem>();
    for (const task of listed) {
      const id = str(task, 'id');
      const content = str(task, 'subject');
      const status = field(task, 'status');
      if (id !== undefined && content !== undefined && typeof status === 'string') {
        if (TASK_STATUSES.has(status)) next.set(id, { content, status });
      }
    }
    return next.size === 0 && tasks.size === 0 ? undefined : next;
  }
  if (toolName === 'TaskCreate') {
    const created = field(result, 'task');
    const id = str(created, 'id');
    const content = str(created, 'subject') ?? str(input, 'subject');
    if (id === undefined || content === undefined) return undefined;
    return new Map(tasks).set(id, { content, status: 'pending' });
  }
  if (toolName !== 'TaskUpdate' || field(result, 'success') === false) return undefined;
  const id = str(input, 'taskId') ?? str(result, 'taskId');
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return undefined;
  const status = field(input, 'status');
  if (status === 'deleted') {
    const next = new Map(tasks);
    next.delete(id);
    return next;
  }
  const content = str(input, 'subject') ?? task.content;
  const nextStatus = typeof status === 'string' && TASK_STATUSES.has(status) ? status : task.status;
  if (content === task.content && nextStatus === task.status) return undefined;
  return new Map(tasks).set(id, { content, status: nextStatus });
}

export const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

/**
 * AskUserQuestion 的输入 → Wevir 的问题（T3 的 `claudeUserInputQuestions`）。问题 ID 就是问题原文：Claude 按原文认回答。
 * Claude Code 的提问总能填别的答案，所以 `allowOther`。
 */
export function askUserQuestions(input: unknown): UserQuestion[] {
  const questions = field(input, 'questions');
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((value, index) => {
    const question = str(value, 'question');
    if (question === undefined) return [];
    const rawOptions = field(value, 'options');
    const options = Array.isArray(rawOptions)
      ? rawOptions.flatMap((option) => {
          const label = str(option, 'label');
          if (label === undefined) return [];
          const description = str(option, 'description');
          return [{ label, ...(description !== undefined && { description }) }];
        })
      : [];
    return [
      {
        id: question,
        header: str(value, 'header') ?? `Question ${index + 1}`,
        question,
        options,
        multiSelect: field(value, 'multiSelect') === true,
        allowOther: true,
      },
    ];
  });
}

/** Wevir 的回答 → AskUserQuestion 的 `answers`（T3 的 `claudeSdkUserInputAnswers`：多选用逗号连起来）。 */
export function askUserAnswers(answers: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers).map(([question, values]) => [question, values.join(', ')]),
  );
}
