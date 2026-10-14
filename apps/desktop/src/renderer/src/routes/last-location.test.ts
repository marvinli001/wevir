import type { Session, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { WorkbenchData } from '@/data/workbench-model';
import { homeWorkspace, parseLastLocation } from './last-location';

const NOW = '2026-10-14T00:00:00.000Z';
const workspace: Workspace = {
  id: 'ws_a',
  rootPath: '/tmp/a',
  displayName: 'a',
  createdAt: NOW,
  updatedAt: NOW,
};
const session = {
  id: 'ses_1',
  workspaceId: 'ws_a',
  cwd: '/tmp/a',
  engine: { kind: 'dsh', sessionId: 'e1' },
  providerId: 'mock',
  modelId: 'mock-model',
  title: '',
  titleSource: 'first_prompt',
  state: 'idle',
  createdAt: NOW,
  updatedAt: NOW,
  lastSeq: 1,
} satisfies Session;
const other: Workspace = { ...workspace, id: 'ws_b', rootPath: '/tmp/b', displayName: 'b' };
const empty: Workspace = { ...workspace, id: 'ws_c', rootPath: '/tmp/c', displayName: 'c' };
const ready = (
  workspaces: { workspace: Workspace; sessions: Session[] }[],
): Extract<WorkbenchData, { status: 'ready' }> => ({ status: 'ready', workspaces, providers: [] });

describe('homeWorkspace', () => {
  const data = ready([
    { workspace: empty, sessions: [] },
    { workspace, sessions: [session] },
    {
      workspace: other,
      sessions: [
        { ...session, id: 'ses_2', workspaceId: 'ws_b', updatedAt: '2026-10-14T01:00:00.000Z' },
      ],
    },
  ]);

  it('上次所在的工作区还在：用它', () => {
    expect(homeWorkspace(data, { workspaceId: 'ws_a' })?.workspace.id).toBe('ws_a');
    expect(homeWorkspace(data, { workspaceId: 'ws_c' })?.workspace.id).toBe('ws_c');
  });

  it('没有记录或已经不在了：用最近有活动的会话所在的工作区', () => {
    expect(homeWorkspace(data, null)?.workspace.id).toBe('ws_b');
    expect(homeWorkspace(data, { workspaceId: 'ws_gone' })?.workspace.id).toBe('ws_b');
  });

  it('都没有会话时用第一个；没有工作区时没有', () => {
    expect(
      homeWorkspace(
        ready([
          { workspace: empty, sessions: [] },
          { workspace, sessions: [] },
        ]),
        null,
      )?.workspace.id,
    ).toBe('ws_c');
    expect(homeWorkspace(ready([]), { workspaceId: 'ws_a' })).toBeUndefined();
  });
});

describe('parseLastLocation', () => {
  it('只认 {workspaceId}；T5.5 存的 sessionId 不再用', () => {
    expect(parseLastLocation({ workspaceId: 'ws_a', sessionId: 'ses_1' })).toEqual({
      workspaceId: 'ws_a',
    });
    expect(parseLastLocation({ workspaceId: 'ws_a' })).toEqual({ workspaceId: 'ws_a' });
    expect(parseLastLocation(null)).toBeNull();
    expect(parseLastLocation({ workspaceId: '' })).toBeUndefined();
    expect(parseLastLocation(['ws_a'])).toBeUndefined();
  });
});
