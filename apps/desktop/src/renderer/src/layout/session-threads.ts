import type { Session } from '@wevir/protocol';

// 侧栏里的会话线程（照 Claude Code 桌面端的嵌套会话）：agent 开出的会话（`openedBy`，wevir_session_create）与从建议开出的
// 会话（`origin`）归在开出它的会话下面。只嵌一层：子会话再开的会话也归到最上面那个会话。开出它的会话不在同一个列表里
// （归档了、在别的项目）时，它照常单独一行。

export interface SessionThread {
  session: Session;
  /** 归在它下面的会话，按列表里原来的先后。 */
  children: Session[];
}

/** 会话由哪个会话开出来：agent 开的取 `openedBy`，从建议开的取 `origin`。 */
export function openerOf(session: Pick<Session, 'openedBy' | 'origin'>): string | undefined {
  return session.openedBy?.sessionId ?? session.origin?.sessionId;
}

/** 把一个列表里的会话按开出它的会话归成线程；线程的先后跟着最上面那个会话在列表里的位置。 */
export function threadSessions(sessions: readonly Session[]): SessionThread[] {
  const byId = new Map<string, Session>(sessions.map((session) => [session.id, session]));
  const rootOf = (session: Session): Session => {
    const seen = new Set<string>([session.id]);
    let current = session;
    for (let opener = openerOf(current); opener !== undefined; opener = openerOf(current)) {
      const parent = byId.get(opener);
      if (parent === undefined) break;
      // 互相指着（数据不该这样）：不嵌套，各自单独一行。
      if (seen.has(parent.id)) return session;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, SessionThread>();
  const children: Array<[string, Session]> = [];
  for (const session of sessions) {
    const root = rootOf(session);
    if (root === session) threads.set(session.id, { session, children: [] });
    else children.push([root.id, session]);
  }
  for (const [rootId, session] of children) threads.get(rootId)?.children.push(session);
  return [...threads.values()];
}
