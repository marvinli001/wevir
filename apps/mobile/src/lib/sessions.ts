// 一台电脑的会话列表（0.101.0 的 `session.list` + `sessions.changed`，domain-model §3.46）：先读一次列表记下 `listVersion`，之后
// 每条变化的版本必须正好加一，否则（或重连上之后）整张重读。纯逻辑。

import type { Session } from '@wevir/protocol';

export interface SessionList {
  sessions: readonly Session[];
  /** 旧 Host 没有列表版本：每条变化都重读。 */
  listVersion: number | undefined;
}

export interface SessionsChangeLike {
  listVersion: number;
  upserted: readonly Session[];
  removed: readonly string[];
}

/** 按 `updatedAt` 从新到旧（同 `session.list`）。 */
export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}

/** 应用一条变化；版本接不上时返回 `undefined`，调用方重读整张列表。 */
export function applySessionsChange(
  list: SessionList,
  change: SessionsChangeLike,
): SessionList | undefined {
  if (list.listVersion === undefined || change.listVersion !== list.listVersion + 1)
    return undefined;
  const removed = new Set(change.removed);
  const upserted = new Map(change.upserted.map((s) => [s.id, s]));
  const kept = list.sessions.filter((s) => !removed.has(s.id) && !upserted.has(s.id));
  return {
    sessions: sortSessions([...kept, ...upserted.values()]),
    listVersion: change.listVersion,
  };
}

/** 等用户处理的审批与提问数。 */
export function pendingCount(
  session: Pick<Session, 'pendingApprovalCount' | 'pendingQuestionCount'>,
): number {
  return (session.pendingApprovalCount ?? 0) + (session.pendingQuestionCount ?? 0);
}
