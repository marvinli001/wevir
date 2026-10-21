import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { DevinAdapter } from './devin-adapter.js';
import {
  EventCollector,
  fakeDevinAdapter,
  fakeDevinEnv,
  readLog,
  tempRoot,
  text,
} from './test-fixtures/harness.js';

const temp = tempRoot('adapter');
const adapters: DevinAdapter[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'messages.ndjson');
  const env = fakeDevinEnv({
    FAKE_DEVIN_LOG: log,
    FAKE_DEVIN_STORE: join(dir, 'store'),
    FAKE_DEVIN_SIGNED_IN: '1',
    ...extra,
  });
  const adapter = fakeDevinAdapter(join(dir, 'home'), env);
  adapters.push(adapter);
  return {
    adapter,
    env,
    log,
    dir,
    config: { cwd: temp.dir(`ws-${seq}`), providerId: 'devin', modelId: 'fixture-model-a' },
  };
}
const configCalls = (log: string) =>
  readLog(log)
    .filter((message) => message.method === 'session/set_config_option')
    .map((message) => [message.params.configId, message.params.value]);

describe('Devin ACP', () => {
  it('构造不启动；`devin acp` 的文本、思考、工具复用通用映射，版本取 `devin --version`', async () => {
    const { adapter, config, log } = setup();
    expect(adapter.process.state).toBe('stopped');
    const session = await adapter.createSession(config);
    expect(session).toMatchObject({ engineVersion: '3000.11.92', modelId: 'fixture-model-a' });
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
    // 默认是请求批准，Devin 建会话就是 accept-edits：不必再设。
    expect(configCalls(log)).toEqual([]);
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
  });

  it('审批的选项原样交出；拒绝和取消不会变成批准', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('approval'));
    const { event } = await events.waitFor((event) => event.type === 'approval.requested');
    if (event.type !== 'approval.requested') throw new Error('missing approval');
    expect(event.options.map((option) => option.optionId)).toEqual([
      'allow',
      'allow_always',
      'reject',
    ]);
    await adapter.respondToApproval(id, event.requestId, { optionId: 'reject' });
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

  it('权限模式按会话切：完全访问是 bypass、自动审核是 smart，模型与模式在下一条消息前设', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId: id } = await adapter.createSession({
      ...config,
      permissionMode: 'full_access',
    });
    expect(configCalls(log)).toEqual([['mode', 'bypass']]);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('hang'));
    await events.waitFor((event) => event.type === 'assistant.delta');
    await adapter.configureSession(id, {
      modelId: 'fixture-model-b',
      reasoningEffort: 'high',
      permissionMode: 'auto_review',
    });
    expect(configCalls(log)).toHaveLength(1);
    await expect(adapter.send(id, text('busy'))).rejects.toMatchObject({ code: 'session_busy' });
    await adapter.cancel(id);
    await events.turn();
    const from = events.events.length;
    await adapter.send(id, text('configured'));
    await events.turn(from);
    // 推理档位不交给 ACP。
    expect(configCalls(log)).toEqual([
      ['mode', 'bypass'],
      ['model', 'fixture-model-b'],
      ['mode', 'smart'],
    ]);
  });

  it('没有 Smart 时自动审核退回 accept-edits', async () => {
    const { adapter, config, log } = setup({ FAKE_DEVIN_NO_SMART: '1' });
    await adapter.createSession({ ...config, permissionMode: 'auto_review' });
    expect(configCalls(log)).toEqual([]);
  });

  it('恢复用 session/load，丢掉它回放的历史；引擎里没有这个会话时报 session_lost', async () => {
    const { adapter, config, log, env, dir } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const first = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('remember me'));
    await first.turn();
    await adapter.dispose();

    const next = fakeDevinAdapter(join(dir, 'home'), env);
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
    const state = join(temp.dir(`auth-${seq + 1}`), 'state');
    writeFileSync(state, 'signed-in');
    const { adapter, config, log } = setup({
      FAKE_DEVIN_SIGNED_IN: '0',
      FAKE_DEVIN_AUTH_STATE: state,
    });
    const { engineSessionId: id } = await adapter.createSession(config);
    // 建会话后在别处登出（假 CLI 的登录状态是这个文件）。
    rmSync(state);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('hello'));
    expect((await events.turn()).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'missing_credentials',
    });
    expect((await adapter.accounts.read('devin')).status).toBe('signed_out');
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
    await expect(adapter.createSession(config)).rejects.toMatchObject({
      code: 'missing_credentials',
    });
  });

  it('额度、限流归 provider，其余 unknown', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('error:provider'));
    expect((await events.turn()).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message: '429 usage limit reached',
    });
    const from = events.events.length;
    await adapter.send(id, text('error:unknown'));
    expect((await events.turn(from)).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'unknown',
    });
  });
});
