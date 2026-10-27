import type { EventSubscription, SubscriptionItem } from '@wevir/client-sdk';
import type {
  ApprovalRequest,
  Session,
  SessionId,
  TurnId,
  WevirEvent,
  WevirEventPayload,
  WevirEventType,
} from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalNotVerifiedError, setApprovalGate } from './approval-gate';
import { approval } from './bot-test-utils';
import type { SessionCache } from './cache';
import { sessionItems } from './session-items';
import { type SessionClient, type SessionView, SessionWatch } from './session-watch';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' as TurnId;

function events(): WevirEvent[] {
  const list: WevirEvent[] = [];
  const add = <T extends WevirEventType>(type: T, payload: WevirEventPayload<T>) => {
    list.push({
      seq: list.length + 1,
      sessionId: SES,
      ts: new Date(Date.UTC(2026, 9, 24, 8, 0, list.length)).toISOString(),
      type,
      source: 'host',
      payload,
    } as WevirEvent);
  };
  add('session.created', {
    workspaceId: 'wsp_01JA2B3C4D5E6F7G8H9JKMNPQR',
    cwd: '/tmp/w',
    providerId: 'echo',
    modelId: 'echo',
  } as never);
  add('user.message', { turnId: TURN, content: [{ type: 'text', text: '修登录页' }] } as never);
  add('turn.started', { turnId: TURN } as never);
  add('assistant.message', {
    turnId: TURN,
    messageId: 'm1',
    text: '先跑测试。',
    replaces: [],
  } as never);
  add('tool.started', {
    turnId: TURN,
    toolCallId: 'call_1',
    toolName: 'shell',
    display: { kind: 'shell', command: 'pnpm test' },
    input: {},
  } as never);
  add('tool.finished', { turnId: TURN, toolCallId: 'call_1', status: 'failed' } as never);
  add('approval.requested', {
    approval: approval({ sessionId: SES, turnId: TURN, toolCallId: 'call_2' }),
  } as never);
  return list;
}

/** 假的订阅：按给的条目依次产出，`close()` 后结束。 */
function feed(items: SubscriptionItem[]): EventSubscription & { closed: boolean } {
  let index = 0;
  const sub = {
    sessionId: SES,
    lastSeq: 0,
    caughtUp: false,
    closed: false,
    close() {
      sub.closed = true;
    },
    async next(): Promise<IteratorResult<SubscriptionItem, undefined>> {
      const item = items[index++];
      if (sub.closed || item === undefined) return { done: true, value: undefined };
      return { done: false, value: item };
    },
    async return() {
      sub.closed = true;
      return { done: true as const, value: undefined };
    },
    async throw(error: unknown): Promise<IteratorResult<SubscriptionItem, undefined>> {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return sub;
    },
  };
  return sub as unknown as EventSubscription & { closed: boolean };
}

function client(items: SubscriptionItem[]) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const subscription = feed(items);
  const sessions: SessionClient = {
    canWrite: true,
    request: (async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === 'session.get')
        return { session: { id: SES, title: '修登录页', state: 'awaiting_approval' } as Session };
      return {};
    }) as SessionClient['request'],
    subscribe: () => subscription,
  };
  return { sessions, requests, subscription };
}

describe('SessionWatch', () => {
  it('读快照、回放事件，回放完给出消息流与待批准的审批', async () => {
    const list = events();
    const { sessions } = client([
      ...list.map((event) => ({ type: 'event' as const, event })),
      { type: 'caught_up', seq: list.length },
    ]);
    const views: SessionView[] = [];
    const watch = new SessionWatch(sessions, SES, (view) => views.push(view));
    await watch.start();
    expect(watch.view.error).toBeUndefined();
    await vi.waitFor(() => expect(watch.view.caughtUp).toBe(true));
    expect(watch.view.session?.title).toBe('修登录页');
    const items = sessionItems(watch.view.transcript as never, '图片');
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'approval']);
    expect(items[2]).toMatchObject({ label: 'shell · pnpm test', state: 'failed' });
    expect(items[3]).toMatchObject({
      kind: 'approval',
      post: { card: { kind: 'approval', tool: 'gmail · send_email', decision: 'pending' } },
    });
    watch.stop();
  });

  it('批准选“仅这一次”，拒绝选拒绝', async () => {
    const list = events();
    const { sessions, requests } = client([
      ...list.map((event) => ({ type: 'event' as const, event })),
      { type: 'caught_up', seq: list.length },
    ]);
    const watch = new SessionWatch(sessions, SES, () => {});
    await watch.start();
    const id = (approval() as ApprovalRequest).id;
    await watch.respond(id, 'approved');
    await watch.respond(id, 'rejected');
    expect(requests.filter((r) => r.method === 'approval.respond').map((r) => r.params)).toEqual([
      { approvalId: id, optionId: 'once' },
      { approvalId: id, optionId: 'no' },
    ]);
  });

  it('读不到会话时给出错误，停下后关掉订阅', async () => {
    const failing: SessionClient = {
      canWrite: true,
      request: (async () => {
        throw new Error('SESSION_NOT_FOUND');
      }) as SessionClient['request'],
      subscribe: () => feed([]),
    };
    const watch = new SessionWatch(failing, SES, () => {});
    await watch.start();
    expect(watch.view.error).toBeInstanceOf(Error);

    const { sessions, subscription } = client([]);
    const second = new SessionWatch(sessions, SES, () => {});
    await second.start();
    second.stop();
    expect(subscription.closed).toBe(true);
  });
});

