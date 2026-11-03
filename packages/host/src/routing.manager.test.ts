import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccountKind,
  AccountState,
  MethodResult,
  RoutingSettings,
  SessionId,
  WevirEventType,
} from '@wevir/protocol';
import type { AgentInput, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWITCH_CONTINUE_PROMPT } from './auto-continue.js';
import { EventStore } from './event-store.js';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { SessionManager, type SessionManagerOptions } from './session-manager.js';
import { identity, TestRpcClient, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-11-03T00:00:00.000Z';
const managers: SessionManager[] = [];
const stores: EventStore[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function account(
  id: string,
  kind: AccountKind = 'chatgpt',
  usedPercent = 10,
  resetsAt?: string,
): AccountState {
  return {
    id,
    kind,
    status: 'signed_in',
    rateLimits: { windows: [{ usedPercent, ...(resetsAt !== undefined && { resetsAt }) }] },
  };
}

function setup(routing: Partial<RoutingSettings> | false = {}) {
  const root = join(tempDir(), `h${managers.length}`);
  mkdirSync(root);
  const storage = storages.open(join(root, 'data'));
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: root,
    displayName: 'Workspace',
    createdAt: T0,
    updatedAt: T0,
  });
  const provider = (id: string, kind = 'openai-compatible', enabled = true) => {
    storage.providers.insert({
      id,
      kind,
      enabled,
      displayName: id,
      models: [{ id: 'm' }, { id: 'm2' }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
  };
  provider('chatgpt', 'chatgpt');
  provider('api');
  const accounts = new Map<string, AccountState>([['chatgpt', account('chatgpt')]]);
  const settings: RoutingSettings = {
    enabled: true,
    chain: [{ providerId: 'api' }],
    preferSoonestReset: true,
    ...(routing === false ? {} : routing),
  };
  const adapter = new EchoAdapter({ stepDelayMs: 0, chunkSize: 4096 });
  const engines = new Map<string, SessionConfig>();
  const blocked = new Set(['chatgpt/m']);
  const deliveries: { providerId: string; modelId: string; input: AgentInput }[] = [];
  const create = adapter.createSession.bind(adapter);
  vi.spyOn(adapter, 'createSession').mockImplementation(async (config) => {
    const engine = await create(config);
    engines.set(engine.engineSessionId, config);
    return engine;
  });
  const configure = adapter.configureSession.bind(adapter);
  vi.spyOn(adapter, 'configureSession').mockImplementation(async (id, config) => {
    Object.assign(engines.get(id) as SessionConfig, config);
    return configure(id, config);
  });
  const send = adapter.send.bind(adapter);
  vi.spyOn(adapter, 'send').mockImplementation((id, input) => {
    const config = engines.get(id) as SessionConfig;
    deliveries.push({ providerId: config.providerId, modelId: config.modelId, input });
    // Echo 的关键字也会匹配接力历史；这里仅按假账号决定是否触顶。
    return send(id, {
      ...input,
      content: [
        {
          type: 'text',
          text: blocked.has(`${config.providerId}/${config.modelId}`) ? 'hitlimit' : 'ready',
        },
      ],
    });
  });
  const events = new EventStore({ storage });
  const options: SessionManagerOptions = {
    storage,
    events,
    adapter,
    engine: 'echo',
    autoContinue: { account: (id) => accounts.get(id) },
    ...(routing !== false && { routing: () => settings }),
  };
  const manager = new SessionManager(options);
  managers.push(manager);
  stores.push(events);
  return {
    manager,
    events,
    options,
    adapter,
    accounts,
    settings,
    provider,
    blocked,
    deliveries,
    root,
  };
}
type Harness = ReturnType<typeof setup>;

async function begin(
  h: Harness,
  providerId = 'chatgpt',
  options?: Parameters<SessionManager['create']>[1],
) {
  const { id } = await h.manager.create({ workspaceId: 'ws_1', providerId }, options);
  const sessionId = id as SessionId;
  const result = await h.manager.send(
    { sessionId, content: [{ type: 'text', text: '开始' }] },
    identity,
  );
  if (result.turnId === undefined) throw new Error('turn was not started');
  return { sessionId, turnId: result.turnId };
}

function eventsOf<T extends WevirEventType>(h: Harness, id: SessionId, type: T) {
  return h.events.readSince(id, 0).filter((event) => event.type === type) as Extract<
    ReturnType<EventStore['readSince']>[number],
    { type: T }
  >[];
}

async function settled(h: Harness, id: SessionId, turns: number) {
  await vi.waitFor(() => {
    expect(eventsOf(h, id, 'turn.finished')).toHaveLength(turns);
    expect(h.events.snapshot(id)?.session.state).toBe('idle');
  });
}

async function restart(h: Harness) {
  await h.manager.dispose();
  h.events.close();
  stores.splice(stores.indexOf(h.events), 1);
  h.events = new EventStore({ storage: h.options.storage });
  h.manager = new SessionManager({ ...h.options, events: h.events });
  managers.push(h.manager);
  stores.push(h.events);
  h.manager.recover();
  h.manager.resumePendingRouting();
}

describe('用户开启的额度路由', () => {
  it('关闭时与没有路由的逐事件记录一致，保留默认自动继续', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(T0));
    const legacy = setup(false);
    const disabled = setup({ enabled: false });
    const a = await begin(legacy);
    const b = await begin(disabled);
    await settled(legacy, a.sessionId, 1);
    await settled(disabled, b.sessionId, 1);
    const normalized = (h: Harness, id: SessionId) =>
      JSON.parse(
        JSON.stringify(h.events.readSince(id, 0), (key, value) => {
          if (key === 'durationMs') return 0;
          if (key === 'ts') return T0;
          if (typeof value !== 'string') return value;
          return value
            .replace(h.root, '/workspace')
            .replace(/(?:ses|trn|stm)_[a-zA-Z0-9]+/g, (id) => id.slice(0, 4))
            .replace(/echo-[a-z0-9-]+/g, 'echo');
        }),
      );
    expect(normalized(disabled, b.sessionId)).toEqual(normalized(legacy, a.sessionId));
    expect(eventsOf(disabled, b.sessionId, 'routing.decided')).toEqual([]);
    expect(disabled.events.snapshot(b.sessionId)?.session.autoContinue).toBeDefined();
    expect(disabled.deliveries).toHaveLength(1);
  });

  it.each([true, false])('同订阅账号优先；最早重置优先=%s', async (preferSoonestReset) => {
    const h = setup({ preferSoonestReset });
    for (const [id, offset] of [
      ['chatgpt-a', 120_000],
      ['chatgpt-b', 60_000],
    ] as const) {
      h.provider(id, 'chatgpt');
      h.accounts.set(id, account(id, 'chatgpt', 30, new Date(Date.now() + offset).toISOString()));
    }
    const { sessionId, turnId } = await begin(h);
    await settled(h, sessionId, 2);
    const target = preferSoonestReset ? 'chatgpt-b' : 'chatgpt-a';
    expect(h.events.snapshot(sessionId)?.session.providerId).toBe(target);
    expect(eventsOf(h, sessionId, 'routing.decided')[0]?.payload).toEqual({
      turnId,
      originTurnId: turnId,
      attempt: 1,
      from: { providerId: 'chatgpt', modelId: 'm' },
      to: { providerId: target, modelId: 'm' },
      skipped: [],
      at: expect.any(String),
    });
    expect(eventsOf(h, sessionId, 'session.handoff')[0]?.payload).toMatchObject({
      reason: 'usage_limit',
      failover: { attempt: 1, originTurnId: turnId },
    });
    expect(eventsOf(h, sessionId, 'session.auto_continue')).toHaveLength(0);
  });

  it('同订阅的停用节点不从优先账号列表绕过', async () => {
    const h = setup({
      chain: [{ providerId: 'chatgpt-a', enabled: false }, { providerId: 'api' }],
    });
    h.provider('chatgpt-a', 'chatgpt');
    h.accounts.set('chatgpt-a', account('chatgpt-a'));
    const { sessionId } = await begin(h);
    await settled(h, sessionId, 2);
    expect(h.events.snapshot(sessionId)?.session.providerId).toBe('api');
    expect(eventsOf(h, sessionId, 'routing.decided')[0]?.payload.skipped).toContainEqual({
      providerId: 'chatgpt-a',
      reason: 'node_disabled',
    });
  });

  it.each(['agent', 'channel', 'automation'] as const)(
    '%s 会话保留原自动继续，路由留给 L3',
    async (kind) => {
      const h = setup();
      const parent = await h.manager.create({ workspaceId: 'ws_1', providerId: 'api' });
      const { sessionId } = await begin(h, 'chatgpt', {
        ...(kind === 'agent' && { openedBy: parent.id }),
        ...(kind === 'channel' && {
          channel: { channelId: 'chn_1' as never, role: 'thread' as const },
        }),
        ...(kind === 'automation' && {
          automation: { automationId: 'aut_1' as never, runId: 'arn_1' as never },
        }),
      });
      await settled(h, sessionId, 1);
      expect(eventsOf(h, sessionId, 'routing.decided')).toEqual([]);
      expect(h.events.snapshot(sessionId)?.session.autoContinue).toBeDefined();
    },
  );

  it('跨来源接力复用隐藏继续消息与历史摘要', async () => {
    const h = setup({ chain: [{ providerId: 'claude' }] });
    h.provider('claude', 'claude');
    h.accounts.set('claude', account('claude', 'claude'));
    const { sessionId, turnId } = await begin(h);
    await settled(h, sessionId, 2);
    expect(h.events.snapshot(sessionId)?.session.providerId).toBe('claude');
    expect(eventsOf(h, sessionId, 'user.message')[1]?.payload).toMatchObject({
      content: [{ type: 'text', text: SWITCH_CONTINUE_PROMPT }],
      from: { sessionId, kind: 'report', usageLimit: { turnId } },
    });
    expect(h.deliveries[1]?.input.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Context handoff'),
    });
  });

  it('同来源换模型写 configured 原因，不新建引擎会话', async () => {
    const h = setup({ chain: [{ providerId: 'chatgpt', modelId: 'm2' }] });
    const { sessionId, turnId } = await begin(h);
    await settled(h, sessionId, 2);
    expect(eventsOf(h, sessionId, 'session.configured')[0]?.payload).toMatchObject({
      modelId: 'm2',
      reason: 'usage_limit',
      failover: { attempt: 1, originTurnId: turnId },
    });
    expect(h.adapter.createSession).toHaveBeenCalledTimes(1);
    expect(eventsOf(h, sessionId, 'session.handoff')).toEqual([]);
  });

  it('依次跳过已满、未登录、未读登录、停用节点、停用来源、缺模型与缺来源', async () => {
    const ids = [
      'full',
      'out',
      'unknown',
      'disabled',
      'provider-off',
      'bad-model',
      'missing',
      'api',
    ];
    const h = setup({
      chain: ids.map((providerId) => ({
        providerId,
        ...(providerId === 'disabled' && { enabled: false }),
        ...(providerId === 'bad-model' && { modelId: 'missing' }),
      })),
    });
    h.provider('full', 'claude');
    h.accounts.set('full', account('full', 'claude', 100));
    h.provider('out', 'cursor');
    h.accounts.set('out', { ...account('out', 'cursor'), status: 'signed_out' });
    h.provider('unknown', 'grok');
    h.provider('disabled');
    h.provider('provider-off', 'openai-compatible', false);
    h.provider('bad-model');
    const { sessionId } = await begin(h);
    await settled(h, sessionId, 2);
    expect(eventsOf(h, sessionId, 'routing.decided')[0]?.payload.skipped).toEqual(
      ids.slice(0, -1).map((providerId, index) => ({
        providerId,
        reason: [
          'exhausted',
          'signed_out',
          'signed_out',
          'node_disabled',
          'provider_disabled',
          'model_missing',
          'provider_missing',
        ][index],
      })),
    );
  });

  it('全满退回原自动继续，to 为 null', async () => {
    const h = setup({ chain: [{ providerId: 'claude' }] });
    h.provider('claude', 'claude');
    h.accounts.set('claude', account('claude', 'claude', 100));
    const { sessionId, turnId } = await begin(h);
    await settled(h, sessionId, 1);
    expect(eventsOf(h, sessionId, 'routing.decided')[0]?.payload).toMatchObject({
      to: null,
      attempt: 0,
      skipped: [{ providerId: 'claude', reason: 'exhausted' }],
    });
    expect(h.events.snapshot(sessionId)?.session.autoContinue?.turnId).toBe(turnId);
    expect(eventsOf(h, sessionId, 'session.handoff')).toEqual([]);
  });

  it('同一原回合最多三次，访问过的来源不再选，重启保留次数', async () => {
    const h = setup({
      chain: ['chatgpt', 'api', 'api2', 'api3', 'api4'].map((providerId) => ({ providerId })),
    });
    for (const id of ['api2', 'api3', 'api4']) h.provider(id);
    for (const id of ['api', 'api2', 'api3', 'api4']) h.blocked.add(`${id}/m`);
    const stop = h.events.listenAll((event) => {
      if (event.type === 'session.handoff' && event.payload.failover?.attempt === 2)
        h.settings.enabled = false;
    });
    const { sessionId, turnId } = await begin(h);
    await vi.waitFor(() => expect(eventsOf(h, sessionId, 'session.handoff')).toHaveLength(2));
    stop();
    await h.manager.dispose();
    h.settings.enabled = true;
    await restart(h);
    await settled(h, sessionId, 4);
    const decisions = eventsOf(h, sessionId, 'routing.decided').map((event) => event.payload);
    expect(decisions.map((decision) => decision.attempt)).toEqual([1, 2, 3, 3]);
    expect(decisions.every((decision) => decision.originTurnId === turnId)).toBe(true);
    expect(decisions[1]?.skipped).toContainEqual({ providerId: 'chatgpt', reason: 'visited' });
    expect(decisions.at(-1)?.to).toBeNull();
    expect(eventsOf(h, sessionId, 'session.handoff')).toHaveLength(3);
    expect(h.deliveries.map((delivery) => delivery.providerId)).toEqual([
      'chatgpt',
      'api',
      'api2',
      'api3',
    ]);
    expect(h.events.snapshot(sessionId)?.session.autoContinue).toBeDefined();
    h.blocked.delete('chatgpt/m');
    const fresh = await h.manager.send(
      { sessionId, content: [{ type: 'text', text: '继续' }] },
      identity,
    );
    await settled(h, sessionId, 6);
    expect(eventsOf(h, sessionId, 'routing.decided').at(-1)?.payload).toMatchObject({
      attempt: 1,
      originTurnId: fresh.turnId,
      to: { providerId: 'chatgpt', modelId: 'm' },
    });
  });

  it.each(['routing.decided', 'session.handoff'] as const)(
    '在 %s 后重启只完成未消费决定',
    async (pauseAt) => {
      const h = setup();
      const stop = h.events.listenAll((event) => {
        if (event.type === pauseAt) h.settings.enabled = false;
      });
      const { sessionId } = await begin(h);
      await vi.waitFor(() => expect(eventsOf(h, sessionId, pauseAt)).toHaveLength(1));
      stop();
      await h.manager.dispose();
      expect(h.events.routingState(sessionId)?.pending).toBeDefined();
      h.settings.enabled = true;
      await restart(h);
      await settled(h, sessionId, 2);
      expect(eventsOf(h, sessionId, 'routing.decided')).toHaveLength(1);
      expect(eventsOf(h, sessionId, 'session.handoff')).toHaveLength(1);
      expect(h.deliveries).toHaveLength(2);
      await restart(h);
      expect(eventsOf(h, sessionId, 'routing.decided')).toHaveLength(1);
      expect(h.events.routingState(sessionId)?.pending).toBeUndefined();
    },
  );

  it('Host 组装重启在 Provider 桥接就绪后才执行待决定', async () => {
    const h = setup();
    const stop = h.events.listenAll((event) => {
      if (event.type === 'routing.decided') h.settings.enabled = false;
    });
    const { sessionId } = await begin(h);
    await settled(h, sessionId, 1);
    stop();
    await h.manager.dispose();
    h.events.close();
    stores.splice(stores.indexOf(h.events), 1);
    h.options.storage.close();
    const home = join(h.root, 'data');
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ sendWhileBusy: 'steer', routing: { ...h.settings, enabled: true } }),
    );
    let providersReady = false;
    const create = vi
      .mocked(h.adapter.createSession)
      .getMockImplementation() as typeof h.adapter.createSession;
    vi.mocked(h.adapter.createSession).mockImplementation((config) => {
      if (!providersReady) throw new Error('providers are not ready');
      return create(config);
    });
    const adapter = Object.assign(h.adapter, {
      configureProviders: async () => {
        providersReady = true;
      },
    });
    const host = await startHost({
      home,
      adapter,
      engine: 'echo',
      logger: createLogger({ level: 'error' }),
    });
    const client = await TestRpcClient.connect(host.url);
    try {
      const runtime = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as {
        token: string;
      };
      await client.hello(runtime.token);
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      await client.until(
        () =>
          client.events(subscriptionId).filter((event) => event.type === 'turn.finished').length ===
            2 || undefined,
        'continued turn',
      );
      expect((await client.request('routing.decisions', {})).decisions).toHaveLength(1);
      expect(
        client.events(subscriptionId).filter((event) => event.type === 'session.handoff'),
      ).toHaveLength(1);
      expect(h.deliveries.map((delivery) => delivery.providerId)).toEqual(['chatgpt', 'api']);
    } finally {
      client.ws.terminate();
      await host.shutdown();
    }
  });

  it('接力失败记下原因并退回自动继续', async () => {
    const h = setup();
    const create = vi
      .mocked(h.adapter.createSession)
      .getMockImplementation() as typeof h.adapter.createSession;
    vi.mocked(h.adapter.createSession).mockImplementation((config) =>
      config.providerId === 'api' ? Promise.reject(new Error('offline')) : create(config),
    );
    const { sessionId } = await begin(h);
    await vi.waitFor(() => expect(eventsOf(h, sessionId, 'routing.decided')).toHaveLength(2));
    expect(eventsOf(h, sessionId, 'routing.decided')[1]?.payload).toMatchObject({
      to: null,
      skipped: [{ providerId: 'api', reason: 'switch_failed' }],
    });
    expect(h.events.snapshot(sessionId)?.session.autoContinue).toBeDefined();
  });

  it('最近决定跨会话按时间倒序，相同时刻与会话的复合游标分页无重漏', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(T0));
    const h = setup({ chain: [] });
    const a = await begin(h);
    await settled(h, a.sessionId, 1);
    const b = await begin(h);
    await settled(h, b.sessionId, 1);
    const decision = eventsOf(h, a.sessionId, 'routing.decided')[0];
    if (decision === undefined) throw new Error('no routing decision');
    h.events.append(a.sessionId, {
      type: 'routing.decided',
      source: 'host',
      payload: decision.payload,
    });
    const all = h.events.routingDecisions({});
    const pages: MethodResult<'routing.decisions'>['decisions'] = [];
    let cursor: MethodResult<'routing.decisions'>['nextCursor'];
    do {
      const page = h.events.routingDecisions({ limit: 1, ...(cursor !== undefined && { cursor }) });
      pages.push(...page.decisions);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toEqual(all.decisions);
    const expected = [
      ...eventsOf(h, a.sessionId, 'routing.decided'),
      ...eventsOf(h, b.sessionId, 'routing.decided'),
    ].sort((a, b) => b.sessionId.localeCompare(a.sessionId) || b.seq - a.seq);
    expect(pages.map((decision) => [decision.sessionId, decision.seq])).toEqual(
      expected.map((event) => [event.sessionId, event.seq]),
    );
  });
});
