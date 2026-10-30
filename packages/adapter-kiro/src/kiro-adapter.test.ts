import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const temp = tempRoot('adapter');
const adapters: KiroAdapter[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'messages.ndjson');
  const argv = join(dir, 'argv.ndjson');
  const env = fakeKiroEnv({
    FAKE_KIRO_LOG: log,
    FAKE_KIRO_ARGV_LOG: argv,
    FAKE_KIRO_STORE: join(dir, 'store'),
    FAKE_KIRO_SIGNED_IN: '1',
    ...extra,
  });
  const adapter = fakeKiroAdapter(join(dir, 'home'), env);
  adapters.push(adapter);
  return {
    adapter,
    env,
    log,
    argv,
    dir,
    config: { cwd: temp.dir(`ws-${seq}`), providerId: 'kiro', modelId: 'fixture-model-a' },
  };
}
const modelCalls = (log: string) =>
  readLog(log)
    .filter((message) => message.method === 'session/set_model')
    .map((message) => message.params.modelId);

describe('Kiro ACP', () => {
  it('构造不启动；`kiro-cli acp --agent-engine v2`；文本与工具复用通用映射；模型用 session/set_model 设', async () => {
    const { adapter, config, log, argv } = setup();
    expect(adapter.process.state).toBe('stopped');
    const session = await adapter.createSession(config);
    expect(session).toMatchObject({ engineVersion: '2.36.0', modelId: 'fixture-model-a' });
    expect(modelCalls(log)).toEqual(['fixture-model-a']);
    expect(readLog(log).some((message) => message.method === 'session/set_config_option')).toBe(
      false,
    );
    const args = readFileSync(argv, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).args);
    expect(args).toContainEqual(['acp', '--agent-engine', 'v2']);

    const events = new EventCollector(adapter.subscribe(session.engineSessionId));
    await adapter.send(session.engineSessionId, text('tool'));
    const turn = await events.turn();
    expect(turn.find((event) => event.type === 'tool.started')).toMatchObject({
      display: { kind: 'read', paths: ['fixture.txt'] },
    });
    expect(turn.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'echo: tool',
    });
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
  });

  it('会话的模型列表（session/new 的 models）换掉账号里的“默认”，当前的是这个会话选的', async () => {
    const { adapter, config } = setup();
    expect(await adapter.accounts.models('kiro')).toEqual({
      models: [{ id: 'kiro-default', displayName: 'Default' }],
      defaultModelId: 'kiro-default',
    });
    await adapter.createSession(config);
    expect(await adapter.accounts.models('kiro')).toEqual({
      models: [
        { id: 'auto', displayName: 'Auto' },
        { id: 'fixture-model-a', displayName: 'Fixture A' },
        { id: 'fixture-model-b', displayName: 'Fixture B' },
      ],
      defaultModelId: 'fixture-model-a',
    });
  });

  it('默认模型不发给 CLI，沿用 Kiro 当前的', async () => {
    const { adapter, config, log } = setup();
    await adapter.createSession({ ...config, modelId: 'kiro-default' });
    expect(modelCalls(log)).toEqual([]);
  });

  it('请求批准：选项原样交出，拒绝不会变成批准', async () => {
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
  });

  it('角色关掉的引擎工具：这类审批请求直接拒绝一次，不交给用户（ACP 只能做到这一步，限制只是建议）', async () => {
    const permissions = join(temp.dir(`perm-${seq + 1}`), 'permissions.ndjson');
    const { adapter, config } = setup({ FAKE_KIRO_PERMISSION_LOG: permissions });
    expect('engineToolEnforcement' in adapter).toBe(false);
    const { engineSessionId: id } = await adapter.createSession({
      ...config,
      engineTools: { denied: ['shell'], deniedNames: ['Bash'] },
    });
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('approval'));
    const turn = await events.turn();
    expect(turn.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(turn.find((event) => event.type === 'tool.finished')).toMatchObject({
      status: 'failed',
    });
    expect(readFileSync(permissions, 'utf8').trim()).toBe(
      JSON.stringify({ outcome: 'selected', optionId: 'reject_once' }),
    );
  });

  it('只带 toolCallId 的审批请求：用回合里报过的工具调用补上 kind，角色关掉的照样拒绝，没关的照常问用户', async () => {
    const permissions = join(temp.dir(`perm-${seq + 1}`), 'permissions.ndjson');
    const { adapter, config } = setup({ FAKE_KIRO_PERMISSION_LOG: permissions });
    const { engineSessionId: id } = await adapter.createSession({
      ...config,
      engineTools: { denied: ['shell'], deniedNames: ['Bash'] },
    });
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('approval-id-only'));
    const turn = await events.turn();
    expect(turn.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(readFileSync(permissions, 'utf8').trim()).toBe(
      JSON.stringify({ outcome: 'selected', optionId: 'reject_once' }),
    );

    const open = setup();
    const { engineSessionId: other } = await open.adapter.createSession({
      ...open.config,
      engineTools: { denied: ['web'], deniedNames: ['WebFetch'] },
    });
    const otherEvents = new EventCollector(open.adapter.subscribe(other));
    await open.adapter.send(other, text('approval-id-only'));
    const { event } = await otherEvents.waitFor((event) => event.type === 'approval.requested');
    if (event.type !== 'approval.requested') throw new Error('missing approval');
    await open.adapter.respondToApproval(other, event.requestId, { optionId: 'allow_once' });
    expect((await otherEvents.turn()).at(-1)).toMatchObject({ outcome: 'completed' });
  });

  it('完全访问：Wevir 替用户选“允许一次”；换模型与换回请求批准从下一条消息起生效', async () => {
    const permissions = join(temp.dir(`perm-${seq + 1}`), 'permissions.ndjson');
    const { adapter, config, log } = setup({ FAKE_KIRO_PERMISSION_LOG: permissions });
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
    expect(modelCalls(log)).toEqual(['fixture-model-a', 'fixture-model-b']);
  });

  it('恢复用 session/load，丢掉它回放的历史；引擎里没有这个会话时报 session_lost', async () => {
    const { adapter, config, log, env, dir } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const first = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('remember me'));
    await first.turn();
    await adapter.dispose();

    const next = fakeKiroAdapter(join(dir, 'home'), env);
    adapters.push(next);
    const resumed = await next.resumeSession(id, config);
    expect(resumed.engineSessionId).toBe(id);
    const events = new EventCollector(next.subscribe(id));
    await next.send(id, text('again'));
    const turn = await events.turn();
    expect(
      turn.filter((event) => event.type === 'assistant.message').map((event) => event.text),
    ).toEqual(['echo: again']);
    expect(readLog(log).map((message) => message.method)).toContain('session/load');

    await expect(next.resumeSession('missing-session', config)).rejects.toMatchObject({
      code: 'session_lost',
    });
  });

  it('回合中发现没登录：回合失败归 missing_credentials，账号改成未登录，不自己 authenticate', async () => {
    const state = join(temp.dir(`auth-${seq + 1}`), 'state.json');
    writeFileSync(state, JSON.stringify({ accountType: 'BuilderId', email: 'me@example.com' }));
    const { adapter, config, log } = setup({ FAKE_KIRO_SIGNED_IN: '0', FAKE_KIRO_STATE: state });
    const { engineSessionId: id } = await adapter.createSession(config);
    expect((await adapter.accounts.read('kiro')).email).toBe('me@example.com');
    rmSync(state);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('error:auth'));
    expect((await events.turn()).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'missing_credentials',
    });
    expect((await adapter.accounts.read('kiro')).status).toBe('signed_out');
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
    await expect(adapter.createSession(config)).rejects.toMatchObject({
      code: 'missing_credentials',
    });
  });

  it('没登录不起 ACP 进程（启动器先看账号），错误里给设置里的指引', async () => {
    const { adapter, config, argv } = setup({ FAKE_KIRO_SIGNED_IN: '0' });
    await expect(adapter.createSession(config)).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('Sign in to Kiro in Settings'),
    });
    expect(readFileSync(argv, 'utf8')).not.toContain('"acp"');
    expect(adapter.process.state).toBe('stopped');
  });

  it('额度用完归 provider，其余 unknown；Kiro 的扩展通知不打断回合', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('error:provider'));
    expect((await events.turn()).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message: 'MonthlyRequestCount: you have used all your credits',
    });
    const from = events.events.length;
    await adapter.send(id, text('error:unknown'));
    expect((await events.turn(from)).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'unknown',
    });
    const after = events.events.length;
    await adapter.send(id, text('plain'));
    expect((await events.turn(after)).at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'completed',
    });
  });

  it('结果的 stopReason 是 error：回合失败（不是完成），原文里像密钥的片段遮盖掉', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('stop-error'));
    const last = (await events.turn()).at(-1);
    expect(last).toMatchObject({ type: 'turn.failed', category: 'unknown', code: -32603 });
    if (last?.type !== 'turn.failed') throw new Error('not failed');
    expect(last.message).toBe('Upstream failed: OPENAI_API_KEY=[REDACTED] my_api_key=[REDACTED]');
  });

  it.skipIf(process.platform === 'win32')(
    '引擎退出：engine.exited 的 stderr 尾部遮盖像密钥的片段，进程组里留下的子进程被收掉',
    async () => {
      const childPid = join(temp.dir(`crash-${seq + 1}`), 'child.pid');
      const { adapter, config } = setup({ FAKE_KIRO_CHILD_PID: childPid });
      const { engineSessionId: id } = await adapter.createSession(config);
      const events = new EventCollector(adapter.subscribe(id));
      await adapter.send(id, text('crash'));
      const { event } = await events.waitFor((event) => event.type === 'engine.exited');
      if (event.type !== 'engine.exited') throw new Error('missing exit');
      expect(event.exitCode).toBe(3);
      expect(event.stderrTail).toContain('fatal: request failed');
      expect(event.stderrTail).toContain('Authorization: Bearer [REDACTED]');
      expect(event.stderrTail).toContain('kiro_api_key=[REDACTED] password: [REDACTED]');
      expect(event.stderrTail).not.toMatch(/short-tok|abc123|p a s s/);
      const pid = Number(readFileSync(childPid, 'utf8'));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && alive(); i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(alive()).toBe(false);
    },
  );
});
