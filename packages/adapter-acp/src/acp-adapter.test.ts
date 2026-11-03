import type { AccountState, AgentEvent, EngineAccounts } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpAdapter } from './acp-adapter.js';
import { AcpProcess } from './acp-process.js';
import type { AcpEngine } from './engine.js';

const AGENT = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const setup = JSON.parse(process.env.FIXTURE_SETUP);
if (setup.ignoreSigterm) process.on('SIGTERM', () => {});
let configOptions = setup.configOptions;
const calls = [];
let pendingPrompt;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  calls.push(method);
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] });
      break;
    case 'session/new':
    case 'session/resume':
      reply(id, { sessionId: 's1', configOptions, models: setup.models });
      break;
    case 'session/set_config_option':
      configOptions = configOptions.map((o) => o.id === params.configId ? { ...o, currentValue: params.value } : o);
      reply(id, { configOptions });
      break;
    case 'session/set_model':
    case 'session/close':
      reply(id, {});
      break;
    case 'session/prompt':
      if (setup.promptError) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: setup.promptError }) + '\n');
        break;
      }
      if (setup.resultError) { reply(id, { stopReason: 'error', error: setup.resultError }); break; }
      if (setup.hangPrompt) { pendingPrompt = id; break; }
      configOptions = setup.nextOptions ?? configOptions;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 's1', update: { sessionUpdate: 'config_option_update', configOptions }
      } }) + '\n');
      reply(id, { stopReason: 'end_turn' });
      break;
    case 'fixture/releasePrompt':
      reply(id, {});
      reply(pendingPrompt, { stopReason: 'end_turn' });
      break;
    case 'fixture/lateOutput':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'late', content: { type: 'text', text: 'late' } }
      } }) + '\n');
      reply(id, {});
      break;
    case 'fixture/calls':
      reply(id, calls);
      break;
    case 'fixture/closeStdout':
      fs.closeSync(1);
      setInterval(() => {}, 1000);
      break;
    case 'fixture/exit':
      fs.closeSync(1);
      setTimeout(() => process.exit(7), 30);
      break;
  }
});
`;

const option = (values = ['a', 'b']) => ({
  id: 'model',
  name: 'Model',
  type: 'select',
  currentValue: 'a',
  options: [{ group: 'Models', options: values.map((value) => ({ value, name: value })) }],
});
const ENGINE: AcpEngine = {
  name: 'fixture',
  version: '1',
  capabilities: { toolCalls: false, approvals: false, resume: true, concurrentSessions: true },
  tools: { display: () => ({ kind: 'unknown' }) },
  route: {
    modelOption: 'model',
    encode: (_, id) => (id === 'default' ? undefined : id),
    decodeModel: (id) => id,
  },
  classifyTurnError: (error) => ({ category: 'unknown', message: String(error) }),
  classifyResumeError: (error) => ({ failure: { kind: 'unknown' }, message: String(error) }),
};
const adapters: AcpAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});

class FixtureAdapter extends AcpAdapter {
  refresh = vi.fn(async () => {});
  protected override refreshUsage() {
    return this.refresh();
  }
  complete(id: string, completion: { error: unknown } | { stopReason: string }) {
    return this.completeTurn(id, completion);
  }
  watch(accounts: Pick<EngineAccounts, 'onChange'>) {
    this.watchRuntime(accounts);
  }
  select(id: string, modelId: string) {
    return this.applyRoute(id, { providerId: 'fixture', modelId });
  }
}

function setup(
  modelMethod: 'config_option' | 'set_model' = 'config_option',
  fields: Record<string, unknown> = {},
) {
  const engine = {
    ...ENGINE,
    route: { ...ENGINE.route, modelMethod },
    classifyTurnError: (error: unknown) => ({
      ...ENGINE.classifyTurnError(error),
      ...(fields.usageLimit === true && { usageLimit: {} }),
    }),
  };
  const adapter = new FixtureAdapter({
    engine,
    createProcess: (hooks) =>
      new AcpProcess({
        engine,
        ...hooks,
        restart: { maxRestarts: 0 },
        disposeTimeouts: { sigtermMs: 100 },
        launcher: {
          prepare: async () => ({
            spawnSpec: () => ({
              command: process.execPath,
              args: ['-e', AGENT],
              options: {
                cwd: process.cwd(),
                env: {
                  ...process.env,
                  FIXTURE_SETUP: JSON.stringify({ configOptions: [option()], ...fields }),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            }),
          }),
        },
      }),
  });
  adapters.push(adapter);
  return adapter;
}
const config = (modelId: string) => ({ cwd: process.cwd(), providerId: 'fixture', modelId });
const calls = (adapter: AcpAdapter) =>
  adapter.process.connection.agent.request<string[]>('fixture/calls', {});

describe('ACP 额度失败结算', () => {
  it.each(['promptError', 'resultError', 'completion'])('%s：先刷新，再报失败', async (source) => {
    const adapter = setup('config_option', {
      usageLimit: true,
      ...(source === 'completion'
        ? { hangPrompt: true }
        : { [source]: { code: -32603, message: 'quota' } }),
    });
    const { engineSessionId: id } = await adapter.createSession(config('a'));
    const order: string[] = [];
    let release!: () => void;
    adapter.refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('refresh');
          release = resolve;
        }),
    );
    const next = adapter
      .subscribe(id)
      [Symbol.asyncIterator]()
      .next()
      .then((event) => {
        order.push('failed');
        return event.value;
      });
    await adapter.send(id, { content: [{ type: 'text', text: 'quota' }] });
    if (source === 'completion') adapter.complete(id, { error: new Error('quota') });
    await expect.poll(() => order).toEqual(['refresh']);
    release();
    expect(await next).toMatchObject({ type: 'turn.failed', usageLimit: {} });
    expect(order).toEqual(['refresh', 'failed']);
  });

  it('完成通知与 RPC 竞速只刷新、结算一次', async () => {
    const adapter = setup('config_option', { usageLimit: true, hangPrompt: true });
    const { engineSessionId: id } = await adapter.createSession(config('a'));
    let release!: () => void;
    adapter.refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of adapter.subscribe(id)) events.push(event);
    })();
    await adapter.send(id, { content: [{ type: 'text', text: 'quota' }] });
    adapter.complete(id, { error: new Error('quota') });
    adapter.complete(id, { stopReason: 'end_turn' });
    await adapter.process.connection.agent.request('fixture/releasePrompt', {});
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    await adapter.process.connection.agent.request('fixture/lateOutput', {});
    expect(events).toMatchObject([{ type: 'engine.raw', kind: 'agent_message_chunk' }]);
    release();
    await expect.poll(() => events.length).toBe(2);
    expect(events[1]).toMatchObject({ type: 'turn.failed', usageLimit: {} });
    await adapter.dispose();
    await consume;
  });

  it('刷新卡住最多等 5 秒；普通错误不刷新', async () => {
    const adapter = setup('config_option', { usageLimit: true, hangPrompt: true });
    const { engineSessionId: id } = await adapter.createSession(config('a'));
    adapter.refresh.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const next = adapter
      .subscribe(id)
      [Symbol.asyncIterator]()
      .next()
      .then((event) => {
        settled = true;
        return event;
      });
    await adapter.send(id, { content: [{ type: 'text', text: 'quota' }] });
    vi.useFakeTimers();
    try {
      adapter.complete(id, { error: new Error('quota') });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await next).value).toMatchObject({ type: 'turn.failed', usageLimit: {} });
    } finally {
      vi.useRealTimers();
    }
    const ordinary = setup('config_option', { promptError: { code: -32603, message: 'network' } });
    const session = await ordinary.createSession(config('a'));
    const failure = ordinary.subscribe(session.engineSessionId)[Symbol.asyncIterator]().next();
    await ordinary.send(session.engineSessionId, { content: [{ type: 'text', text: 'error' }] });
    expect((await failure).value).not.toHaveProperty('usageLimit');
    expect(ordinary.refresh).not.toHaveBeenCalled();
  });

  it('刷新抛错不改变失败；刷新期间取消不触发引擎重启', async () => {
    const adapter = setup('config_option', { usageLimit: true, hangPrompt: true });
    const { engineSessionId: id } = await adapter.createSession(config('a'));
    adapter.refresh.mockRejectedValue(new Error('read failed'));
    const iterator = adapter.subscribe(id)[Symbol.asyncIterator]();
    const next = iterator.next();
    await adapter.send(id, { content: [{ type: 'text', text: 'quota' }] });
    adapter.complete(id, { error: new Error('quota') });
    expect((await next).value).toMatchObject({ type: 'turn.failed', usageLimit: {} });
    adapter.refresh.mockImplementation(() => new Promise(() => {}));
    await adapter.send(id, { content: [{ type: 'text', text: 'quota' }] });
    adapter.complete(id, { error: new Error('quota') });
    const cancelled = iterator.next();
    await adapter.cancel(id);
    expect((await cancelled).value).toMatchObject({ type: 'turn.failed', usageLimit: {} });
    expect(await calls(adapter)).not.toContain('session/cancel');
  });
});

describe.each(['config_option', 'set_model'] as const)('ACP 模型目录（%s）', (method) => {
  it('创建与恢复都在发送模型选择前拒绝未提供的模型，并关闭会话', async () => {
    const adapter = setup(method);
    await expect(adapter.createSession(config('missing'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(adapter.resumeSession('s1', config('missing'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const methods = await calls(adapter);
    expect(methods.filter((m) => m === 'session/close')).toHaveLength(2);
    expect(methods).not.toContain('session/set_model');
    expect(methods).not.toContain('session/set_config_option');
  });

  it('识别分组模型，换模型时也先校验；默认模型由引擎决定', async () => {
    const adapter = setup(method);
    const session = await adapter.createSession(config('b'));
    await expect(adapter.select(session.engineSessionId, 'missing')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(
      (await calls(adapter)).filter(
        (m) => m === `session/${method === 'set_model' ? 'set_model' : 'set_config_option'}`,
      ),
    ).toHaveLength(1);
    await expect(adapter.createSession(config('default'))).resolves.toMatchObject({
      engineSessionId: 's1',
    });
  });

  it('旧版 availableModels 也参与校验', async () => {
    const adapter = setup(method, {
      configOptions: [],
      models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'A' }] },
    });
    await expect(adapter.createSession(config('missing'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('没有模型目录时交给引擎，有空目录时拒绝指定模型', async () => {
    const unknown = setup(method, { configOptions: [] });
    await expect(unknown.createSession(config('b'))).resolves.toMatchObject({
      engineSessionId: 's1',
    });
    const empty = setup(method, { configOptions: [option([])] });
    await expect(empty.createSession(config('b'))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('运行中模型目录更新后，下一回合拒绝已移除的模型', async () => {
    const adapter = setup(method, { nextOptions: [option(['b'])] });
    const session = await adapter.createSession(config('a'));
    const events = adapter.subscribe(session.engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'hi' }] });
    while ((await events.next()).value?.type !== 'turn.settled') {}
    await expect(
      adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'again' }] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await calls(adapter)).filter((m) => m === 'session/prompt')).toHaveLength(1);
    await events.return?.();
  });
});

describe.skipIf(process.platform === 'win32')('ACP stdout 关闭', () => {
  it.each([false, true])(
    '进程仍活着（忽略 SIGTERM=%s）：请求失败并回收进程',
    async (ignoreSigterm) => {
      const adapter = setup('config_option', { ignoreSigterm });
      await adapter.createSession(config('a'));
      const connection = adapter.process.connection;
      const exited = new Promise<void>((resolve) => adapter.process.once('exit', () => resolve()));
      await expect(connection.agent.request('fixture/closeStdout', {})).rejects.toMatchObject({
        code: 'engine_unavailable',
        message: expect.stringContaining('stdout 已关闭'),
      });
      await expect(connection.agent.request('fixture/calls', {})).rejects.toBeDefined();
      await exited;
      expect(adapter.process.lastExit?.stderrTail).toContain('stdout 已关闭');
    },
  );

  it('随后退出时保留真实退出码', async () => {
    const adapter = setup();
    await adapter.createSession(config('a'));
    await expect(
      adapter.process.connection.agent.request('fixture/exit', {}),
    ).rejects.toMatchObject({ code: 'engine_unavailable', message: expect.stringContaining('7') });
    expect(adapter.process.lastExit?.exitCode).toBe(7);
  });
});

it('运行体升级等回合结束后重启，不打断回合；停用后解除监听', async () => {
  const adapter = setup('config_option', { hangPrompt: true });
  let changed: ((state: AccountState) => void) | undefined;
  const stop = vi.fn();
  adapter.watch({
    onChange: (listener) => {
      changed = listener;
      return stop;
    },
  });
  const session = await adapter.createSession({
    cwd: process.cwd(),
    providerId: 'fixture',
    modelId: 'a',
  });
  const restart = vi.spyOn(adapter.process, 'restart');
  changed?.({ kind: 'kiro', status: 'signed_in', installed: true, version: '1.0.0' });
  await adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'hold' }] });
  changed?.({ kind: 'kiro', status: 'signed_in', installed: true, version: '1.1.0' });
  expect(restart).not.toHaveBeenCalled();
  await adapter.process.connection.agent.request('fixture/releasePrompt', {});
  await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  await adapter.dispose();
  expect(stop).toHaveBeenCalledOnce();
});
