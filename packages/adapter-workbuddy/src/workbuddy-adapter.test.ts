import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  EventCollector,
  fakeWorkBuddyAdapter,
  fakeWorkBuddyEnv,
  readLog,
  tempRoot,
  text,
} from './test-fixtures/harness.js';
import type { WorkBuddyAdapter } from './workbuddy-adapter.js';

const temp = tempRoot('adapter');
const adapters: WorkBuddyAdapter[] = [];
afterAll(() => temp.remove());
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'messages.ndjson');
  const adapter = fakeWorkBuddyAdapter(
    join(dir, 'home'),
    fakeWorkBuddyEnv({
      FAKE_WORKBUDDY_LOG: log,
      FAKE_WORKBUDDY_STORE: join(dir, 'store'),
      ...extra,
    }),
  );
  adapters.push(adapter);
  return {
    adapter,
    log,
    dir,
    config: { cwd: temp.dir(`ws-${seq}`), providerId: 'workbuddy', modelId: 'fixture-model-a' },
  };
}

describe('WorkBuddy ACP', () => {
  it('构造不启动；文本、思考、工具、待办复用通用映射', async () => {
    const { adapter, config, log } = setup();
    expect(adapter.process.state).toBe('stopped');
    const session = await adapter.createSession(config);
    expect(session).toMatchObject({ engineVersion: '2.168.2', modelId: 'fixture-model-a' });
    expect(session.reasoningEffort).toBeUndefined();
    const events = new EventCollector(adapter.subscribe(session.engineSessionId));
    await adapter.send(session.engineSessionId, text('tool'));
    const turn = await events.turn();
    expect(turn.find((event) => event.type === 'assistant.thought')).toMatchObject({
      text: 'Thinking about the fixture.',
    });
    expect(turn.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'echo: tool',
    });
    expect(
      turn.find((event) => event.type === 'tool.started' && event.toolName === 'Read'),
    ).toMatchObject({ display: { kind: 'read', paths: ['fixture.txt'] } });
    expect(turn.find((event) => event.type === 'todo.updated')).toMatchObject({
      items: [
        { content: 'Read fixture', status: 'completed' },
        { content: 'Report result', status: 'in_progress' },
      ],
    });
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(
      readLog(log)
        .filter((message) => message.method === 'initialize')
        // 不声明 fs 与 terminal（工具在引擎自己的沙箱里执行）；会话的进程只声明 elicitation。
        .every((message) =>
          Object.keys(message.params.clientCapabilities).every((key) => key === 'elicitation'),
        ),
    ).toBe(true);
  });
  it('普通审批的所有选项原样交出；拒绝和取消不会变成批准', async () => {
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
  it('同一进程按会话切权限；进行中的回合不改，下次消息前 set_config_option', async () => {
    const { adapter, config, log } = setup({ FAKE_WORKBUDDY_INITIAL_MODE: 'bypassPermissions' });
    const { engineSessionId: id } = await adapter.createSession(config);
    const pid = adapter.process.pid;
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('hang'));
    await events.waitFor((event) => event.type === 'assistant.delta');
    const before = readLog(log).filter(
      (message) => message.method === 'session/set_config_option',
    ).length;
    await adapter.configureSession(id, {
      modelId: 'fixture-model-b',
      reasoningEffort: 'low',
      permissionMode: 'full_access',
    });
    expect(
      readLog(log).filter((message) => message.method === 'session/set_config_option'),
    ).toHaveLength(before);
    await expect(adapter.send(id, text('busy'))).rejects.toMatchObject({ code: 'session_busy' });
    await adapter.cancel(id);
    await events.turn();
    const from = events.events.length;
    await adapter.send(id, text('configured'));
    await events.turn(from);
    expect(adapter.process.pid).toBe(pid);
    const selected = readLog(log)
      .filter((message) => message.method === 'session/set_config_option')
      .map((message) => [message.params.configId, message.params.value]);
    expect(selected).toEqual([
      ['mode', 'default'],
      ['model', 'fixture-model-b'],
      ['thought_level', 'low'],
      ['mode', 'bypassPermissions'],
    ]);
    expect(
      readLog(log).some(
        (message) => message.method === 'session/set_model' || message.method === 'authenticate',
      ),
    ).toBe(false);
    expect(
      (await adapter.accounts.models('workbuddy')).models.find(
        (model) => model.id === 'fixture-model-b',
      )?.reasoningEfforts,
    ).toEqual(['low']);
    await adapter.configureSession(id, {
      modelId: 'fixture-model-b',
      permissionMode: 'auto_review',
    });
    const later = events.events.length;
    await adapter.send(id, text('auto'));
    await events.turn(later);
    expect(
      readLog(log)
        .filter((message) => message.method === 'session/set_config_option')
        .at(-1)?.params,
    ).toMatchObject({ configId: 'mode', value: 'auto' });
  });
  it('off 编码为 disabled；不存在的权限模式失败，不沿用更宽权限', async () => {
    const { adapter, config, log } = setup();
    const session = await adapter.createSession({ ...config, reasoningEffort: 'off' });
    expect(session.reasoningEffort).toBe('off');
    expect(
      readLog(log).find((message) => message.params?.configId === 'thought_level')?.params.value,
    ).toBe('disabled');
    const unavailable = setup({ FAKE_WORKBUDDY_NO_MODE: '1' });
    await expect(unavailable.adapter.createSession(unavailable.config)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('模式写入失败时不发 prompt，保留待应用配置；改为有效模式后能继续', async () => {
    const { adapter, config, log } = setup({ FAKE_WORKBUDDY_REJECT_MODE: 'bypassPermissions' });
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.configureSession(id, { modelId: config.modelId, permissionMode: 'full_access' });
    await expect(adapter.send(id, text('denied mode'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(readLog(log).some((message) => message.method === 'session/prompt')).toBe(false);
    await adapter.configureSession(id, { modelId: config.modelId, permissionMode: 'auto_review' });
    await adapter.send(id, text('recovered'));
    expect((await events.turn()).at(-1)).toMatchObject({ type: 'turn.settled' });
  });

  it('账号重新检测到新 CLI 时，在运行的进程仍记录其启动版本', async () => {
    const dir = temp.dir(`version-${++seq}`);
    const env = fakeWorkBuddyEnv();
    const adapter = fakeWorkBuddyAdapter(join(dir, 'home'), env);
    adapters.push(adapter);
    const config = { cwd: dir, providerId: 'workbuddy', modelId: 'fixture-model-a' };
    expect((await adapter.createSession(config)).engineVersion).toBe('2.168.2');
    env.FAKE_WORKBUDDY_VERSION = '2.169.0';
    expect((await adapter.accounts.read('workbuddy', { refresh: true })).version).toBe('2.169.0');
    expect((await adapter.createSession(config)).engineVersion).toBe('2.168.2');
  });
  it('AskUserQuestion 经现成提问桥收答案，再调用官方 ACP 扩展；不以批准冒充答案', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('question'));
    const { event } = await events.waitFor((event) => event.type === 'question.requested');
    if (event.type !== 'question.requested') throw new Error('missing question');
    expect(events.events.some((event) => event.type === 'approval.requested')).toBe(false);
    await adapter.respondToQuestion(id, event.requestId, { q_0: ['my own answer'] });
    expect((await events.turn()).at(-1)).toMatchObject({ type: 'turn.settled' });
    expect(
      readLog(log).find((message) => message.method === '_codebuddy.ai/resolveInterruption')
        ?.params,
    ).toMatchObject({ sessionId: id, decision: 'allow', answers: { q_0: ['my own answer'] } });
    const from = events.events.length;
    await adapter.send(id, text('question-extension'));
    const next = await events.waitFor((event) => event.type === 'question.requested', from);
    if (next.event.type !== 'question.requested') throw new Error('missing question');
    await adapter.respondToQuestion(id, next.event.requestId, { q_0: ['B'] });
    expect(
      (await events.turn(from)).find((event) => event.type === 'assistant.message'),
    ).toMatchObject({ text: JSON.stringify({ outcome: 'submitted', answers: { q_0: ['B'] } }) });
  });
  it('MCP 的 elicitation：initialize 声明支持，表单是提问，链接是“打开链接”的审批', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    expect(
      readLog(log).some(
        (message) =>
          message.method === 'initialize' &&
          JSON.stringify(message.params.clientCapabilities) ===
            JSON.stringify({ elicitation: { form: {}, url: {} } }),
      ),
    ).toBe(true);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('elicitation-form'));
    const { event } = await events.waitFor((event) => event.type === 'question.requested');
    if (event.type !== 'question.requested') throw new Error('missing question');
    expect(event.questions).toEqual([
      {
        id: 'title',
        header: 'Title',
        question: 'New ticket\n\nTitle',
        options: [],
        allowOther: true,
      },
    ]);
    await adapter.respondToQuestion(id, event.requestId, { title: ['Broken login'] });
    expect((await events.turn()).find((event) => event.type === 'assistant.message')).toMatchObject(
      { text: JSON.stringify({ action: 'accept', content: { title: 'Broken login' } }) },
    );
    const from = events.events.length;
    await adapter.send(id, text('elicitation-url'));
    const approval = await events.waitFor((event) => event.type === 'approval.requested', from);
    if (approval.event.type !== 'approval.requested') throw new Error('missing approval');
    const toolCallId = approval.event.toolCallId;
    expect(
      events.events.find(
        (event) => event.type === 'tool.started' && event.toolCallId === toolCallId,
      ),
    ).toMatchObject({
      toolName: 'mcp/elicitation/url',
      input: { url: 'https://tickets.example.com/authorize' },
    });
    await adapter.respondToApproval(id, approval.event.requestId, { optionId: 'accept' });
    const turn = await events.turn(from);
    expect(
      turn.find((event) => event.type === 'tool.finished' && event.toolCallId === toolCallId),
    ).toMatchObject({ status: 'completed' });
    expect(turn.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: JSON.stringify({ action: 'accept' }),
    });
  });
  it('提问时取消回收未决请求；ExitPlanMode 交出计划并拒绝实施', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('question'));
    await events.waitFor((event) => event.type === 'question.requested');
    await adapter.cancel(id);
    expect((await events.turn()).some((event) => event.type === 'question.cancelled')).toBe(true);
    const from = events.events.length;
    await adapter.send(id, text('exit-plan'));
    const turn = await events.turn(from);
    expect(turn.find((event) => event.type === 'plan.proposed')).toMatchObject({
      text: '# Fixture plan\n\nInspect the file.',
    });
    expect(turn.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(turn.find((event) => event.type === 'tool.finished')).toMatchObject({
      status: 'failed',
    });
  });
  it('扩展通知和未知元数据不破坏回合；usage 仅报上下文，成员文本不进入主回答', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('extensions'));
    const turn = await events.turn();
    expect(turn.find((event) => event.type === 'usage.updated')).toEqual({
      type: 'usage.updated',
      engineSessionId: id,
      contextUsed: 1200,
      contextSize: 200000,
    });
    expect((await adapter.accounts.read('workbuddy')).rateLimits).toBeUndefined();
    const from = events.events.length;
    await adapter.send(id, text('member'));
    const member = await events.turn(from);
    expect(member.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'echo: member',
    });
    expect(member.some((event) => event.type === 'engine.raw')).toBe(true);
  });
  it.each([
    ['auth', 'missing_credentials'],
    ['provider', 'provider'],
    ['unknown', 'unknown'],
  ])('回合错误 %s 的分类', async (name, category) => {
    const { adapter, config, log } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text(`error:${name}`));
    expect((await events.turn()).at(-1)).toMatchObject({ type: 'turn.failed', category });
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
    if (name === 'auth')
      expect(await adapter.accounts.read('workbuddy')).toMatchObject({ status: 'signed_out' });
  });
  it('关闭和进程退出后续接；退出上报并走通用重启策略', async () => {
    const { adapter, config } = setup();
    const { engineSessionId: id } = await adapter.createSession(config);
    let events = new EventCollector(adapter.subscribe(id));
    await adapter.close(id);
    await adapter.resumeSession(id, config);
    events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('hang'));
    await events.waitFor((event) => event.type === 'assistant.delta');
    process.kill(adapter.process.pid as number, 'SIGKILL');
    await events.waitFor((event) => event.type === 'engine.exited');
    await adapter.resumeSession(id, config);
    events = new EventCollector(adapter.subscribe(id));
    await adapter.send(id, text('resumed'));
    expect((await events.turn()).find((event) => event.type === 'assistant.message')).toMatchObject(
      { text: 'echo: resumed' },
    );
    await expect(adapter.resumeSession('missing-fixture-session', config)).rejects.toMatchObject({
      code: 'session_lost',
    });
  });
  it('图片和应用工具、历史工具经原有 ACP 内容块和 MCP 接法', async () => {
    const { config, dir, log } = setup();
    const appToolsBridge = { script: join(dir, 'app-tools.mjs'), node: process.execPath };
    const historyTool = {
      script: join(dir, 'history.mjs'),
      node: process.execPath,
      historyDir: join(dir, 'history'),
    };
    const adapter = fakeWorkBuddyAdapter(
      join(dir, 'bridged'),
      fakeWorkBuddyEnv({ FAKE_WORKBUDDY_LOG: log }),
      [],
      { appToolsBridge, historyTool },
    );
    adapters.push(adapter);
    const { engineSessionId: id } = await adapter.createSession({
      ...config,
      appTools: { url: 'http://127.0.0.1:4100/mcp', token: 'fixture-session-token' },
    });
    const events = new EventCollector(adapter.subscribe(id));
    const image = join(dir, 'fixture.png');
    writeFileSync(image, 'fixture image');
    await adapter.send(id, {
      content: [
        { type: 'text', text: 'image' },
        { type: 'image', path: image, mimeType: 'image/png', name: 'fixture.png' },
      ],
    });
    await events.turn();
    expect(adapter.acceptsImages).toBeDefined();
    const created = readLog(log)
      .filter((message) => message.method === 'session/new')
      .at(-1);
    expect(created?.params.mcpServers.map((server: { name: string }) => server.name)).toEqual([
      'wevir_history',
      'wevir',
    ]);
    expect(readFileSync(appToolsBridge.script, 'utf8')).toContain('WEVIR_APP_TOOLS_TOKEN');
    expect(
      readLog(log).find((message) => message.method === 'session/prompt')?.params.prompt[1],
    ).toMatchObject({ type: 'image', data: Buffer.from('fixture image').toString('base64') });
  });
});
