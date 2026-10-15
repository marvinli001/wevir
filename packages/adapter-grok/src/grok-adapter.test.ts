// GrokAdapter 驱动假 grok（test-fixtures/fake-grok.mjs），引擎写出的 ACP 消息来自 T3 Code 录的真实 Grok Build 1.0.41 / 1.0.44
// 样本（test-fixtures/acp/）：逐字增量合成消息、工具、待办（`plan`）、审批、提问、取消、回合失败、引擎自己报的回合结束、
// 后台任务自己开的回合，以及按权限模式分进程、会话中换模型与权限模式、要认证时认证后重试。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { GrokAdapter } from './grok-adapter.js';
import {
  EventCollector,
  fakeGrokAdapter,
  fakeGrokEnv,
  readLog,
  tempRoot,
  text,
  type Warning,
} from './test-fixtures/harness.js';

const temp = tempRoot('adapter');
afterAll(() => temp.remove());

let adapters: GrokAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.dispose()));
  adapters = [];
});

let seq = 0;
function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'grok.log');
  const argv = join(dir, 'argv.log');
  const warnings: Warning[] = [];
  const adapter = fakeGrokAdapter(
    join(dir, 'home'),
    fakeGrokEnv({ FAKE_GROK_LOG: log, FAKE_GROK_ARGV_LOG: argv, ...extra }),
    warnings,
  );
  adapters.push(adapter);
  const config = { cwd: temp.dir(`ws-${seq}`), providerId: 'grok', modelId: 'grok-4.7' };
  return { adapter, log, argv, warnings, config };
}

const types = (events: AgentEvent[]) => events.map((event) => event.type);

