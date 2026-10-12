import {
  JSON_STRING_MAX_LENGTH,
  TOOL_OUTPUT_MAX_LENGTH,
  type WevirEvent,
  WevirEventSchema,
} from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppendInput, EventStore, SessionNotFoundError } from './event-store.js';
import { EventRejectedError } from './snapshot.js';
import {
  createStore,
  delta,
  ev,
  SES,
  SES2,
  seedSession,
  T0,
  TURN,
  useStorages,
  useTempDir,
} from './test-utils.js';

function seqs(events: readonly WevirEvent[]): number[] {
  return events.map((e) => e.seq);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** 让出事件循环，制造异步调用方之间的交错。 */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EventStore.append / readSince', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  it('分配 seq 并返回完整事件；readSince 按 seq 升序读出同样的事件', () => {
    const storage = open(dataDir());
    seedSession(storage);
    const store = new EventStore({ storage });

    const created = store.append(SES, ev.created());
    expect(created).toMatchObject({
      seq: 1,
      sessionId: SES,
      type: 'session.created',
      source: 'host',
    });
    expect(new Date(created.ts).toISOString()).toBe(created.ts);
    const [user, started] = store.appendMany(SES, [ev.user(), ev.turnStarted()]);
    expect(seqs([user as WevirEvent, started as WevirEvent])).toEqual([2, 3]);

    const all = store.readSince(SES, 0);
    expect(all).toEqual([created, user, started]);
    for (const event of all) expect(WevirEventSchema.parse(event)).toEqual(event);
    expect(store.readSince(SES, 1)).toEqual([user, started]);
    expect(store.readSince(SES, 1, 1)).toEqual([user]);
    expect(store.readSince(SES, 3)).toEqual([]);
    expect(store.readSince(SES2, 0)).toEqual([]);
    expect(() => store.readSince(SES, -1)).toThrow();
    expect(() => store.readSince(SES, 0, 0)).toThrow(RangeError);
  });

  it('payload 按 schema 写入：多余字段被剥掉，不合 schema 时抛错且不写入', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    const withExtra = {
      type: 'usage.updated',
      source: 'engine',
      payload: { contextUsed: 1, contextSize: 2, internal: 'x' },
    } as AppendInput;
    expect(store.append(SES, withExtra).payload).toEqual({ contextUsed: 1, contextSize: 2 });

    const invalid = { type: 'usage.updated', source: 'engine', payload: { contextUsed: -1 } };
    expect(() => store.append(SES, invalid as AppendInput)).toThrow();
    expect(() =>
      store.append(SES, { type: 'nope', source: 'host', payload: {} } as unknown as AppendInput),
    ).toThrow(EventRejectedError);
    expect(() =>
      store.append(SES, { ...ev.usage(1), source: 'client' } as unknown as AppendInput),
    ).toThrow();
    expect(() =>
      store.append(SES, {
        type: 'assistant.delta',
        source: 'engine',
        payload: delta('x'),
      } as unknown as AppendInput),
    ).toThrow(/appendDelta/);
    expect(store.readSince(SES, 0)).toHaveLength(2);
  });

  it('会话不存在时抛 SessionNotFoundError', () => {
    const storage = open(dataDir());
    const store = new EventStore({ storage });
    expect(() => store.append(SES, ev.created())).toThrow(SessionNotFoundError);
    expect(() => store.appendDelta(SES, delta('x'))).toThrow(SessionNotFoundError);
    expect(store.snapshot(SES)).toBeUndefined();
  });

  it('appendMany 是原子的：任何一条被拒绝时整批都不写', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    expect(() =>
      store.appendMany(SES, [
        ev.user(),
        ev.turnStarted(),
        ev.state('running', 'idle', 'turn_finished'),
      ]),
    ).toThrow(EventRejectedError);
    expect(store.readSince(SES, 0)).toHaveLength(1);
    expect(storage.sessions.get(SES)?.lastSeq).toBe(1);
    expect(store.snapshot(SES)?.session.lastSeq).toBe(1);
    // 被拒绝之后照常可写，seq 没有空洞。
    expect(store.append(SES, ev.usage(1)).seq).toBe(2);
  });

  it('同一会话并发 append：交错的异步调用方之间 seq 连续、无重复，各自顺序不变', async () => {
    const storage = open(dataDir());
    const store = createStore(storage, { deltaWindowMs: 2 });
    const producers = 8;
    const perProducer = 25;

    await Promise.all(
      range(1, producers).map(async (p) => {
        for (let i = 0; i < perProducer; i++) {
          await tick((p * 7 + i) % 3);
          if (i % 5 === 4) store.appendDelta(SES, delta(`p${p}-${i};`, p));
          else store.append(SES, ev.usage(p * 1000 + i));
        }
      }),
    );
    store.flushAll();

    const events = store.readSince(SES, 0);
    expect(seqs(events)).toEqual(range(1, events.length));
    const usage = events.filter((e) => e.type === 'usage.updated');
    expect(usage).toHaveLength(producers * (perProducer - perProducer / 5));
    for (let p = 1; p <= producers; p++) {
      const mine = usage
        .map((e) => e.payload.contextUsed)
        .filter((n) => Math.floor(n / 1000) === p);
      expect(mine).toEqual([...mine].sort((a, b) => a - b));
      const text = events
        .flatMap((e) =>
          e.type === 'assistant.delta' && e.payload.blockIndex === p ? [e.payload.text] : [],
        )
        .join('');
      expect(text).toBe(
        range(0, perProducer - 1)
          .filter((i) => i % 5 === 4)
          .map((i) => `p${p}-${i};`)
          .join(''),
      );
    }
    expect(storage.sessions.get(SES)?.lastSeq).toBe(events.length);
  });

  it('两个连接交替写同一会话：seq 取自库而不是内存计数，各自的快照能追上对方的写入', () => {
    const dir = dataDir();
    const a = createStore(open(dir));
    const storageB = open(dir);
    const b = new EventStore({ storage: storageB });

    for (let i = 0; i < 20; i++) {
      const store = i % 3 === 0 ? b : a;
      expect(store.append(SES, ev.usage(i)).seq).toBe(i + 2);
    }
    b.append(SES, ev.title('交替写入'));

    expect(seqs(a.readSince(SES, 0))).toEqual(range(1, 22));
    expect(a.snapshot(SES)).toEqual(b.snapshot(SES));
    expect(a.snapshot(SES)?.session).toMatchObject({ lastSeq: 22, title: '交替写入' });
    expect(a.snapshot(SES)?.usage?.contextUsed).toBe(19);
  });

  it('重开数据库后 readSince 与快照都与重开前一致', () => {
    const dir = dataDir();
    const storage = open(dir);
    const store = createStore(storage);
    store.appendMany(SES, [
      ev.user(TURN, 'msg-1'),
      ev.turnStarted(),
      ev.title('写一个 summary.md'),
      ev.state('idle', 'running', 'turn_started'),
    ]);
    store.appendDelta(SES, delta('好的，'));
    store.append(SES, ev.toolStarted('call_1', { command: 'ls' }));
    store.appendMany(SES, [
      ev.approvalRequested('apr_1'),
      ev.state('running', 'awaiting_approval', 'approval_requested'),
    ]);
    store.appendDelta(SES, delta('仍在缓冲'));
    store.close();
    const before = store.readSince(SES, 0);
    const snapshotBefore = store.snapshot(SES);
    storage.close();

    const reopened = new EventStore({ storage: open(dir) });
    expect(reopened.readSince(SES, 0)).toEqual(before);
    expect(reopened.readSince(SES, 5, 2)).toEqual(before.slice(5, 7));
    expect(before.at(-1)).toMatchObject({ type: 'assistant.delta', payload: { text: '仍在缓冲' } });
    expect(reopened.snapshot(SES)).toEqual(snapshotBefore);
    expect(snapshotBefore?.session).toMatchObject({
      state: 'awaiting_approval',
      activeTurn: { turnId: TURN, clientMessageId: 'msg-1' },
      lastSeq: before.length,
    });
    expect(snapshotBefore?.pendingApprovals.map((a) => a.id)).toEqual(['apr_1']);
  });

  it('close 之后拒绝写入，可重复调用', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    store.close();
    store.close();
    expect(() => store.append(SES, ev.usage(1))).toThrow(/已关闭/);
    expect(() => store.appendDelta(SES, delta('x'))).toThrow(/已关闭/);
    expect(store.readSince(SES, 0)).toHaveLength(1);
  });
});

