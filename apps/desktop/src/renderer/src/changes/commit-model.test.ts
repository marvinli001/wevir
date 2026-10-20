import type { GitStatusResult } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  canCommit,
  changedCount,
  checkTone,
  groupFiles,
  stageState,
  statusLetter,
} from './commit-model';

const status: GitStatusResult = {
  repo: true,
  head: 'a'.repeat(40),
  index: 'b'.repeat(64),
  files: [
    { path: 'a.ts', staged: { status: 'modified', by: 'wevir' }, unstaged: { status: 'modified' } },
    { path: 'b.ts', staged: { status: 'added', by: 'external' } },
    { path: 'lib/c.ts', staged: { status: 'deleted', by: 'external' }, outside: true },
    { path: 'd.ts', unstaged: { status: 'untracked' } },
    { path: 'e.ts', conflicted: true },
  ],
};

describe('提交区的分组', () => {
  it('目录里的已暂存与未暂存分开；不是在这里暂存的（含目录外）另列', () => {
    const groups = groupFiles(status);
    expect(groups.staged.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(groups.unstaged.map((file) => file.path)).toEqual(['a.ts', 'd.ts', 'e.ts']);
    expect(groups.external.map((file) => file.path)).toEqual(['b.ts', 'lib/c.ts']);
  });

  it('有其他已暂存内容时要勾选；有冲突、进行中的操作、空说明时不能提交', () => {
    const clean = { ...status, files: status.files?.slice(0, 4) };
    const groups = groupFiles(clean);
    expect(canCommit(clean, groups, 'msg', false)).toBe(false);
    expect(canCommit(clean, groups, 'msg', true)).toBe(true);
    expect(canCommit(clean, groups, '  ', true)).toBe(false);
    expect(canCommit({ ...clean, operation: 'merge' }, groups, 'msg', true)).toBe(false);
    expect(canCommit(status, groupFiles(status), 'msg', true)).toBe(false);
  });

  it('状态字母与验证记录的五种显示', () => {
    expect(statusLetter(status.files?.[3] as never, 'unstaged')).toBe('U');
    expect(statusLetter(status.files?.[2] as never, 'staged')).toBe('D');
    expect(statusLetter(status.files?.[4] as never, 'unstaged')).toBe('!');
    expect(
      ['passed', 'timed_out', 'stale', 'cancelled', 'running'].map((s) => checkTone(s as never)),
    ).toEqual(['passed', 'failed', 'stale', 'not_run', 'running']);
  });
});

describe('文件头的暂存状态', () => {
  it('全部、部分、没暂存与冲突；目录外与找不到的没有', () => {
    const files = status.files ?? [];
    expect(files.map(stageState)).toEqual([
      'partial',
      'staged',
      undefined,
      'unstaged',
      'conflicted',
    ]);
    expect(stageState(undefined)).toBeUndefined();
  });

  it('改动的文件数按路径算一次', () => {
    expect(changedCount(groupFiles(status))).toBe(4);
  });
});
