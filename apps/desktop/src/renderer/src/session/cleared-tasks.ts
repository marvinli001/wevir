import type { SubagentSummary } from '@wevir/protocol';
import { createPersistedStore } from '@/lib/store';
import { clearMark, withoutCleared } from './subagent-model';

// “后台任务”的“清除已完成”记在本机（desktop-layout.md §15）：会话 ID → 清除时已结束的里最晚的结束时刻
// （subagent-model.ts 的 clearMark）。只留最近清除过的 MAX_SESSIONS 个会话。

const MAX_SESSIONS = 200;

const clearedTasks = createPersistedStore<Readonly<Record<string, string>>>(
  'wevir.cleared-tasks.v1',
  {},
  (raw) =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined,
);

/** 会话的子会话里没被“清除已完成”藏起来的。 */
export function useVisibleSubagents(
  sessionId: string,
  subagents: readonly SubagentSummary[],
): readonly SubagentSummary[] {
  const mark = clearedTasks.use()[sessionId];
  return withoutCleared(subagents, mark);
}

export function clearFinishedTasks(sessionId: string, subagents: readonly SubagentSummary[]): void {
  const mark = clearMark(subagents);
  if (mark === undefined) return;
  clearedTasks.set((current) => {
    const { [sessionId]: _, ...rest } = current;
    const kept = Object.entries(rest).slice(-(MAX_SESSIONS - 1));
    return Object.fromEntries([...kept, [sessionId, mark]]);
  });
}
