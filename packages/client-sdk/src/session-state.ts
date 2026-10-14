// 会话列表的实时更新：把一条事件应用到 `session.list` / `session.get` 给的 `Session` 上（T5.3）。推导规则与
// Host 的快照推导相同（packages/host/src/snapshot.ts 的 applyEvent，domain-model §3.3），只保留 `Session`
// 自己的字段；客户端据此在两次读取列表之间跟上状态、标题与最近活动时间。子会话（R4）另外推进 `subagent`；父会话的
// 子会话列表用 `applySubagentEvent`。

import type {
  Session,
  SubagentStatus,
  SubagentSummary,
  TurnOutcome,
  WevirEvent,
} from '@wevir/protocol';

/** 子会话的回合结果 → 子会话的状态（domain-model §3.3.1，与 Host 的推导相同）。 */
const SUBAGENT_STATUS_OF_OUTCOME: Record<TurnOutcome, SubagentStatus> = {
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
  interrupted: 'failed',
};

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
    case 'question.requested':
      next.awaitingInput = true;
      break;
    case 'question.resolved':
      delete next.awaitingInput;
      break;
    case 'session.configured':
      next.modelId = event.payload.modelId;
      if (event.payload.reasoningEffort === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = event.payload.reasoningEffort;
      // 0.11.0 之前的 Host 不带权限模式：那时只有 on_request，省略即是。
      if (event.payload.permissionMode === undefined) delete next.permissionMode;
      else next.permissionMode = event.payload.permissionMode;
      break;
    case 'session.state_changed': {
      next.state = event.payload.to;
      if (event.payload.reason === 'turn_started' || event.payload.reason === 'resumed') {
        delete next.lastError;
      }
      const subagent = session.subagent;
      if (subagent !== undefined && event.payload.to === 'closed') {
        next.subagent = { ...subagent, status: 'closed', endedAt: subagent.endedAt ?? event.ts };
      } else if (subagent?.status === 'running' && event.payload.to === 'error') {
        next.subagent = { ...subagent, status: 'failed', endedAt: subagent.endedAt ?? event.ts };
      }
      break;
    }
    case 'turn.started':
      next.activeTurn = { turnId: event.payload.turnId, startedAt: event.ts };
      if (session.subagent !== undefined) {
        const { endedAt: _ended, ...rest } = session.subagent;
        next.subagent = { ...rest, status: 'running' };
      }
      break;
    case 'turn.finished':
      if (session.activeTurn?.turnId === event.payload.turnId) delete next.activeTurn;
      if (session.subagent !== undefined) {
        next.subagent = {
          ...session.subagent,
          status: SUBAGENT_STATUS_OF_OUTCOME[event.payload.outcome],
          endedAt: event.ts,
        };
      }
      break;
    case 'engine.error':
      next.lastError = { category: event.payload.category, message: event.payload.message };
      break;
    default:
      break;
  }
  return next;
}

/**
 * 父会话的子会话列表（R4，domain-model §3.3.1）：把父会话的一条事件应用到 `SessionSnapshot.subagents`（或上一次的
 * 结果）上，返回新的列表（不修改传入的数组）。`subagent.started` 追加，`subagent.updated` 按 `sessionId` 替换；其余事件
 * 原样返回。
 */
export function applySubagentEvent(
  subagents: readonly SubagentSummary[],
  event: WevirEvent,
): readonly SubagentSummary[] {
  if (event.type !== 'subagent.started' && event.type !== 'subagent.updated') return subagents;
  const summary = event.payload.subagent;
  const index = subagents.findIndex((item) => item.sessionId === summary.sessionId);
  return index < 0
    ? [...subagents, summary]
    : subagents.map((item, i) => (i === index ? summary : item));
}
