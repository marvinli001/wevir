// 设置 → 记忆（0.57.0）的纯逻辑：默认看哪个项目、列表按范围拆开、编辑框的草稿与冲突、详情里的来源（0.58.0）。界面在
// memory-settings.tsx。

import type {
  HostSettings,
  MemoryNote,
  MemoryScope,
  MemorySource,
  MemorySummary,
  MemoryType,
  MethodResult,
  Session,
  SessionId,
} from '@wevir/protocol';
import type { WorkspaceEntry } from '@/data/workbench-model';
import type { PlainMessageKey } from '@/i18n';
import { paths } from '@/routes/paths';

/** 自动记忆开着没有：旧 Host 的设置里没有这一项，当作开着。 */
export function autoMemoryOn(settings: Pick<HostSettings, 'autoMemory'>): boolean {
  return settings.autoMemory !== false;
}

/**
 * 默认看的项目：上次所在的项目（或“对话”）还在就用它，否则第一个项目，再没有就是“对话”；都没有时是 `undefined`。
 * `projects` 是可选的工作区（项目在前，“对话”在最后）。
 */
export function defaultMemoryWorkspace(
  projects: readonly WorkspaceEntry[],
  lastWorkspaceId: string | null | undefined,
): string | undefined {
  const remembered = projects.find((entry) => entry.workspace.id === lastWorkspaceId);
  return (remembered ?? projects[0])?.workspace.id;
}

export interface MemorySections {
  global: MemorySummary[];
  project: MemorySummary[];
  /** 读不出来的文件名，按范围。 */
  unreadable: Record<MemoryScope, string[]>;
}

/** `memory.list` 的结果拆成全局与项目两组（各自保持 Host 给的顺序：最近更新的在前）。 */
export function splitMemory(listing: MethodResult<'memory.list'> | undefined): MemorySections {
  const notes = listing?.notes ?? [];
  const unreadable = listing?.unreadable ?? [];
  return {
    global: notes.filter((note) => note.scope === 'global'),
    project: notes.filter((note) => note.scope === 'project'),
    unreadable: {
      global: unreadable.filter((entry) => entry.scope === 'global').map((entry) => entry.name),
      project: unreadable.filter((entry) => entry.scope === 'project').map((entry) => entry.name),
    },
  };
}

export const MEMORY_TYPE_LABELS: Record<MemoryType, PlainMessageKey> = {
  user: 'settings.memory.type.user',
  feedback: 'settings.memory.type.feedback',
  project: 'settings.memory.type.project',
  reference: 'settings.memory.type.reference',
};

/** 编辑框里的草稿。 */
export interface MemoryDraft {
  type: MemoryType;
  description: string;
  content: string;
}

export function draftOf(note: Pick<MemoryNote, 'type' | 'description' | 'content'>): MemoryDraft {
  return { type: note.type, description: note.description, content: note.content };
}

/** 草稿与笔记有没有不同（说明与正文按去掉首尾空白比，同 Host 保存时的规整）。 */
export function draftChanged(draft: MemoryDraft, note: MemoryDraft): boolean {
  return (
    draft.type !== note.type ||
    draft.description.trim() !== note.description.trim() ||
    draft.content.trim() !== note.content.trim()
  );
}

/** 草稿能不能保存：说明与正文都不能是空的（其余规则由 Host 检查）。 */
export function draftValid(draft: MemoryDraft): boolean {
  return draft.description.trim() !== '' && draft.content.trim() !== '';
}

/** `memory.update` 的参数：只带改了的字段。 */
export function updatePatch(
  draft: MemoryDraft,
  note: MemoryDraft,
): Partial<Pick<MemoryNote, 'type' | 'description' | 'content'>> {
  return {
    ...(draft.type !== note.type && { type: draft.type }),
    ...(draft.description.trim() !== note.description.trim() && {
      description: draft.description,
    }),
    ...(draft.content.trim() !== note.content.trim() && { content: draft.content }),
  };
}

/** 详情里“来源”的一行：首次保存（没有记录时 `source` 是 `undefined`），以及与它不同的最近修改。 */
export interface MemorySourceRow {
  label: PlainMessageKey;
  source: MemorySource | undefined;
}

const sameWrite = (a: MemorySource, b: MemorySource) =>
  a.by === b.by && a.at === b.at && a.sessionId === b.sessionId && a.turnId === b.turnId;

/** “来源”的几行：首次保存总在（旧笔记显示未记录）；最近修改与首次保存是同一次写入时不重复列。 */
export function memorySourceRows(
  note: Pick<MemorySummary, 'origin' | 'lastEdit'>,
): MemorySourceRow[] {
  const rows: MemorySourceRow[] = [{ label: 'settings.memory.source.origin', source: note.origin }];
  if (
    note.lastEdit !== undefined &&
    (note.origin === undefined || !sameWrite(note.origin, note.lastEdit))
  ) {
    rows.push({ label: 'settings.memory.source.lastEdit', source: note.lastEdit });
  }
  return rows;
}

/** 要取标题的来源会话：Agent 写的、有会话、Host 没说已删除的，去重。 */
export function sourceSessions(rows: readonly MemorySourceRow[]): SessionId[] {
  const ids = rows.flatMap(({ source }) =>
    source?.by === 'agent' && source.sessionId !== undefined && source.status !== 'deleted'
      ? [source.sessionId]
      : [],
  );
  return [...new Set(ids)];
}

/** 打开来源会话的路由：子会话在父会话的“子智能体”窗格里打开。 */
export function sourceSessionPath(
  session: Pick<Session, 'id' | 'workspaceId' | 'parentSessionId'>,
): string {
  return session.parentSessionId === undefined
    ? paths.session(session.workspaceId, session.id)
    : paths.agent(session.workspaceId, session.parentSessionId, session.id);
}