describe('GrokAdapter：样本回放', () => {
  it('simple：逐字增量合成一条思考与一条消息，引擎报的回合结束先到', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId, engineVersion, modelId, reasoningEffort } =
      await adapter.createSession(config);
    expect(engineVersion).toBe('1.0.41');
    expect({ modelId, reasoningEffort }).toEqual({ modelId: 'grok-4.7', reasoningEffort: 'high' });
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:simple'));
    const turn = await events.turn();

    const thought = turn.find((event) => event.type === 'assistant.thought');
    const message = turn.find((event) => event.type === 'assistant.message');
    expect(message).toMatchObject({ text: 'fixture simple ok' });
    expect(thought?.type === 'assistant.thought' && thought.text.length).toBeGreaterThan(0);
    // 每条增量都被替换，每块以 committed 结束。
    const deltas = turn.filter((event) => event.type === 'assistant.delta');
    expect(deltas.length).toBeGreaterThan(2);
    expect(types(turn).filter((type) => type === 'assistant.stream_ended')).toHaveLength(2);
    expect(turn.at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    // 中途的 session_info_update / available_commands_update 不把一块内容截成两块。
    expect(types(turn).filter((type) => type === 'assistant.thought')).toHaveLength(1);

    const sent = readLog(log);
    const initialize = sent.find((message) => message.method === 'initialize');
    expect(initialize?.params._meta).toEqual({ clientType: 'extension' });
    const promptRequest = sent.find((message) => message.method === 'session/prompt');
    expect(promptRequest?.params._meta.promptId).toMatch(/^wevir-on_request-\d+$/);
  });

  it('todo_list：todo_write 的完整列表来自随后的 plan，记在这次 todo_write 上', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:todo_list'));
    const turn = await events.turn();

    const started = turn.filter((event) => event.type === 'tool.started');
    expect(started.map((event) => event.type === 'tool.started' && event.toolName)).toEqual([
      'search_tool',
      'search_tool',
      'list_dir',
      'todo_write',
      'read_file',
      'read_file',
      'read_file',
      'todo_write',
    ]);
    const display = (name: string) =>
      started.find((event) => event.type === 'tool.started' && event.toolName === name);
    expect(display('read_file')).toMatchObject({
      display: { kind: 'read', paths: ['<workspace>/package.json'] },
    });
    expect(display('todo_write')).toMatchObject({ display: { kind: 'plan' } });

    const todos = turn.filter((event) => event.type === 'todo.updated');
    const writes = started.filter(
      (event) => event.type === 'tool.started' && event.toolName === 'todo_write',
    );
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({
      toolCallId: writes[0]?.type === 'tool.started' && writes[0].toolCallId,
      items: [
        { content: 'inspect package.json', status: 'in_progress' },
        { content: 'inspect tsconfig.json', status: 'pending' },
        { content: 'report completion', status: 'pending' },
      ],
    });
    // 第二次 todo_write 是 merge: true，只给了状态；完整列表照样来自 plan。
    expect(todos[1]).toMatchObject({
      toolCallId: writes[1]?.type === 'tool.started' && writes[1].toolCallId,
      items: [
        { content: 'inspect package.json', status: 'completed' },
        { content: 'inspect tsconfig.json', status: 'completed' },
        { content: 'report completion', status: 'completed' },
      ],
    });
    const failed = turn.filter(
      (event) => event.type === 'tool.finished' && event.status === 'failed',
    );
    expect(failed).toHaveLength(2);
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });

  it('审批：只给一次性的选项与本会话允许编辑，选允许后写入完成', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:tool_call_read_only_on_request'));
    const { event: request } = await events.waitFor((event) => event.type === 'approval.requested');
    if (request.type !== 'approval.requested') throw new Error('unreachable');
    expect(request.options.map((option) => option.optionId)).toEqual([
      'allow-edits-session',
      'allow-once',
      'reject-once',
    ]);
    const started = events.events.find(
      (event) => event.type === 'tool.started' && event.toolCallId === request.toolCallId,
    );
    expect(started).toMatchObject({
      toolName: 'write',
      display: { kind: 'write', paths: ['<workspace>/.codex-probe-write-action.txt'] },
    });
    await adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-once' });
    const turn = await events.turn();
    expect(
      turn.find(
        (event) => event.type === 'tool.finished' && event.toolCallId === request.toolCallId,
      ),
    ).toMatchObject({ status: 'completed' });
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    const reply = readLog(log).find(
      (message) => message.method === undefined && message.result?.outcome !== undefined,
    );
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('grok_prompt_error：引擎报 error 先于 session/prompt 的错误，回合失败归为 provider', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:grok_prompt_error'));
    const turn = await events.turn();
    expect(turn.at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message:
        'API error (status 400 Bad Request): invalid_request_error: grok prompt error fixture',
    });
    // 同一会话接着用：第二个 prompt 恢复正常。
    const from = events.events.length;
    await adapter.send(engineSessionId, text('replay:grok_prompt_error#2'));
    const next = await events.turn(from);
    expect(next.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'grok prompt error fixture recovered',
    });
  });

  it('session/prompt 的结果不来时按引擎报的回合结束结算', async () => {
    const { adapter, config } = setup({ FAKE_GROK_PROMPT_RESPONSE: 'never' });
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('hello'));
    const turn = await events.turn();
    expect(turn.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'echo: hello',
    });
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', stopReason: 'end_turn' });
  });

  it('取消：session/cancel 带 cancelTrigger，回合以取消结算', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:message_steering'));
    await adapter.cancel(engineSessionId);
    const turn = await events.turn();
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    const cancel = readLog(log).find((message) => message.method === 'session/cancel');
    expect(cancel?.params).toEqual({
      sessionId: engineSessionId,
      _meta: { cancelTrigger: 'ctrl_c' },
    });
    // 取消之后的下一个 prompt 照常。
    const from = events.events.length;
    await adapter.send(engineSessionId, text('replay:message_steering#2'));
    const next = await events.turn(from);
    expect(next.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'steering fixture observed',
    });
  });

  it('ask_user_question：变成提问，回答按问题原文与选项 label 回给 Grok', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:plan_questions'));
    const { event } = await events.waitFor((e) => e.type === 'question.requested');
    if (event.type !== 'question.requested') throw new Error('unreachable');
    expect(event).toMatchObject({
      toolCallId: 'ask-user-question-tool-call-1',
      questions: [
        {
          id: 'schema_vs_ui_flexibility',
          question: 'For this fixture, should the plan prefer strict schemas or UI flexibility?',
          options: [
            {
              label: 'Strict schemas (Recommended)',
              description: 'Favor precise contracts and validation.',
            },
            { label: 'UI flexibility', description: 'Favor looser fixture shapes.' },
          ],
          allowOther: true,
        },
      ],
    });
    await adapter.respondToQuestion(engineSessionId, event.requestId, {
      schema_vs_ui_flexibility: ['Strict schemas (Recommended)'],
    });
    const turn = await events.turn();
    expect(turn.find((e) => e.type === 'assistant.message')).toMatchObject({
      text: 'plan questions fixture complete',
    });
    const reply = readLog(log).find((message) => message.result?.outcome === 'accepted');
    expect(reply?.result).toEqual({
      outcome: 'accepted',
      answers: {
        'For this fixture, should the plan prefer strict schemas or UI flexibility?': [
          'Strict schemas (Recommended)',
        ],
      },
    });
  });

  it('exit_plan_mode（0.36.0）：计划报成 plan.proposed，回复放弃这道关，不当审批问', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:exit_plan'));
    const turn = await events.turn();
    expect(turn.filter((e) => e.type === 'plan.proposed')).toEqual([
      {
        type: 'plan.proposed',
        engineSessionId,
        planId: 'exit-plan-tool-call-1',
        text: '# Export button\n\n- Add it to the toolbar',
      },
    ]);
    expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    const reply = readLog(log).find((message) => message.result?.outcome === 'abandoned');
    expect(reply?.result?.feedback).toMatch(/captured your proposed plan/);
  });

  it('提问时取消：提问以 cancelled 结束，回给 Grok cancelled', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:plan_questions'));
    const { event } = await events.waitFor((e) => e.type === 'question.requested');
    await adapter.cancel(engineSessionId);
    const turn = await events.turn();
    expect(turn).toContainEqual(
      expect.objectContaining({
        type: 'question.cancelled',
        requestId: event.type === 'question.requested' && event.requestId,
        reason: 'turn_cancelled',
      }),
    );
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    await expect
      .poll(() => readLog(log).find((message) => message.result?.outcome === 'cancelled'))
      .toBeTruthy();
  });

  it('后台任务结束后 Grok 自己开的回合：Wevir 接不住，保留为 engine.raw', async () => {
    const { adapter, config, warnings } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('replay:grok_background_bash'));
    const turn = await events.turn();
    expect(turn.filter((event) => event.type === 'assistant.message').at(-1)).toMatchObject({
      text: expect.stringContaining('ROOT_DONE'),
    });
    // 唤醒回合的消息与工具更新在回合之外到达。
    await events.waitFor(
      (event) => event.type === 'engine.raw' && event.kind === 'agent_message_chunk',
      turn.length,
    );
    const after = events.events.slice(turn.length);
    expect(
      after.every((event) => event.type === 'engine.raw' || event.type === 'usage.updated'),
    ).toBe(true);
    expect(warnings.map((warning) => warning.message)).toContain(
      'ACP session/update 到达时没有进行中的回合，保留为 engine.raw',
    );
  });
});

