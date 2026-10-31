// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/lib/diffCollapse.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只有 areAllCollapsed / toggleAll 取自 T3（改名），其余是 Wevir 的。
//
// “变更”窗格的纯逻辑（desktop-layout.md §18）：范围、回合的编号与菜单、范围对应的 `workspace.diff` 来源、大 diff 默认折叠。

import type { ChatMessage } from '@wevir/client-sdk';
import type { DiffSource, TurnCheckpoint, TurnId } from '@wevir/protocol';
import { t } from '@/i18n';
import { filePreviews } from '@/session/file-preview-model';
import { foldTurn, type TurnFold } from '@/session/turn-model';

/** 窗格选的范围：未提交、已暂存（0.67.0）、本分支、最近一回合（跟着会话走）、第 N 回合。 */
export type ChangesScope =
  | { kind: 'uncommitted' }
  | { kind: 'staged' }
  | { kind: 'branch' }
  | { kind: 'latest' }
  | { kind: 'turn'; turnId: TurnId };

export const DEFAULT_SCOPE: ChangesScope = { kind: 'uncommitted' };

export function sameScope(a: ChangesScope, b: ChangesScope): boolean {
  return a.kind === b.kind && (a.kind !== 'turn' || (b.kind === 'turn' && a.turnId === b.turnId));
}

/** 回合的编号（从 1 起）：消息流里每个回合第一条用户消息的先后，插话不另算。 */
export function turnNumbers(messages: readonly ChatMessage[]): Map<TurnId, number> {
  const numbers = new Map<TurnId, number>();
  for (const message of messages) {
    if (message.role !== 'user' || message.steered || numbers.has(message.turnId)) continue;
    numbers.set(message.turnId, numbers.size + 1);
  }
  return numbers;
}

export interface TurnOption {
  turnId: TurnId;
  /** 消息流里找不到这个回合（还没读到）时没有。 */
  number?: number;
  fileCount?: number;
  added?: number;
  removed?: number;
  /** 回合尚未结束，也没有回合后的快照。 */
  live: boolean;
}

/** Git 不收录被忽略的文件；空快照保留工具记录的编辑，非空快照采用净改动。 */
export function turnChangeStats(
  checkpoint: Pick<TurnCheckpoint, 'fileCount' | 'added' | 'removed'> | undefined,
  recorded: TurnFold['changes'],
): TurnFold['changes'] {
  return checkpoint?.fileCount
    ? {
        files: checkpoint.fileCount,
        added: checkpoint.added ?? 0,
        removed: checkpoint.removed ?? 0,
      }
    : recorded;
}

export function recordedChangePreviews(messages: readonly ChatMessage[]) {
  return messages.flatMap((message) =>
    message.role !== 'assistant'
      ? []
      : message.parts.flatMap((part) =>
          part.type === 'tool' && part.status === 'completed'
            ? (filePreviews(part) ?? []).map((preview, index) => ({
                key: `${message.id}/${part.key}/${index}`,
                preview,
              }))
            : [],
        ),
  );
}

/** “回合”子菜单：快照与有编辑记录的回合，从新到旧。 */
export function turnOptions(
  checkpoints: readonly TurnCheckpoint[],
  numbers: ReadonlyMap<TurnId, number>,
  messages: readonly ChatMessage[] = [],
): TurnOption[] {
  const turns = new Map<TurnId, ChatMessage[]>();
  for (const message of messages) {
    if (message.role === 'system') continue;
    const turn = turns.get(message.turnId) ?? [];
    turn.push(message);
    turns.set(message.turnId, turn);
  }
  const snapshots = new Map(checkpoints.map((checkpoint) => [checkpoint.turnId, checkpoint]));
  const ids = new Set(snapshots.keys());
  for (const [turnId, turn] of turns) {
    if (!snapshots.has(turnId) && recordedChangePreviews(turn).length > 0) ids.add(turnId);
  }
  return [...ids]
    .sort()
    .reverse()
    .map((turnId) => {
      const checkpoint = snapshots.get(turnId);
      const fold = foldTurn(turns.get(turnId) ?? [], false, false);
      const stats = turnChangeStats(checkpoint, fold.changes);
      const settled = checkpoint?.fileCount !== undefined || fold.finished !== undefined;
      const number = numbers.get(turnId);
      return {
        turnId,
        ...(number !== undefined && { number }),
        ...(settled && { fileCount: stats.files, added: stats.added, removed: stats.removed }),
        live: !settled,
      };
    });
}

