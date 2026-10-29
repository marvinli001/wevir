import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CopilotAdapter } from './copilot-adapter.js';
import {
  EventCollector,
  fakeCopilotAdapter,
  fakeCopilotEnv,
  readLog,
  tempRoot,
  text,
} from './test-fixtures/harness.js';

const temp = tempRoot('adapter');
const adapters: CopilotAdapter[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'messages.ndjson');
  const env = fakeCopilotEnv({
    FAKE_COPILOT_LOG: log,
    FAKE_COPILOT_STORE: join(dir, 'store'),
    FAKE_COPILOT_SIGNED_IN: '1',
    COPILOT_HOME: join(dir, 'copilot-home'),
    ...extra,
  });
  const adapter = fakeCopilotAdapter(join(dir, 'home'), env);
  adapters.push(adapter);
  return {
    adapter,
    env,
    log,
    dir,
    config: { cwd: temp.dir(`ws-${seq}`), providerId: 'copilot', modelId: 'fixture-model-a' },
  };
}
const configCalls = (log: string) =>
  readLog(log)
    .filter((message) => message.method === 'session/set_config_option')
    .map((message) => [message.params.configId, message.params.value]);

describe('Copilot：添加的账号', () => {
  it('用首个账号那里下载的 copilot（设置里的下载装在 engines/copilot/runtime）', async () => {
    const dir = temp.dir(`case-${++seq}`);
    const home = join(dir, 'home');
    const runtime = join(home, 'engines', 'copilot', 'runtime');
    const executable = join(
      runtime,
      'versions',
      '1.0.105',
      process.platform === 'win32' ? 'copilot.exe' : 'copilot',
    );
    mkdirSync(join(runtime, 'versions', '1.0.105'), { recursive: true });
    writeFileSync(executable, '', { mode: 0o755 }); // 只看它有没有被找到，不运行
    writeFileSync(join(runtime, 'active.json'), JSON.stringify({ version: '1.0.105' }));
    const managed: (string | undefined)[] = [];
    const env = fakeCopilotEnv();
    const adapter = new CopilotAdapter({
      home,
      env,
      account: {
        workDir: join(dir, 'accounts', 'copilot-a', 'work'),
        copilotHome: join(dir, 'copilot-a'),
        ghConfigDir: join(dir, 'gh-a'),
      },
      accounts: {
        findExecutable: (_custom, path) => {
          managed.push(path);
          return env.WEVIR_COPILOT_BIN as string;
        },
        probeSession: async () => ({ signedIn: false }) as never,
      },
    });
    adapters.push(adapter);
    await adapter.accounts.read('copilot');
    expect(managed).toContain(executable);
  });
});