describe('GrokAdapter：图片（0.28.0）', () => {
  it('session/prompt 里文本之后是 image 内容块（base64）', async () => {
    const { adapter, config, log } = setup();
    expect(adapter.acceptsImages()).toBe(true);
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    const path = join(temp.dir('images'), 'shot.png');
    writeFileSync(path, Buffer.from('fake png bytes'));
    await adapter.send(engineSessionId, {
      content: [
        { type: 'text', text: 'replay:simple' },
        { type: 'image', path, mimeType: 'image/png', name: 'shot.png' },
      ],
    });
    expect((await events.turn()).at(-1)).toMatchObject({ type: 'turn.settled' });
    const prompt = readLog(log).find((message) => message.method === 'session/prompt');
    expect(prompt?.params.prompt).toEqual([
      { type: 'text', text: 'replay:simple' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('fake png bytes').toString('base64'),
      },
    ]);
  });
});

describe('GrokAdapter：权限模式、模型与认证', () => {
  it('每种权限模式一个进程，启动参数照 T3', async () => {
    const { adapter, config, argv } = setup();
    for (const permissionMode of ['on_request', 'auto_review', 'full_access'] as const) {
      await adapter.createSession({ ...config, permissionMode });
    }
    await adapter.createSession({ ...config, permissionMode: 'on_request' });
    const agents = readFileSync(argv, 'utf8')
      .split('\n')
      .filter((line) => line.includes('stdio'))
      .map((line) => JSON.parse(line) as string[]);
    // 账号检测的 initialize 探测也是一次请求批准模式的启动。
    expect(agents.slice(-3)).toEqual([
      ['--permission-mode', 'default', 'agent', 'stdio'],
      ['--permission-mode', 'auto', 'agent', 'stdio'],
      ['agent', '--always-approve', 'stdio'],
    ]);
    expect(adapter.engines.map((engine) => engine.mode)).toEqual([
      'on_request',
      'auto_review',
      'full_access',
    ]);
  });

  it('会话中换权限模式：下一次发送前挪到新模式的进程，订阅不断', async () => {
    // 真实的 Grok 把会话记在 ~/.grok/sessions，别的进程也能 resume；假 grok 记在 FAKE_GROK_STORE。
    const { adapter, config, log } = setup({ FAKE_GROK_STORE: temp.dir(`store-${seq + 1}`) });
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('one'));
    await events.turn();
    await adapter.configureSession(engineSessionId, {
      modelId: 'grok-4.7',
      reasoningEffort: 'high',
      permissionMode: 'full_access',
    });
    const from = events.events.length;
    await adapter.send(engineSessionId, text('two'));
    const turn = await events.turn(from);
    expect(turn.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'echo: two',
    });
    expect(events.ended).toBe(false);
    const methods = readLog(log).map((message) => message.method);
    expect(methods).toContain('session/close');
    expect(methods).toContain('session/resume');
    expect(adapter.engines.map((engine) => engine.mode)).toEqual(['on_request', 'full_access']);
  });

  it('会话中换模型与推理档位：下一次发送前 session/set_model，档位在 _meta 里', async () => {
    const { adapter, config, log } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.configureSession(engineSessionId, {
      modelId: 'grok-4.6',
      reasoningEffort: 'low',
    });
    await adapter.send(engineSessionId, text('x'));
    await events.turn();
    const setModel = readLog(log).filter((message) => message.method === 'session/set_model');
    expect(setModel.map((message) => message.params)).toEqual([
      { sessionId: engineSessionId, modelId: 'grok-4.6', _meta: { reasoningEffort: 'low' } },
    ]);
    // 选 grok-build（检测不到模型时的产品名）不换模型；只换档位时对当前模型发。
    await adapter.configureSession(engineSessionId, {
      modelId: 'grok-build',
      reasoningEffort: 'medium',
    });
    const from = events.events.length;
    await adapter.send(engineSessionId, text('y'));
    expect((await events.turn(from)).at(-1)).toMatchObject({ type: 'turn.settled' });
    await expect
      .poll(() => readLog(log).filter((message) => message.method === 'session/set_model').length)
      .toBe(2);
    expect(
      readLog(log).filter((message) => message.method === 'session/set_model')[1]?.params,
    ).toEqual({
      sessionId: engineSessionId,
      modelId: 'grok-4.6',
      _meta: { reasoningEffort: 'medium' },
    });
  });

  it('要认证时用 Grok 缓存的登录认证一次再重试', async () => {
    const { adapter, config, log } = setup({ FAKE_GROK_REQUIRE_AUTH: '1' });
    const { engineSessionId } = await adapter.createSession(config);
    expect(engineSessionId).toMatch(/^grok-fake-/);
    const sent = readLog(log).map((message) => message.method);
    expect(sent.filter((method) => method === 'session/new')).toHaveLength(2);
    expect(readLog(log).find((message) => message.method === 'authenticate')?.params).toEqual({
      methodId: 'cached_token',
    });
  });

  it('close 之后 resume 回到同一进程；引擎退出后 resume 到新进程', async () => {
    const { adapter, config } = setup({ FAKE_GROK_STORE: temp.dir(`store-${seq + 1}`) });
    const { engineSessionId } = await adapter.createSession(config);
    let events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.close(engineSessionId);
    await expect.poll(() => events.ended).toBe(true);
    await adapter.resumeSession(engineSessionId, config);
    events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('after resume'));
    await events.turn();

    const engine = adapter.engines[0];
    process.kill(engine?.process.pid as number, 'SIGKILL');
    const { event } = await events.waitFor((e) => e.type === 'engine.exited');
    // Windows 上被别的进程结束的子进程没有信号，只有退出码。
    expect(event).toMatchObject({
      engineSessionId,
      signal: process.platform === 'win32' ? null : 'SIGKILL',
    });
    await expect.poll(() => events.ended).toBe(true);
    await expect
      .poll(
        () =>
          adapter.resumeSession(engineSessionId, config).then(
            () => true,
            () => false,
          ),
        {
          timeout: 5000,
        },
      )
      .toBe(true);
    events = new EventCollector(adapter.subscribe(engineSessionId));
    await adapter.send(engineSessionId, text('after restart'));
    expect((await events.turn()).at(-1)).toMatchObject({ type: 'turn.settled' });
  });
});

