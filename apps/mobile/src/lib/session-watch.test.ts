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
import { describe, expect, it, vi } from 'vitest';
import { approval } from './bot-test-utils';
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
