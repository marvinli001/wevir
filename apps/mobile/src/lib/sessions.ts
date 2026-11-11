// 一台电脑的会话列表（0.101.0 的 `session.list` + `sessions.changed`，domain-model §3.46）：先读一次列表记下 `listVersion`，之后
// 每条变化的版本必须正好加一，否则（或重连上之后）整张重读。纯逻辑。

import { sessionActivityAt } from '@wevir/client-sdk';
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

/** 按最近活动（0.147.0，旧 Host 是 `updatedAt`）从新到旧：引擎重启、关闭这类事件不把旧会话顶到前面。 */
export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const at = sessionActivityAt(a);
    const bt = sessionActivityAt(b);
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
}

/** 默认列表（`session.list {}`）里有的会话：没归档、不是子会话、不是支线。 */
function inDefaultList(session: Session): boolean {
  return session.archivedAt === undefined && session.parentSessionId === undefined && !session.side;
}

/**
 * 应用一条变化；版本接不上时返回 `undefined`，调用方重读整张列表。Host 按这条连接读过的所有列表推送变化：读过已归档的列表后，
 * 归档的会话也作为 `upserted` 推来，这里从默认列表里拿掉。
 */
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
    sessions: sortSessions([...kept, ...[...upserted.values()].filter(inDefaultList)]),
    listVersion: change.listVersion,
  };
}

/** 等用户处理的审批与提问数。 */
export function pendingCount(
  session: Pick<Session, 'pendingApprovalCount' | 'pendingQuestionCount'>,
): number {
  return (session.pendingApprovalCount ?? 0) + (session.pendingQuestionCount ?? 0);
}

/** 会话所在目录的最后一段，作项目名。 */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? cwd;
}

/** 已归档的会话（`session.list { archived: true }`）：按归档时刻从新到旧；搜索词不分大小写，匹配标题或项目名。 */
export function archivedSessions(sessions: readonly Session[], query: string): Session[] {
  const needle = query.trim().toLowerCase();
  const at = (session: Session) => session.archivedAt ?? session.updatedAt;
  return sessions
    .filter(
      (session) =>
        needle === '' ||
        session.title.toLowerCase().includes(needle) ||
        folderName(session.cwd).toLowerCase().includes(needle),
    )
    .sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
}
