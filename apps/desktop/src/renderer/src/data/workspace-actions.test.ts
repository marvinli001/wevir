import { type WevirClient, WevirRpcError } from '@wevir/client-sdk';
import type { Session, Workspace } from '@wevir/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { WorkspaceEntry } from './workbench-model';
import type { WorkbenchStore } from './workbench-store';
import {
  pinnedWorkspaces,
  removalImpact,
  removeWorkspace,
  togglePinnedWorkspace,
  updateWorkspace,
} from './workspace-actions';

const NOW = '2026-10-17T00:00:00.000Z';
const workspace = (id: `ws_${string}`): Workspace => ({
  id,
  rootPath: `/tmp/${id}`,
  displayName: id,
  createdAt: NOW,
  updatedAt: NOW,
});
const session = (id: `ses_${string}`, state: Session['state']) =>
  ({ id, state, workspaceId: 'ws_a' }) as unknown as Session;

function fakeStore() {
  const refresh = vi.fn(async () => {});
  return { store: { refresh } as unknown as WorkbenchStore, refresh };
}

beforeEach(() => {
  route.matches = [];
  route.navigate.mockClear();
  pinnedWorkspaces.set([]);
});

describe('updateWorkspace', () => {
  it('经 workspace.update 改名，然后重读列表', async () => {
    const request = vi.fn(async () => ({}));
    const { store, refresh } = fakeStore();
    await updateWorkspace({ request } as unknown as WevirClient, store, 'ws_a', '新名字');
    expect(request).toHaveBeenCalledWith('workspace.update', {
      workspaceId: 'ws_a',
      displayName: '新名字',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Host 拒绝时抛出，不重读', async () => {
    const request = vi.fn(async () => {
      throw new Error('INVALID_PARAMS');
    });
    const { store, refresh } = fakeStore();
    await expect(
      updateWorkspace({ request } as unknown as WevirClient, store, 'ws_a', 'x'),
    ).rejects.toThrow('INVALID_PARAMS');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('removeWorkspace', () => {
  it('被未关闭的会话挡住（RESOURCE_IN_USE）时先关闭它们再试一次，取消置顶，只注销', async () => {
    let removals = 0;
    const calls: [string, unknown][] = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      if (method === 'workspace.remove' && removals++ === 0) {
        throw new WevirRpcError('workspace.remove', {
          code: -32024,
          message: 'in use',
          data: { sessionIds: ['ses_1', 'ses_2'] },
        });
      }
      return {};
    });
    const { store, refresh } = fakeStore();
    pinnedWorkspaces.set(['ws_a', 'ws_b']);
    await removeWorkspace({ request } as unknown as WevirClient, store, { id: 'ws_a' });
    expect(calls).toEqual([
      ['workspace.remove', { workspaceId: 'ws_a' }],
      ['session.close', { sessionId: 'ses_1' }],
      ['session.close', { sessionId: 'ses_2' }],
      ['workspace.remove', { workspaceId: 'ws_a' }],
    ]);
    expect(pinnedWorkspaces.get()).toEqual(['ws_b']);
    expect(refresh).toHaveBeenCalledTimes(1);
    // 磁盘上的文件不由 Host 的这个方法碰：客户端只发 workspace.remove 与 session.close。
    expect(calls.map(([method]) => method)).not.toContain('workspace.delete');
  });

  it('正在看这个项目里的会话时回到首页；看别的项目时不动', async () => {
    const request = vi.fn(async () => ({}));
    const { store } = fakeStore();
    route.matches = [{ params: { workspaceId: 'ws_b' } }];
    await removeWorkspace({ request } as unknown as WevirClient, store, { id: 'ws_a' });
    expect(route.navigate).not.toHaveBeenCalled();
    route.matches = [{ params: { workspaceId: 'ws_a' } }];
    await removeWorkspace({ request } as unknown as WevirClient, store, { id: 'ws_a' });
    expect(route.navigate).toHaveBeenCalledWith('/');
  });

  it('其他错误原样抛出，不关会话', async () => {
    const request = vi.fn(async () => {
      throw new Error('boom');
    });
    const { store } = fakeStore();
    await expect(
      removeWorkspace({ request } as unknown as WevirClient, store, { id: 'ws_a' }),
    ).rejects.toThrow('boom');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('togglePinnedWorkspace', () => {
  it('后置顶的在前，再点一次取消', () => {
    togglePinnedWorkspace('ws_a');
    togglePinnedWorkspace('ws_b');
    expect(pinnedWorkspaces.get()).toEqual(['ws_b', 'ws_a']);
    togglePinnedWorkspace('ws_b');
    expect(pinnedWorkspaces.get()).toEqual(['ws_a']);
  });
});

describe('removalImpact', () => {
  it('会话数与其中未关闭的个数', () => {
    const entry: WorkspaceEntry = {
      workspace: workspace('ws_a'),
      sessions: [session('ses_1', 'idle'), session('ses_2', 'closed'), session('ses_3', 'running')],
    };
    expect(removalImpact(entry)).toEqual({ sessions: 3, open: 2 });
  });
});
