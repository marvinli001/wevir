import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AutomationRun,
  MethodParams,
  Session,
  SessionId,
  TurnId,
  WevirEvent,
} from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AutomationChanged, AutomationService, answerOf } from './service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-20T00:00:00.000Z');

interface Harness {
  service: AutomationService;
  clock: { now: number };
  created: { params: MethodParams<'session.create'>; automation: unknown }[];
  sent: { sessionId: string; text: string }[];
  changes: AutomationChanged[];
  sessions: Map<string, Session>;
  listeners: Map<string, Set<(event: WevirEvent) => void>>;
  log: Map<string, WevirEvent[]>;
  emit(sessionId: string, event: Partial<WevirEvent> & { type: string; payload: unknown }): void;
  finishTurn(
    sessionId: string,
    turnId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    answer?: string,
  ): void;
  dir: string;
}

let dirs: string[] = [];
let services: AutomationService[] = [];

async function harness(options: { dir?: string; failSend?: boolean } = {}): Promise<Harness> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'wevir-automations-')));
  dirs.push(dir);
  const clock = { now: START };
  const sessions = new Map<string, Session>();
  const listeners = new Map<string, Set<(event: WevirEvent) => void>>();
  const log = new Map<string, WevirEvent[]>();
  const created: Harness['created'] = [];
  const sent: Harness['sent'] = [];
  let count = 0;
  let seq = 1;
  const emit: Harness['emit'] = (sessionId, partial) => {
    const event = {
      seq: seq++,
      sessionId,
      ts: new Date(clock.now).toISOString(),
      source: 'host',
      ...partial,
    } as WevirEvent;
    const list = log.get(sessionId) ?? [];
    list.push(event);
    log.set(sessionId, list);
    for (const listener of listeners.get(sessionId) ?? []) listener(event);
  };
  const service = new AutomationService({
    dir,
    now: () => clock.now,
    identity: { deviceId: 'hst_1', clientId: 'wevir-automations', clientKind: 'desktop' },
    isChats: (id) => id === 'ws_chats',
    storage: {
      workspaces: {
        get: (id: string) =>
          id === 'ws_1' || id === 'ws_chats' ? { id, removedAt: undefined } : undefined,
      },
      providers: { get: (id: string) => (id === 'deepseek' ? { id } : undefined) },
      sessions: {
        get: (id: string) => (sessions.has(id) ? { id, origin: undefined } : undefined),
      },
    } as never,
    events: {
      snapshot: (id) => {
        const session = sessions.get(id);
        return session === undefined ? undefined : { session };
      },
      subscribe: (id, listener) => {
        const set = listeners.get(id) ?? new Set();
        set.add(listener);
        listeners.set(id, set);
        return { unsubscribe: () => set.delete(listener) };
      },
      readSince: (id, since) => (log.get(id) ?? []).filter((event) => event.seq > since),
    },
    sessions: {
      create: async (params, extra) => {
        count += 1;
        const id = `ses_${count}` as SessionId;
        created.push({ params, automation: extra.automation });
        const session = { id, state: 'idle', title: '' } as Session;
        sessions.set(id, session);
        return session;
      },
      rename: async (id, title) => {
        const session = sessions.get(id);
        if (session) session.title = title;
      },
      send: async (params) => {
        if (options.failSend) throw new Error('engine exploded');
        const text = params.content[0]?.type === 'text' ? params.content[0].text : '';
        sent.push({ sessionId: params.sessionId, text });
        const session = sessions.get(params.sessionId);
        if (session) session.state = 'running';
        return { turnId: `trn_${sent.length}` as TurnId, seq: seq++ };
      },
    },
  });
  services.push(service);
  const changes: AutomationChanged[] = [];
  service.watch((change) => changes.push(change));
  return {
    service,
    clock,
    created,
    sent,
    changes,
    sessions,
    listeners,
    log,
    emit,
    dir,
    finishTurn(sessionId, turnId, outcome, answer) {
      if (answer !== undefined) {
        emit(sessionId, { type: 'assistant.message', payload: { turnId, text: answer } } as never);
      }
      const session = sessions.get(sessionId);
      if (session) session.state = 'idle';
      service.onTurnFinished({
        sessionId: sessionId as SessionId,
        turnId: turnId as TurnId,
        outcome,
      });
    },
  };
}

const daily = {
  title: '依赖检查',
  prompt: '检查过期的依赖。',
  schedule: { kind: 'daily', time: '09:00' },
  timezone: 'Asia/Shanghai',
  workspaceId: 'ws_1',
  providerId: 'deepseek',
} as const satisfies MethodParams<'automation.create'>;

