import type {
  ApprovalId,
  EngineErrorCategory,
  SessionSnapshot,
  SessionState,
  StateChangeReason,
} from '@wevir/protocol';
import { SessionSnapshotSchema } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { type AppendInput, EventStore } from './event-store.js';
import {
  applyEvent,
  EventRejectedError,
  INITIAL_PROJECTION,
  isAllowedTransition,
  SESSION_TRANSITIONS,
} from './snapshot.js';
import {
  createStore,
  ev,
  SES,
  seedSession,
  TURN,
  TURN2,
  useStorages,
  useTempDir,
} from './test-utils.js';

// 到达各状态的事件前缀（domain-model §4.1 的编号写在注释里）。
const START: AppendInput[] = [
  ev.user(TURN, 'msg-1'),
  ev.turnStarted(),
  ev.title('写一个 summary.md'),
  ev.state('idle', 'running', 'turn_started'),
]; // #2
const TO_AWAITING: AppendInput[] = [
  ...START,
  ev.toolStarted('call_apr_1'),
  ev.approvalRequested('apr_1'),
  ev.state('running', 'awaiting_approval', 'approval_requested'),
]; // #3
const TO_CANCELLING: AppendInput[] = [
  ...START,
  ev.state('running', 'cancelling', 'cancel_requested'),
];
const TO_ERROR: AppendInput[] = [
  ev.engineError('engine_exited', true),
  ev.state('idle', 'error', 'engine_exited'),
];
const TO_CLOSED: AppendInput[] = [ev.state('idle', 'closed', 'closed')];

interface Expected {
  state: SessionState;
  activeTurn?: boolean;
  pending?: ApprovalId[];
  lastError?: EngineErrorCategory;
}

interface Case {
  name: string;
  setup: AppendInput[];
  events: AppendInput[];
  expect: Expected;
}

