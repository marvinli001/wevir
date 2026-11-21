import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { KiroAdapter } from './kiro-adapter.js';
import {
  EventCollector,
  fakeKiroAdapter,
  fakeKiroEnv,
  readLog,
  tempRoot,
  text,
} from './test-fixtures/harness.js';

const temp = tempRoot('v3');
const adapters: KiroAdapter[] = [];
let seq = 0;

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});
afterAll(() => temp.remove());

function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'acp.ndjson');
  const argv = join(dir, 'argv.ndjson');
  const sessions = join(dir, 'sessions.ndjson');
  const common = {
    FAKE_KIRO_SIGNED_IN: '1',
    FAKE_KIRO_LOG: log,
    FAKE_KIRO_ARGV_LOG: argv,
    FAKE_KIRO_SESSION_LOG: sessions,
    FAKE_KIRO_STORE: join(dir, 'store'),
  };
  const create = (version: string, more: Record<string, string> = {}) => {
    const adapter = fakeKiroAdapter(
      dir,
      fakeKiroEnv({ ...common, FAKE_KIRO_VERSION: version, ...more }),
    );
    adapters.push(adapter);
    return adapter;
  };
  return {
    adapter: create('3.2.0', extra),
    create,
    log,
    argv,
    sessions,
    config: { cwd: dir, providerId: 'kiro', modelId: 'fixture-model-a' },
  };
}

