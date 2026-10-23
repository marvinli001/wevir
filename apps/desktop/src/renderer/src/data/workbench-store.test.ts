import type { SessionsChange, WevirClient } from '@wevir/client-sdk';
import type { Session, SessionId } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchStore } from './workbench-store';

const NOW = '2026-10-22T00:00:00.000Z';
const WS = 'ws_1';

function session(id: `ses_${string}`, extra: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: WS,
    cwd: '/tmp/ws',
    engine: { kind: 'echo', sessionId: id },
    providerId: 'mock',
    modelId: 'mock-model',
    title: id,
    titleSource: 'first_prompt',
    state: 'idle',
    createdAt: NOW,
    updatedAt: NOW,
    lastSeq: 1,
    ...extra,
  };
}

/** 列表请求按 `lists` 依次回答；订阅永远不来事件。 */
function fakeClient(
  lists: Array<{ sessions: Session[]; listVersion?: number }>,
  permissions: { providerRead?: boolean } = {},
) {
  let push: ((change: SessionsChange | undefined) => void) | undefined;
  const closed = new Set<SessionId>();
  const subscribed: SessionId[] = [];
  const request = vi.fn(async (method: string) => {
    if (method === 'workspace.list') {
      return {
        workspaces: [
          { id: WS, rootPath: '/tmp/ws', displayName: 'ws', createdAt: NOW, updatedAt: NOW },
        ],
      };
    }
    if (method === 'provider.list') return { providers: [] };
    return lists.shift() ?? { sessions: [] };
  });
  const client = {
    request,
    can: (permission: string) =>
      permission !== 'provider.read' || permissions.providerRead !== false,
    onSessionsChanged: (listener: (change: SessionsChange | undefined) => void) => {
      push = listener;
      return () => {
        push = undefined;
      };
    },
    subscribe: (sessionId: SessionId) => {
      subscribed.push(sessionId);
      return {
        close: () => closed.add(sessionId),
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
      };
    },
  } as unknown as WevirClient;
  const listCalls = () => request.mock.calls.filter(([method]) => method === 'session.list').length;
  return {
    client,
    push: (change: SessionsChange) => push?.(change),
    closed,
    subscribed,
    listCalls,
  };
}

function titles(store: WorkbenchStore): string[] {
  const data = store.get();
  if (data.status !== 'ready') return [];
  return data.workspaces.flatMap((group) => group.sessions.map((item) => item.title)).sort();
}

beforeEach(() => {
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkbenchStore 与远程设备的权限', () => {
  it('没有 provider.read 时不列 Provider，项目与会话照常读到', async () => {
    const fake = fakeClient([{ sessions: [session('ses_a')], listVersion: 1 }], {
      providerRead: false,
    });
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    expect(titles(store)).toEqual(['ses_a']);
    const data = store.get();
    expect(data.status === 'ready' && data.providers).toEqual([]);
    expect(
      (fake.client.request as unknown as { mock: { calls: string[][] } }).mock.calls.map(
        ([method]) => method,
      ),
    ).not.toContain('provider.list');
  });
});

describe('WorkbenchStore 与 sessions.changed（0.101.0）', () => {
  it('版本连续时照推送增删、跟上新会话，不重读列表', async () => {
    const fake = fakeClient([{ sessions: [session('ses_a'), session('ses_b')], listVersion: 10 }]);
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    expect(titles(store)).toEqual(['ses_a', 'ses_b']);

    fake.push({
      listVersion: 11,
      upserted: [session('ses_c'), session('ses_a', { title: 'renamed', lastSeq: 2 })],
      removed: ['ses_b'],
    });
    expect(titles(store)).toEqual(['renamed', 'ses_c']);
    expect(fake.closed.has('ses_b')).toBe(true);
    expect(fake.subscribed).toContain('ses_c');
    // 与这条连接无关的一批：版本照样前进。
    fake.push({ listVersion: 12, upserted: [], removed: [] });
    fake.push({
      listVersion: 13,
      upserted: [session('ses_c', { title: 'c2', lastSeq: 3 })],
      removed: [],
    });
    expect(titles(store)).toEqual(['c2', 'renamed']);
    expect(fake.listCalls()).toBe(1);
    store.dispose();
  });

  it('手里的行 lastSeq 更大时留着自己的', async () => {
    const fake = fakeClient([
      { sessions: [session('ses_a', { lastSeq: 5, title: 'live' })], listVersion: 1 },
    ]);
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    fake.push({
      listVersion: 2,
      upserted: [session('ses_a', { lastSeq: 4, title: 'old' })],
      removed: [],
    });
    expect(titles(store)).toEqual(['live']);
    store.dispose();
  });

  it('版本不连续就重读一次列表', async () => {
    const fake = fakeClient([
      { sessions: [session('ses_a')], listVersion: 10 },
      { sessions: [session('ses_a'), session('ses_z')], listVersion: 20 },
    ]);
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    fake.push({ listVersion: 12, upserted: [session('ses_x')], removed: [] });
    await vi.waitFor(() => expect(fake.listCalls()).toBe(2));
    await vi.waitFor(() => expect(titles(store)).toEqual(['ses_a', 'ses_z']));
    // 重读之后从新的版本接着算。
    fake.push({ listVersion: 21, upserted: [], removed: ['ses_z'] });
    expect(titles(store)).toEqual(['ses_a']);
    store.dispose();
  });

  it('旧 Host 的列表没有版本：推送不起作用', async () => {
    const fake = fakeClient([{ sessions: [session('ses_a')] }]);
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    fake.push({ listVersion: 1, upserted: [session('ses_b')], removed: [] });
    expect(titles(store)).toEqual(['ses_a']);
    expect(fake.listCalls()).toBe(1);
    store.dispose();
  });
});
