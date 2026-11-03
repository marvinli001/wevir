// “后台任务”（desktop-layout.md §15）的纯逻辑：子智能体与 Host 起的后台进程（0.69.0）合成一个列表，按“进行中”“已完成”分组、
// 排序，子智能体自己起的进程挂在它下面，以及“清除已完成”的记号。组件在 panes/tasks-pane.tsx。

import type { HostProcess, SubagentSummary } from '@wevir/protocol';
import { lastActivity } from '@/session/subagent-model';
import { processKey } from './process-model';

export type TaskItem =
  | {
      kind: 'subagent';
      summary: SubagentSummary;
      /** 它自己起的后台进程（`source.sessionId` 是它的子会话），照 Claude Code 卡片下的“N 个任务”。 */
      processes: readonly HostProcess[];
    }
  | { kind: 'process'; process: HostProcess };

/** 列表里的身份：子会话 ID，或进程 ID 加启动时刻（Host 重启后 ID 会重用）。 */
export function taskKey(item: TaskItem): string {
  return item.kind === 'subagent'
    ? `subagent:${item.summary.sessionId}`
    : `process:${processKey(item.process)}`;
}

/** 子智能体结束了、它起的进程还在跑时也算进行中。 */
export function taskRunning(item: TaskItem): boolean {
  return item.kind === 'subagent'
    ? item.summary.status === 'running' ||
        item.processes.some((process) => process.status === 'running')
    : item.process.status === 'running';
}

function processActivity(process: HostProcess): string {
  return process.status === 'running' ? process.startedAt : (process.endedAt ?? process.startedAt);
}

/**
 * 排序与清除用的时刻（都是 Host 的时钟）：进行中的是开始时刻，结束的是结束时刻；子智能体取它与它的进程里最晚的。
 */
export function taskActivity(item: TaskItem): string {
  if (item.kind === 'process') return processActivity(item.process);
  let at = lastActivity(item.summary);
  for (const process of item.processes) {
    const own = processActivity(process);
    if (own > at) at = own;
  }
  return at;
}

export interface TaskGroups {
  /** 进行中：最近开始的在前。 */
  open: TaskItem[];
  /** 已完成（子智能体的完成、失败、关闭、取消，进程退出）：最近结束的在前。 */
  done: TaskItem[];
}

/**
 * 时刻相同时后来的在前（输入按派出、启动的先后）。`source.sessionId` 是某个子智能体的进程挂到它下面，其余的进程各占一行
 * （调用方只给这个会话与它的子会话的进程）。
 */
export function groupTasks(
  subagents: readonly SubagentSummary[],
  processes: readonly HostProcess[],
): TaskGroups {
  const children = new Map<string, HostProcess[]>(
    subagents.map((summary) => [summary.sessionId, []]),
  );
  const own: HostProcess[] = [];
  for (const process of processes) {
    const list = children.get(process.source.sessionId);
    if (list) list.push(process);
    else own.push(process);
  }
  const items: TaskItem[] = [
    ...subagents.map((summary) => ({
      kind: 'subagent' as const,
      summary,
      processes: children.get(summary.sessionId) ?? [],
    })),
    ...own.map((process) => ({ kind: 'process' as const, process })),
  ];
  const ordered = items
    .map((item, index) => ({ item, index, at: taskActivity(item) }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.index - a.index)
    .map((entry) => entry.item);
  return {
    open: ordered.filter(taskRunning),
    done: ordered.filter((item) => !taskRunning(item)),
  };
}

/** 一个子智能体卡片下的进程，分组与排序同列表。 */
export function groupProcesses(processes: readonly HostProcess[]): {
  open: HostProcess[];
  done: HostProcess[];
} {
  const { open, done } = groupTasks([], processes);
  const unwrap = (items: TaskItem[]) =>
    items.flatMap((item) => (item.kind === 'process' ? [item.process] : []));
  return { open: unwrap(open), done: unwrap(done) };
}

/**
 * “清除已完成”：记下当时已结束的里最晚的结束时刻，之后只列运行中的与在那之后结束的。只是不显示，记录还在；又跑起来、再结束的
 * 重新出现。没有已结束的时返回 undefined。
 */
export function clearMark(items: readonly TaskItem[]): string | undefined {
  let mark: string | undefined;
  for (const item of items) {
    if (taskRunning(item)) continue;
    const at = taskActivity(item);
    if (mark === undefined || at > mark) mark = at;
  }
  return mark;
}

export function withoutCleared(groups: TaskGroups, mark: string | undefined): TaskGroups {
  if (mark === undefined) return groups;
  return { open: groups.open, done: groups.done.filter((item) => taskActivity(item) > mark) };
}
