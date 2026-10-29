import type { WevirClient } from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 路由根拖着整个界面，动作只用它读当前路由与跳转。
const route = vi.hoisted(() => ({
  matches: [] as { params: Record<string, string | undefined> }[],
  navigate: vi.fn(),
}));
vi.mock('@/routes/router', () => ({
  router: {
    get state() {
      return { matches: route.matches };
    },
    navigate: route.navigate,
  },
}));

import {
  archiveSession,
  archiveSessions,
  canBranchSession,
  deleteSessionPermanently,
  leavingSessions,
  moveTarget,
  pinnedSessions,
  worktreeRestoreNotices,
} from './session-actions';
import type { WorkbenchStore } from './workbench-store';

const id = (suffix: string) => `ses_${suffix}` as SessionId;

function fakeClient(fail: ReadonlySet<string> = new Set()) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (fail.has(String(params.sessionId))) throw new Error(`failed ${String(params.sessionId)}`);
      if (method === 'session.delete')
        return { sessionIds: [params.sessionId], keptBranches: ['wevir/x'] };
      return {};
    }),
  } as unknown as WevirClient;
  return { client, calls };
}

function fakeStore() {
  const steps: string[] = [];
  const refresh = vi.fn(async () => {
    steps.push('refresh');
  });
  const hold = vi.fn((ids: readonly SessionId[]) => steps.push(`hold ${ids.join(',')}`));
  const release = vi.fn((ids: readonly SessionId[]) => steps.push(`release ${ids.join(',')}`));
  return { store: { refresh, hold, release } as unknown as WorkbenchStore, refresh, steps };
}

beforeEach(() => {
  route.matches = [];
  route.navigate.mockClear();
  pinnedSessions.set([]);
});

describe('canBranchSession', () => {
  const plain: Parameters<typeof canBranchSession>[0] = {};

  it('Host 声明了 session_branches、引擎能分支、是可写的顶层会话时才能', () => {
    expect(canBranchSession(plain, { session_branches: true }, { branch: true })).toBe(true);
    expect(canBranchSession(plain, {}, { branch: true })).toBe(false);
    expect(canBranchSession(plain, { session_branches: true }, { branch: false })).toBe(false);
    expect(canBranchSession(plain, { session_branches: true }, undefined)).toBe(false);
  });

  it('子会话、支线与只读的会话不能', () => {
    const features = { session_branches: true };
    const engine = { branch: true };
    expect(canBranchSession({ ...plain, parentSessionId: id('p') }, features, engine)).toBe(false);
    expect(canBranchSession({ ...plain, side: true as const }, features, engine)).toBe(false);
    expect(
      canBranchSession(
        { ...plain, readOnly: { reason: 'session_lost' } as never },
        features,
        engine,
      ),
    ).toBe(false);
  });
});

describe('moveTarget', () => {
  const features = { session_move: true };
  it('项目目录里的会话移到工作树，Host 开的一个工作树里的移回本地（0.81.0）', () => {
    expect(moveTarget({}, features, false)).toBe('worktree');
    expect(
      moveTarget(
        { worktrees: [{ workspaceId: 'ws_x', path: '/w', branch: 'b' }] } as never,
        features,
        false,
      ),
    ).toBe('local');
  });

  it('Host 不支持、对话、子会话、支线、只读、已归档、环境会话都不能移', () => {
    expect(moveTarget({}, {}, false)).toBeUndefined();
    expect(moveTarget({}, features, true)).toBeUndefined();
    for (const session of [
      { parentSessionId: 'ses_p' },
      { side: true },
      { readOnly: { reason: 'engine_lost', message: 'x', since: 't' } },
      { archivedAt: 't' },
      { environmentId: 'env_x' },
    ]) {
      expect(moveTarget(session as never, features, false)).toBeUndefined();
    }
  });
});

