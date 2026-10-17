// 会话的“未读”标记（T5.2）：本机记下每个会话看过的最后一个事件 seq，会话的 lastSeq 比它大就算未读。
// 第一次见到的会话以当时的 lastSeq 为起点（不把历史会话全标成未读）；打开会话时更新。只存在本机的
// localStorage，不同步到其他设备。

import type { Session } from '@wevir/protocol';
import { createPersistedStore } from '@/lib/store';

type SeenMap = Readonly<Record<string, number>>;

const seen = createPersistedStore<SeenMap>('wevir.sessions-seen.v1', {}, (raw) =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      )
    : undefined,
);

/** 读到新的会话列表时调用：给没见过的会话记起点，并清掉列表里已经没有的会话。 */
export function recordBaselines(sessions: readonly Session[]): void {
  seen.set((current) => {
    const next: Record<string, number> = {};
    for (const session of sessions) next[session.id] = current[session.id] ?? session.lastSeq;
    return next;
  });
}

export function markSeen(session: Session): void {
  if (seen.get()[session.id] === session.lastSeq) return;
  seen.set((current) => ({ ...current, [session.id]: session.lastSeq }));
}

/** 标记为未读：记的位置退到最后一个事件之前，会话的 `lastSeq` 就比它大；会话再被打开时照常记为已读。 */
export function markUnread(session: Session): void {
  const before = Math.max(0, session.lastSeq - 1);
  if (seen.get()[session.id] === before) return;
  seen.set((current) => ({ ...current, [session.id]: before }));
}

export function isUnread(map: SeenMap, session: Session): boolean {
  const last = map[session.id];
  return last !== undefined && session.lastSeq > last;
}

export const useSeenSessions = seen.use;