describe('Copilot ACP', () => {
  it('构造不启动；`copilot --acp` 的文本、思考、工具复用通用映射；模型按类别找到选项再设', async () => {
    const { adapter, config, log } = setup();
    expect(adapter.process.state).toBe('stopped');
    const session = await adapter.createSession(config);
    expect(session).toMatchObject({ engineVersion: '1.0.103', modelId: 'fixture-model-a' });
    expect(configCalls(log)).toEqual([['fixture-model-option', 'fixture-model-a']]);
    const initialize = readLog(log).find((message) => message.method === 'initialize');
    expect(initialize?.params.clientCapabilities).toEqual({
      _meta: { 'github.com/copilot': { events: ['assistant.usage'] } },
    });
    const events = new EventCollector(adapter.subscribe(session.engineSessionId));
    await adapter.send(session.engineSessionId, text('tool'));
    const turn = await events.turn();
    expect(turn.find((event) => event.type === 'assistant.thought')).toMatchObject({
      text: 'Thinking about the fixture.',
    });
    expect(turn.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'echo: tool',
    });
    expect(turn.find((event) => event.type === 'tool.started')).toMatchObject({
      display: { kind: 'read', paths: ['fixture.txt'] },
    });
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
  });

  it('默认模型不发给 CLI，沿用 Copilot 当前的', async () => {
    const { adapter, config, log } = setup();
    await adapter.createSession({ ...config, modelId: 'copilot-default' });
    expect(configCalls(log)).toEqual([]);
  });

  it('MCP 服务的表单（elicitation/create）是提问，回答交回引擎', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('elicitation-form'));
    const { event } = await events.waitFor((event) => event.type === 'question.requested');
    if (event.type !== 'question.requested') throw new Error('missing question');
    expect(event.questions).toMatchObject([{ id: 'title', header: 'Title' }]);
    await adapter.respondToQuestion(id, event.requestId, { title: ['Broken login'] });
    expect((await events.turn()).find((event) => event.type === 'assistant.message')).toMatchObject(
      { text: JSON.stringify({ action: 'accept', content: { title: 'Broken login' } }) },
    );
  });

  it('请求批准：选项原样交出，拒绝和取消不会变成批准', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('approval'));
    const { event } = await events.waitFor((event) => event.type === 'approval.requested');
    if (event.type !== 'approval.requested') throw new Error('missing approval');
    expect(event.options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);
    await adapter.respondToApproval(id, event.requestId, { optionId: 'reject_once' });
    expect((await events.turn()).find((event) => event.type === 'tool.finished')).toMatchObject({
      status: 'failed',
      output: 'Permission denied',
    });
    const from = events.events.length;
    await adapter.send(id, text('approval'));
    await events.waitFor((event) => event.type === 'approval.requested', from);
    await adapter.cancel(id);
    expect((await events.turn(from)).at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'cancelled',
    });
  });

  it('完全访问：Wevir 替用户选“允许一次”，不发审批；换回请求批准从下一条消息起生效', async () => {
    const permissions = join(temp.dir(`perm-${seq + 1}`), 'permissions.ndjson');
    const { adapter, config, log } = setup({ FAKE_COPILOT_PERMISSION_LOG: permissions });
    const { engineSessionId: id } = await adapter.createSession({
      ...config,
      permissionMode: 'full_access',
    });
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('approval'));
    const turn = await events.turn();
    expect(turn.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(turn.find((event) => event.type === 'tool.finished')).toMatchObject({
      status: 'completed',
    });
    expect(readFileSync(permissions, 'utf8').trim()).toBe(
      JSON.stringify({ outcome: 'selected', optionId: 'allow_once' }),
    );

    await adapter.configureSession(id, {
      modelId: 'fixture-model-b',
      reasoningEffort: 'high',
      permissionMode: 'on_request',
    });
    const from = events.events.length;
    await adapter.send(id, text('approval'));
    const { event } = await events.waitFor((event) => event.type === 'approval.requested', from);
    if (event.type !== 'approval.requested') throw new Error('missing approval');
    await adapter.respondToApproval(id, event.requestId, { optionId: 'allow_once' });
    await events.turn(from);
    // 推理档位不交给 ACP。
    expect(configCalls(log)).toEqual([
      ['fixture-model-option', 'fixture-model-a'],
      ['fixture-model-option', 'fixture-model-b'],
    ]);
  });

  it('恢复用 session/load，丢掉它回放的历史；引擎里没有这个会话时报 session_lost', async () => {
    const { adapter, config, log, env, dir } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const first = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('remember me'));
    await first.turn();
    await adapter.dispose();

    const next = fakeCopilotAdapter(join(dir, 'home'), env);
    adapters.push(next);
    const resumed = await next.resumeSession(id, config);
    expect(resumed.engineSessionId).toBe(id);
    const events = new EventCollector(next.subscribe(id));
    await next.send(id, text('again'));
    const turn = await events.turn();
    expect(turn.filter((event) => event.type === 'engine.raw')).toEqual([]);
    expect(
      turn.filter((event) => event.type === 'assistant.message').map((event) => event.text),
    ).toEqual(['echo: again']);
    const methods = readLog(log).map((message) => message.method);
    expect(methods).toContain('session/load');
    expect(methods).not.toContain('session/resume');

    await expect(next.resumeSession('missing-session', config)).rejects.toMatchObject({
      code: 'session_lost',
    });
  });

  it('回合中发现没登录：回合失败归 missing_credentials，账号改成未登录，不自己 authenticate', async () => {
    const home = join(temp.dir(`auth-${seq + 1}`), 'copilot-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ lastLoggedInUser: { host: 'https://github.com', login: 'octocat' } }),
    );
    const { adapter, config, log } = setup({ FAKE_COPILOT_SIGNED_IN: '0', COPILOT_HOME: home });
    const { engineSessionId: id } = await adapter.createSession(config);
    expect((await adapter.accounts.read('copilot')).email).toBe('octocat');
    // 建会话后在别处登出（假 CLI 的登录状态在 config.json）。
    writeFileSync(join(home, 'config.json'), '{}');
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('hello'));
    expect((await events.turn()).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'missing_credentials',
    });
    expect((await adapter.accounts.read('copilot')).status).toBe('signed_out');
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
    await expect(adapter.createSession(config)).rejects.toMatchObject({
      code: 'missing_credentials',
    });
  });

  it('额度用完归 provider，其余 unknown', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('error:provider'));
    expect((await events.turn()).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message: 'You have exceeded your premium request allowance',
    });
    const from = events.events.length;
    await adapter.send(id, text('error:unknown'));
    expect((await events.turn(from)).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'unknown',
    });
  });

  it('回合里的 assistant.usage 带来每月的高级请求额度，无限的不列', async () => {
    const { adapter, config } = setup({ FAKE_COPILOT_USAGE: '1' });
    const { engineSessionId: id } = await adapter.createSession(config);
    const seen: unknown[] = [];
    adapter.accounts.onChange((state) => seen.push(state.rateLimits));
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('hello'));
    await events.turn();
    const window = {
      usedPercent: 15,
      period: 'monthly',
      scope: 'Premium requests',
      resetsAt: '2026-11-01T00:00:00.000Z',
    };
    expect(seen.at(-1)).toEqual({ primary: window, windows: [window] });
    expect((await adapter.accounts.read('copilot')).rateLimits?.windows).toEqual([window]);
  });
});