const cases: Case[] = [
  { name: '#1 session.create → idle', setup: [], events: [], expect: { state: 'idle' } },
  {
    name: '#2 idle → running',
    setup: [],
    events: START,
    expect: { state: 'running', activeTurn: true },
  },
  {
    name: '#3 running → awaiting_approval',
    setup: START,
    events: TO_AWAITING.slice(START.length),
    expect: { state: 'awaiting_approval', activeTurn: true, pending: ['apr_1'] },
  },
  {
    name: '#3 再来一个审批时保持 awaiting_approval',
    setup: TO_AWAITING,
    events: [ev.approvalRequested('apr_2')],
    expect: { state: 'awaiting_approval', activeTurn: true, pending: ['apr_1', 'apr_2'] },
  },
  {
    name: '#4 awaiting_approval → running（最后一个审批被决定）',
    setup: TO_AWAITING,
    events: [
      ev.approvalResolved('apr_1', 'approved', 'user'),
      ev.state('awaiting_approval', 'running', 'approvals_settled'),
    ],
    expect: { state: 'running', activeTurn: true },
  },
  {
    name: '#5 running → cancelling',
    setup: START,
    events: [ev.state('running', 'cancelling', 'cancel_requested')],
    expect: { state: 'cancelling', activeTurn: true },
  },
  {
    name: '#5 awaiting_approval → cancelling（未决审批结为 cancelled）',
    setup: TO_AWAITING,
    events: [
      ev.approvalResolved('apr_1', 'cancelled', 'turn_cancelled'),
      ev.state('awaiting_approval', 'cancelling', 'cancel_requested'),
    ],
    expect: { state: 'cancelling', activeTurn: true },
  },
  {
    name: '#6 running → idle（end_turn，未收尾工具补 unknown）',
    setup: [...START, ev.toolStarted('call_1')],
    events: [
      ev.toolFinished('call_1', 'unknown'),
      ev.turnFinished('completed'),
      ev.state('running', 'idle', 'turn_finished'),
    ],
    expect: { state: 'idle' },
  },
  {
    name: '#7 running → idle（回合失败，lastError 保留到下一回合）',
    setup: START,
    events: [
      ev.engineError('missing_credentials', false, TURN),
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ],
    expect: { state: 'idle', lastError: 'missing_credentials' },
  },
  {
    name: '#8 cancelling → idle',
    setup: TO_CANCELLING,
    events: [ev.turnFinished('cancelled'), ev.state('cancelling', 'idle', 'turn_finished')],
    expect: { state: 'idle' },
  },
  {
    name: '#9 cancelling → error（取消无法确认）',
    setup: TO_CANCELLING,
    events: [
      ev.engineError('cancel_unconfirmed', true, TURN),
      ev.turnFinished('interrupted'),
      ev.state('cancelling', 'error', 'cancel_unconfirmed'),
    ],
    expect: { state: 'error', lastError: 'cancel_unconfirmed' },
  },
  ...(['running', 'awaiting_approval', 'cancelling'] as const).map(
    (from): Case => ({
      name: `#10 ${from} → error（dsh 进程退出）`,
      setup:
        from === 'running' ? START : from === 'awaiting_approval' ? TO_AWAITING : TO_CANCELLING,
      events: [
        ...(from === 'awaiting_approval'
          ? [ev.approvalResolved('apr_1', 'cancelled', 'engine_exited')]
          : []),
        ev.turnFinished('interrupted'),
        ev.engineError('engine_exited', true, TURN),
        ev.state(from, 'error', 'engine_exited'),
      ],
      expect: { state: 'error', lastError: 'engine_exited' },
    }),
  ),
  {
    name: '#10 idle → error（回合之间 dsh 退出）',
    setup: [],
    events: TO_ERROR,
    expect: { state: 'error', lastError: 'engine_exited' },
  },
  {
    name: '#11 idle → error（send 前自动 resume 失败）',
    setup: [],
    events: [
      ev.engineError('session_unavailable', true),
      ev.state('idle', 'error', 'resume_failed'),
    ],
    expect: { state: 'error', lastError: 'session_unavailable' },
  },
  {
    name: '#12 error → idle（resume 成功，清掉 lastError）',
    setup: TO_ERROR,
    events: [ev.state('error', 'idle', 'resumed')],
    expect: { state: 'idle' },
  },
  {
    name: '#12 closed → idle',
    setup: TO_CLOSED,
    events: [ev.state('closed', 'idle', 'resumed')],
    expect: { state: 'idle' },
  },
  {
    name: '#12 的反面：resume 失败，状态不变，记 lastError',
    setup: TO_CLOSED,
    events: [ev.engineError('session_unavailable', false)],
    expect: { state: 'closed', lastError: 'session_unavailable' },
  },
  { name: '#13 idle → closed', setup: [], events: TO_CLOSED, expect: { state: 'closed' } },
  {
    name: '#13 error → closed',
    setup: TO_ERROR,
    events: [ev.state('error', 'closed', 'closed')],
    expect: { state: 'closed', lastError: 'engine_exited' },
  },
  {
    name: '#14 awaiting_approval → closed（先取消、结算，再关闭）',
    setup: TO_AWAITING,
    events: [
      ev.approvalResolved('apr_1', 'cancelled', 'session_closed'),
      ev.state('awaiting_approval', 'cancelling', 'cancel_requested'),
      ev.turnFinished('cancelled'),
      ev.state('cancelling', 'idle', 'turn_finished'),
      ev.state('idle', 'closed', 'closed'),
    ],
    expect: { state: 'closed' },
  },
  ...(['running', 'awaiting_approval', 'cancelling'] as const).map(
    (from): Case => ({
      name: `#15 ${from} → idle（Host 非正常退出后重启）`,
      setup:
        from === 'running' ? START : from === 'awaiting_approval' ? TO_AWAITING : TO_CANCELLING,
      events: [
        ...(from === 'awaiting_approval'
          ? [ev.approvalResolved('apr_1', 'expired', 'host_restarted')]
          : []),
        ev.turnFinished('interrupted'),
        ev.state(from, 'idle', 'host_restarted'),
      ],
      expect: { state: 'idle' },
    }),
  ),
];