describe('archiveSession', () => {
  it('归档：取消置顶、重读列表；正在看它时回到首页', async () => {
    const { client } = fakeClient();
    const { store, refresh } = fakeStore();
    pinnedSessions.set([id('a'), id('b')]);
    route.matches = [{ params: { sessionId: id('a') } }];
    await archiveSession(client, store, id('a'), true);
    expect(pinnedSessions.get()).toEqual([id('b')]);
    expect(route.navigate).toHaveBeenCalledWith('/');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('归档时行先收起：留住会话、重读之后才放开；收起期间算离开', async () => {
    const { client } = fakeClient();
    const { store, steps } = fakeStore();
    const pending = archiveSession(client, store, id('a'), true);
    expect(leavingSessions.get().has(id('a'))).toBe(true);
    await pending;
    expect(steps).toEqual([`hold ${id('a')}`, 'refresh', `release ${id('a')}`]);
    expect(leavingSessions.get().size).toBe(0);
  });

  it('归档失败时放开会话，行回到原处', async () => {
    const { client } = fakeClient(new Set([id('a')]));
    const { store, steps } = fakeStore();
    await expect(archiveSession(client, store, id('a'), true)).rejects.toThrow();
    expect(steps).toEqual([`hold ${id('a')}`, `release ${id('a')}`]);
    expect(leavingSessions.get().size).toBe(0);
  });

  it('取消归档只重读列表', async () => {
    const { client } = fakeClient();
    const { store, refresh, steps } = fakeStore();
    route.matches = [{ params: { sessionId: id('a') } }];
    await archiveSession(client, store, id('a'), false);
    expect(route.navigate).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(['refresh']);
  });
  it('取消归档时没恢复的 worktree 与改动没放回的各一条提示（0.81.0）', () => {
    const base = { workspaceId: 'ws_x', path: '/w/1-app' } as const;
    const notices = worktreeRestoreNotices([
      { ...base, branch: 'wevir/a', status: 'restored' },
      { ...base, branch: 'wevir/b', status: 'restored', reason: 'branch_moved', ref: 'refs/x/1' },
      { ...base, branch: 'wevir/c', status: 'failed', reason: 'repository_missing' },
      { ...base, branch: 'wevir/d', status: 'failed', reason: 'git_error', message: 'fatal: x' },
    ] as Parameters<typeof worktreeRestoreNotices>[0]);
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain('refs/x/1');
    expect(notices[1]).toContain('repository_missing');
    expect(notices[2]).toContain('fatal: x');
  });
});

describe('archiveSessions', () => {
  it('一个失败不影响其余的：成功的取消置顶，只重读一次，返回失败个数与第一个原因', async () => {
    const { client, calls } = fakeClient(new Set([id('b')]));
    const { store, refresh } = fakeStore();
    pinnedSessions.set([id('a'), id('b'), id('c')]);
    const result = await archiveSessions(client, store, [id('a'), id('b'), id('c')]);
    expect(calls.map((call) => call.params.sessionId)).toEqual([id('a'), id('b'), id('c')]);
    expect(result.failed).toBe(1);
    expect(String((result.firstError as Error).message)).toContain('failed ses_b');
    expect(pinnedSessions.get()).toEqual([id('b')]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('全部成功时没有 firstError；正在看其中一个时回到首页', async () => {
    const { client } = fakeClient();
    const { store } = fakeStore();
    route.matches = [{ params: { sessionId: id('c') } }];
    const result = await archiveSessions(client, store, [id('a'), id('c')]);
    expect(result).toEqual({ failed: 0 });
    expect(route.navigate).toHaveBeenCalledWith('/');
  });
});

describe('deleteSessionPermanently', () => {
  it('没归档的先归档再删，带 force，取消置顶', async () => {
    const { client, calls } = fakeClient();
    const { store } = fakeStore();
    pinnedSessions.set([id('a')]);
    const result = await deleteSessionPermanently(client, store, { id: id('a') }, true);
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['session.archive', { sessionId: id('a'), archived: true }],
      ['session.delete', { sessionId: id('a'), force: true }],
    ]);
    expect(result).toEqual({ keptBranches: ['wevir/x'], engineDataKept: false });
    expect(pinnedSessions.get()).toEqual([]);
  });

  it('已归档的直接删，不带 force', async () => {
    const { client, calls } = fakeClient();
    const { store } = fakeStore();
    await deleteSessionPermanently(
      client,
      store,
      { id: id('a'), archivedAt: '2026-10-17T00:00:00.000Z' },
      false,
    );
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ['session.delete', { sessionId: id('a') }],
    ]);
  });

  it('归档失败时不删', async () => {
    const { client, calls } = fakeClient(new Set([id('a')]));
    const { store } = fakeStore();
    await expect(deleteSessionPermanently(client, store, { id: id('a') }, false)).rejects.toThrow();
    expect(calls.map((call) => call.method)).toEqual(['session.archive']);
  });
});
