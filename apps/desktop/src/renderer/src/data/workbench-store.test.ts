import type { SessionsChange, WevirClient } from '@wevir/client-sdk';
import type { Session, SessionId, WevirEvent } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET_PUBLISH_MS, WorkbenchStore } from './workbench-store';

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

/** 列表请求按 `lists` 依次回答；订阅的事件由 `emit` 送进去。 */
function fakeClient(
  lists: Array<{ sessions: Session[]; listVersion?: number }>,
  permissions: { providerRead?: boolean } = {},
) {
  let push: ((change: SessionsChange | undefined) => void) | undefined;
  const closed = new Set<SessionId>();
  const subscribed: SessionId[] = [];
  const streams = new Map<SessionId, (event: WevirEvent) => void>();
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
      const queued: WevirEvent[] = [];
      let waiting:
        | ((result: IteratorResult<{ type: 'event'; event: WevirEvent }>) => void)
        | undefined;
      streams.set(sessionId, (event) => {
        if (waiting) {
          waiting({ value: { type: 'event', event }, done: false });
          waiting = undefined;
        } else queued.push(event);
      });
      return {
        close: () => closed.add(sessionId),
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const event = queued.shift();
            return event
              ? Promise.resolve({ value: { type: 'event', event }, done: false })
              : new Promise((resolve) => {
                  waiting = resolve;
                });
          },
        }),
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
    emit: (event: WevirEvent) => streams.get(event.sessionId)?.(event),
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

  it('推来的会话在不认识的项目里：重读一次列表，同一个工作区不再重读', async () => {
    const fake = fakeClient([
      { sessions: [session('ses_a')], listVersion: 10 },
      { sessions: [session('ses_a')], listVersion: 11 },
    ]);
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    fake.push({
      listVersion: 11,
      upserted: [session('ses_x', { workspaceId: 'ws_new' as Session['workspaceId'] })],
      removed: [],
    });
    await vi.waitFor(() => expect(fake.listCalls()).toBe(2));
    fake.push({
      listVersion: 12,
      upserted: [session('ses_y', { workspaceId: 'ws_new' as Session['workspaceId'] })],
      removed: [],
    });
    expect(fake.listCalls()).toBe(2);
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

describe('WorkbenchStore 与流式事件', () => {
  function event(seq: number, type: string, payload: unknown = {}): WevirEvent {
    return {
      sessionId: 'ses_a',
      seq,
      ts: `2026-10-22T00:00:0${seq}.000Z`,
      type,
      payload,
    } as unknown as WevirEvent;
  }

  async function settle(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('只推进 lastSeq 的事件安静一阵后才通知一次；状态变了立即通知', async () => {
    const fake = fakeClient([{ sessions: [session('ses_a')], listVersion: 1 }]);
    const store = new WorkbenchStore(fake.client);
    await store.refresh();
    const notified = vi.fn();
    store.subscribe(notified);
    const seen: number[] = [];
    store.onSessionEvent((item) => seen.push(item.seq));
    const lastSeq = () => {
      const data = store.get();
      return data.status === 'ready' ? data.workspaces[0]?.sessions[0]?.lastSeq : undefined;
    };

    fake.emit(event(2, 'turn.started', { turnId: 'trn_1' }));
    await settle(100);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(lastSeq()).toBe(2);

    for (const seq of [3, 4, 5]) {
      fake.emit(event(seq, 'assistant.delta', { text: 'x' }));
      await settle(100);
    }
    // 事件的监听照常逐条收到，界面先不通知。
    expect(seen).toEqual([2, 3, 4, 5]);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(lastSeq()).toBe(2);

    await settle(QUIET_PUBLISH_MS);
    expect(notified).toHaveBeenCalledTimes(2);
    expect(lastSeq()).toBe(5);

    fake.emit(event(6, 'assistant.delta', { text: 'y' }));
    await settle(100);
    fake.emit(event(7, 'turn.finished', { turnId: 'trn_1', outcome: 'completed' }));
    await settle(100);
    expect(notified).toHaveBeenCalledTimes(3);
    expect(lastSeq()).toBe(7);
    await settle(QUIET_PUBLISH_MS);
    expect(notified).toHaveBeenCalledTimes(3);
    store.dispose();
  });
});