/** 内存里的缓存（真机是加密的 SQLite，cache.ts）。 */
function memoryCache(): SessionCache & {
  conversations: Map<string, { session: Session; events: readonly WevirEvent[] }>;
} {
  const conversations = new Map<string, { session: Session; events: readonly WevirEvent[] }>();
  return {
    conversations,
    loadSessions: async () => undefined,
    saveSessions: async () => {},
    loadConversation: async (id) => {
      const saved = conversations.get(id);
      return saved === undefined
        ? undefined
        : {
            session: saved.session,
            events: [...saved.events],
            savedAt: '2026-10-27T08:00:00.000Z',
            truncated: false,
          };
    },
    saveConversation: async (id, conversation) => {
      conversations.set(id, conversation);
    },
  };
}

describe('SessionWatch 的本地缓存', () => {
  let offGate: (() => void) | undefined;
  afterEach(() => offGate?.());

  it('回放完存进缓存；离线时从缓存显示，不带待批准，也不能作答', async () => {
    const list = events();
    const cache = memoryCache();
    const { sessions } = client([
      ...list.map((event) => ({ type: 'event' as const, event })),
      { type: 'caught_up', seq: list.length },
    ]);
    const online = new SessionWatch(sessions, SES, () => {}, cache);
    await online.start();
    online.stop();
    expect(cache.conversations.get(SES)?.events).toHaveLength(list.length);

    const views: SessionView[] = [];
    const offline = new SessionWatch(undefined, SES, (view) => views.push(view), cache);
    await offline.start();
    expect(offline.view).toMatchObject({
      offline: true,
      caughtUp: true,
      cachedAt: '2026-10-27T08:00:00.000Z',
    });
    const items = sessionItems(offline.view.transcript as never, '图片');
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool']);
    await offline.respond((approval() as ApprovalRequest).id, 'approved');
  });

  it('有缓存时先显示缓存，连上回放完再换成最新的', async () => {
    const list = events();
    const cache = memoryCache();
    cache.conversations.set(SES, {
      session: { id: SES, title: '旧标题' } as Session,
      events: list.slice(0, 4),
    });
    const { sessions } = client([
      ...list.map((event) => ({ type: 'event' as const, event })),
      { type: 'caught_up', seq: list.length },
    ]);
    const views: SessionView[] = [];
    const watch = new SessionWatch(sessions, SES, (view) => views.push({ ...view }), cache);
    await watch.start();
    expect(views[0]).toMatchObject({ cachedAt: '2026-10-27T08:00:00.000Z', caughtUp: true });
    // 回放期间不出半截的投影：只有缓存那一版与回放完的一版带消息流。
    const withTranscript = views.filter((v) => v.transcript !== undefined);
    expect(withTranscript.map((v) => v.cachedAt !== undefined)).toEqual([true, true, false]);
    expect(watch.view.cachedAt).toBeUndefined();
    expect(watch.view.transcript?.pendingApprovals).toHaveLength(1);
    watch.stop();
  });

  it('高风险的批准先验证本人', async () => {
    const list = events();
    const last = list.at(-1) as WevirEvent & { payload: { approval: ApprovalRequest } };
    last.payload.approval = {
      ...last.payload.approval,
      risk: { level: 'high', reasons: ['destructive_command'] },
    };
    const { sessions, requests } = client([
      ...list.map((event) => ({ type: 'event' as const, event })),
      { type: 'caught_up', seq: list.length },
    ]);
    const watch = new SessionWatch(sessions, SES, () => {});
    await watch.start();
    const id = last.payload.approval.id;
    await expect(watch.respond(id, 'approved')).rejects.toBeInstanceOf(ApprovalNotVerifiedError);
    offGate = setApprovalGate(async () => true);
    await watch.respond(id, 'approved');
    await watch.respond(id, 'rejected');
    expect(requests.filter((r) => r.method === 'approval.respond')).toHaveLength(2);
  });
});
