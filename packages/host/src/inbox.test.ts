// 收件箱（0.103.0）：InboxService 从事件、审批表与自动化的运行算出等用户处理的事，100 ms 合一批推变化，收起落库，重启后重建。

import type {
  ApprovalId,
  Automation,
  AutomationRun,
  NotificationParams,
  QuestionId,
  SessionId,
} from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from './event-store.js';
import { INBOX_WINDOW_MS, type InboxChange, InboxService, needsAttention } from './inbox.js';
import {
  approval,
  createStore,
  ev,
  type Input,
  SES,
  SES2,
  TURN,
  TURN2,
  useStorages,
  useTempDir,
} from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const START = 5_000;
const NOW = Date.parse('2026-10-22T08:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeAutomations(initial: Automation[] = []) {
  let automations = initial;
  const listeners = new Set<(change: NotificationParams<'automation.changed'>) => void>();
  return {
    list: () => automations,
    watch(listener: (change: NotificationParams<'automation.changed'>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Automation[], automationId: string) {
      automations = next;
      for (const listener of listeners) listener({ automationId: automationId as never });
    },
  };
}

function setup(options: { automations?: ReturnType<typeof fakeAutomations>; dir?: string } = {}) {
  const storage = storages.open(options.dir ?? tempDir());
  const events = createStore(storage, { deltaWindowMs: 0 }, [SES, SES2]);
  const inbox = new InboxService({
    storage,
    events,
    ...(options.automations !== undefined && { automations: options.automations }),
    secrets: () => ['hunter2-connector-token'],
    startVersion: START,
  });
  inbox.start();
  const changes: InboxChange[] = [];
  inbox.watch((change) => changes.push(change));
  const flush = () => {
    vi.advanceTimersByTime(INBOX_WINDOW_MS);
    return changes.splice(0);
  };
  return { storage, events, inbox, flush };
}

function startTurn(events: EventStore, sessionId: SessionId = SES, turnId = TURN): void {
  events.appendMany(sessionId, [
    ev.user(turnId),
    ev.turnStarted(turnId),
    ev.state('idle', 'running', 'turn_started'),
  ]);
}

function questionRequested(
  id: QuestionId,
  sessionId: SessionId = SES,
): Input<'question.requested'> {
  return {
    type: 'question.requested',
    source: 'engine',
    payload: {
      question: {
        id,
        sessionId,
        turnId: TURN,
        questions: [
          {
            id: 'scope',
            header: '范围',
            question: '用 sk-abcdefghijklmnopqrstuvwxyz012345 还是 hunter2-connector-token？',
            options: [{ label: '前者' }, { label: '后者', description: '更慢' }],
          },
        ],
        status: 'pending',
        createdAt: '2026-10-22T07:59:00.000Z',
      },
    },
  };
}

function approvalIn(sessionId: SessionId, id: ApprovalId): Input<'approval.requested'> {
  return {
    type: 'approval.requested',
    source: 'engine',
    payload: { approval: { ...approval(id), sessionId } },
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPQR',
    automationId: 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR',
    trigger: 'schedule',
    status: 'failed',
    startedAt: '2026-10-22T07:00:00.000Z',
    finishedAt: '2026-10-22T07:01:00.000Z',
    error: 'provider is gone',
    ...overrides,
  };
}

function automation(lastRun: AutomationRun | undefined, notify: Automation['notify']): Automation {
  return {
    id: 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR',
    title: '每天看一眼 CI',
    prompt: '看看 CI',
    schedule: { kind: 'manual' },
    timezone: 'Asia/Shanghai',
    enabled: true,
    providerId: 'deepseek-official',
    permissionMode: 'on_request',
    newSessionEachRun: true,
    notify,
    createdBy: { kind: 'user' },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    runCount: 1,
    ...(lastRun !== undefined && { lastRun }),
  } as Automation;
}

describe('InboxService', () => {
  it('审批与提问进出收件箱；每批版本加一', () => {
    const { events, inbox, flush } = setup();
    expect(inbox.list()).toEqual([]);
    expect(inbox.version).toBe(START);

    startTurn(events);
    expect(flush()).toEqual([]);
    events.appendMany(SES, [
      ev.approvalRequested('apr_1'),
      ev.state('running', 'awaiting_approval', 'approval_requested'),
      questionRequested('qst_1'),
    ]);
    const [added] = flush();
    expect(added?.inboxVersion).toBe(START + 1);
    expect(added?.removed).toEqual([]);
    expect(added?.upserted.map((item) => item.id).sort()).toEqual([
      'approval:apr_1',
      'question:qst_1',
    ]);
    const approvalItem = inbox.list().find((item) => item.kind === 'approval');
    expect(approvalItem).toMatchObject({
      sessionId: SES,
      summary: '/tmp/out.txt',
      ref: { approvalId: 'apr_1', turnId: TURN, options: approval('apr_1').options },
    });

    events.appendMany(SES, [
      ev.approvalResolved('apr_1', 'denied', 'user'),
      {
        type: 'question.resolved',
        source: 'host',
        payload: {
          questionId: 'qst_1',
          status: 'cancelled',
          resolution: { reason: 'turn_cancelled' },
        },
      },
    ]);
    expect(flush()).toEqual([
      { inboxVersion: START + 2, upserted: [], removed: ['approval:apr_1', 'question:qst_1'] },
    ]);
    expect(inbox.list()).toEqual([]);
  });

  it('说明打码、截断；提问带问题与选项', () => {
    const { events, inbox, flush } = setup();
    startTurn(events);
    events.append(SES, questionRequested('qst_1'));
    flush();
    const [item] = inbox.list();
    expect(item?.summary).toBe('用 [REDACTED] 还是 [REDACTED]？');
    expect(item).toMatchObject({
      kind: 'question',
      ref: {
        questionId: 'qst_1',
        questions: [
          { id: 'scope', header: '范围', options: [{ label: '前者' }, { label: '后者' }] },
        ],
      },
    });
    expect(JSON.stringify(item)).not.toContain('hunter2');
  });

  it('失败回合：新回合开始就离开；收起落库、推移除；审批不能收起', () => {
    const { events, inbox, flush, storage } = setup();
    startTurn(events);
    events.appendMany(SES, [
      ev.engineError('provider', true, TURN),
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    const [failed] = flush();
    expect(failed?.upserted).toMatchObject([
      { id: `turn_failed:${TURN}`, kind: 'turn_failed', ref: { turnId: TURN } },
    ]);

    startTurn(events, SES, TURN2);
    expect(flush()).toMatchObject([{ removed: [`turn_failed:${TURN}`] }]);

    events.appendMany(SES, [
      ev.turnFinished('failed', TURN2),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    flush();
    inbox.dismiss(`turn_failed:${TURN2}`);
    expect(flush()).toMatchObject([{ upserted: [], removed: [`turn_failed:${TURN2}`] }]);
    expect(storage.inbox.dismissed()).toEqual(new Set([`turn_failed:${TURN2}`]));
    expect(inbox.list()).toEqual([]);
    // 已不在收件箱的：什么都不做。
    inbox.dismiss(`turn_failed:${TURN}`);
    expect(() => inbox.dismiss('approval:apr_1')).toThrow(/cannot be dismissed/);
  });

  it('dismiss 立即推一批移除', () => {
    const { events, inbox, flush } = setup();
    const changes: InboxChange[] = [];
    inbox.watch((change) => changes.push(change));
    startTurn(events);
    events.appendMany(SES, [
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    flush();
    changes.length = 0;
    inbox.dismiss(`turn_failed:${TURN}`);
    expect(changes).toEqual([
      { inboxVersion: START + 2, upserted: [], removed: [`turn_failed:${TURN}`] },
    ]);
  });

  it('归档、删除会话时项一起离开', () => {
    const { events, inbox, flush, storage } = setup();
    startTurn(events);
    startTurn(events, SES2);
    events.appendMany(SES, [
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    events.appendMany(SES2, [approvalIn(SES2, 'apr_2')]);
    flush();
    expect(inbox.list()).toHaveLength(2);

    storage.sessions.setArchived(SES, '2026-10-22T08:00:00.000Z');
    events.touch([SES]);
    expect(flush()).toMatchObject([{ removed: [`turn_failed:${TURN}`] }]);

    storage.sessions.remove([SES2]);
    events.forget([SES2]);
    expect(flush()).toMatchObject([{ removed: ['approval:apr_2'] }]);
  });

  it('重启后从事件与审批表重建，减去收起的，删掉过时的收起记录', () => {
    const dir = tempDir();
    const first = setup({ dir });
    startTurn(first.events);
    first.events.appendMany(SES, [
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    startTurn(first.events, SES2);
    first.events.appendMany(SES2, [approvalIn(SES2, 'apr_2'), questionRequested('qst_2', SES2)]);
    first.flush();
    first.storage.inbox.dismiss('automation:arn_gone', '2026-10-01T00:00:00.000Z');
    first.inbox.close();

    const second = setup({ dir });
    expect(
      second.inbox
        .list()
        .map((item) => item.id)
        .sort(),
    ).toEqual(['approval:apr_2', 'question:qst_2', `turn_failed:${TURN}`]);
    second.inbox.dismiss(`turn_failed:${TURN}`);
    second.inbox.close();

    const third = setup({ dir });
    expect(
      third.inbox
        .list()
        .map((item) => item.kind)
        .sort(),
    ).toEqual(['approval', 'question']);
    expect(third.storage.inbox.dismissed()).toEqual(new Set([`turn_failed:${TURN}`]));
  });

  it('失败回合与自动化项超过 7 天不列出', () => {
    const { events, inbox, flush } = setup();
    startTurn(events);
    events.appendMany(SES, [
      ev.turnFinished('failed'),
      ev.state('running', 'idle', 'turn_finished'),
    ]);
    flush();
    expect(inbox.list()).toHaveLength(1);
    vi.setSystemTime(NOW + 8 * 24 * 60 * 60 * 1000);
    expect(inbox.list()).toEqual([]);
    expect(inbox.items()).toHaveLength(1);
  });

  it('自动化：失败与要提醒的完成进，下一次运行开始或删除时离开', () => {
    const automations = fakeAutomations([automation(run(), 'important')]);
    const { inbox, flush } = setup({ automations });
    expect(inbox.list()).toMatchObject([
      {
        id: 'automation:arn_01JA2B3C4D5E6F7G8H9JKMNPQR',
        kind: 'automation',
        title: '每天看一眼 CI',
        summary: 'provider is gone',
        createdAt: '2026-10-22T07:01:00.000Z',
        ref: { status: 'failed' },
      },
    ]);

    const next = run({
      id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPQS',
      status: 'running',
      startedAt: '2026-10-22T08:00:00.000Z',
    });
    delete next.finishedAt;
    automations.set([automation(next, 'important')], 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR');
    expect(flush()).toMatchObject([{ removed: ['automation:arn_01JA2B3C4D5E6F7G8H9JKMNPQR'] }]);

    const done = run({ ...next, status: 'completed', summary: '一切正常', quiet: true });
    automations.set([automation(done, 'important')], 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR');
    expect(flush()).toEqual([]);
    automations.set([automation(done, 'always')], 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR');
    expect(flush()).toMatchObject([
      { upserted: [{ summary: '一切正常', ref: { status: 'completed' } }] },
    ]);
    automations.set([], 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR');
    expect(flush()).toMatchObject([{ removed: ['automation:arn_01JA2B3C4D5E6F7G8H9JKMNPQS'] }]);
  });

  it('needsAttention 照自动化的通知设置', () => {
    expect(needsAttention('never', run())).toBe(false);
    expect(needsAttention('failures', run())).toBe(true);
    expect(needsAttention('failures', run({ status: 'completed' }))).toBe(false);
    expect(needsAttention('changes', run({ status: 'completed', unchanged: true }))).toBe(false);
    expect(needsAttention('always', run({ status: 'waiting' }))).toBe(false);
  });
});
