// AntigravityAdapter 在契约之外的行为，跑在假运行体上：没登录时建会话、权限模式与会话中换设置、借审批方法的提问、
// 恢复、登出时停掉进程、会话带来的模型列表。

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function create(): Promise<AntigravityAdapter> {
  const adapter = new AntigravityAdapter({
    home,
    logger: collectingLogger(),
    env: { PATH: process.env.PATH, HOME: home },
  });
  adapters.push(adapter);
  await adapter.accounts.setExecutablePath(
    'antigravity',
    path.join(home, 'bin', 'agy_acp_server.par'),
  );
  return adapter;
}

function config(extra: Partial<SessionConfig> = {}): SessionConfig {
  return { cwd: workspace, providerId: 'antigravity', modelId: 'gemini-3.7-flash-high', ...extra };
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
    const session = await adapter.createSession(config({ permissionMode: 'full_access' }));
    expect(session).toMatchObject({ modelId: 'gemini-3.7-flash-high', engineVersion: '1.3.0' });
    const events = collect(adapter, session);
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=yolo model=gemini-3.7-flash-high',
    );
    await adapter.configureSession(session.engineSessionId, {
      modelId: 'gemini-pro-agent',
      permissionMode: 'auto_review',
    });
    expect(replyText(await turn(adapter, session, events, 'mode?'))).toBe(
      'mode=auto_edit model=gemini-pro-agent',
    );
    // 会话带来的模型列表存下（Host 重启后不必启动运行体）。
    expect(existsSync(path.join(home, 'engines', 'antigravity', 'models.json'))).toBe(true);
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
