// AntigravityAdapter 在契约之外的行为，跑在假运行体上：没登录时建会话、权限模式与会话中换设置、借审批方法的提问、
// 恢复、登出时停掉进程、会话带来的模型列表。

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntigravityAdapter } from './antigravity-adapter.js';
import {
  collectingLogger,
  installFakeRuntime,
  removeDir,
  tempDir,
  waitFor,
  writeFakeToken,
} from './test-fixtures/runtime.js';
import { stepDatabase, usageMetadata } from './test-fixtures/step-db.js';

let home: string;
let workspace: string;
let adapters: AntigravityAdapter[];

beforeEach(() => {
  home = tempDir();
  installFakeRuntime(path.join(home, 'bin'));
  workspace = realpathSync(home);
  adapters = [];
});

afterEach(async () => {
  for (const adapter of adapters) await adapter.dispose();
  removeDir(home);
});

async function create(
  options: { native?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<AntigravityAdapter> {
  const adapter = new AntigravityAdapter({
    home,
    logger: collectingLogger(),
    env: { PATH: process.env.PATH, HOME: home, ...options.env },
  });
  adapters.push(adapter);
  await adapter.accounts.setExecutablePath(
    'antigravity',
    options.native
      ? installFakeRuntime(path.join(home, 'bin'), { native: true })
      : path.join(home, 'bin', 'agy_acp_server.par'),
  );
  return adapter;
}

function config(extra: Partial<SessionConfig> = {}): SessionConfig {
  return { cwd: workspace, providerId: 'antigravity', modelId: 'gemini-3.8-flash', ...extra };
}

function collect(adapter: AntigravityAdapter, session: EngineSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of adapter.subscribe(session.engineSessionId)) events.push(event);
  })();
  return events;
}

async function turn(
  adapter: AntigravityAdapter,
  session: EngineSession,
  events: AgentEvent[],
  text: string,
): Promise<AgentEvent[]> {
  const from = events.length;
  await adapter.send(session.engineSessionId, { content: [{ type: 'text', text }] });
  await waitFor(
    () =>
      events
        .slice(from)
        .some((event) => event.type === 'turn.settled' || event.type === 'turn.failed'),
    '回合结束',
  );
  return events.slice(from);
}

