// “变更”窗格的界面状态：每个会话选的范围（本次运行内）、要滚到的文件，以及记在本机的显示偏好（并排、自动换行）。
// 入口（会话侧栏的“变更”卡片、回合下面的“N 个文件已更改”）经 openChanges 选好范围再打开窗格。

import type { SessionId } from '@wevir/protocol';
import type { PaneController } from '@/layout/pane-controller';
import { createPersistedStore, createStore } from '@/lib/store';
import { type ChangesScope, DEFAULT_SCOPE } from './changes-model';

export interface ChangesSelection {
  scope: ChangesScope;
  /** 打开时要滚到的文件；`id` 每次请求加一，同一个文件再点也会滚过去。 */
  reveal?: { path: string; id: number };
}

const DEFAULT_SELECTION: ChangesSelection = { scope: DEFAULT_SCOPE };

const selections = createStore<ReadonlyMap<SessionId, ChangesSelection>>(new Map());
let revealCounter = 0;

export function useChangesSelection(sessionId: SessionId): ChangesSelection {
  return selections.use().get(sessionId) ?? DEFAULT_SELECTION;
}

export function selectScope(sessionId: SessionId, scope: ChangesScope, revealPath?: string): void {
  selections.set((current) => {
    const next = new Map(current);
    next.set(sessionId, {
      scope,
      ...(revealPath !== undefined && { reveal: { path: revealPath, id: ++revealCounter } }),
    });
    return next;
  });
}

/** 选好范围（可带要滚到的文件）再打开“变更”窗格。 */
export function openChanges(
  panes: PaneController | undefined,
  sessionId: SessionId,
  scope: ChangesScope,
  revealPath?: string,
): void {
  selectScope(sessionId, scope, revealPath);
  panes?.open({ kind: 'changes' });
}

export interface ChangesPrefs {
  /** 并排（split）还是统一（unified），默认统一。 */
  split: boolean;
  /** 长行自动换行，默认不换（横向滚动）。 */
  wrap: boolean;
}

export const changesPrefs = createPersistedStore<ChangesPrefs>(
  'wevir.changes.v1',
  { split: false, wrap: false },
  (raw) => {
    if (raw === null || typeof raw !== 'object') return undefined;
    const value = raw as Partial<Record<keyof ChangesPrefs, unknown>>;
    return { split: value.split === true, wrap: value.wrap === true };
  },
);
