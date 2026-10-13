// 会话列表的实时更新：把一条事件应用到 `session.list` / `session.get` 给的 `Session` 上（T5.3）。推导规则与
// Host 的快照推导相同（packages/host/src/snapshot.ts 的 applyEvent，domain-model §3.3），只保留 `Session`
// 自己的字段；客户端据此在两次读取列表之间跟上状态、标题与最近活动时间。

import type { Session, WevirEvent } from '@wevir/protocol';

/**
 * 应用一条事件，返回新的 `Session`（不修改传入的对象）。事件的 seq 不大于 `session.lastSeq` 时视为已应用，
 * 原样返回；不认识的事件只推进 `lastSeq` 与 `updatedAt`。
 */
export function applySessionEvent(session: Session, event: WevirEvent): Session {
  if (event.sessionId !== session.id || event.seq <= session.lastSeq) return session;
  const next: Session = { ...session, lastSeq: event.seq, updatedAt: event.ts };
  switch (event.type) {
    case 'session.read_only':
      next.readOnly = {
        reason: event.payload.reason,
        message: event.payload.message,
        since: event.ts,
      };
      break;
    case 'session.resumed':
      delete next.readOnly;
      break;
    case 'session.title_changed':
      next.title = event.payload.title;
      next.titleSource = event.payload.source;
      break;
    case 'session.state_changed':
      next.state = event.payload.to;
      if (event.payload.reason === 'turn_started' || event.payload.reason === 'resumed') {
        delete next.lastError;
      }
      break;
    case 'turn.started':
      next.activeTurn = { turnId: event.payload.turnId, startedAt: event.ts };
      break;
    case 'turn.finished':
      if (session.activeTurn?.turnId === event.payload.turnId) delete next.activeTurn;
      break;
    case 'engine.error':
      next.lastError = { category: event.payload.category, message: event.payload.message };
      break;
    default:
      break;
  }
  return next;
}