/** 快照字段、`sessions` 表缓存列、`approvals` 表三者一致。 */
function expectConsistent(storage: Storage, store: EventStore): SessionSnapshot {
  const snapshot = store.snapshot(SES);
  if (!snapshot) throw new Error('快照不存在');
  expect(SessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const { session } = snapshot;
  const row = storage.sessions.get(SES);
  expect(row).toMatchObject({
    title: session.title,
    titleSource: session.titleSource,
    state: session.state,
    lastSeq: session.lastSeq,
    updatedAt: session.updatedAt,
  });
  expect(row?.activeTurn).toEqual(session.activeTurn);
  expect(row?.lastError).toEqual(session.lastError);
  expect(storage.events.lastSeq(SES)).toBe(session.lastSeq);
  expect(storage.approvals.listBySession(SES, { status: 'pending' }).map((a) => a.id)).toEqual(
    snapshot.pendingApprovals.map((a) => a.id),
  );
  return snapshot;
}

describe('会话快照推导', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  it.each(cases)('$name', ({ setup, events, expect: expected }) => {
    const dir = dataDir();
    const storage = open(dir);
    const store = createStore(storage);
    if (setup.length > 0) store.appendMany(SES, setup);
    if (events.length > 0) store.appendMany(SES, events);

    const snapshot = expectConsistent(storage, store);
    expect(snapshot.session.state).toBe(expected.state);
    expect(snapshot.session.activeTurn !== undefined).toBe(expected.activeTurn ?? false);
    expect(snapshot.pendingApprovals.map((a) => a.id)).toEqual(expected.pending ?? []);
    expect(snapshot.session.lastError?.category).toBe(expected.lastError);
    expect(snapshot.session.lastSeq).toBe(1 + setup.length + events.length);

    // Host 重启后从事件重放，得到同样的快照。
    storage.close();
    const reopened = open(dir);
    expect(createStore(reopened).snapshot(SES)).toEqual(snapshot);
  });

  it('覆盖了状态机的每一条转换', () => {
    const covered = new Set(
      cases.flatMap(({ setup, events }) =>
        [...setup, ...events].flatMap((e) =>
          e.type === 'session.state_changed'
            ? [`${e.payload.from}>${e.payload.to}:${e.payload.reason}`]
            : [],
        ),
      ),
    );
    const all = SESSION_TRANSITIONS.flatMap((t) =>
      t.from.map((from) => `${from}>${t.to}:${t.reason}`),
    );
    expect(all.filter((edge) => !covered.has(edge))).toEqual([]);
  });

  it('快照的其余字段：身份取自会话行，标题、回合、待办、用量、更新时间取自事件', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    store.appendMany(SES, START);
    store.append(SES, ev.todo([{ content: '读 CSV', status: 'in_progress' }]));
    const last = store.append(SES, ev.usage(1200));

    const snapshot = expectConsistent(storage, store);
    expect(snapshot).toEqual({
      session: {
        id: SES,
        workspaceId: 'ws_1',
        cwd: '/home/u/project',
        engine: { kind: 'dsh', sessionId: `engine-${SES}` },
        providerId: 'deepseek-official',
        modelId: 'deepseek-chat',
        reasoningEffort: 'high',
        title: '写一个 summary.md',
        titleSource: 'first_prompt',
        state: 'running',
        activeTurn: {
          turnId: TURN,
          startedAt: snapshot.session.activeTurn?.startedAt,
          clientMessageId: 'msg-1',
        },
        createdAt: '2026-10-13T00:00:00.000Z',
        updatedAt: last.ts,
        lastSeq: 7,
      },
      pendingApprovals: [],
      todos: [{ content: '读 CSV', status: 'in_progress' }],
      usage: { contextUsed: 1200, contextSize: 262144 },
    });

    // 返回的是副本，改它不影响下一次快照。
    snapshot.pendingApprovals.push(snapshot.pendingApprovals[0] as never);
    snapshot.session.title = '改过';
    expect(store.snapshot(SES)?.session.title).toBe('写一个 summary.md');
  });

  it('下一回合开始时清掉上一回合的 lastError；没有 clientMessageId 时 activeTurn 也不带', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    store.appendMany(SES, [
      ...START,
      ev.engineError('missing_credentials', false, TURN),
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    expect(store.snapshot(SES)?.session.lastError?.category).toBe('missing_credentials');
    store.appendMany(SES, [
      ev.user(TURN2),
      ev.turnStarted(TURN2),
      ev.state('idle', 'running', 'turn_started'),
    ]);
    const { session } = expectConsistent(storage, store);
    expect(session.lastError).toBeUndefined();
    expect(session.activeTurn).toEqual({ turnId: TURN2, startedAt: session.updatedAt });
  });
});

