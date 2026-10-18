// 设置 → 记忆（0.57.0）的纯逻辑：默认看哪个项目、列表按范围拆开、编辑框的草稿与冲突。界面在 memory-settings.tsx。

import type {
  HostSettings,
  MemoryNote,
  MemoryScope,
  MemorySummary,
  MemoryType,
  MethodResult,
} from '@wevir/protocol';
import type { WorkspaceEntry } from '@/data/workbench-model';
import type { PlainMessageKey } from '@/i18n';

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