describe('EventStore 增量合并', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(options: { onError?: (error: unknown) => void } = {}) {
    vi.useFakeTimers({ now: Date.parse(T0) });
    const storage = open(dataDir());
    const store = createStore(storage, options);
    store.appendMany(SES, [
      ev.user(),
      ev.turnStarted(),
      ev.state('idle', 'running', 'turn_started'),
    ]);
    const live: WevirEvent[] = [];
    store.subscribe(SES, (event) => live.push(event));
    return { storage, store, live };
  }

  function deltas(events: readonly WevirEvent[]): Array<[number, number, string, string]> {
    return events.flatMap((e) =>
      e.type === 'assistant.delta'
        ? [[e.seq, e.payload.blockIndex, e.payload.kind, e.payload.text]]
        : [],
    ) as Array<[number, number, string, string]>;
  }

  it('窗口首尾各 flush 一次；相邻同一块合并，不同块分开且保持顺序', () => {
    const { store, live } = setup();

    store.appendDelta(SES, delta('一')); // t=0：静默之后的第一个增量，立即写入
    expect(deltas(live)).toEqual([[5, 0, 'text', '一']]);

    vi.advanceTimersByTime(10);
    store.appendDelta(SES, delta('二'));
    vi.advanceTimersByTime(10);
    store.appendDelta(SES, delta('三'));
    store.appendDelta(SES, delta('想', 1, 'reasoning'));
    store.appendDelta(SES, delta('法', 1, 'reasoning'));
    store.appendDelta(SES, delta('四'));
    store.appendDelta(SES, delta('')); // 空文本忽略
    vi.advanceTimersByTime(39); // t=59：窗口还没结束
    expect(deltas(live)).toHaveLength(1);
    vi.advanceTimersByTime(1); // t=60：窗口尾
    expect(deltas(live)).toEqual([
      [5, 0, 'text', '一'],
      [6, 0, 'text', '二三'],
      [7, 1, 'reasoning', '想法'],
      [8, 0, 'text', '四'],
    ]);

    vi.advanceTimersByTime(10);
    store.appendDelta(SES, delta('五')); // t=70：距上次写入不足一个窗口，等到 t=120
    vi.advanceTimersByTime(49);
    expect(deltas(live)).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(deltas(live).at(-1)).toEqual([9, 0, 'text', '五']);

    vi.advanceTimersByTime(200);
    store.appendDelta(SES, delta('六')); // 又是静默之后，立即写入
    expect(deltas(live).at(-1)).toEqual([10, 0, 'text', '六']);

    expect(store.readSince(SES, 0)).toEqual([...store.readSince(SES, 0, 4), ...live]);
    expect(seqs(store.readSince(SES, 0))).toEqual(range(1, 10));
  });

  it('不能合并的事件到达时先写掉缓冲的增量，seq 连续且顺序正确', () => {
    const { store, live } = setup();
    store.appendDelta(SES, delta('a')); // 立即写入（seq 5）
    store.appendDelta(SES, delta('b'));
    store.appendDelta(SES, delta('c', 1));

    const tool = store.append(SES, ev.toolStarted('call_1'));
    expect(tool.seq).toBe(8);
    expect(live.map((e) => [e.seq, e.type])).toEqual([
      [5, 'assistant.delta'],
      [6, 'assistant.delta'],
      [7, 'assistant.delta'],
      [8, 'tool.started'],
    ]);
    // 缓冲已清空，窗口定时器也随之取消。
    vi.advanceTimersByTime(1000);
    expect(live).toHaveLength(4);
    expect(seqs(store.readSince(SES, 0))).toEqual(range(1, 8));
  });

  it('不同会话各自缓冲；flush / flushAll / close 立即写入', () => {
    vi.useFakeTimers({ now: Date.parse(T0) });
    const storage = open(dataDir());
    const store = createStore(storage, {}, [SES, SES2]);
    for (const id of [SES, SES2]) {
      store.appendMany(id, [
        ev.user(),
        ev.turnStarted(),
        ev.state('idle', 'running', 'turn_started'),
      ]);
      store.appendDelta(id, delta('首'));
      store.appendDelta(id, delta('尾'));
    }
    store.flush(SES);
    expect(store.readSince(SES, 0).at(-1)).toMatchObject({ seq: 6, payload: { text: '尾' } });
    expect(store.readSince(SES2, 0)).toHaveLength(5);
    store.flushAll();
    expect(store.readSince(SES2, 0).at(-1)).toMatchObject({ seq: 6, payload: { text: '尾' } });

    store.appendDelta(SES, delta('关闭前'));
    store.close();
    expect(store.readSince(SES, 0).at(-1)).toMatchObject({ seq: 7, payload: { text: '关闭前' } });
  });

  it('定时 flush 失败时交给 onError 并丢弃这批增量，之后照常写入', () => {
    const errors: unknown[] = [];
    const { storage, store } = setup({ onError: (error) => errors.push(error) });
    store.appendDelta(SES, delta('a'));
    store.appendDelta(SES, delta('b'));
    storage.db.exec('PRAGMA query_only = ON');
    vi.advanceTimersByTime(60);
    storage.db.exec('PRAGMA query_only = OFF');
    expect(errors).toHaveLength(1);

    expect(store.append(SES, ev.usage(1)).seq).toBe(6);
    expect(store.readSince(SES, 4).map((e) => e.type)).toEqual([
      'assistant.delta',
      'usage.updated',
    ]);
  });
});