const ndjson = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('Kiro V3 ACP', () => {
  it.each(['0', '1'])(
    'waits for the live model configuration (notification first: %s)',
    async (order) => {
      const { adapter, argv, log, sessions, config } = setup({ FAKE_KIRO_V3_UPDATE_FIRST: order });
      const { engineSessionId, modelId, reasoningEffort } = await adapter.createSession({
        ...config,
        reasoningEffort: 'high',
      });

      expect(modelId).toBe(config.modelId);
      expect(reasoningEffort).toBe('high');
      expect(ndjson(argv).find(({ args }) => args[0] === 'acp').args).toEqual([
        'acp',
        '--agent-engine=v3',
        '--auth-method=cli',
      ]);
      const choices = readLog(log)
        .filter(({ method }) => method === 'session/set_config_option')
        .map(({ params }) => [params.configId, params.value]);
      expect(choices).toContainEqual(['effortLevel', 'high']);

      const events = new EventCollector(adapter.subscribe(engineSessionId));
      await adapter.configureSession(engineSessionId, {
        modelId: 'fixture-model-b',
        reasoningEffort: 'max',
      });
      await adapter.send(engineSessionId, text('model change'));
      expect((await events.turn()).at(-1)?.type).toBe('turn.settled');
      expect(ndjson(sessions).at(-1).prompt).toMatchObject({
        model: 'fixture-model-b',
        effort: 'max',
      });
      expect(readLog(log).some(({ method }) => method === 'session/set_model')).toBe(false);
    },
  );

  it('keeps a full-access plan supervised and restores the prior agent for a default turn', async () => {
    const { adapter, sessions, config } = setup();
    const { engineSessionId } = await adapter.createSession({
      ...config,
      permissionMode: 'full_access',
      reasoningEffort: 'high',
    });
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    expect(adapter.supports(engineSessionId, 'planMode')).toBe(true);
    await adapter.send(engineSessionId, { ...text('approval-read'), collaborationMode: 'plan' });
    const { event } = await events.waitFor((event) => event.type === 'approval.requested');
    if (event.type !== 'approval.requested') throw new Error('Expected a supervised approval');
    expect(event.options.map(({ kind }) => kind)).toEqual(['allow_once', 'reject_once']);
    await adapter.respondToApproval(engineSessionId, event.requestId, { optionId: 'allow_once' });
    expect((await events.turn()).at(-1)?.type).toBe('turn.settled');

    const next = events.events.length;
    await adapter.send(engineSessionId, text('after plan'));
    expect((await events.turn(next)).at(-1)?.type).toBe('turn.settled');
    expect(ndjson(sessions).flatMap(({ prompt }) => prompt ?? [])).toEqual([
      { mode: 'plan', model: config.modelId, autopilot: 'off', effort: 'high' },
      { mode: 'custom', model: config.modelId, autopilot: 'on', effort: 'high' },
    ]);
  });

  it('preserves manual approval for full-access sessions with tool restrictions', async () => {
    const { adapter, sessions, config } = setup();
    const { engineSessionId } = await adapter.createSession({
      ...config,
      permissionMode: 'full_access',
      engineTools: { denied: ['edit'], deniedNames: [] },
    });
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('approval'));
    const { event } = await events.waitFor((event) => event.type === 'approval.requested');
    if (event.type !== 'approval.requested') throw new Error('Expected a supervised approval');
    expect(ndjson(sessions).at(-1).prompt.autopilot).toBe('off');
    await adapter.respondToApproval(engineSessionId, event.requestId, { optionId: 'reject_once' });
    expect((await events.turn()).at(-1)?.type).toBe('turn.settled');
  });

  it('runs the advertised /agent command locally and restores that agent after planning', async () => {
    const { adapter, sessions, log, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    expect(await adapter.listCommands(engineSessionId)).toContainEqual(
      expect.objectContaining({ name: 'agent' }),
    );
    await adapter.send(engineSessionId, text('/agent fixture-custom'));
    expect((await events.turn()).at(-1)?.type).toBe('turn.settled');
    expect(readLog(log).some(({ method }) => method === 'session/prompt')).toBe(false);
    expect(readLog(log).find(({ params }) => params?.configId === 'mode')?.params.value).toBe(
      'fixture-custom',
    );

    const planning = events.events.length;
    await adapter.send(engineSessionId, { ...text('prepare a plan'), collaborationMode: 'plan' });
    expect((await events.turn(planning)).at(-1)?.type).toBe('turn.settled');
    const execution = events.events.length;
    await adapter.send(engineSessionId, text('continue'));
    expect((await events.turn(execution)).at(-1)?.type).toBe('turn.settled');
    expect(ndjson(sessions).flatMap(({ prompt }) => prompt?.mode ?? [])).toEqual([
      'plan',
      'fixture-custom',
    ]);
  });

  it('opens new V3 sessions alongside previously persisted V2 sessions', async () => {
    const { adapter, create, argv, log, config } = setup();
    const legacy = create('2.36.0');
    const old = await legacy.createSession(config);
    await legacy.dispose();
    const modern = await adapter.createSession(config);
    const resumed = await adapter.resumeSession(old.engineSessionId, config);
    expect(resumed.engineSessionId).toBe(old.engineSessionId);
    expect(modern.engineSessionId).toMatch(/^kiro-v3:/);
    expect(adapter.supports(resumed.engineSessionId, 'planMode')).toBe(false);
    expect(adapter.supports(modern.engineSessionId, 'planMode')).toBe(true);
    expect(
      ndjson(argv)
        .filter(({ args }) => args[0] === 'acp')
        .map(({ args }) => args),
    ).toEqual([
      ['acp', '--agent-engine', 'v2'],
      ['acp', '--agent-engine=v3', '--auth-method=cli'],
      ['acp', '--agent-engine', 'v2'],
    ]);
    expect(readLog(log).find(({ method }) => method === 'session/load')?.params.sessionId).toBe(
      old.engineSessionId,
    );
    for (const { engineSessionId } of [resumed, modern]) {
      const events = new EventCollector(adapter.subscribe(engineSessionId));
      await adapter.send(engineSessionId, text('session continues'));
      expect((await events.turn()).at(-1)).toMatchObject({ type: 'turn.settled', engineSessionId });
    }
  });

  it('uses V2 when the installed CLI reports that this platform cannot run V3', async () => {
    const { adapter, argv, config } = setup({ FAKE_KIRO_V3_UNSUPPORTED: '1' });
    const first = await adapter.createSession(config);
    const second = await adapter.createSession(config);
    expect(first.engineSessionId).toMatch(/^kiro-fake-/);
    expect(second.engineSessionId).toMatch(/^kiro-fake-/);
    expect(adapter.supports(first.engineSessionId, 'planMode')).toBe(false);
    expect(
      ndjson(argv)
        .filter(({ args }) => args[0] === 'acp')
        .map(({ args }) => args),
    ).toEqual([
      ['acp', '--agent-engine=v3', '--auth-method=cli'],
      ['acp', '--agent-engine', 'v2'],
    ]);
  });

  it('reports only injected steering and declines attachments for Host queue fallback', async () => {
    const { adapter, log, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('hang'));
    await events.waitFor((event) => event.type === 'turn.bound');
    await expect(
      adapter.steer(engineSessionId, 'attachment', {
        content: [{ type: 'image', path: 'fixture.png', mimeType: 'image/png' }],
      }),
    ).rejects.toMatchObject({ code: 'steer_rejected' });
    await adapter.steer(engineSessionId, 'queued', text('keep queued'));
    await adapter.steer(engineSessionId, 'injected', text('inject now'));
    await events.waitFor((event) => event.type === 'turn.steered');
    await adapter.cancel(engineSessionId);
    expect((await events.turn()).filter((event) => event.type === 'turn.steered')).toEqual([
      { type: 'turn.steered', engineSessionId, steerId: 'injected' },
    ]);
    expect(
      readLog(log)
        .filter(({ method }) => method === '_session/steer')
        .map(({ params }) => params.message),
    ).toEqual(['keep queued', 'inject now']);
  });

  it.each(['0', '1'])(
    'compacts once and forks at an earlier native message ID (sparse: %s)',
    async (sparse) => {
      const { adapter, log, config } = setup({ FAKE_KIRO_V3_SPARSE_FORK: sparse });
      const { engineSessionId } = await adapter.createSession(config);
      const events = new EventCollector(adapter.subscribe(engineSessionId));
      expect(adapter.supports(engineSessionId, 'compact')).toBe(true);
      await adapter.send(engineSessionId, text('fork base'));
      const binding = (await events.turn()).find((event) => event.type === 'turn.bound');
      const nativeTurnId = binding?.engineTurnId;
      expect(binding).toMatchObject({ engineSessionId, forkPoint: true });
      expect(nativeTurnId).toMatch(/^native-user-message-/);
      const recent = events.events.length;
      await adapter.send(engineSessionId, text('turn excluded from branch'));
      await events.turn(recent);
      const next = events.events.length;
      await adapter.compact(engineSessionId);
      expect(
        (await events.turn(next))
          .filter((event) => event.type !== 'engine.raw')
          .map((event) => event.type),
      ).toEqual(['context.compacting', 'context.compacted', 'turn.settled']);
      expect(adapter.supports(engineSessionId, 'branch')).toBe(true);
      const fork = await adapter.fork(
        engineSessionId,
        { ...config, reasoningEffort: 'high' },
        {
          kind: 'branch',
          dropTurns: 1,
          nativeTurnId,
        },
      );
      expect(fork.engineSessionId).not.toBe(engineSessionId);
      expect(fork.reasoningEffort).toBe('high');
      expect(readLog(log).find(({ method }) => method === 'session/fork')?.params).toMatchObject({
        sessionId: engineSessionId.replace(/^kiro-v3:/, ''),
        _meta: { kiro: { messageId: nativeTurnId } },
      });
    },
  );

  it('detaches a V3 subscription with a next call pending', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession({ ...config, reasoningEffort: 'high' });
    const iterator = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    const pending = iterator.next();
    expect(await iterator.return?.()).toMatchObject({ done: true });
    expect(await pending).toMatchObject({ done: true });
  });

  it('does not call methods that the current server did not advertise', async () => {
    const { adapter, log, config } = setup({ FAKE_KIRO_V3_EXTENSIONS: '0' });
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    expect(adapter.supports(engineSessionId, 'compact')).toBe(false);
    expect(adapter.supports(engineSessionId, 'branch')).toBe(false);
    await expect(adapter.compact(engineSessionId)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      adapter.fork(engineSessionId, config, {
        kind: 'branch',
        dropTurns: 0,
        atHead: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await adapter.send(engineSessionId, text('hang'));
    await events.waitFor((event) => event.type === 'turn.bound');
    await expect(
      adapter.steer(engineSessionId, 'unsupported', text('steer')),
    ).rejects.toMatchObject({
      code: 'steer_rejected',
    });
    await adapter.cancel(engineSessionId);
    expect(
      readLog(log).some(
        ({ method }) =>
          method === '_session/steer' ||
          method === '_kiro/session/compact' ||
          method === 'session/fork',
      ),
    ).toBe(false);
  });
});
