import type { MemorySource, MemorySummary, SessionId, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { WorkspaceEntry } from '@/data/workbench-model';
import {
  autoMemoryOn,
  defaultMemoryWorkspace,
  draftChanged,
  draftValid,
  memorySourceRows,
  sourceSessionPath,
  sourceSessions,
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

  it('来源：旧笔记只有一行“未记录”；同一次写入不重复列；最近修改不同时列两行', () => {
    const S1 = 'ses_1' as SessionId;
    const agent: MemorySource = { by: 'agent', at: '2026-10-19T00:00:00.000Z', sessionId: S1 };
    expect(memorySourceRows({})).toEqual([
      { label: 'settings.memory.source.origin', source: undefined },
    ]);
    expect(
      memorySourceRows({ origin: agent, lastEdit: { ...agent, status: 'available' } }),
    ).toEqual([{ label: 'settings.memory.source.origin', source: agent }]);
    const user: MemorySource = { by: 'user', at: '2026-10-19T01:00:00.000Z' };
    expect(memorySourceRows({ origin: agent, lastEdit: user })).toEqual([
      { label: 'settings.memory.source.origin', source: agent },
      { label: 'settings.memory.source.lastEdit', source: user },
    ]);
    expect(memorySourceRows({ lastEdit: user })).toHaveLength(2);
  });

  it('要取标题的来源会话去重，跳过用户编辑与已删除的；子会话在父会话的子智能体窗格打开', () => {
    const S1 = 'ses_1' as SessionId;
    const S2 = 'ses_2' as SessionId;
    expect(
      sourceSessions([
        { label: 'settings.memory.source.origin', source: { by: 'agent', at: '', sessionId: S1 } },
        {
          label: 'settings.memory.source.lastEdit',
          source: { by: 'agent', at: '', sessionId: S1, status: 'withdrawn' },
        },
        {
          label: 'settings.memory.source.lastEdit',
          source: { by: 'agent', at: '', sessionId: S2, status: 'deleted' },
        },
        { label: 'settings.memory.source.lastEdit', source: { by: 'user', at: '' } },
        { label: 'settings.memory.source.origin', source: undefined },
      ]),
    ).toEqual([S1]);
    expect(sourceSessionPath({ id: S1, workspaceId: 'ws_1' as never })).toBe(
      '/workspace/ws_1/session/ses_1',
    );
    expect(sourceSessionPath({ id: S2, workspaceId: 'ws_1' as never, parentSessionId: S1 })).toBe(
      '/workspace/ws_1/session/ses_1/agent/ses_2',
    );
  });
});