describe('EventStore 截断', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  it('工具输出、工具输入、审批详情与 engine.raw 在入库前截断，回放与推送是同一份', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    const live: WevirEvent[] = [];
    store.subscribe(SES, (event) => live.push(event));
    store.appendMany(SES, [
      ev.user(),
      ev.turnStarted(),
      ev.state('idle', 'running', 'turn_started'),
    ]);

    const big = 'x'.repeat(TOOL_OUTPUT_MAX_LENGTH + 100);
    const longString = 'y'.repeat(JSON_STRING_MAX_LENGTH + 5);
    const started = store.append(
      SES,
      ev.toolStarted('call_1', { file_path: 'a.txt', content: longString }),
    );
    const finished = store.append(SES, ev.toolFinished('call_1', 'completed', big));
    const approvalInput = ev.approvalRequested('apr_1');
    const detail = approvalInput.payload.approval.detail;
    if (!detail) throw new Error('样例审批应有 detail');
    detail.input = { content: longString };
    const requested = store.append(SES, approvalInput);
    const raw = store.append(SES, {
      type: 'engine.raw',
      source: 'engine',
      payload: { protocol: 'acp', method: 'session/update', params: { blob: longString } },
    });

    expect(started.payload.input).toEqual({
      file_path: 'a.txt',
      content: `${'y'.repeat(JSON_STRING_MAX_LENGTH)}…[+5 chars]`,
    });
    expect(finished.payload.output).toMatchObject({
      truncated: true,
      originalLength: TOOL_OUTPUT_MAX_LENGTH + 100,
    });
    expect(finished.payload.output?.text).toContain('[… 100 chars truncated …]');
    expect(requested.payload.approval.detail?.input).toEqual({
      content: `${'y'.repeat(JSON_STRING_MAX_LENGTH)}…[+5 chars]`,
    });
    expect(raw.payload.params).toEqual({
      blob: `${'y'.repeat(JSON_STRING_MAX_LENGTH)}…[+5 chars]`,
    });
    // 调用方的对象没有被改动。
    expect(detail.input).toEqual({ content: longString });

    const replayed = store.readSince(SES, 4);
    expect(replayed).toEqual([started, finished, requested, raw]);
    expect(live.slice(-4)).toEqual(replayed);
  });
});

