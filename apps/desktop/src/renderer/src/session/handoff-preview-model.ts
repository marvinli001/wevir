// 换来源前的接力预览（0.60.0）的纯逻辑：这次要交的约束与笔记、能选哪些笔记、材料预算占了多少、什么时候能确认。

import {
  HANDOFF_CONSTRAINT_MAX_CHARS,
  HANDOFF_MAX_CONSTRAINTS,
  HANDOFF_MAX_NOTES,
  type HandoffMaterialRequest,
  type HandoffPreview,
  type HostSettings,
  type MemoryScope,
  type MemorySummary,
} from '@wevir/protocol';

export { HANDOFF_CONSTRAINT_MAX_CHARS, HANDOFF_MAX_CONSTRAINTS, HANDOFF_MAX_NOTES };

/** 选入的一条笔记。 */
export interface NoteChoice {
  scope: MemoryScope;
  name: string;
}

export function noteKey(note: NoteChoice): string {
  return `${note.scope}/${note.name}`;
}

/**
 * 交给 Host 的材料：去掉首尾空白后为空的约束不交；没有约束与笔记时省略整个字段（与旧的切换一样）。约束最多
 * `HANDOFF_MAX_CONSTRAINTS` 条，笔记最多 `HANDOFF_MAX_NOTES` 条，多出的不交（界面本来也加不了）。
 */
export function handoffRequest(
  constraints: readonly string[],
  notes: readonly NoteChoice[],
): HandoffMaterialRequest | undefined {
  const kept = constraints
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .slice(0, HANDOFF_MAX_CONSTRAINTS);
  const chosen = notes.slice(0, HANDOFF_MAX_NOTES).map(({ scope, name }) => ({ scope, name }));
  if (kept.length === 0 && chosen.length === 0) return undefined;
  return {
    ...(kept.length > 0 && { constraints: kept }),
    ...(chosen.length > 0 && { notes: chosen }),
  };
}

/** 同样的材料请求得到同样的键：预览对应的请求与现在编辑中的不同时，不能确认。 */
export function requestKey(request: HandoffMaterialRequest | undefined): string {
  return JSON.stringify(request ?? {});
}

/**
 * 能选的笔记：启用的，全局与这个项目的（`memory.list` 已经只给这两种），最近更新的在前。自动记忆关着时一条都不能选（Host 也会
 * 拒绝），Host 没有记忆管理时也没有。
 */
export function selectableNotes(
  notes: readonly MemorySummary[] | undefined,
  settings: Pick<HostSettings, 'autoMemory'>,
): MemorySummary[] {
  if (notes === undefined || settings.autoMemory === false) return [];
  return notes.filter((note) => note.enabled);
}

/** 选中的笔记里已经不能选的（停用、删掉或自动记忆关了）去掉，免得 Host 拒绝。 */
export function keepSelectable(
  chosen: readonly NoteChoice[],
  selectable: readonly MemorySummary[],
): NoteChoice[] {
  const keys = new Set(selectable.map(noteKey));
  return chosen.filter((note) => keys.has(noteKey(note)));
}

/** 材料预算用了多少：没有材料时 0；超出时是一条历史都不放时的字节数。 */
export function budgetUsage(preview: HandoffPreview): {
  used: number;
  budget: number;
  ratio: number;
  over: boolean;
} {
  const used = preview.overBudget?.bytes ?? preview.bytes ?? 0;
  return {
    used,
    budget: preview.budgetBytes,
    ratio: Math.min(1, used / preview.budgetBytes),
    over: preview.overBudget !== undefined,
  };
}