describe('GrokAdapter：应用级工具（0.30.0）', () => {
  it('给了桥时会话带 appTools 的 session/new 多一项 stdio 的 wevir，令牌只在它自己的 env 里', async () => {
    const dir = temp.dir(`case-${++seq}`);
    const log = join(dir, 'grok.log');
    const bridge = { script: join(dir, 'mcp', 'wevir-app-tools.mjs'), node: '/usr/bin/node' };
    const adapter = fakeGrokAdapter(join(dir, 'home'), fakeGrokEnv({ FAKE_GROK_LOG: log }), [], {
      appToolsBridge: bridge,
    });
    adapters.push(adapter);
    expect(adapter.appTools).toBe(true);
    const appTools = { url: 'http://127.0.0.1:4100/mcp', token: 'session-token' };
    await adapter.createSession({
      cwd: temp.dir(`ws-${seq}`),
      providerId: 'grok',
      modelId: 'grok-4.7',
      appTools,
    });
    const created = readLog(log).find((message) => message.method === 'session/new');
    expect((created?.params as { mcpServers?: unknown[] } | undefined)?.mcpServers).toEqual([
      {
        name: 'wevir',
        command: '/usr/bin/node',
        args: [bridge.script],
        env: [
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
          { name: 'WEVIR_APP_TOOLS_URL', value: appTools.url },
          { name: 'WEVIR_APP_TOOLS_TOKEN', value: appTools.token },
        ],
      },
    ]);
    expect(readFileSync(bridge.script, 'utf8')).toContain('WEVIR_APP_TOOLS_TOKEN');
  });
});
