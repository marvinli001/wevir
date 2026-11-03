import type { SessionId, TurnId, WorkspaceId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { changeFolders, folderCacheKey, folderParams } from './change-folders';
import { sourceKey } from './changes-data';

vi.mock('@/host/host-connection', () => ({ useHostConnection: vi.fn() }));

const workspace = { extraFolders: ['/api', '/docs'] };
const session = { cwd: '/app' };

describe('变更源文件夹', () => {
  it('用会话目录与额外目录，去重且保持顺序', () => {
    expect(
      changeFolders(workspace, { ...session, extraRoots: ['/app', '/work/api', '/work/api'] }),
    ).toEqual(['/app', '/work/api']);
  });

  it('旧会话没有额外目录或 worktree 时补工作区的目录', () => {
    expect(changeFolders(workspace, session)).toEqual(['/app', '/api', '/docs']);
    expect(changeFolders(workspace, { ...session, extraRoots: [], worktrees: [] })).toEqual([
      '/app',
      '/api',
      '/docs',
    ]);
    expect(changeFolders({}, session)).toEqual(['/app']);
  });

  it('worktree 会话不补原工作区的目录', () => {
    expect(
      changeFolders(workspace, {
        cwd: '/work/app',
        worktrees: [{ workspaceId: 'ws_app' as WorkspaceId, path: '/work/app', branch: 'work' }],
      }),
    ).toEqual(['/work/app']);
  });
});

describe('目录请求与缓存', () => {
  it('只有明确声明功能的 Host 收到 folder', () => {
    expect(folderParams(undefined, '/api')).toEqual({});
    expect(folderParams({}, '/api')).toEqual({});
    expect(folderParams({ multi_folder_changes: false }, '/api')).toEqual({});
    expect(folderParams({ multi_folder_changes: true }, '/api')).toEqual({ folder: '/api' });
    expect(folderParams({ multi_folder_changes: true }, undefined)).toEqual({});
  });

  it('回合不带目录，也不按目录分出缓存', () => {
    const turn = { kind: 'turn' as const, turnId: 'trn_one' as TurnId };
    const sessionId = 'ses_one' as SessionId;
    expect(folderParams({ multi_folder_changes: true }, '/api', turn)).toEqual({});
    expect(sourceKey(sessionId, turn, '/app')).toBe(sourceKey(sessionId, turn, '/api'));
    for (const kind of ['uncommitted', 'staged', 'branch'] as const) {
      expect(sourceKey(sessionId, { kind }, '/app')).not.toBe(
        sourceKey(sessionId, { kind }, '/api'),
      );
    }
  });

  it('相同路径、不同目录或会话的状态不共用缓存', () => {
    expect(folderCacheKey('ses_one', '/api')).not.toBe(folderCacheKey('ses_one', '/app'));
    expect(folderCacheKey('ses_one', '/api')).not.toBe(folderCacheKey('ses_two', '/api'));
    expect(folderCacheKey('ses_one', undefined)).not.toBe(folderCacheKey('ses_one', '/api'));
    expect(folderCacheKey('a:b', 'c')).not.toBe(folderCacheKey('a', 'b:c'));
  });
});
