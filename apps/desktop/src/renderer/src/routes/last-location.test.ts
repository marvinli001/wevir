import type { Session, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { WorkbenchData } from '@/data/workbench-model';
import { parseLastLocation, restorePath } from './last-location';

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
const data: WorkbenchData = {
  status: 'ready',
  workspaces: [{ workspace, sessions: [session] }],
  providers: [],
};

describe('restorePath', () => {
  it('会话还在：回到它', () => {
    expect(restorePath(data, { workspaceId: 'ws_a', sessionId: 'ses_1' })).toBe(
      '/workspace/ws_a/session/ses_1',
    );
  });

  it('会话不在了、或上次在草稿页：进这个工作区的新会话草稿', () => {
    expect(restorePath(data, { workspaceId: 'ws_a', sessionId: 'ses_gone' })).toBe(
      '/workspace/ws_a/session',
    );
    expect(restorePath(data, { workspaceId: 'ws_a' })).toBe('/workspace/ws_a/session');
  });

  it('工作区不在了、没有记录、读列表失败：不恢复；还在读：等', () => {
    expect(restorePath(data, { workspaceId: 'ws_gone', sessionId: 'ses_1' })).toBeUndefined();
    expect(restorePath(data, null)).toBeUndefined();
    expect(restorePath({ status: 'error', error: 'x' }, { workspaceId: 'ws_a' })).toBeUndefined();
    expect(restorePath({ status: 'loading' }, { workspaceId: 'ws_a' })).toBe('pending');
  });
});

describe('parseLastLocation', () => {
  it('只认 {workspaceId, sessionId?}，其余当作没有记录', () => {
    expect(parseLastLocation({ workspaceId: 'ws_a', sessionId: 'ses_1' })).toEqual({
      workspaceId: 'ws_a',
      sessionId: 'ses_1',
    });
    expect(parseLastLocation({ workspaceId: 'ws_a' })).toEqual({ workspaceId: 'ws_a' });
    expect(parseLastLocation(null)).toBeNull();
    expect(parseLastLocation({ workspaceId: '' })).toBeUndefined();
    expect(parseLastLocation({ workspaceId: 'ws_a', sessionId: 3 })).toBeUndefined();
    expect(parseLastLocation(['ws_a'])).toBeUndefined();
  });
});