describe('EventStore.subscribe', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  it('先按 lastSeq 回放、再收实时事件：不丢不重', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    store.append(SES, ev.usage(1));

    const live: WevirEvent[] = [];
    const { lastSeq, unsubscribe } = store.subscribe(SES, (event) => live.push(event));
    expect(lastSeq).toBe(2);
    store.append(SES, ev.usage(2));
    store.append(SES, ev.usage(3));
    const replay = store.readSince(SES, 0, lastSeq);
    expect(seqs([...replay, ...live])).toEqual([1, 2, 3, 4]);

    unsubscribe();
    unsubscribe();
    store.append(SES, ev.usage(4));
    expect(live).toHaveLength(2);
  });

  it('订阅者在回调里追加事件（重入）时，每个订阅者看到的 seq 仍然递增；回调里新建的订阅不会收到重复事件', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    const first: number[] = [];
    const second: number[] = [];
    const late: number[] = [];
    let lateLastSeq = 0;
    store.subscribe(SES, (event) => {
      first.push(event.seq);
      if (event.type === 'usage.updated' && event.payload.contextUsed === 1) {
        store.append(SES, ev.usage(99));
        const sub = store.subscribe(SES, (e) => late.push(e.seq));
        lateLastSeq = sub.lastSeq;
      }
    });
    store.subscribe(SES, (event) => second.push(event.seq));

    store.appendMany(SES, [ev.usage(1), ev.usage(2)]);
    expect(first).toEqual([2, 3, 4]);
    expect(second).toEqual([2, 3, 4]);
    expect(lateLastSeq).toBe(4);
    expect(late).toEqual([]);
    store.append(SES, ev.usage(5));
    expect(late).toEqual([5]);
  });

  it('订阅者抛错交给 onError，不影响其他订阅者和已提交的写入', () => {
    const errors: unknown[] = [];
    const storage = open(dataDir());
    const store = createStore(storage, { onError: (error) => errors.push(error) });
    const received: number[] = [];
    store.subscribe(SES, () => {
      throw new Error('boom');
    });
    store.subscribe(SES, (event) => received.push(event.seq));
    expect(store.append(SES, ev.usage(1)).seq).toBe(2);
    expect(received).toEqual([2]);
    expect(errors).toEqual([new Error('boom')]);
  });

  it('只收订阅的那个会话', () => {
    const storage = open(dataDir());
    const store = createStore(storage, {}, [SES, SES2]);
    const received: string[] = [];
    store.subscribe(SES2, (event) => received.push(event.sessionId));
    store.append(SES, ev.usage(1));
    store.append(SES2, ev.usage(1));
    expect(received).toEqual([SES2]);
  });
});
