// 通知意图（0.106.0）：NotificationService 从收件箱的新项、回合完成与自动化的等待判定要不要提醒，规则同此前桌面的 notificationKind 与
// 自动化提醒；按 Host 设置的种类开关过滤；重启前的事与旧事不提醒。

import {
  type ApprovalId,
  type Automation,
  type AutomationRun,
  type HostSettings,
  NOTIFICATION_MAX_AGE_MS,
  type NotificationIntent,
  type NotificationParams,
  type SessionId,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from './event-store.js';
import { INBOX_WINDOW_MS, InboxService } from './inbox.js';
import { firstSentence, NotificationService } from './notifications.js';
import {
  approval,
  createStore,
  ev,
  type Input,
  SES,
  SES2,
  seedSession,
  TURN,
  TURN2,
  useStorages,
  useTempDir,
} from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const NOW = Date.parse('2026-10-22T08:00:00.000Z');
const CHILD: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQT';
const SIDE: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQV';
const AUTO: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQW';
const RUN = 'arn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const AUTOMATION = 'aut_01JA2B3C4D5E6F7G8H9JKMNPQR';

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
    /** 换掉自动化列表，发一条带运行的变化（同 AutomationService）。 */
    set(next: Automation[], run?: AutomationRun) {
      automations = next;
      for (const listener of listeners) {
        listener({ automationId: AUTOMATION as never, ...(run !== undefined && { run }) });
      }
    },
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: RUN,
    automationId: AUTOMATION,
    trigger: 'schedule',
    status: 'running',
    startedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  } as AutomationRun;
}

function automation(lastRun: AutomationRun | undefined, notify: Automation['notify']): Automation {
  return {
    id: AUTOMATION,
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
    workspaceId: 'ws_1',
    ...(lastRun !== undefined && { lastRun }),
  } as Automation;
}

/** 子会话、支线与自动化开的会话：会话行带上这些字段。 */
function seedSpecialSessions(storage: Storage): void {
  seedSession(storage, SES);
  const base = storage.sessions.get(SES);
  if (base === undefined) throw new Error('no base session');
  const { archivedAt: _archived, ...row } = base;
  const engineSessionId = (id: SessionId) => `engine-${id}`;
  storage.sessions.insert({
    ...row,
    id: CHILD,
    engineSessionId: engineSessionId(CHILD),
    parentSessionId: SES,
    parentToolCallId: 'call_1',
  });
  storage.sessions.insert({
    ...row,
    id: SIDE,
    engineSessionId: engineSessionId(SIDE),
    side: true,
    forkedFrom: { sessionId: SES },
  });
  storage.sessions.insert({
    ...row,
    id: AUTO,
    engineSessionId: engineSessionId(AUTO),
    origin: { kind: 'automation', automationId: AUTOMATION, runId: RUN },
  });
}

function setup(
  options: {
    automations?: ReturnType<typeof fakeAutomations>;
    settings?: HostSettings;
    storage?: Storage;
  } = {},
) {
  const storage = options.storage ?? storages.open(tempDir());
  if (options.storage === undefined) seedSpecialSessions(storage);
  const events = createStore(storage, { deltaWindowMs: 0 }, [SES, SES2, CHILD, SIDE, AUTO]);
  events.append(SES, ev.title('修登录页'));
  const inbox = new InboxService({
    storage,
    events,
    ...(options.automations !== undefined && { automations: options.automations }),
  });
  inbox.start();
  let settings: HostSettings = options.settings ?? { sendWhileBusy: 'steer' };
  const service = new NotificationService({
    storage,
    events,
    inbox,
    ...(options.automations !== undefined && { automations: options.automations }),
    settings: () => settings,
    onError: (error) => {
      throw error;
    },
  });
  service.start();
  const intents: NotificationIntent[] = [];
  service.watch((intent) => intents.push(intent));
  const flush = () => {
    vi.advanceTimersByTime(INBOX_WINDOW_MS);
    return intents.splice(0);
  };
  const setSettings = (next: HostSettings) => {
    settings = next;
  };
  return { storage, events, inbox, service, flush, setSettings };
}

function startTurn(events: EventStore, sessionId: SessionId = SES, turnId = TURN): void {
  events.appendMany(sessionId, [
    ev.user(turnId),
    ev.turnStarted(turnId),
    ev.state('idle', 'running', 'turn_started'),
  ]);
}

