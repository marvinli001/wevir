import { createPersistedStore, createStore } from '@/lib/store';
import { clearMark, type TaskItem } from './tasks-model';

// “后台任务”（desktop-layout.md §15）的本机状态：“清除已完成”的记号（持久，会话 ID → tasks-model.ts 的 clearMark，只留最近清除
// 过的 MAX_SESSIONS 个会话），与窗格里打开着的后台进程（会话 ID → 进程的 processKey，不持久；子智能体的详情在 URL 里）。

const MAX_SESSIONS = 200;

const clearMarks = createPersistedStore<Readonly<Record<string, string>>>(
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

export function useClearMark(sessionId: string): string | undefined {
  return clearMarks.use()[sessionId];
}

export function clearFinishedTasks(sessionId: string, items: readonly TaskItem[]): void {
  const mark = clearMark(items);
  if (mark === undefined) return;
  clearMarks.set((current) => {
    const { [sessionId]: _, ...rest } = current;
    const kept = Object.entries(rest).slice(-(MAX_SESSIONS - 1));
    return Object.fromEntries([...kept, [sessionId, mark]]);
  });
}

const openProcesses = createStore<Readonly<Record<string, string>>>({});

export function useOpenProcess(sessionId: string): string | undefined {
  return openProcesses.use()[sessionId];
}

/** 打开（`key`）或关掉（undefined）会话的“后台任务”窗格里的进程详情。 */
export function setOpenProcess(sessionId: string, key: string | undefined): void {
  openProcesses.set((current) => {
    if (current[sessionId] === key) return current;
    const { [sessionId]: _, ...rest } = current;
    return key === undefined ? rest : { ...rest, [sessionId]: key };
  });
}
