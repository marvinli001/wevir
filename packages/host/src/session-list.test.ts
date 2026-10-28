// 会话列表推送（0.101.0）：SessionListFeed 从事件库收变化、100 ms 合一批、按行的指纹判断；SessionListScope 按一条连接的范围裁剪。

import type { ChannelId, Session, SessionId } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from './event-store.js';
import {
  SESSION_LIST_WINDOW_MS,
  type SessionListBatch,
  SessionListFeed,
  SessionListScope,
} from './session-list.js';
import {
  createStore,
  delta,
  ev,
  SES,
  SES2,
  T0,
  TURN,
  useStorages,
  useTempDir,
} from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const START = 1_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const storage = storages.open(tempDir());
  const events = createStore(storage, { deltaWindowMs: 0 }, [SES, SES2]);
  const errors: unknown[] = [];
  const feed = new SessionListFeed({
    storage,
    events,
    startVersion: START,
    onError: (error) => errors.push(error),
  });
  const batches: SessionListBatch[] = [];
  const stop = feed.watch((batch) => batches.push(batch));
  /** 等过一个窗口，返回这期间的批次。 */
  const flush = () => {
    vi.advanceTimersByTime(SESSION_LIST_WINDOW_MS);
    return batches.splice(0);
  };
  return { storage, events, feed, batches, stop, flush, errors };
}

function startTurn(events: EventStore, sessionId: SessionId = SES): void {
  events.appendMany(sessionId, [
    ev.user(),
    ev.turnStarted(),
    ev.state('idle', 'running', 'turn_started'),
  ]);
}

describe('SessionListFeed', () => {
  it('建、状态、改名、待处理数、归档、工作区移除与恢复、删除都推；版本每批加一', () => {
    const { storage, events, feed, flush, errors } = setup();
    expect(feed.version).toBe(START);

    startTurn(events);
    let [batch] = flush();
    expect(batch?.listVersion).toBe(START + 1);
    expect(batch?.rows.get(SES)).toMatchObject({ id: SES, state: 'running' });

    events.appendMany(SES, [
      ev.approvalRequested('apr_1'),
      ev.state('running', 'awaiting_approval', 'approval_requested'),
    ]);
    [batch] = flush();
    expect(batch?.rows.get(SES)).toMatchObject({
      state: 'awaiting_approval',
      pendingApprovalCount: 1,
    });

    events.appendMany(SES, [
      ev.approvalResolved('apr_1', 'approved', 'user'),
      ev.state('awaiting_approval', 'running', 'approvals_settled'),
    ]);
    [batch] = flush();
    expect(batch?.rows.get(SES)).not.toHaveProperty('pendingApprovalCount');

    events.append(SES2, ev.title('新标题'));
    [batch] = flush();
    expect([...(batch?.rows.keys() ?? [])]).toEqual([SES2]);
    expect(batch?.rows.get(SES2)?.title).toBe('新标题');

    storage.sessions.setArchived(SES2, T0);
    events.touch([SES2]);
    [batch] = flush();
    expect(batch?.rows.get(SES2)?.archivedAt).toBe(T0);

    storage.workspaces.markRemoved('ws_1', T0);
    events.touch([SES, SES2]);
    [batch] = flush();
    expect(batch?.rows.get(SES)).toBeUndefined();
    expect(batch?.rows.has(SES)).toBe(true);
    expect(batch?.rows.has(SES2)).toBe(true);

    storage.workspaces.restore('ws_1', T0);
    events.touch([SES, SES2]);
    [batch] = flush();
    expect(batch?.rows.get(SES)).toMatchObject({ id: SES });

    storage.transaction(() => storage.sessions.remove([SES2]));
    events.forget([SES2]);
    [batch] = flush();
    expect([...(batch?.rows.entries() ?? [])]).toEqual([[SES2, undefined]]);
    expect(feed.version).toBe(START + 8);
    expect(errors).toEqual([]);
  });

  it('一个窗口里的多次变化合成一批', () => {
    const { events, flush } = setup();
    startTurn(events);
    events.append(SES, ev.title('一'));
    events.append(SES2, ev.title('二'));
    vi.advanceTimersByTime(SESSION_LIST_WINDOW_MS / 2);
    events.append(SES, ev.title('三'));
    const batches = flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.rows.get(SES)?.title).toBe('三');
    expect(batches[0]?.rows.get(SES2)?.title).toBe('二');
  });

  it('回合进行中的流式增量与工具进展不推，回合结束推', () => {
    const { events, flush } = setup();
    startTurn(events);
    expect(flush()).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      events.appendDelta(SES, delta(`第 ${i} 段`));
      events.append(SES, ev.toolStarted(`call_${i}`));
      events.append(SES, ev.toolFinished(`call_${i}`, 'completed', 'ok'));
      events.append(SES, ev.usage(i + 1));
      expect(flush()).toEqual([]);
    }
    events.appendMany(SES, [
      ev.turnFinished('completed', TURN),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    const [batch] = flush();
    expect(batch?.rows.get(SES)).toMatchObject({ state: 'idle' });
    expect(batch?.rows.get(SES)).not.toHaveProperty('activeTurn');
  });

  it('空闲时只有 updatedAt 变了也推', () => {
    const { events, flush } = setup();
    vi.setSystemTime(new Date('2026-10-22T08:00:00.000Z'));
    events.append(SES, ev.usage(1));
    const [batch] = flush();
    expect(batch?.rows.get(SES)?.updatedAt).toBe('2026-10-22T08:00:00.000Z');
  });

  it('回合进行中行没变（同样的标题再写一次）不推，版本不动', () => {
    const { events, feed, flush } = setup();
    startTurn(events);
    events.append(SES, ev.title('同一个'));
    expect(flush()).toHaveLength(1);
    const version = feed.version;
    vi.advanceTimersByTime(1_000);
    events.append(SES, ev.title('同一个'));
    expect(flush()).toEqual([]);
    expect(feed.version).toBe(version);
  });

  it('没有监听者时不记录；重新有了之后第一处变化照推', () => {
    const { events, stop, feed, flush } = setup();
    events.append(SES, ev.title('A'));
    flush();
    stop();
    events.append(SES, ev.title('B'));
    vi.advanceTimersByTime(SESSION_LIST_WINDOW_MS);
    expect(feed.version).toBe(START + 1);
    // 再改回 A：没有监听者期间的指纹已清掉，不会被当作“没变”。
    const batches: SessionListBatch[] = [];
    feed.watch((batch) => batches.push(batch));
    events.append(SES, ev.title('A'));
    vi.advanceTimersByTime(SESSION_LIST_WINDOW_MS);
    expect(batches.map((batch) => batch.rows.get(SES)?.title)).toEqual(['A']);
  });

  it('close 之后不再推', () => {
    const { events, feed, flush } = setup();
    feed.close();
    events.append(SES, ev.title('A'));
    expect(flush()).toEqual([]);
  });
});