function finishTurn(
  events: EventStore,
  outcome: 'completed' | 'failed',
  sessionId: SessionId = SES,
  turnId = TURN,
): void {
  events.appendMany(sessionId, [
    ev.turnFinished(outcome, turnId),
    ev.state('running', 'idle', 'turn_finished'),
  ]);
}

/** 现在发起的审批（`approval()` 的 createdAt 是很久以前）。 */
function approvalIn(
  sessionId: SessionId,
  id: ApprovalId,
  createdAt = new Date(NOW).toISOString(),
): Input<'approval.requested'> {
  return {
    type: 'approval.requested',
    source: 'engine',
    payload: { approval: { ...approval(id), sessionId, createdAt } },
  };
}

function questionIn(sessionId: SessionId): Input<'question.requested'> {
  return {
    type: 'question.requested',
    source: 'engine',
    payload: {
      question: {
        id: 'qst_1',
        sessionId,
        turnId: TURN,
        questions: [{ id: 'scope', question: '做到哪一步？', options: [{ label: '全链路' }] }],
        status: 'pending',
        createdAt: new Date(NOW).toISOString(),
      },
    },
  };
}

describe('NotificationService', () => {
  it('审批、提问、失败与完成各产生一条意图；同一件事只发一次', () => {
    const { events, flush } = setup();
    startTurn(events);
    events.append(SES, approvalIn(SES, 'apr_1'));
    expect(flush()).toEqual([
      {
        id: 'approval:apr_1',
        kind: 'approval',
        sessionId: SES,
        workspaceId: 'ws_1',
        title: '修登录页',
        body: '/tmp/out.txt',
        createdAt: new Date(NOW).toISOString(),
        collapseKey: `session:${SES}`,
      },
    ]);
    // 收件箱的项内容变了会再推（标题变了），意图不再发。
    events.append(SES, ev.title('修登录页（二）'));
    expect(flush()).toEqual([]);

    events.append(SES, questionIn(SES));
    expect(flush()).toMatchObject([
      { id: 'question:qst_1', kind: 'question', body: '做到哪一步？' },
    ]);

    finishTurn(events, 'failed');
    expect(flush()).toMatchObject([{ id: `turn_failed:${TURN}`, kind: 'failed' }]);

    startTurn(events, SES, TURN2);
    finishTurn(events, 'completed', SES, TURN2);
    expect(flush()).toMatchObject([
      { id: `completed:${TURN2}`, kind: 'completed', body: '', sessionId: SES },
    ]);
  });

  it('回合收了尾（0.128.0）：完成的正文是要用户做的决定，没有就是回顾的第一句', () => {
    const { events, flush } = setup();
    startTurn(events);
    events.append(SES, {
      type: 'turn.wrap_up',
      source: 'host',
      payload: { turnId: TURN, recap: '测试全部通过。还没提交。' },
    });
    finishTurn(events, 'completed');
    expect(flush()).toMatchObject([{ kind: 'completed', body: '测试全部通过。' }]);

    startTurn(events, SES, TURN2);
    events.append(SES, {
      type: 'turn.wrap_up',
      source: 'host',
      payload: {
        turnId: TURN2,
        recap: 'Tests pass. Not committed yet.',
        ask: '要提交吗？',
        actions: [{ label: '提交', message: '提交。' }],
        blocked: true,
      },
    });
    finishTurn(events, 'completed', SES, TURN2);
    expect(flush()).toMatchObject([{ kind: 'completed', body: '要提交吗？' }]);
  });

  it('firstSentence 取到第一个句末标点', () => {
    expect(firstSentence('Tests pass. Not committed.')).toBe('Tests pass.');
    expect(firstSentence('版本 0.128.0 已发布，测试通过。还差文档。')).toBe(
      '版本 0.128.0 已发布，测试通过。',
    );
    expect(firstSentence('没有句号')).toBe('没有句号');
  });

  it('关掉的种类不产生意图，其余照旧', () => {
    const { events, flush, setSettings } = setup({
      settings: { sendWhileBusy: 'steer', notifications: { approval: false, completed: false } },
    });
    startTurn(events);
    events.append(SES, approvalIn(SES, 'apr_1'));
    finishTurn(events, 'completed');
    expect(flush()).toEqual([]);
    startTurn(events, SES, TURN2);
    events.append(SES, questionIn(SES));
    expect(flush()).toMatchObject([{ kind: 'question' }]);

    setSettings({ sendWhileBusy: 'steer', notifications: {} });
    events.append(SES, approvalIn(SES, 'apr_2'));
    expect(flush()).toMatchObject([{ id: 'approval:apr_2' }]);
  });

  it('子会话、支线、自动化开的会话与归档的会话不按会话提醒', () => {
    const { events, storage, inbox, flush } = setup();
    for (const sessionId of [CHILD, SIDE, AUTO]) {
      startTurn(events, sessionId);
      events.append(sessionId, approvalIn(sessionId, `apr_${sessionId.slice(-1)}` as ApprovalId));
      finishTurn(events, 'completed', sessionId);
    }
    expect(flush()).toEqual([]);
    // 收件箱里有它们，只是不提醒。
    expect(
      inbox
        .items()
        .map((item) => item.id)
        .sort(),
    ).toEqual(['approval:apr_T', 'approval:apr_V', 'approval:apr_W']);

    storage.sessions.setArchived(SES2, new Date(NOW).toISOString());
    events.touch([SES2]);
    startTurn(events, SES2);
    events.append(SES2, approvalIn(SES2, 'apr_9'));
    finishTurn(events, 'completed', SES2);
    expect(flush()).toEqual([]);
  });

  it('事发超过两分钟的不提醒（取消归档后重新出现的旧审批）', () => {
    const { events, flush } = setup();
    startTurn(events);
    const old = new Date(NOW - NOTIFICATION_MAX_AGE_MS - 1).toISOString();
    events.append(SES, approvalIn(SES, 'apr_old', old));
    expect(flush()).toEqual([]);
  });

  it('Host 重启：重建出来的项不产生意图，之后的新事照常', () => {
    const dir = tempDir();
    const storage = storages.open(dir);
    seedSpecialSessions(storage);
    const first = setup({ storage });
    startTurn(first.events);
    first.events.append(SES, approvalIn(SES, 'apr_1'));
    first.flush();
    first.service.close();
    first.inbox.close();
    first.events.close();

    const second = setup({ storage });
    second.flush();
    expect(second.inbox.items().map((item) => item.id)).toContain('approval:apr_1');
    second.events.append(SES, approvalIn(SES, 'apr_2'));
    expect(second.flush().map((intent) => intent.id)).toEqual(['approval:apr_2']);
  });

  it('自动化：等待处理、失败与要提醒的完成按通知策略产生 automation 意图', () => {
    const automations = fakeAutomations([automation(undefined, 'important')]);
    const { flush, setSettings } = setup({ automations });
    const waiting = run({ status: 'waiting', sessionId: AUTO });
    automations.set([automation(waiting, 'important')], waiting);
    // 同一次运行再进 waiting 不再提醒。
    automations.set([automation(waiting, 'important')], waiting);
    expect(flush()).toEqual([
      {
        id: `automation:${RUN}:waiting`,
        kind: 'automation',
        sessionId: AUTO,
        workspaceId: 'ws_1',
        automationId: AUTOMATION,
        automationStatus: 'waiting',
        title: '每天看一眼 CI',
        body: '',
        createdAt: new Date(NOW).toISOString(),
        collapseKey: `session:${AUTO}`,
      },
    ]);

    const failed = run({
      status: 'failed',
      sessionId: AUTO,
      finishedAt: new Date(NOW).toISOString(),
      error: 'provider is gone',
    });
    automations.set([automation(failed, 'important')], failed);
    expect(flush()).toMatchObject([
      { id: `automation:${RUN}`, automationStatus: 'failed', body: 'provider is gone' },
    ]);

    // important：Agent 标了无事可报的完成不提醒；关掉 automation 后什么都不发。
    const quiet = run({
      id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPQS',
      status: 'completed',
      finishedAt: new Date(NOW).toISOString(),
      quiet: true,
    });
    automations.set([automation(quiet, 'important')], quiet);
    expect(flush()).toEqual([]);
    setSettings({ sendWhileBusy: 'steer', notifications: { automation: false } });
    const again = run({ id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPQT', status: 'waiting' });
    automations.set([automation(again, 'important')], again);
    expect(flush()).toEqual([]);
  });

  it('自动化的 never 不提醒；没建出会话时按自动化收起', () => {
    const automations = fakeAutomations();
    const { flush } = setup({ automations });
    const waiting = run({ status: 'waiting' });
    automations.set([automation(waiting, 'never')], waiting);
    expect(flush()).toEqual([]);

    const failed = run({
      id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPQS',
      status: 'failed',
      finishedAt: new Date(NOW).toISOString(),
      error: 'no provider',
    });
    automations.set([automation(failed, 'always')], failed);
    const [intent] = flush();
    expect(intent).toMatchObject({
      kind: 'automation',
      automationStatus: 'failed',
      collapseKey: `automation:${AUTOMATION}`,
    });
    expect(intent?.sessionId).toBeUndefined();
  });

  it('自动化发进已有会话的运行期间，那个会话的事不按会话提醒；运行结束后照常', () => {
    const automations = fakeAutomations();
    const { events, flush } = setup({ automations });
    const active = run({ status: 'running', sessionId: SES });
    automations.set([automation(active, 'always')], active);
    startTurn(events);
    events.append(SES, approvalIn(SES, 'apr_1'));
    finishTurn(events, 'failed');
    expect(flush()).toEqual([]);

    vi.advanceTimersByTime(1_000);
    const done = run({ status: 'failed', sessionId: SES, finishedAt: new Date().toISOString() });
    automations.set([automation(done, 'always')], done);
    expect(flush()).toMatchObject([{ kind: 'automation', automationStatus: 'failed' }]);

    vi.advanceTimersByTime(1_000);
    startTurn(events, SES, TURN2);
    finishTurn(events, 'completed', SES, TURN2);
    expect(flush()).toMatchObject([{ id: `completed:${TURN2}`, kind: 'completed' }]);
  });
});

describe('NotificationService：agent 的提醒（0.142.0）', () => {
  const OPENED: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQX';

  it('生成意图不发，publish 才发；标题省略用会话标题，ID 带时刻，收起键与回合完成分开', () => {
    const { service, flush } = setup();
    const intent = service.agentIntent(SES, { body: 'Staging is down; approve the rollback.' });
    expect(flush()).toEqual([]);
    expect(intent).toEqual({
      id: `agent:${SES}:${NOW}`,
      kind: 'agent',
      sessionId: SES,
      workspaceId: 'ws_1',
      title: '修登录页',
      body: 'Staging is down; approve the rollback.',
      createdAt: new Date(NOW).toISOString(),
      collapseKey: `agent:${SES}`,
    });
    if ('refused' in intent) throw new Error('refused');
    // 测试的监听者不是客户端连接，不算收下。
    expect(service.publish(intent)).toBe(0);
    expect(flush()).toEqual([intent]);
    expect(service.agentIntent(SES, { title: 'Deploy', body: 'Done.' })).toMatchObject({
      title: 'Deploy',
    });
  });

  it('publish 数收下它的客户端连接（监听者返回 true 的）', () => {
    const { service } = setup();
    service.watch(() => true);
    service.watch(() => true);
    service.watch(() => undefined);
    const intent = service.agentIntent(SES, { body: 'Build finished.' });
    if ('refused' in intent) throw new Error('refused');
    expect(service.publish(intent)).toBe(2);
  });

  it('子会话、支线、别的会话开的会话不发；种类开关关着、会话归档或不在时说原因', () => {
    const { service, events, storage, setSettings } = setup();
    const base = storage.sessions.get(SES);
    if (base === undefined) throw new Error('no base session');
    storage.sessions.insert({
      ...base,
      id: OPENED,
      engineSessionId: `engine-${OPENED}`,
      origin: { kind: 'agent', sessionId: SES },
    });
    events.append(OPENED, ev.created());
    for (const sessionId of [CHILD, SIDE, OPENED]) {
      expect(service.agentIntent(sessionId, { body: 'x' })).toEqual({ refused: 'nested' });
    }
    // 自动化开的会话可以提醒（它们的回合不按会话提醒，agent 主动要提醒的照发）。
    expect(service.agentIntent(AUTO, { body: 'x' })).toMatchObject({ kind: 'agent' });
    expect(service.agentIntent('ses_01JA2B3C4D5E6F7G8H9JKMNPQZ', { body: 'x' })).toEqual({
      refused: 'session',
    });
    storage.sessions.setArchived(SES2, new Date(NOW).toISOString());
    expect(service.agentIntent(SES2, { body: 'x' })).toEqual({ refused: 'session' });
    setSettings({ sendWhileBusy: 'steer', notifications: { agent: false } });
    expect(service.agentIntent(SES, { body: 'x' })).toEqual({ refused: 'off' });
  });
});
