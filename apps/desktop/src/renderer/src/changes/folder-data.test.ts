import type { HostFeatures, SessionId, WorkspaceId } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceGitFolders } from '@/data/workspace-git';
import { useWorkspaceDiff } from './changes-data';
import { useGitStatus } from './git-data';
import { useReviewComments } from './review-data';

// 数据 hook 的 effect 在 Node 中逐次运行，保留状态，手动推进请求与目录切换。
const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  effects: new Map<number, { deps: readonly unknown[]; cleanup: undefined | (() => void) }>(),
}));
const host = vi.hoisted(() => ({
  features: {} as HostFeatures,
  request: vi.fn<(method: string, params: { folder?: string }) => Promise<unknown>>(),
}));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial?: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useCallback: <T>(callback: T) => callback,
  useEffect(effect: () => undefined | (() => void), deps: readonly unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.effects.get(index);
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    previous?.cleanup?.();
    hooks.effects.set(index, { deps, cleanup: effect() });
  },
}));
vi.mock('@/host/host-connection', () => {
  const client = { request: host.request };
  return {
    useHostConnection: () => ({
      client,
      view: { status: 'connected', hello: { features: host.features } },
    }),
  };
});
vi.mock('@/lib/visible-interval', () => ({ everyWhileVisible: () => () => {} }));

const workspaceId = 'ws_folders' as WorkspaceId;
const sessionId = 'ses_folders' as SessionId;
const status = (folder: string | undefined) => ({
  repo: true,
  branch: folder ?? 'main',
  head: null,
  index: `index:${folder ?? 'main'}`,
  files: [],
});

function render<T>(hook: () => T): T {
  hooks.cursor = 0;
  return hook();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.values = [];
  hooks.effects.clear();
  host.features = {
    workspace_git: true,
    workspace_diff: true,
    git_commit: true,
    multi_folder_changes: true,
    review_comments: true,
  };
  host.request.mockReset().mockImplementation(async (method, params) => {
    if (method === 'workspace.diff') return { repo: true, patch: params.folder ?? 'main' };
    if (method === 'workspace.git' || method === 'git.status') return status(params.folder);
    if (method === 'review.list') return { comments: [{ id: 'comment', path: 'same.ts' }] };
    return { status: status(params.folder), outcome: { kind: 'failed', reason: 'nothing_staged' } };
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  vi.unstubAllGlobals();
});

describe('多目录数据', () => {
  it('并行读取各目录，换会话时不闪现另一会话的仓库状态', async () => {
    let owner = sessionId;
    const read = () =>
      useWorkspaceGitFolders(workspaceId, ['/app', '/api', '/plain'], {
        active: true,
        sessionId: owner,
      });
    render(read);
    expect(host.request.mock.calls.map(([, params]) => params.folder)).toEqual([
      '/app',
      '/api',
      '/plain',
    ]);
    await settle();
    expect(render(read).folders.map(({ status }) => status?.branch)).toEqual([
      '/app',
      '/api',
      '/plain',
    ]);
    owner = 'ses_other' as SessionId;
    expect(render(read).folders.every(({ status }) => status === undefined)).toBe(true);
    await settle();
    expect(render(read).folders[1]?.status?.branch).toBe('/api');
  });

  it.each([true, false])('暂存、取消暂存和提交按 Host 功能发送目录：%s', async (multiple) => {
    host.features.multi_folder_changes = multiple;
    const read = () => useGitStatus(workspaceId, sessionId, 0, '/api');
    render(read);
    await settle();
    const git = render(read);
    await git.stage(['same.ts']);
    await git.unstage(['same.ts']);
    await git.commit('Update file', false);
    expect(host.request.mock.calls.map(([method]) => method)).toEqual([
      'git.status',
      'git.stage',
      'git.unstage',
      'git.commit',
    ]);
    for (const [, params] of host.request.mock.calls) {
      if (multiple) expect(params.folder).toBe('/api');
      else expect(params).not.toHaveProperty('folder');
    }
  });

  it('旧 Host 只读一个仓库，忽略原先选过的附加目录', async () => {
    host.features.multi_folder_changes = false;
    const read = () =>
      useWorkspaceGitFolders(workspaceId, ['/app', '/api'], { active: true, sessionId });
    expect(render(read).folders).toHaveLength(1);
    await settle();
    expect(render(read).folders[0]?.status?.branch).toBe('main');
    expect(host.request.mock.calls).toEqual([['workspace.git', { workspaceId, sessionId }]]);
  });

  it('切换目录后旧回调不能拿新目录状态去写，新目录读到状态之前不能暂存', async () => {
    let folder = '/first';
    const read = () => useGitStatus(workspaceId, sessionId, 0, folder);
    render(read);
    await settle();
    const old = render(read);
    folder = '/second';
    const next = render(read);
    expect(next.status).toBeUndefined();
    await old.stage(['same.ts']);
    await next.stage(['same.ts']);
    expect(host.request.mock.calls.filter(([method]) => method === 'git.stage')).toHaveLength(0);
    await settle();
    await render(read).stage(['same.ts']);
    expect(host.request).toHaveBeenLastCalledWith('git.stage', {
      workspaceId,
      sessionId,
      folder: '/second',
      paths: ['same.ts'],
      expected: { head: null, index: 'index:/second' },
    });
  });

  it('diff 缓存隔离目录，旧 Host 的请求不带目录', async () => {
    let folder = '/diff-first';
    const read = () =>
      useWorkspaceDiff(
        workspaceId,
        sessionId,
        { kind: 'branch' },
        { refreshKey: 0, live: false, folder },
      );
    render(read);
    await settle();
    expect(render(read).result?.patch).toBe('/diff-first');
    folder = '/diff-second';
    expect(render(read).result).toBeUndefined();
    await settle();
    expect(render(read).result?.patch).toBe('/diff-second');
    host.features.multi_folder_changes = false;
    render(read);
    await settle();
    expect(render(read).result?.patch).toBe('main');
    expect(host.request).toHaveBeenLastCalledWith('workspace.diff', {
      workspaceId,
      sessionId,
      source: { kind: 'branch' },
    });
  });

  it('上一个目录的慢写结果不会覆盖新目录状态', async () => {
    let folder = '/slow';
    const read = () => useGitStatus(workspaceId, sessionId, 0, folder);
    render(read);
    await settle();
    let finish: (value: unknown) => void = () => {};
    host.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = render(read).stage(['same.ts']);
    folder = '/current';
    render(read);
    await settle();
    expect(render(read).status?.branch).toBe('/current');
    finish({ status: status('/slow') });
    await pending;
    expect(render(read).status?.branch).toBe('/current');
    expect(render(read).busy).toBe(false);
  });

  it('附加目录禁用批注时不读取或返回主目录同名路径的批注', async () => {
    let enabled = true;
    const read = () => useReviewComments(workspaceId, sessionId, 0, enabled);
    render(read);
    await settle();
    expect(render(read).comments).toHaveLength(1);
    enabled = false;
    expect(render(read).comments).toEqual([]);
    expect(host.request.mock.calls.filter(([method]) => method === 'review.list')).toHaveLength(1);
  });
});