describe('SessionListScope', () => {
  const row = (id: SessionId, extra: Partial<Session> = {}): Session => ({
    id,
    workspaceId: 'ws_1',
    cwd: '/p',
    engine: { kind: 'echo', sessionId: id },
    providerId: 'p',
    modelId: 'm',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    createdAt: T0,
    updatedAt: T0,
    lastSeq: 1,
    ...extra,
  });
  const CHILD = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQT' as SessionId;
  const batch = (rows: Array<[SessionId, Session | undefined]>): SessionListBatch => ({
    listVersion: 5,
    rows: new Map(rows),
  });

  it('默认列表：顶层未归档的进 upserted，归档了、删了的见过才进 removed，子会话不发', () => {
    const scope = new SessionListScope();
    scope.add({}, [row(SES)]);
    expect(
      scope.apply(
        batch([
          [SES, row(SES, { archivedAt: T0 })],
          [SES2, undefined],
          [CHILD, row(CHILD, { parentSessionId: SES })],
        ]),
      ),
    ).toEqual({ listVersion: 5, upserted: [], removed: [SES] });
    // 已经告诉过它移除了：再变也不发。
    expect(scope.apply(batch([[SES, undefined]]))).toEqual({
      listVersion: 5,
      upserted: [],
      removed: [],
    });
    expect(scope.apply(batch([[SES2, row(SES2)]])).upserted.map((s) => s.id)).toEqual([SES2]);
  });

  it('多次调用取并集：归档列表、子会话列表与按工作区的列表', () => {
    const scope = new SessionListScope();
    scope.add({ archived: true }, []);
    scope.add({ parentSessionId: SES }, []);
    scope.add({ workspaceId: 'ws_2' }, []);
    const result = scope.apply(
      batch([
        [SES, row(SES, { archivedAt: T0 })],
        [CHILD, row(CHILD, { parentSessionId: SES })],
        [SES2, row(SES2)],
      ]),
    );
    expect(result.upserted.map((s) => s.id)).toEqual([SES, CHILD]);
    expect(result.removed).toEqual([]);
    // 取消归档：离开归档列表，也不在 ws_2 里。
    expect(scope.apply(batch([[SES, row(SES)]])).removed).toEqual([SES]);
  });

  it('开在项目里的频道线程（0.134.0）照常发；旧连接不要', () => {
    const thread = row(SES, { channel: { channelId: 'chn_1' as ChannelId, role: 'thread' } });
    const scope = new SessionListScope();
    scope.add({}, []);
    expect(scope.apply(batch([[SES, thread]])).upserted.map((s) => s.id)).toEqual([SES]);
    const old = new SessionListScope();
    old.channelThreads = false;
    old.add({}, []);
    expect(old.apply(batch([[SES, thread]])).upserted).toEqual([]);
  });
});
