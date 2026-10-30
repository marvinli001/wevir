// 会话侧栏“任务清单”卡片的纯逻辑（0.52.0，desktop-layout.md §12）：共享任务清单（`tasks.board_updated`）按状态分组，
// 每项算出等着谁、能不能开始，认领的会话认成“本会话 / 子智能体 / 别的会话 / 不认识”；清单在会话树的哪个会话里（`boardRootOf`）。
// 清单由 agent 改，界面只读。

import type {
  BoardTask,
  BoardTaskStatus,
  Session,
  SessionId,
  SubagentSummary,
} from '@wevir/protocol';
import { paths } from '@/routes/paths';

/** 分组的先后：在做的最前，做完与取消的垫底。 */
export const BOARD_STATUS_ORDER: readonly BoardTaskStatus[] = [
  'in_progress',
  'pending',
  'completed',
  'cancelled',
];

/** 认领（或写备注）的会话是谁；`to` 是点它去的地方。 */
export type SessionRef =
  | { kind: 'self' }
  | { kind: 'subagent'; title: string; to: string }
  | { kind: 'session'; title: string; to: string }
  | { kind: 'unknown' };

export interface SessionDirectory {
  /** 当前看的会话（会话树里的任何一个，不一定是根）：它认领的项标“本会话”。 */
  sessionId: SessionId;
  workspaceId: string;
  /** 它派出的子会话。 */
  subagents: readonly Pick<SubagentSummary, 'sessionId' | 'title' | 'nickname'>[];
  /** 列表里的所有会话（agent 开出来的会话在里面）。 */
  sessions: readonly Pick<Session, 'id' | 'workspaceId' | 'title'>[];
  /** 没有标题时的写法。 */
  untitled: string;
}

type TreeLinks = Pick<Session, 'id' | 'parentSessionId' | 'forkedFrom' | 'openedBy' | 'opinionOf'>;

/**
 * 清单在哪个会话里：会话树的根（Host 只把 `tasks.board_updated` 写进根会话）。照 Host 找根的办法一层层往上：子会话到父会话、
 * 分支与支线到被分的会话、agent 开的会话到开它的会话、第二意见到收意见的会话。`lookup` 认不得上一层（归档了、不在列表里）时，
 * 就当上一层是根。
 */
export function boardRootOf(
  session: TreeLinks,
  lookup: (id: SessionId) => TreeLinks | undefined,
): SessionId {
  const seen = new Set<string>();
  let current = session;
  while (!seen.has(current.id)) {
    seen.add(current.id);
    const up =
      current.parentSessionId ??
      current.forkedFrom?.sessionId ??
      current.openedBy?.sessionId ??
      current.opinionOf?.sessionId;
    if (up === undefined) break;
    const next = lookup(up);
    if (next === undefined) return up;
    current = next;
  }
  return current.id;
}

export function resolveSession(id: string, directory: SessionDirectory): SessionRef {
  if (id === directory.sessionId) return { kind: 'self' };
  const child = directory.subagents.find((item) => item.sessionId === id);
  if (child) {
    return {
      kind: 'subagent',
      title: child.title.trim() || child.nickname?.trim() || directory.untitled,
      to: paths.agent(directory.workspaceId, directory.sessionId, id),
    };
  }
  const session = directory.sessions.find((item) => item.id === id);
  if (session) {
    return {
      kind: 'session',
      title: session.title.trim() || directory.untitled,
      to: paths.session(session.workspaceId, session.id),
    };
  }
  return { kind: 'unknown' };
}

export interface BoardNote {
  author: SessionRef;
  text: string;
  at: string;
}

export interface BoardRow {
  task: BoardTask;
  owner?: SessionRef;
  /** 还没做完的依赖项（找不到的算已解除）。 */
  waitingFor: string[];
  /** 还没开始、没有依赖挡着：随时能开始。 */
  ready: boolean;
  notes: BoardNote[];
  /** 有说明或备注可展开。 */
  expandable: boolean;
}

export interface BoardGroup {
  status: BoardTaskStatus;
  rows: BoardRow[];
}

const isResolved = (task: BoardTask): boolean =>
  task.status === 'completed' || task.status === 'cancelled';

/** 按状态分组（空组不出现），组内保持清单里的先后（创建的先后）。 */
export function boardGroups(
  tasks: readonly BoardTask[],
  directory: SessionDirectory,
): BoardGroup[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rows = tasks.map<BoardRow>((task) => {
    const waitingFor = isResolved(task)
      ? []
      : task.blockedBy.filter((id) => {
          const blocker = byId.get(id);
          return blocker !== undefined && !isResolved(blocker);
        });
    const notes = task.notes.map((note) => ({
      author: resolveSession(note.sessionId, directory),
      text: note.text,
      at: note.at,
    }));
    return {
      task,
      ...(task.owner !== undefined && { owner: resolveSession(task.owner, directory) }),
      waitingFor,
      ready: task.status === 'pending' && waitingFor.length === 0,
      notes,
      expandable: task.description !== undefined || notes.length > 0,
    };
  });
  return BOARD_STATUS_ORDER.flatMap((status) => {
    const inGroup = rows.filter((row) => row.task.status === status);
    return inGroup.length === 0 ? [] : [{ status, rows: inGroup }];
  });
}

/** 收起时的摘要“已完成 / 总数”（取消的不算在总数里）；全是取消的没有摘要。 */
export function boardProgress(tasks: readonly BoardTask[]): { done: number; total: number } {
  const counted = tasks.filter((task) => task.status !== 'cancelled');
  return {
    done: counted.filter((task) => task.status === 'completed').length,
    total: counted.length,
  };
}