describe('写入前的校验', () => {
  const dataDir = useTempDir();
  const { open } = useStorages();

  const rejected: Array<[string, AppendInput[], AppendInput]> = [
    ['第二条 session.created', [], ev.created()],
    ['from 不是当前状态', [], ev.state('running', 'idle', 'turn_finished')],
    ['不在状态机里的转换', [], ev.state('idle', 'cancelling', 'cancel_requested')],
    ['原因不对', [], ev.state('idle', 'running', 'resumed')],
    ['回合重叠', [ev.turnStarted()], ev.turnStarted(TURN2)],
    ['结束的不是当前回合', [ev.turnStarted()], ev.turnFinished('completed', TURN2)],
    ['结算不存在的审批', [], ev.approvalResolved('apr_x', 'approved', 'user')],
    [
      '重复结算',
      [ev.approvalRequested('apr_1'), ev.approvalResolved('apr_1', 'denied', 'user')],
      ev.approvalResolved('apr_1', 'approved', 'user'),
    ],
  ];

  it.each(rejected)('%s', (_name, before, input) => {
    const storage = open(dataDir());
    const store = createStore(storage);
    if (before.length > 0) store.appendMany(SES, before);
    const lastSeq = storage.events.lastSeq(SES);
    expect(() => store.append(SES, input)).toThrow(EventRejectedError);
    expect(storage.events.lastSeq(SES)).toBe(lastSeq);
  });

  it('第一条事件必须是 session.created', () => {
    const storage = open(dataDir());
    seedSession(storage);
    const store = new EventStore({ storage });
    expect(() => store.append(SES, ev.usage(1))).toThrow(EventRejectedError);
    expect(storage.events.lastSeq(SES)).toBe(0);
  });

  it('新审批必须是 pending 且属于本会话', () => {
    const storage = open(dataDir());
    const store = createStore(storage);
    const notPending = ev.approvalRequested('apr_1');
    notPending.payload.approval.status = 'approved';
    expect(() => store.append(SES, notPending)).toThrow(EventRejectedError);
    const otherSession = ev.approvalRequested('apr_2');
    otherSession.payload.approval.sessionId = 'ses_other';
    expect(() => store.append(SES, otherSession)).toThrow(EventRejectedError);
  });

  it('isAllowedTransition 与状态机表一致', () => {
    const reasons = new Set<StateChangeReason>(SESSION_TRANSITIONS.map((t) => t.reason));
    expect(isAllowedTransition('idle', 'running', 'turn_started')).toBe(true);
    expect(isAllowedTransition('closed', 'running', 'turn_started')).toBe(false);
    expect(reasons.size).toBe(11);
  });

  it('applyEvent 不校验：重放时不认识的事件只推进 lastSeq', () => {
    const unknown = {
      seq: 1,
      sessionId: SES,
      ts: '2026-10-13T00:00:00.000Z',
      type: 'session.renamed',
      source: 'host',
      payload: {},
    } as never;
    expect(applyEvent(INITIAL_PROJECTION, unknown)).toEqual({
      ...INITIAL_PROJECTION,
      lastSeq: 1,
      updatedAt: '2026-10-13T00:00:00.000Z',
    });
  });
});
