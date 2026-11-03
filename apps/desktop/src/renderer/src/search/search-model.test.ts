import { describe, expect, it } from 'vitest';
import type { WorkspaceEntry } from '@/data/workbench-model';
import {
  focusText,
  hitPath,
  matchingSessions,
  nextKind,
  partialResult,
  recentSessions,
  searchNotices,
  snippetSegments,
} from './search-model';

const ready = { state: 'ready' as const, fts: true, pendingSessions: 0, pendingEvents: 0 };

describe('搜索浮窗的纯函数', () => {
  it('片段按高亮切段，越界与重叠的忽略；跳转时找第一处高亮', () => {
    expect(
      snippetSegments('…修复登录审批流程', [
        { start: 3, end: 7 },
        { start: 5, end: 6 },
        { start: 8, end: 99 },
      ]),
    ).toEqual([
      { text: '…修复', mark: false },
      { text: '登录审批', mark: true },
      { text: '流程', mark: false },
    ]);
    expect(focusText({ snippet: 'abc event-store.ts', highlights: [{ start: 4, end: 15 }] })).toBe(
      'event-store',
    );
    expect(focusText({ snippet: 'x', highlights: [] })).toBeUndefined();
  });

  it('子会话在父会话的子智能体窗格里打开', () => {
    expect(hitPath({ workspaceId: 'ws_1', sessionId: 'ses_2' } as never)).toBe(
      '/workspace/ws_1/session/ses_2',
    );
    expect(
      hitPath({ workspaceId: 'ws_1', sessionId: 'ses_2', parentSessionId: 'ses_1' } as never),
    ).toBe('/workspace/ws_1/session/ses_1/agent/ses_2');
  });

  it('Tab 循环种类', () => {
    expect(nextKind('all', 1)).toBe('user_message');
    expect(nextKind('all', -1)).toBe('file_change');
    expect(nextKind('file_change', 1)).toBe('all');
  });

  it('范围说明：索引中、短词只扫了最近的、没有全文索引；完整时没有说明', () => {
    expect(searchNotices({ mode: 'index', index: ready })).toEqual([]);
    expect(partialResult({ index: ready })).toBe(false);
    const lagging = { ...ready, state: 'indexing' as const, pendingSessions: 4 };
    expect(searchNotices({ mode: 'index', index: lagging })).toEqual([
      { kind: 'indexing', sessions: 4 },
    ]);
    expect(partialResult({ index: lagging })).toBe(true);
    const scan = { examined: 20000, limit: 20000, complete: false };
    expect(searchNotices({ mode: 'scan', reason: 'short_query', scan, index: ready })).toEqual([
      { kind: 'scan', count: 20000 },
    ]);
    expect(partialResult({ scan, index: ready })).toBe(true);
    expect(searchNotices({ mode: 'mixed', scan, index: ready })).toEqual([
      { kind: 'mixed', count: 20000 },
    ]);
    expect(
      searchNotices({
        mode: 'scan',
        reason: 'fts_unavailable',
        scan: { examined: 3, limit: 20000, complete: true },
        index: ready,
      }),
    ).toEqual([{ kind: 'noIndex', count: 3 }]);
    expect(
      searchNotices({
        mode: 'scan',
        reason: 'short_query',
        scan: { examined: 3, limit: 20000, complete: true },
        index: ready,
      }),
    ).toEqual([]);
  });

  it('最近的会话：顶层的，按更新时间', () => {
    const sessions = [
      { id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'b', updatedAt: '2026-10-03T00:00:00.000Z', parentSessionId: 'a' },
      { id: 'c', updatedAt: '2026-10-02T00:00:00.000Z' },
    ];
    expect(recentSessions(sessions as never, 5).map((session) => session.id)).toEqual(['c', 'a']);
  });

  it('先匹配标题，再匹配项目、路径和分支；同类按活动排序，忽略子会话', () => {
    const workspaces = [
      {
        workspace: { displayName: 'Auth Service', rootPath: '/projects/auth' },
        sessions: [
          { id: 'title', title: 'Fix Login', cwd: '/projects/auth', updatedAt: '2026-11-01' },
          { id: 'exact', title: 'login', cwd: '/projects/auth', updatedAt: '2026-10-01' },
          {
            id: 'branch',
            title: 'Tests',
            cwd: '/trees/auth',
            worktrees: [{ branch: 'fix/login' }],
            updatedAt: '2026-11-03',
          },
          {
            id: 'title-recent',
            title: 'LOGIN bug',
            cwd: '/projects/auth',
            updatedAt: '2026-11-02',
          },
          {
            id: 'child',
            title: 'Login',
            cwd: '/projects/auth',
            parentSessionId: 'title',
            updatedAt: '2026-11-04',
          },
        ],
      },
    ] as unknown as WorkspaceEntry[];
    expect(matchingSessions(workspaces, ' LOGIN ', 8).map((session) => session.id)).toEqual([
      'exact',
      'title-recent',
      'title',
      'branch',
    ]);
    expect(matchingSessions(workspaces, 'auth login', 2).map((session) => session.id)).toEqual([
      'branch',
      'title-recent',
    ]);
    expect(matchingSessions(workspaces, '/trees/auth', 8).map((session) => session.id)).toEqual([
      'branch',
    ]);
    expect(matchingSessions(workspaces, 'auth absent', 8)).toEqual([]);
  });
});
