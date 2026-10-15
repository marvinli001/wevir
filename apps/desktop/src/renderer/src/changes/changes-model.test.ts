import type { ChatMessage } from '@wevir/client-sdk';
import type { TurnId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  areAllCollapsed,
  defaultCollapsed,
  LARGE_DIFF_FILES,
  LARGE_DIFF_LINES,
  LARGE_FILE_LINES,
  resolveSource,
  sameScope,
  scopeLabel,
  splitPath,
  toggleAll,
  turnNumbers,
  turnOptions,
} from './changes-model';

const T1 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP01' as TurnId;
const T2 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP02' as TurnId;
const T3 = 'trn_01JA2B3C4D5E6F7G8H9JKMNP03' as TurnId;

function user(turnId: TurnId, steered = false): ChatMessage {
  return {
    id: `${turnId}:${steered ? 'steer' : 'user'}`,
    role: 'user',
    turnId,
    parts: [],
    seqRange: [0, 0],
    ts: '2026-10-15T00:00:00.000Z',
    ...(steered && { steered: true as const }),
  };
}

function assistant(turnId: TurnId): ChatMessage {
  return { id: `${turnId}:a`, role: 'assistant', turnId, parts: [], seqRange: [0, 0] };
}

describe('回合', () => {
  it('编号按每个回合第一条用户消息的先后，插话不另算', () => {
    const numbers = turnNumbers([
      user(T1),
      assistant(T1),
      user(T1, true),
      user(T2),
      assistant(T2),
      user(T3),
    ]);
    expect([...numbers]).toEqual([
      [T1, 1],
      [T2, 2],
      [T3, 3],
    ]);
  });

  it('菜单从新到旧；没有回合后的快照的是进行中', () => {
    const options = turnOptions(
      [{ turnId: T1, fileCount: 2, added: 5, removed: 1 }, { turnId: T3 }],
      new Map([
        [T1, 1],
        [T3, 3],
      ]),
    );
    expect(options).toEqual([
      { turnId: T3, number: 3, live: true },
      { turnId: T1, number: 1, fileCount: 2, added: 5, removed: 1, live: false },
    ]);
  });
});

describe('范围', () => {
  const turns = turnOptions(
    [
      { turnId: T1, fileCount: 1, added: 1, removed: 0 },
      { turnId: T2, fileCount: 1, added: 1, removed: 0 },
    ],
    new Map([
      [T1, 1],
      [T2, 2],
    ]),
  );

  it('来源：最近一回合是最新的有快照的回合，没有时没有来源', () => {
    expect(resolveSource({ kind: 'uncommitted' }, turns)).toEqual({ kind: 'uncommitted' });
    expect(resolveSource({ kind: 'branch' }, turns)).toEqual({ kind: 'branch' });
    expect(resolveSource({ kind: 'latest' }, turns)).toEqual({ kind: 'turn', turnId: T2 });
    expect(resolveSource({ kind: 'turn', turnId: T1 }, turns)).toEqual({
      kind: 'turn',
      turnId: T1,
    });
    expect(resolveSource({ kind: 'latest' }, [])).toBeUndefined();
  });

  it('按钮上的字：最新的回合写“最近一回合”', () => {
    expect(scopeLabel({ kind: 'uncommitted' }, turns)).toBe('未提交');
    expect(scopeLabel({ kind: 'branch' }, turns)).toBe('本分支');
    expect(scopeLabel({ kind: 'latest' }, turns)).toBe('最近一回合');
    expect(scopeLabel({ kind: 'turn', turnId: T2 }, turns)).toBe('最近一回合');
    expect(scopeLabel({ kind: 'turn', turnId: T1 }, turns)).toBe('第 1 回合');
    expect(scopeLabel({ kind: 'turn', turnId: T3 }, turns)).toBe('回合');
  });

  it('同一个范围', () => {
    expect(sameScope({ kind: 'turn', turnId: T1 }, { kind: 'turn', turnId: T1 })).toBe(true);
    expect(sameScope({ kind: 'turn', turnId: T1 }, { kind: 'turn', turnId: T2 })).toBe(false);
    expect(sameScope({ kind: 'latest' }, { kind: 'uncommitted' })).toBe(false);
  });
});

describe('折叠', () => {
  it('小 diff 只折叠改动特别多的文件；文件或行数太多时全部折叠', () => {
    expect(
      defaultCollapsed([
        { key: 'a', lines: 10 },
        { key: 'b', lines: LARGE_FILE_LINES + 1 },
      ]),
    ).toEqual({ keys: new Set(['b']), all: false });
    const many = Array.from({ length: LARGE_DIFF_FILES + 1 }, (_, i) => ({
      key: `f${i}`,
      lines: 1,
    }));
    expect(defaultCollapsed(many)).toMatchObject({ all: true });
    expect(defaultCollapsed(many).keys.size).toBe(LARGE_DIFF_FILES + 1);
    expect(
      defaultCollapsed([
        { key: 'a', lines: LARGE_DIFF_LINES / 2 },
        { key: 'b', lines: LARGE_DIFF_LINES / 2 + 1 },
      ]),
    ).toEqual({ keys: new Set(['a', 'b']), all: true });
    expect(defaultCollapsed([])).toEqual({ keys: new Set(), all: false });
  });

  it('全部展开 / 收起', () => {
    expect(areAllCollapsed([], new Set())).toBe(false);
    expect(areAllCollapsed(['a', 'b'], new Set(['a']))).toBe(false);
    expect(toggleAll(['a', 'b'], new Set(['a']))).toEqual(new Set(['a', 'b']));
    expect(toggleAll(['a', 'b'], new Set(['a', 'b']))).toEqual(new Set());
  });

  it('文件名与目录', () => {
    expect(splitPath('src/a/b.ts')).toEqual({ name: 'b.ts', dir: 'src/a' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });
});
