import type { HandoffPreview, MemorySummary } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { handoffPreviewRows } from './handoff-model';
import {
  budgetUsage,
  HANDOFF_MAX_CONSTRAINTS,
  HANDOFF_MAX_NOTES,
  handoffRequest,
  keepSelectable,
  requestKey,
  selectableNotes,
} from './handoff-preview-model';

function note(name: string, extra: Partial<MemorySummary> = {}): MemorySummary {
  return {
    scope: 'project',
    name,
    type: 'feedback',
    description: name,
    updatedAt: '2026-10-19T00:00:00.000Z',
    enabled: true,
    revision: `rev-${name}`,
    ...extra,
  };
}

const preview: HandoffPreview = {
  providerId: 'claude',
  strategy: 'full_thread_summary',
  resumed: false,
  historyTool: true,
  covered: { fromSeq: 1, toSeq: 12 },
  budgetBytes: 16000,
  items: 3,
  omittedItems: 0,
  omitted: [],
  context: 'Context handoff',
  bytes: 4000,
  hash: '0'.repeat(64),
  constraints: 1,
  notes: [],
};

describe('接力预览的纯逻辑（0.60.0）', () => {
  it('handoffRequest：空白的约束不交，没有约束与笔记时整个省略；超出条数的不交', () => {
    expect(handoffRequest(['', '  '], [])).toBeUndefined();
    expect(handoffRequest(['  只改 src/ ', ''], [{ scope: 'global', name: 'a' }])).toEqual({
      constraints: ['只改 src/'],
      notes: [{ scope: 'global', name: 'a' }],
    });
    const many = handoffRequest(
      Array.from({ length: 12 }, (_, index) => `c${index}`),
      Array.from({ length: 7 }, (_, index) => ({ scope: 'global' as const, name: `n${index}` })),
    );
    expect(many?.constraints).toHaveLength(HANDOFF_MAX_CONSTRAINTS);
    expect(many?.notes).toHaveLength(HANDOFF_MAX_NOTES);
    // 键只随实际要交的变：多一段空白不需要重新预览。
    expect(requestKey(handoffRequest(['a'], []))).toBe(requestKey(handoffRequest(['a', ' '], [])));
    expect(requestKey(handoffRequest(['a'], []))).not.toBe(requestKey(handoffRequest(['b'], [])));
  });

  it('selectableNotes / keepSelectable：只给启用的；自动记忆关着时一条都不给，选中的随之去掉', () => {
    const notes = [note('a'), note('b', { enabled: false }), note('c', { scope: 'global' })];
    expect(selectableNotes(notes, {}).map((entry) => entry.name)).toEqual(['a', 'c']);
    expect(selectableNotes(notes, { autoMemory: false })).toEqual([]);
    expect(selectableNotes(undefined, {})).toEqual([]);
    const chosen = [
      { scope: 'project' as const, name: 'a' },
      { scope: 'project' as const, name: 'b' },
      { scope: 'project' as const, name: 'c' },
    ];
    expect(keepSelectable(chosen, selectableNotes(notes, {}))).toEqual([chosen[0]]);
  });

  it('budgetUsage：用了多少、是否超出；超出时按一条历史都不放的字节算', () => {
    expect(budgetUsage(preview)).toEqual({ used: 4000, budget: 16000, ratio: 0.25, over: false });
    const { context: _c, bytes: _b, hash: _h, ...rest } = preview;
    expect(budgetUsage({ ...rest, overBudget: { bytes: 20000 } })).toEqual({
      used: 20000,
      budget: 16000,
      ratio: 1,
      over: true,
    });
    expect(budgetUsage({ ...rest, items: 0 }).used).toBe(0);
  });

  it('handoffPreviewRows：同详情的方式、引擎会话、范围、条目与读历史；没有材料时不说读历史', () => {
    expect(handoffPreviewRows(preview).map((row) => [row.key, row.value])).toEqual([
      ['strategy', '完整：整段对话'],
      ['engine', '新建'],
      ['covered', '事件 1–12'],
      ['items', '选入 3 条，省略 0 条'],
      ['history', '可读取全文'],
    ]);
    const { context: _c, bytes: _b, hash: _h, covered: _v, ...empty } = preview;
    expect(handoffPreviewRows({ ...empty, items: 0 }).map((row) => row.key)).toEqual([
      'strategy',
      'engine',
      'covered',
      'items',
    ]);
  });
});