function replyText(events: AgentEvent[]): string {
  return events
    .filter((event) => event.type === 'assistant.message')
    .map((event) => (event.type === 'assistant.message' ? event.text : ''))
    .join('');
}

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('AntigravityAdapter', () => {
  it('隐藏的额度错误先刷新用量，再排空重启，恢复后的回合不沿用旧错误', async () => {
    writeFakeToken(home);
    const adapter = await create();
    const session = await adapter.createSession(config());
    const refresh = vi.spyOn(adapter.accounts, 'refreshUsage').mockResolvedValue(undefined);
    stepDatabase(path.join(home, 'engines/antigravity/profile'), session.engineSessionId).close();
    const events = collect(adapter, session);
    const failed = await turn(adapter, session, events, 'native-quota');
    expect(failed.find((event) => event.type === 'turn.failed')).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      usageLimit: { resetsAt: '2026-12-01T00:00:00Z' },
    });
    expect(refresh).toHaveBeenCalledWith('antigravity');
    await waitFor(() => events.some((event) => event.type === 'engine.exited'), 'engine.exited');
    const resumed = await adapter.resumeSession(session.engineSessionId, config());
    expect((await turn(adapter, resumed, collect(adapter, resumed), 'hello')).at(-1)).toMatchObject(
      {
        type: 'turn.settled',
        outcome: 'completed',
      },
    );
  });

  it.each(['resume', 'load'] as const)(
    'new 与 %s 都禁用 workflow，并重新给系统规则',
    async (resumeMethod) => {
      writeFakeToken(home);
      const first = await create();
      const session = await first.createSession(config({ ruleInstructions: 'First rules' }));
      expect((await first.ruleFiles()).instructions).toBe(true);
      const before = collect(first, session);
      expect(JSON.parse(replyText(await turn(first, session, before, 'session-meta?')))).toEqual({
        antigravity: { disabledTools: ['run_workflow'], systemPrompt: { append: 'First rules' } },
      });
      expect(existsSync(path.join(workspace, 'skills/system/run-workflow/SKILL.md'))).toBe(false);
      await first.dispose();
      const second = await create();
      Object.assign(second.engine, { resumeMethod });
      const resumed = await second.resumeSession(
        session.engineSessionId,
        config({ ruleInstructions: 'Updated rules' }),
      );
      const after = collect(second, resumed);
      expect(JSON.parse(replyText(await turn(second, resumed, after, 'session-meta?')))).toEqual({
        antigravity: { disabledTools: ['run_workflow'], systemPrompt: { append: 'Updated rules' } },
      });
      expect(existsSync(path.join(workspace, 'skills/system/run-workflow/SKILL.md'))).toBe(false);
    },
  );

  it('原生 CLI 用 Wevir 标识，在原来的 profile 恢复旧会话并切回默认审批', async () => {
    writeFakeToken(home);
    const envDump = path.join(home, 'spawn.json');
    const clientDump = path.join(home, 'client.json');
    const adapter = await create({
      env: { FAKE_AGY_ENV_DUMP: envDump, FAKE_AGY_CLIENT_DUMP: clientDump },
    });
    const session = await adapter.createSession(config({ permissionMode: 'full_access' }));
    const oldPid = adapter.process.pid;
    const agy = installFakeRuntime(path.join(home, 'bin'), { native: true });
    await adapter.accounts.setExecutablePath('antigravity', agy);
    const resumed = await adapter.resumeSession(
      session.engineSessionId,
      config({ permissionMode: 'full_access' }),
    );
    expect(resumed).toMatchObject({
      engineSessionId: session.engineSessionId,
      engineVersion: '1.5.13',
    });
    expect(adapter.process.pid).not.toBe(oldPid);
    const profile = path.join(home, 'engines', 'antigravity', 'profile');
    const spawn = JSON.parse(readFileSync(envDump, 'utf8'));
    expect(spawn.argv).toEqual([
      'acp',
      '--gemini-dir',
      profile,
      '--app-data-dir',
      'antigravity-acp',
    ]);
    expect(spawn.env).toMatchObject({ GEMINI_HOME: profile, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    expect(spawn.env.ANTIGRAVITY_HARNESS_PATH).toBeUndefined();
    expect(JSON.parse(readFileSync(clientDump, 'utf8'))).toMatchObject({ name: 'wevir' });
    expect(
      JSON.parse(readFileSync(path.join(profile, 'antigravity-acp', 'settings.json'), 'utf8')),
    ).toMatchObject({
      auth: { type: 'oauth-personal' },
      agentMode: '',
      toolPermission: 'strict',
    });
    const events = collect(adapter, resumed);
    expect(replyText(await turn(adapter, resumed, events, 'mode?'))).toContain('mode=default');
    const approved = await turn(adapter, resumed, events, 'approve');
    expect(replyText(approved)).toBe('Wrote the file.');
    expect(approved.some((event) => event.type === 'approval.requested')).toBe(false);
    expect((await adapter.ruleFiles()).instructions).toBe(false);
    expect(replyText(await turn(adapter, resumed, events, 'session-meta?'))).toBe('null');
  });

  it('只在原生 CLI 声明支持时给新会话与恢复会话附加系统规则', async () => {
    writeFakeToken(home);
    for (const append of [false, true]) {
      const promptDump = path.join(home, 'prompt.txt');
      const options = {
        native: true,
        env: { FAKE_AGY_APPEND: append ? '1' : undefined, FAKE_AGY_PROMPT_DUMP: promptDump },
      };
      const first = await create(options);
      expect((await first.ruleFiles()).instructions).toBe(append);
      if (!append) {
        const session = await first.createSession(config({ ruleInstructions: 'Rule\n\n' }));
        await turn(first, session, collect(first, session), 'Hello');
        expect(readFileSync(promptDump, 'utf8')).toBe('Rule\n\nHello');
        await first.dispose();
        continue;
      }
      const session = await first.createSession(config({ ruleInstructions: 'Initial rule' }));
      const initial = collect(first, session);
      expect(JSON.parse(replyText(await turn(first, session, initial, 'session-meta?')))).toEqual({
        antigravity: { systemPrompt: { append: 'Initial rule' } },
      });
      await first.dispose();
      const second = await create(options);
      const resumed = await second.resumeSession(
        session.engineSessionId,
        config({ ruleInstructions: 'Updated rule' }),
      );
      const events = collect(second, resumed);
      expect(JSON.parse(replyText(await turn(second, resumed, events, 'session-meta?')))).toEqual({
        antigravity: { systemPrompt: { append: 'Updated rule' } },
      });
    }
  });

  it('原生 CLI 无法从自动模式切回默认审批时拒绝建立会话', async () => {
    writeFakeToken(home);
    const native = await create({ native: true, env: { FAKE_AGY_UNSAFE_MODE_ONLY: '1' } });
    await expect(native.createSession(config())).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('default approval mode'),
    });
  });

  it('没登录：建会话报 missing_credentials（不等用户去浏览器），账号改为未登录，进程停掉', async () => {
    const adapter = await create();
    await expect(adapter.createSession(config())).rejects.toMatchObject({
      code: 'missing_credentials',
    });
    expect(adapter.process.state).toBe('stopped');
    expect((await adapter.accounts.read('antigravity')).status).toBe('signed_out');
  });

  it('预先启动：拉起运行体并完成认证，之后建会话用同一个进程；没登录时报 missing_credentials、账号改为未登录', async () => {
    const signedOut = await create();
    await expect(signedOut.prewarm()).rejects.toMatchObject({ code: 'missing_credentials' });
    expect((await signedOut.accounts.read('antigravity')).status).toBe('signed_out');
    await signedOut.dispose();

    writeFakeToken(home);
    const adapter = await create();
    await Promise.all([adapter.prewarm(), adapter.prewarm()]);
    expect(adapter.process.state).toBe('ready');
    const pid = adapter.process.pid;
    expect(pid).toBeDefined();
    await adapter.prewarm();
    await adapter.createSession(config());
    expect(adapter.process.pid).toBe(pid);
  });

  it('建会话时按权限模式设 Antigravity 的会话模式，会话中换模型与模式从下一个回合起生效', async () => {
    writeFakeToken(home);
    const adapter = await create();
    expect(adapter.permissionModes).toEqual(['on_request', 'full_access']);
    const session = await adapter.createSession(config({ permissionMode: 'full_access' }));
    expect(session).toMatchObject({ modelId: 'gemini-3.8-flash', engineVersion: '1.4.5' });
    const events = collect(adapter, session);
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=yolo model=gemini-3.8-flash-high',
    );
    await adapter.configureSession(session.engineSessionId, {
      modelId: 'gemini-pro-agent',
      permissionMode: 'auto_review',
    });
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=gemini-pro-agent',
    );
    // 会话带来的模型列表存下（Host 重启后不必启动运行体）。
    expect(existsSync(path.join(home, 'engines', 'antigravity', 'models.json'))).toBe(true);
  });

  it('推理档位对到运行体的思考档位：建会话时设，会话中换模型与档位从下一个回合起生效，没有这一档时沿用', async () => {
    writeFakeToken(home);
    const logger = collectingLogger();
    const adapter = new AntigravityAdapter({
      home,
      logger,
      env: { PATH: process.env.PATH, HOME: home },
    });
    adapters.push(adapter);
    await adapter.accounts.setExecutablePath(
      'antigravity',
      path.join(home, 'bin', 'agy_acp_server.par'),
    );
    const session = await adapter.createSession(config({ reasoningEffort: 'low' }));
    expect(session.modelId).toBe('gemini-3.8-flash');
    const events = collect(adapter, session);
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=gemini-3.8-flash-low',
    );
    // xhigh 在这个模型上是 extra_high。
    await adapter.configureSession(session.engineSessionId, {
      modelId: 'gemini-3.1-pro',
      reasoningEffort: 'xhigh',
    });
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=gemini-3.1-pro-extra_high',
    );
    // 非 Gemini 模型（报成 Zed 才有）：换过去不给档位时运行体取最近的一档。
    await adapter.configureSession(session.engineSessionId, { modelId: 'claude-sonnet-4-6' });
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=claude-sonnet-4-6-high',
    );
    // 没有这一档：告警，沿用当前档位，回合照常。
    await adapter.configureSession(session.engineSessionId, {
      modelId: 'claude-sonnet-4-6',
      reasoningEffort: 'minimal',
    });
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=claude-sonnet-4-6-high',
    );
    expect(logger.messages).toContain('Antigravity 的这个模型没有这个思考档位，沿用当前档位');
    // 没有档位的模型：给了档位也只告警。
    await adapter.configureSession(session.engineSessionId, {
      modelId: 'gemini-pro-agent',
      reasoningEffort: 'high',
    });
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=gemini-pro-agent',
    );
  });

  it('1.3 存下的带档位的模型 ID：照样交给运行体，会话落在对应的家族与档位上', async () => {
    writeFakeToken(home);
    const adapter = await create();
    const session = await adapter.createSession(config({ modelId: 'gemini-3.8-flash-low' }));
    expect(session.modelId).toBe('gemini-3.8-flash');
    const events = collect(adapter, session);
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=default model=gemini-3.8-flash-low',
    );
  });

  it('interaction_* 提问：经 requestAnswers 报 question.requested，按 label 回答，换成选项 ID 回复', async () => {
    writeFakeToken(home);
    const adapter = await create();
    const session = await adapter.createSession(config());
    const events = collect(adapter, session);
    await adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'ask me' }] });
    const asked = await waitFor(
      () => events.find((event) => event.type === 'question.requested'),
      '提问',
    );
    expect(asked).toMatchObject({
      toolCallId: 'interaction_9960062f',
      questions: [
        {
          id: 'interaction_9960062f',
          question: 'Which result label should be used for the verification?',
          options: [{ label: 'Verified' }, { label: 'Needs review' }],
        },
      ],
    });
    if (asked.type !== 'question.requested') throw new Error('unreachable');
    // 审批列表里没有它。
    expect(await adapter.listPendingApprovals(session.engineSessionId)).toEqual([]);
    await adapter.respondToQuestion(session.engineSessionId, asked.requestId, {
      interaction_9960062f: ['Needs review'],
    });
    await waitFor(() => events.some((event) => event.type === 'turn.settled'), '回合结束');
    expect(replyText(events)).toBe('You chose 2.');
    await expect(
      adapter.respondToQuestion(session.engineSessionId, asked.requestId, {
        interaction_9960062f: ['1'],
      }),
    ).rejects.toMatchObject({ code: 'question_not_found' });
  });

  it('回答对不上选项（Host 已核对过，这里只是兜底）：回复 cancelled，回合以取消结算', async () => {
    writeFakeToken(home);
    const adapter = await create();
    const session = await adapter.createSession(config());
    const events = collect(adapter, session);
    await adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'ask me' }] });
    const asked = await waitFor(
      () => events.find((event) => event.type === 'question.requested'),
      '提问',
    );
    if (asked.type !== 'question.requested') throw new Error('unreachable');
    await adapter.respondToQuestion(session.engineSessionId, asked.requestId, {
      interaction_9960062f: ['?'],
    });
    await waitFor(() => events.some((event) => event.type === 'turn.settled'), '回合结束');
    expect(events.find((event) => event.type === 'turn.settled')).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('提问挂起时取消：question.cancelled（turn_cancelled），回合以取消结算', async () => {
    writeFakeToken(home);
    const adapter = await create();
    const session = await adapter.createSession(config());
    const events = collect(adapter, session);
    await adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'ask me' }] });
    await waitFor(() => events.some((event) => event.type === 'question.requested'), '提问');
    await adapter.cancel(session.engineSessionId);
    await waitFor(() => events.some((event) => event.type === 'turn.settled'), '回合结束');
    expect(events.find((event) => event.type === 'question.cancelled')).toMatchObject({
      reason: 'turn_cancelled',
    });
    expect(events.find((event) => event.type === 'turn.settled')).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('恢复：新的适配器（Host 重启）用 session/resume 接上，找不到的会话报 session_lost', async () => {
    writeFakeToken(home);
    const first = await create();
    const session = await first.createSession(config({ modelId: 'gemini-pro-agent' }));
    await first.dispose();
    const second = await create();
    const resumed = await second.resumeSession(
      session.engineSessionId,
      config({ modelId: 'gemini-pro-agent' }),
    );
    expect(resumed).toMatchObject({
      engineSessionId: session.engineSessionId,
      modelId: 'gemini-pro-agent',
    });
    const events = collect(second, resumed);
    expect(replyText(await turn(second, resumed, events, 'hello'))).toBe('Hello from Antigravity.');
    await expect(
      second.resumeSession('11111111-1111-4111-8111-111111111111', config()),
    ).rejects.toMatchObject({ code: 'session_lost', lostReason: 'not_found' });
  });

  it('用量：回合结束后读运行体会话库，每次模型请求报一条 usage.recorded；恢复前已有的步骤不再报', async () => {
    writeFakeToken(home);
    const profile = path.join(home, 'engines', 'antigravity', 'profile');
    const first = await create();
    const session = await first.createSession(config());
    const events = collect(first, session);
    const db = stepDatabase(profile, session.engineSessionId);
    db.add(0, 3);
    db.add(1, 3, usageMetadata('resp-a', 1200, 80));
    db.add(2, 3, usageMetadata('resp-b', 300, 40));
    await turn(first, session, events, 'hello');
    const recorded = () => events.filter((event) => event.type === 'usage.recorded');
    await waitFor(() => recorded().length === 2, 'usage.recorded');
    expect(recorded()).toEqual([
      {
        type: 'usage.recorded',
        engineSessionId: session.engineSessionId,
        requestId: 'resp-a',
        inputTokens: 1200,
        outputTokens: 80,
      },
      expect.objectContaining({ requestId: 'resp-b', inputTokens: 300 }),
    ]);
    await first.dispose();

    const second = await create();
    const resumed = await second.resumeSession(session.engineSessionId, config());
    const after = collect(second, resumed);
    db.add(3, 3, usageMetadata('resp-c', 50));
    await turn(second, resumed, after, 'hello');
    await waitFor(() => after.some((event) => event.type === 'usage.recorded'), 'usage.recorded');
    expect(
      after.filter((event) => event.type === 'usage.recorded').map((event) => event.requestId),
    ).toEqual(['resp-c']);
    db.close();
  });

  it('登出：先停掉会话进程（会话以 engine.exited config_changed 脱开），再清掉登录', async () => {
    writeFakeToken(home);
    const adapter = await create();
    const session = await adapter.createSession(config());
    const events = collect(adapter, session);
    expect(adapter.process.state).toBe('ready');
    await adapter.accounts.logout('antigravity');
    await waitFor(() => events.some((event) => event.type === 'engine.exited'), 'engine.exited');
    expect(events.find((event) => event.type === 'engine.exited')).toMatchObject({
      reason: 'config_changed',
    });
    expect(adapter.process.state).toBe('stopped');
    await expect(adapter.createSession(config())).rejects.toMatchObject({
      code: 'missing_credentials',
    });
    // 进程的解包目录不留下。
    await adapter.dispose();
    const tmp = path.join(home, 'engines', 'antigravity', 'tmp');
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([]);
  });
});