/** 范围对应的来源；没有快照或编辑记录时，“最近一回合”没有来源。 */
export function resolveSource(
  scope: ChangesScope,
  turns: readonly TurnOption[],
): DiffSource | undefined {
  switch (scope.kind) {
    case 'uncommitted':
    case 'staged':
    case 'branch':
      return { kind: scope.kind };
    case 'turn':
      return { kind: 'turn', turnId: scope.turnId };
    case 'latest': {
      const latest = turns[0];
      return latest === undefined ? undefined : { kind: 'turn', turnId: latest.turnId };
    }
  }
}

export function turnLabel(number: number | undefined): string {
  return number === undefined
    ? t('changes.scope.turnUnknown')
    : t('changes.scope.turnN', { number });
}

/** 范围按钮上的字。 */
export function scopeLabel(scope: ChangesScope, turns: readonly TurnOption[]): string {
  switch (scope.kind) {
    case 'uncommitted':
      return t('changes.scope.uncommitted');
    case 'staged':
      return t('changes.scope.staged');
    case 'branch':
      return t('changes.scope.branch');
    case 'latest':
      return t('changes.scope.latest');
    case 'turn': {
      const latest = turns[0];
      if (latest?.turnId === scope.turnId) return t('changes.scope.latest');
      return turnLabel(turns.find((turn) => turn.turnId === scope.turnId)?.number);
    }
  }
}

/**
 * 大 diff 默认把文件都折起来（照 Claude Code：“Files are collapsed for large diffs”）：文件多于 LARGE_DIFF_FILES 个或改动的
 * 行合计多于 LARGE_DIFF_LINES 行时全部折叠；否则只折叠单个改动多于 LARGE_FILE_LINES 行的文件。
 */
export const LARGE_DIFF_FILES = 30;
export const LARGE_DIFF_LINES = 2000;
export const LARGE_FILE_LINES = 500;

export interface CollapseCandidate {
  key: string;
  /** 增删的行数之和。 */
  lines: number;
}

export function defaultCollapsed(files: readonly CollapseCandidate[]): {
  keys: ReadonlySet<string>;
  /** 因为整体太大而全部折叠（窗格写一句说明）。 */
  all: boolean;
} {
  const total = files.reduce((sum, file) => sum + file.lines, 0);
  if (files.length > LARGE_DIFF_FILES || total > LARGE_DIFF_LINES) {
    return { keys: new Set(files.map((file) => file.key)), all: files.length > 0 };
  }
  return {
    keys: new Set(files.filter((file) => file.lines > LARGE_FILE_LINES).map((file) => file.key)),
    all: false,
  };
}

/** 全部都折叠着（T3 diffCollapse.ts）。 */
export function areAllCollapsed(keys: readonly string[], collapsed: ReadonlySet<string>): boolean {
  return keys.length > 0 && keys.every((key) => collapsed.has(key));
}

/** “全部展开 / 全部收起”：全折着就全展开，否则全折起来（T3 diffCollapse.ts）。 */
export function toggleAll(
  keys: readonly string[],
  collapsed: ReadonlySet<string>,
): ReadonlySet<string> {
  return areAllCollapsed(keys, collapsed) ? new Set() : new Set(keys);
}

/** 文件头上的目录与文件名：`src/a/b.ts` → `b.ts` 与 `src/a`。 */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}
