import type { MemorySummary, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { WorkspaceEntry } from '@/data/workbench-model';
import {
  autoMemoryOn,
  defaultMemoryWorkspace,
  draftChanged,
  draftValid,
  splitMemory,
  updatePatch,
} from './memory-model';

const entry = (id: string, kind?: 'chats'): WorkspaceEntry => ({
  workspace: {
    id,
    rootPath: `/p/${id}`,
    displayName: id,
    ...(kind !== undefined && { kind }),
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  } as Workspace,
  sessions: [],
});

const summary = (scope: 'global' | 'project', name: string): MemorySummary => ({
  scope,
  name,
  type: 'feedback',
  description: name,
  updatedAt: '2026-10-18T00:00:00.000Z',
  enabled: true,
  revision: `r-${name}`,
});

describe('设置 → 记忆', () => {
  it('自动记忆：旧 Host 没有这一项时当作开着', () => {
    expect(autoMemoryOn({})).toBe(true);
    expect(autoMemoryOn({ autoMemory: true })).toBe(true);
    expect(autoMemoryOn({ autoMemory: false })).toBe(false);
  });

  it('默认项目：上次所在的还在就用它，否则第一个；没有项目时 undefined', () => {
    const list = [entry('ws_a'), entry('ws_b'), entry('ws_chats', 'chats')];
    expect(defaultMemoryWorkspace(list, 'ws_b')).toBe('ws_b');
    expect(defaultMemoryWorkspace(list, 'ws_chats')).toBe('ws_chats');
    expect(defaultMemoryWorkspace(list, 'ws_gone')).toBe('ws_a');
    expect(defaultMemoryWorkspace(list, null)).toBe('ws_a');
    expect(defaultMemoryWorkspace([], 'ws_a')).toBeUndefined();
  });

  it('列表按范围拆开，保持顺序；读不出来的文件按范围列名字', () => {
    const sections = splitMemory({
      notes: [summary('project', 'p1'), summary('global', 'g1'), summary('project', 'p2')],
      unreadable: [
        { scope: 'project', name: 'broken' },
        { scope: 'global', name: 'bad' },
      ],
    });
    expect(sections.global.map((note) => note.name)).toEqual(['g1']);
    expect(sections.project.map((note) => note.name)).toEqual(['p1', 'p2']);
    expect(sections.unreadable).toEqual({ global: ['bad'], project: ['broken'] });
    expect(splitMemory(undefined)).toEqual({
      global: [],
      project: [],
      unreadable: { global: [], project: [] },
    });
  });

  it('草稿：首尾空白不算改动，空的说明或正文不能保存，补丁只带改了的字段', () => {
    const note = { type: 'feedback' as const, description: 'Use cents', content: 'Round once.' };
    expect(draftChanged({ ...note, content: ' Round once.\n' }, note)).toBe(false);
    expect(draftChanged({ ...note, type: 'project' }, note)).toBe(true);
    expect(draftValid({ ...note, description: '  ' })).toBe(false);
    expect(draftValid({ ...note, content: '' })).toBe(false);
    expect(updatePatch({ ...note, content: 'Round at the end.' }, note)).toEqual({
      content: 'Round at the end.',
    });
    expect(updatePatch({ ...note, type: 'user', description: 'Cents' }, note)).toEqual({
      type: 'user',
      description: 'Cents',
    });
  });
});
