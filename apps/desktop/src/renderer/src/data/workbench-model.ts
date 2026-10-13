// 左栏“工作区 → 会话”树的数据模型与路由解析（T5.2）。纯函数，不碰 DOM 与 Host 连接。

import type { Session, SessionId, Workspace } from '@wevir/protocol';

export interface WorkspaceEntry {
  workspace: Workspace;
  /** 属于这个工作区的会话，按最近活动（`updatedAt`，最后一个事件的时刻）从新到旧。 */
  sessions: Session[];
}

export type WorkbenchData =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceEntry[] }
  | { status: 'error'; error: string };

/**
 * 会话按 workspaceId 归到各自的工作区下，每组按最近活动从新到旧（同一时刻按 ID 倒序，顺序稳定）；不属于
 * 任何已知工作区的会话不显示。
 */
export function groupSessions(
  workspaces: readonly Workspace[],
  sessions: Iterable<Session>,
): WorkspaceEntry[] {
  const entries = workspaces.map((workspace) => ({ workspace, sessions: [] as Session[] }));
  const byId = new Map(entries.map((entry) => [entry.workspace.id, entry]));
  for (const session of sessions) byId.get(session.workspaceId)?.sessions.push(session);
  for (const entry of entries) entry.sessions.sort(byRecentActivity);
  return entries;
}

function byRecentActivity(a: Session, b: Session): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 重新读到的会话列表与本地实时跟着事件更新的会话合并：两边都有时取 `lastSeq` 大的（订阅可能已经比列表
 * 新，也可能还没追上）；列表里没有的会话（所在工作区已移除）去掉。
 */
export function mergeSessions(
  live: ReadonlyMap<SessionId, Session>,
  fetched: readonly Session[],
): Map<SessionId, Session> {
  const merged = new Map<SessionId, Session>();
  for (const session of fetched) {
    const current = live.get(session.id);
    merged.set(session.id, current && current.lastSeq >= session.lastSeq ? current : session);
  }
  return merged;
}

/** 会话行左侧的状态标记。`cancelling` 仍算运行中；只读会话与上一回合失败（idle 下有 lastError）算出错。 */
export type SessionMarker = 'running' | 'awaiting_approval' | 'error';

export function sessionMarker(session: Session): SessionMarker | undefined {
  switch (session.state) {
    case 'running':
    case 'cancelling':
      return 'running';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'error':
      return 'error';
    case 'idle':
      return session.lastError || session.readOnly ? 'error' : undefined;
    case 'closed':
      return session.readOnly ? 'error' : undefined;
  }
}

export type RouteTarget =
  | { kind: 'loading' }
  | { kind: 'unavailable'; error: string }
  | { kind: 'workspace-not-found'; workspaceId: string }
  | { kind: 'session-not-found'; entry: WorkspaceEntry; sessionId: string }
  | { kind: 'draft'; entry: WorkspaceEntry }
  | { kind: 'session'; entry: WorkspaceEntry; session: Session };

/**
 * 按 URL 里的 ID 在数据里找工作区与会话。会话必须属于 URL 里的那个工作区，否则也算“未找到”——URL
 * 是唯一事实，不替用户改写到会话真正所在的工作区。
 */
export function resolveRoute(
  data: WorkbenchData,
  workspaceId: string,
  sessionId?: string,
): RouteTarget {
  if (data.status === 'loading') return { kind: 'loading' };
  if (data.status === 'error') return { kind: 'unavailable', error: data.error };
  const entry = data.workspaces.find((candidate) => candidate.workspace.id === workspaceId);
  if (!entry) return { kind: 'workspace-not-found', workspaceId };
  if (sessionId === undefined) return { kind: 'draft', entry };
  const session = entry.sessions.find((candidate) => candidate.id === sessionId);
  return session
    ? { kind: 'session', entry, session }
    : { kind: 'session-not-found', entry, sessionId };
}
