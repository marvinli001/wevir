// 设置 → 存储里按会话的占用与删除（0.43.0，Host 的 `session.usage` / `session.delete`，domain-model §3.20）：把会话与占用对上、
// 排序，依次删掉选中的已归档会话。纯函数，组件只显示。

import type {
  MethodResult,
  Session,
  SessionId,
  SessionUsage,
  SessionWorktreeUsage,
} from '@wevir/protocol';

/** 一个会话（含它的子会话与支线）一共占了多少：事件、文件与 worktree。 */
export function usageBytes(usage: SessionUsage): number {
  return (
    usage.eventBytes +
    usage.fileBytes +
    usage.worktrees.reduce((sum, worktree) => sum + worktree.bytes, 0)
  );
}

export interface ArchivedChatRow {
  session: Session;
  bytes: number;
  /** 有没提交的改动的 worktree 数：删除时要 `force`，确认框里提醒。 */
  dirtyWorktrees: number;
}

/** 已归档的会话与它们的占用：大的在前，一样大时先归档的在前。没量到的会话（量的时候还没归档）不列。 */
export function archivedChatRows(
  sessions: readonly Session[],
  usage: readonly SessionUsage[],
): ArchivedChatRow[] {
  const byId = new Map(usage.map((entry) => [entry.sessionId, entry]));
  const rows: ArchivedChatRow[] = [];
  for (const session of sessions) {
    const entry = byId.get(session.id);
    if (entry === undefined) continue;
    rows.push({
      session,
      bytes: usageBytes(entry),
      dirtyWorktrees: entry.worktrees.filter((worktree) => worktree.dirty).length,
    });
  }
  return rows.sort(
    (a, b) =>
      b.bytes - a.bytes ||
      (a.session.archivedAt ?? '').localeCompare(b.session.archivedAt ?? '') ||
      a.session.id.localeCompare(b.session.id),
  );
}

export interface WorktreeRow extends SessionWorktreeUsage {
  sessionId: SessionId;
  title: string;
  archived: boolean;
}

/** Host 为会话开的 worktree（已归档的与没归档的会话），大的在前。 */
export function worktreeRows(
  sessions: readonly Session[],
  usage: readonly SessionUsage[],
): WorktreeRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rows: WorktreeRow[] = [];
  for (const entry of usage) {
    const session = byId.get(entry.sessionId);
    for (const worktree of entry.worktrees) {
      rows.push({
        ...worktree,
        sessionId: entry.sessionId,
        title: session?.title ?? '',
        archived: session?.archivedAt !== undefined,
      });
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

export interface DeleteOutcome {
  deleted: SessionId[];
  failed: { sessionId: SessionId; error: string }[];
  keptBranches: string[];
  engineDataKept: boolean;
}

/**
 * 依次删掉这些会话。量的时候有没提交的改动的带 `force`（确认框已经提醒过）；之后才改出来的 Host 会拒绝，记为失败。一个失败不影响
 * 其余的。
 */
export async function deleteChats(
  rows: readonly ArchivedChatRow[],
  remove: (sessionId: SessionId, force: boolean) => Promise<MethodResult<'session.delete'>>,
  describe: (reason: unknown) => string,
): Promise<DeleteOutcome> {
  const outcome: DeleteOutcome = {
    deleted: [],
    failed: [],
    keptBranches: [],
    engineDataKept: false,
  };
  for (const row of rows) {
    const sessionId = row.session.id as SessionId;
    try {
      const result = await remove(sessionId, row.dirtyWorktrees > 0);
      outcome.deleted.push(sessionId);
      outcome.keptBranches.push(...(result.keptBranches ?? []));
      if (result.engineDataKept === true) outcome.engineDataKept = true;
    } catch (reason) {
      outcome.failed.push({ sessionId, error: describe(reason) });
    }
  }
  return outcome;
}