beforeEach(() => {
  dirs = [];
  services = [];
});

afterEach(async () => {
  for (const service of services) {
    await service.flush();
    service.dispose();
  }
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('建、改、删', () => {
  it('建好后算出下一次运行，写进文件并通知', async () => {
    const h = await harness();
    const automation = await h.service.create(daily, { kind: 'user' });
    expect(automation).toMatchObject({
      enabled: true,
      permissionMode: 'on_request',
      newSessionEachRun: true,
      notify: 'important',
      nextRunAt: '2026-10-20T01:00:00.000Z',
      runCount: 0,
    });
    expect(h.changes).toEqual([{ automationId: automation.id }]);
    await h.service.flush();
    expect(await readdir(h.dir)).toEqual([`${automation.id}.json`]);
  });

  it('时区、Provider、项目不对时拒绝；一次性的时刻不能已过', async () => {
    const h = await harness();
    await expect(
      h.service.create({ ...daily, timezone: 'Mars/Base' }, { kind: 'user' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.service.create({ ...daily, providerId: 'nope' }, { kind: 'user' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    await expect(
      h.service.create({ ...daily, workspaceId: 'ws_gone' }, { kind: 'user' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    await expect(
      h.service.create({ ...daily, workspaceId: 'ws_chats' }, { kind: 'user' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.service.create(
        { ...daily, schedule: { kind: 'once', at: '2026-10-19T00:00:00.000Z' } },
        { kind: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('停用清掉下一次，启用重新算；改计划重新算；删除后找不到', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    const paused = await h.service.update({ automationId: id, enabled: false });
    expect(paused.nextRunAt).toBeUndefined();
    h.clock.now = START + 2 * HOUR;
    const resumed = await h.service.update({ automationId: id, enabled: true });
    expect(resumed.nextRunAt).toBe('2026-10-21T01:00:00.000Z');
    const hourly = await h.service.update({
      automationId: id,
      schedule: { kind: 'interval', minutes: 60 },
      workspaceId: null,
    });
    expect(hourly.nextRunAt).toBe(new Date(START + 3 * HOUR).toISOString());
    expect(hourly.workspaceId).toBeUndefined();
    await h.service.delete(id);
    expect(() => h.service.get(id)).toThrow(/not found/);
    expect(h.changes.at(-1)).toEqual({ automationId: id, deleted: true });
    await h.service.flush();
    expect(await readdir(h.dir)).toEqual([]);
  });
});

describe('运行', () => {
  it('到点时开会话、改标题、发指令；回合结束记下结果与回答', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    h.clock.now = START + HOUR;
    await h.service.tick();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.params).toEqual({ workspaceId: 'ws_1', providerId: 'deepseek' });
    expect(h.sessions.get('ses_1')?.title).toBe('依赖检查');
    expect(h.sent).toEqual([{ sessionId: 'ses_1', text: '检查过期的依赖。' }]);
    let { automation, runs } = h.service.get(id);
    expect(automation.nextRunAt).toBe('2026-10-21T01:00:00.000Z');
    expect(automation.runCount).toBe(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'running',
      sessionId: 'ses_1',
      turnId: 'trn_1',
    });

    h.finishTurn('ses_1', 'trn_1', 'completed', '有两个依赖过期。');
    ({ automation, runs } = h.service.get(id));
    expect(runs[0]).toMatchObject({ status: 'completed', summary: '有两个依赖过期。' });
    expect(automation.lastRun?.status).toBe('completed');
    expect(
      h.changes.filter((change) => change.run !== undefined).map((change) => change.run?.status),
    ).toEqual(['running', 'running', 'completed']);
  });

  it('等用户批准时是 waiting，处理完回到 running', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    const run = await h.service.runNow(id);
    expect(run).toMatchObject({ trigger: 'manual', status: 'running' });
    h.emit('ses_1', {
      type: 'approval.requested',
      payload: { approval: { id: 'apr_1', turnId: 'trn_1' } },
    } as never);
    expect(h.service.get(id).runs[0]?.status).toBe('waiting');
    await expect(h.service.runNow(id)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    h.emit('ses_1', { type: 'approval.resolved', payload: { approvalId: 'apr_1' } } as never);
    expect(h.service.get(id).runs[0]?.status).toBe('running');
    h.finishTurn('ses_1', 'trn_1', 'cancelled');
    expect(h.service.get(id).runs[0]?.status).toBe('cancelled');
  });

  it('发不出去时记 failed', async () => {
    const h = await harness({ failSend: true });
    const { id } = await h.service.create(daily, { kind: 'user' });
    const run = await h.service.runNow(id);
    expect(run).toMatchObject({ status: 'failed', error: 'engine exploded', sessionId: 'ses_1' });
  });

  it('上一次还在跑时到点记 skipped，连着的并成一条', async () => {
    const h = await harness();
    const { id } = await h.service.create(
      { ...daily, schedule: { kind: 'interval', minutes: 60 } },
      { kind: 'user' },
    );
    h.clock.now = START + HOUR;
    await h.service.tick();
    h.clock.now = START + 2 * HOUR;
    await h.service.tick();
    h.clock.now = START + 3 * HOUR;
    await h.service.tick();
    const { runs, automation } = h.service.get(id);
    expect(runs.map((run) => run.status)).toEqual(['skipped', 'running']);
    expect(runs[0]?.startedAt).toBe(new Date(START + 3 * HOUR).toISOString());
    expect(automation.nextRunAt).toBe(new Date(START + 4 * HOUR).toISOString());
    expect(h.sent).toHaveLength(1);
  });

  it('错过的只补跑一次（catch_up），超过七天的不补', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    h.clock.now = START + 3 * DAY;
    await h.service.tick();
    expect(h.service.get(id).runs.map((run) => run.trigger)).toEqual(['catch_up']);
    expect(h.service.get(id).automation.nextRunAt).toBe('2026-10-23T01:00:00.000Z');
    h.finishTurn('ses_1', 'trn_1', 'completed');

    h.clock.now = START + 20 * DAY;
    await h.service.tick();
    expect(h.service.get(id).runs).toHaveLength(1);
    expect(h.service.get(id).automation.nextRunAt).toBe('2026-11-09T01:00:00.000Z');
  });

  it('一次性的运行后停用', async () => {
    const h = await harness();
    const { id } = await h.service.create(
      { ...daily, schedule: { kind: 'once', at: '2026-10-20T05:00:00.000Z' } },
      { kind: 'user' },
    );
    h.clock.now = Date.parse('2026-10-20T05:00:10.000Z');
    await h.service.tick();
    const { automation, runs } = h.service.get(id);
    expect(automation.enabled).toBe(false);
    expect(automation.nextRunAt).toBeUndefined();
    expect(runs[0]?.trigger).toBe('schedule');
  });

  it('不每次开新会话时沿用同一个会话；会话正忙就等它空下来', async () => {
    const h = await harness();
    const { id } = await h.service.create(
      { ...daily, schedule: { kind: 'interval', minutes: 60 }, newSessionEachRun: false },
      { kind: 'user' },
    );
    h.clock.now = START + HOUR;
    await h.service.tick();
    expect(h.service.get(id).automation.sessionId).toBe('ses_1');
    h.finishTurn('ses_1', 'trn_1', 'completed');
    // 用户在这个会话里开了个回合。
    const session = h.sessions.get('ses_1');
    if (session) session.state = 'running';
    h.clock.now = START + 2 * HOUR;
    await h.service.tick();
    expect(h.sent).toHaveLength(1);
    if (session) session.state = 'idle';
    h.clock.now = START + 2 * HOUR + 30_000;
    await h.service.tick();
    expect(h.created).toHaveLength(1);
    expect(h.sent.map((sent) => sent.sessionId)).toEqual(['ses_1', 'ses_1']);
  });

  it('Host 重启时还在跑的运行记为 cancelled', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    await h.service.runNow(id);
    await h.service.flush();
    const restarted = await harness({ dir: h.dir });
    await restarted.service.load();
    const run = restarted.service.get(id).runs[0] as AutomationRun;
    expect(run.status).toBe('cancelled');
    expect(run.error).toMatch(/Interrupted/);
  });
});

describe('answerOf', () => {
  it('最后一行是 NOTHING_TO_REPORT 时记 quiet 并去掉它', () => {
    expect(answerOf('一切照旧。\n\nNOTHING_TO_REPORT')).toEqual({
      summary: '一切照旧。',
      quiet: true,
    });
    expect(answerOf('**NOTHING_TO_REPORT**')).toEqual({ quiet: true });
    expect(answerOf('发现一个漏洞。')).toEqual({ summary: '发现一个漏洞。' });
    expect(answerOf('')).toEqual({});
  });
});
