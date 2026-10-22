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
import { automationRunMessage } from './automation-tools.js';
import type { CheckExecutor, CheckOutcome } from './check.js';
import { type AutomationChanged, AutomationService, answerOf } from './service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-20T00:00:00.000Z');

interface Harness {
  service: AutomationService;
  clock: { now: number };
  created: { params: MethodParams<'session.create'>; automation: unknown; openedBy?: string }[];
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
  /** 检查脚本的请求；`checkResults` 依次给出结果（可以是还没好的 Promise；没有时一直不结束，直到取消）。 */
  checks: { command: string; cwd: string }[];
  checkResults: (Partial<CheckOutcome> | Promise<Partial<CheckOutcome>>)[];
  /** 加一个用户自己的会话。 */
  addSession(id: string, props?: Partial<Session> & { archived?: boolean }): void;
}

let dirs: string[] = [];
let services: AutomationService[] = [];

async function harness(
  options: { dir?: string; failSend?: boolean; message?: boolean } = {},
): Promise<Harness> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'wevir-automations-')));
  dirs.push(dir);
  const clock = { now: START };
  const sessions = new Map<string, Session>();
  const listeners = new Map<string, Set<(event: WevirEvent) => void>>();
  const log = new Map<string, WevirEvent[]>();
  const created: Harness['created'] = [];
  const sent: Harness['sent'] = [];
  const origins = new Map<string, unknown>();
  const archived = new Set<string>();
  const checks: Harness['checks'] = [];
  const checkResults: Harness['checkResults'] = [];
  const runCheck: CheckExecutor = (request) => {
    checks.push({ command: request.command, cwd: request.cwd });
    const next = checkResults.shift();
    const outcome = (partial: Partial<CheckOutcome>): CheckOutcome => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      durationMs: 5,
      output: '',
      truncated: false,
      fingerprint: partial.output ?? '',
      ...partial,
    });
    if (next !== undefined) return Promise.resolve(next).then(outcome);
    return new Promise((resolve) => {
      request.signal?.addEventListener('abort', () =>
        resolve(outcome({ exitCode: null, cancelled: true })),
      );
    });
  };
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
    runCheck,
    homeDir: '/home/me',
    ...(options.message === true && {
      message: (automation, context) =>
        automationRunMessage(automation, { ...context, marker: 'NOTHING_TO_REPORT' }),
    }),
    storage: {
      workspaces: {
        get: (id: string) =>
          id === 'ws_1' || id === 'ws_chats'
            ? { id, rootPath: `/projects/${id}`, removedAt: undefined }
            : undefined,
      },
      providers: {
        get: (id: string) => (id === 'deepseek' || id === 'kimi' ? { id } : undefined),
      },
      sessions: {
        get: (id: string) =>
          sessions.has(id)
            ? {
                id,
                origin: origins.get(id),
                ...(archived.has(id) && { archivedAt: '2026-10-20T00:00:00.000Z' }),
              }
            : undefined,
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
        created.push({
          params,
          automation: extra.automation,
          ...(extra.openedBy !== undefined && { openedBy: extra.openedBy }),
        });
        origins.set(id, { kind: 'automation', ...extra.automation });
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
    checks,
    checkResults,
    addSession(id, props = {}) {
      const { archived: isArchived, ...rest } = props;
      sessions.set(id, {
        id: id as SessionId,
        state: 'idle',
        title: 'mine',
        workspaceId: 'ws_1',
        cwd: '/projects/ws_1/wt',
        providerId: 'kimi',
        modelId: 'k2',
        ...rest,
      } as Session);
      if (isArchived === true) archived.add(id);
    },
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

  it('会话里的 Agent 手动运行时，新开的会话记为它开的', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    await h.service.runNow(id, 'ses_agent' as SessionId);
    expect(h.created[0]).toMatchObject({ openedBy: 'ses_agent' });
  });

  it('错过了 onTurnFinished 的回合：查询时照事件结掉，不再显示 running', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    await h.service.runNow(id);
    expect(h.service.get(id).runs[0]?.status).toBe('running');
    h.emit('ses_1', {
      type: 'assistant.message',
      payload: { turnId: 'trn_1', text: '做完了。' },
    } as never);
    h.emit('ses_1', {
      type: 'turn.finished',
      payload: { turnId: 'trn_1', outcome: 'completed', durationMs: 5 },
    } as never);
    expect(h.service.list()[0]?.lastRun).toMatchObject({
      status: 'completed',
      summary: '做完了。',
    });
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

/** 等后台的检查脚本跑完（假的检查立即返回）。 */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('发进已有会话（0.73.0）', () => {
  it('用会话的项目与模型，不另开会话；消息前面有一行说明', async () => {
    const h = await harness({ message: true });
    h.addSession('ses_mine');
    const automation = await h.service.create(
      {
        title: '盯 CI',
        prompt: '看看 CI。',
        schedule: { kind: 'interval', minutes: 30 },
        timezone: 'Asia/Shanghai',
        sessionId: 'ses_mine' as SessionId,
      },
      { kind: 'user' },
    );
    expect(automation).toMatchObject({
      sessionId: 'ses_mine',
      newSessionEachRun: false,
      workspaceId: 'ws_1',
      providerId: 'kimi',
      modelId: 'k2',
    });
    await h.service.runNow(automation.id);
    expect(h.created).toHaveLength(0);
    expect(h.sent[0]?.sessionId).toBe('ses_mine');
    expect(h.sent[0]?.text).toMatch(/^\[Wevir automation "盯 CI" \(every 30 minutes\)/);
    expect(h.sent[0]?.text).toMatch(/NOTHING_TO_REPORT\.\]\n\n看看 CI。$/);
  });

  it('自动化自己开的会话不加说明行', async () => {
    const h = await harness({ message: true });
    const { id } = await h.service.create({ ...daily, newSessionEachRun: false }, { kind: 'user' });
    await h.service.runNow(id);
    h.finishTurn('ses_1', 'trn_1', 'completed');
    await h.service.runNow(id);
    expect(h.sent.map((sent) => sent.text)).toEqual(['检查过期的依赖。', '检查过期的依赖。']);
  });

  it('会话不在、归档了时拒绝；没有会话时要 providerId；改成 null 回到每次新开', async () => {
    const h = await harness();
    h.addSession('ses_old', { archived: true });
    const base = { title: 'x', prompt: 'y', schedule: { kind: 'manual' } } as const;
    await expect(
      h.service.create({ ...base, sessionId: 'ses_none' as SessionId }, { kind: 'user' }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(
      h.service.create({ ...base, sessionId: 'ses_old' as SessionId }, { kind: 'user' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(h.service.create(base, { kind: 'user' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    h.addSession('ses_mine', { workspaceId: 'ws_chats' as Session['workspaceId'] });
    const created = await h.service.create(
      { ...base, sessionId: 'ses_mine' as SessionId },
      { kind: 'user' },
    );
    expect(created.workspaceId).toBeUndefined();
    const updated = await h.service.update({ automationId: created.id, sessionId: null });
    expect(updated.sessionId).toBeUndefined();
    expect(updated.newSessionEachRun).toBe(true);
  });

  it('会话正忙时立即运行被拒绝', async () => {
    const h = await harness();
    h.addSession('ses_mine', { state: 'running' });
    const { id } = await h.service.create(
      { ...daily, providerId: undefined, sessionId: 'ses_mine' as SessionId },
      { kind: 'user' },
    );
    await expect(h.service.runNow(id)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

describe('检查脚本（0.73.0）', () => {
  const exitCode = { command: './has-news.sh', wake: 'exit_code' } as const;

  it('退出码 1 不唤醒，连着的并成一条；0 唤醒并附上输出；别的算失败', async () => {
    const h = await harness({ message: true });
    const { id } = await h.service.create({ ...daily, check: exitCode }, { kind: 'user' });
    h.checkResults.push({ exitCode: 1, output: 'nothing' }, { exitCode: 1, output: 'still' });
    const first = await h.service.runNow(id);
    expect(first.status).toBe('checking');
    await settle();
    await h.service.runNow(id);
    await settle();
    let { automation, runs } = h.service.get(id);
    expect(h.checks).toEqual([
      { command: './has-news.sh', cwd: '/projects/ws_1' },
      { command: './has-news.sh', cwd: '/projects/ws_1' },
    ]);
    expect(h.created).toHaveLength(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'silent', check: { decision: 'silent', exitCode: 1 } });
    expect(runs[0]?.check?.output).toBe('still');
    expect(automation.runCount).toBe(2);

    h.checkResults.push({ exitCode: 0, output: 'v1.2.0 released\n', truncated: true });
    await h.service.runNow(id);
    await settle();
    expect(h.sent[0]?.text).toBe(
      '检查过期的依赖。\n\n<check_output command="./has-news.sh" exit_code="0" truncated="true">\nv1.2.0 released\n\n</check_output>',
    );
    ({ runs } = h.service.get(id));
    expect(runs[0]).toMatchObject({ status: 'running', sessionId: 'ses_1', turnId: 'trn_1' });
    h.finishTurn('ses_1', 'trn_1', 'completed', '出了 1.2.0。');

    h.checkResults.push({ exitCode: 2, output: 'boom' });
    await h.service.runNow(id);
    await settle();
    ({ automation, runs } = h.service.get(id));
    expect(runs[0]).toMatchObject({
      status: 'failed',
      error: 'The check exited with code 2 (0 wakes the agent, 1 skips).',
    });
    expect(h.sent).toHaveLength(1);
  });

  it('输出变了才唤醒：第一次作基准；基准存盘，重启后照用；改脚本时丢掉', async () => {
    const h = await harness();
    const { id } = await h.service.create(
      { ...daily, check: { command: 'gh pr checks 42', wake: 'output_changed' } },
      { kind: 'user' },
    );
    h.checkResults.push({ output: 'pending' }, { output: 'pending' });
    await h.service.runNow(id);
    await settle();
    expect(h.service.get(id).runs[0]?.check?.error).toMatch(/baseline/);
    await h.service.runNow(id);
    await settle();
    expect(h.sent).toHaveLength(0);

    await h.service.flush();
    const restarted = await harness({ dir: h.dir });
    await restarted.service.load();
    restarted.checkResults.push({ output: 'pending' }, { output: 'fail' });
    await restarted.service.runNow(id);
    await settle();
    expect(restarted.sent).toHaveLength(0);
    await restarted.service.runNow(id);
    await settle();
    expect(restarted.sent).toHaveLength(1);
    restarted.finishTurn('ses_1', 'trn_1', 'completed', 'CI 挂了。');

    await restarted.service.update({
      automationId: id,
      check: { command: 'gh pr checks 43', wake: 'output_changed' },
    });
    restarted.checkResults.push({ output: 'other' });
    await restarted.service.runNow(id);
    await settle();
    expect(restarted.service.get(id).runs[0]).toMatchObject({ status: 'silent' });
  });

  it('跑完时沿用的会话正忙：记跳过，基准不动', async () => {
    const h = await harness();
    h.addSession('ses_mine');
    const { id } = await h.service.create(
      {
        ...daily,
        sessionId: 'ses_mine' as SessionId,
        check: { command: 'x', wake: 'output_changed' },
      },
      { kind: 'user' },
    );
    h.checkResults.push({ output: 'a' });
    await h.service.runNow(id);
    await settle();
    let finish = (_: Partial<CheckOutcome>) => {};
    h.checkResults.push(new Promise((resolve) => (finish = resolve)));
    await h.service.runNow(id);
    // 检查跑的期间，用户在这个会话里开了个回合。
    const session = h.sessions.get('ses_mine') as Session;
    session.state = 'running';
    finish({ output: 'b' });
    await settle();
    expect(h.service.get(id).runs[0]).toMatchObject({
      status: 'skipped',
      error: 'Its session was busy.',
    });
    expect(h.sent).toHaveLength(0);
    // 基准还是 a：空下来后再看到 b 照样唤醒。
    session.state = 'idle';
    h.checkResults.push({ output: 'b' });
    await h.service.runNow(id);
    await settle();
    expect(h.sent.map((sent) => sent.sessionId)).toEqual(['ses_mine']);
  });

  it('连着失败三次自动停用；重新启用清除', async () => {
    const h = await harness();
    const { id } = await h.service.create({ ...daily, check: exitCode }, { kind: 'user' });
    for (let i = 0; i < 3; i += 1) {
      h.checkResults.push({ exitCode: null, timedOut: true });
      await h.service.runNow(id);
      await settle();
    }
    let { automation, runs } = h.service.get(id);
    expect(runs[0]?.error).toBe('The check timed out after 60 s.');
    expect(automation).toMatchObject({ enabled: false, autoPausedAt: '2026-10-20T00:00:00.000Z' });
    expect(automation.nextRunAt).toBeUndefined();
    automation = await h.service.update({ automationId: id, enabled: true });
    expect(automation.autoPausedAt).toBeUndefined();
    expect(automation.nextRunAt).toBeDefined();
    // 计数也清零：再失败一次不会停用。
    h.checkResults.push({ exitCode: 3 });
    await h.service.runNow(id);
    await settle();
    ({ automation } = h.service.get(id));
    expect(automation.enabled).toBe(true);
  });

  it('删除时取消在跑的检查；重启时 checking 记为 cancelled', async () => {
    const h = await harness();
    const { id } = await h.service.create({ ...daily, check: exitCode }, { kind: 'user' });
    await h.service.runNow(id);
    await expect(h.service.runNow(id)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await h.service.flush();
    const restarted = await harness({ dir: h.dir });
    await restarted.service.load();
    expect(restarted.service.get(id).runs[0]?.status).toBe('cancelled');
    await h.service.delete(id);
    await settle();
    expect(h.sent).toHaveLength(0);
  });

  it('试跑不记运行、不改基准；不在项目中时在主目录跑', async () => {
    const h = await harness();
    const { id } = await h.service.create(
      { ...daily, check: { command: 'x', wake: 'output_changed' } },
      { kind: 'user' },
    );
    h.checkResults.push({ output: 'a' }, { output: 'a' }, { output: 'b' });
    await h.service.runNow(id);
    await settle();
    const same = await h.service.testCheck({
      automationId: id,
      check: { command: 'x', wake: 'output_changed' },
    });
    expect(same.decision).toBe('silent');
    const changed = await h.service.testCheck({
      automationId: id,
      check: { command: 'x', wake: 'output_changed' },
    });
    expect(changed.decision).toBe('wake');
    expect(h.service.get(id).runs).toHaveLength(1);
    h.checkResults.push({ exitCode: 0 });
    await h.service.testCheck({ check: { command: 'pwd', wake: 'exit_code' } });
    expect(h.checks.at(-1)).toEqual({ command: 'pwd', cwd: '/home/me' });
    h.checkResults.push({ exitCode: 0 });
    await h.service.testCheck({
      check: { command: 'pwd', wake: 'exit_code' },
      workspaceId: 'ws_1' as never,
    });
    expect(h.checks.at(-1)?.cwd).toBe('/projects/ws_1');
    h.addSession('ses_mine');
    h.checkResults.push({ exitCode: 0 });
    await h.service.testCheck({
      check: { command: 'pwd', wake: 'exit_code' },
      sessionId: 'ses_mine' as SessionId,
    });
    expect(h.checks.at(-1)?.cwd).toBe('/projects/ws_1/wt');
    await expect(
      h.service.testCheck({
        check: { command: 'pwd', wake: 'exit_code' },
        sessionId: 'ses_gone' as SessionId,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});

describe('与上次相同（0.73.0）', () => {
  it('完成的回答与上一次完成的相同时记 unchanged', async () => {
    const h = await harness();
    const { id } = await h.service.create(daily, { kind: 'user' });
    for (const [index, answer] of ['没变化。', '没变化。', '有新的。'].entries()) {
      await h.service.runNow(id);
      h.finishTurn(`ses_${index + 1}`, `trn_${index + 1}`, 'completed', answer);
    }
    const { runs } = h.service.get(id);
    expect(runs.map((run) => run.unchanged ?? false)).toEqual([false, true, false]);
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
