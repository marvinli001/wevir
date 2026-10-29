import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorCredentialFile, cursorCredentialsPath } from './credentials.js';
import {
  agentOptions,
  CursorAdapter,
  type CursorAdapterOptions,
  cursorPermissionModes,
  permissionPolicy,
  SETTING_SOURCES,
} from './cursor-adapter.js';
import { CURSOR_SDK_VERSION } from './sdk.js';
import { FakeCursorSdk, type RunScript, sdkError } from './test-fixtures/fake-sdk.js';
import { PLAIN_UPDATES, TOOL_UPDATES, TRANSPORT_FAILURE_UPDATES } from './test-fixtures/updates.js';

const dirs: string[] = [];
const adapters: CursorAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Partial<CursorAdapterOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wevir-cursor-adapter-'));
  dirs.push(home);
  const sdk = new FakeCursorSdk();
  const warnings: string[] = [];
  const adapter = new CursorAdapter({
    home,
    env: { CURSOR_API_KEY: 'test-key' },
    sdk: async () => sdk,
    logger: { warn: (message) => warnings.push(message) },
    platform: 'linux', // Windows 只有完全访问，单独的用例传 win32
    ...options,
  });
  adapters.push(adapter);
  return { home, sdk, adapter, warnings };
}

/** 收集一个会话的事件，直到订阅结束。 */
function collect(adapter: CursorAdapter, id: string) {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of adapter.subscribe(id)) events.push(event);
  })();
  return { events, done };
}

async function until(events: AgentEvent[], type: AgentEvent['type']): Promise<AgentEvent> {
  await vi.waitFor(() => expect(events.some((event) => event.type === type)).toBe(true), {
    timeout: 3000,
  });
  return events.find((event) => event.type === type) as AgentEvent;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

describe('CursorAdapter', () => {
  it('应用级工具（0.30.0）：会话带 appTools 时选项里有 HTTP 的 wevir 服务', () => {
    const options = agentOptions({
      apiKey: 'k',
      cwd: '/w',
      modelId: 'auto',
      appTools: { url: 'http://127.0.0.1:4100/mcp', token: 't' },
    });
    expect(options.mcpServers).toEqual({
      wevir: {
        type: 'http',
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer t' },
      },
    });
    expect(agentOptions({ apiKey: 'k', cwd: '/w', modelId: 'auto' }).mcpServers).toBeUndefined();
  });

  it('权限模式 → 沙箱与 Auto-review；建 agent 的选项带 cwd、Key、全部设置层与重试', () => {
    expect(permissionPolicy(undefined)).toEqual({ autoReview: false, sandboxEnabled: true });
    expect(permissionPolicy('on_request')).toEqual({ autoReview: false, sandboxEnabled: true });
    expect(permissionPolicy('auto_review')).toEqual({ autoReview: true, sandboxEnabled: true });
    expect(permissionPolicy('full_access')).toEqual({ autoReview: false, sandboxEnabled: false });
    expect(
      agentOptions({ apiKey: 'k', cwd: '/w', modelId: 'auto', permissionMode: 'full_access' }),
    ).toEqual({
      model: { id: 'default' },
      name: 'Wevir',
      mode: 'agent',
      apiKey: 'k',
      local: {
        cwd: '/w',
        autoReview: false,
        settingSources: [...SETTING_SOURCES],
        sandboxOptions: { enabled: false },
        enableAgentRetries: true,
      },
    });
  });

  it('建会话：agentId 是引擎会话 ID，带 SDK 版本；send 带会话的模型与推理档位', async () => {
    const { adapter, sdk, home } = setup();
    const session = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'composer-2',
      reasoningEffort: 'high',
      permissionMode: 'auto_review',
    });
    expect(session).toEqual({
      engineSessionId: 'agent-1',
      modelId: 'composer-2',
      reasoningEffort: 'high',
      engineVersion: CURSOR_SDK_VERSION,
    });
    const agent = sdk.agent('agent-1');
    expect(agent.options).toMatchObject({
      apiKey: 'test-key',
      model: { id: 'composer-2', params: [{ id: 'effort', value: 'high' }] },
      local: { cwd: home, autoReview: true, sandboxOptions: { enabled: true } },
    });
    const { events } = collect(adapter, session.engineSessionId);
    await adapter.send(session.engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(agent.sent[0]?.message).toBe('Say hello');
    expect(agent.sent[0]?.options).toMatchObject({
      mode: 'agent',
      model: { id: 'composer-2', params: [{ id: 'effort', value: 'high' }] },
    });
    expect(events.at(-1)).toEqual({
      type: 'turn.settled',
      engineSessionId: 'agent-1',
      outcome: 'completed',
      stopReason: 'finished',
    });
  });

  it('没有 Key 时建会话报 missing_credentials；工作目录不存在报 invalid_input', async () => {
    const { adapter, home } = setup({ env: {} });
    await expect(
      adapter.createSession({ cwd: home, providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({ code: 'missing_credentials' });
    await expect(
      adapter.createSession({ cwd: join(home, 'missing'), providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('登录存下的 Key 也能用（没有 CURSOR_API_KEY 时）', async () => {
    const { adapter, sdk, home } = setup({ env: {} });
    await new CursorCredentialFile(cursorCredentialsPath(home)).save({
      version: 1,
      backendUrl: 'https://api2.cursor.sh',
      apiKey: 'stored-key',
      createdAtMs: 0,
    });
    await adapter.createSession({ cwd: home, providerId: 'cursor', modelId: 'auto' });
    expect(sdk.agent('agent-1').options.apiKey).toBe('stored-key');
  });

  it('run 开出之前来的更新先存着，send 返回后按顺序映射', async () => {
    const { adapter, sdk, home } = setup();
    sdk.deltaBeforeSend = true;
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(events[0]).toMatchObject({
      type: 'assistant.delta',
      kind: 'reasoning',
      text: 'The user ',
    });
    expect(events.filter((event) => event.type === 'assistant.message')).toHaveLength(1);
  });

  it('回合进行中再 send 报 session_busy；取消：没完成的工具按失败收尾，回合以取消结算，之后能接着发', async () => {
    const { adapter, sdk, home } = setup();
    sdk.script = (message): RunScript =>
      message === 'hang'
        ? { updates: TOOL_UPDATES.slice(0, 2), hang: true }
        : { updates: PLAIN_UPDATES };
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('hang'));
    await until(events, 'tool.updated');
    await expect(adapter.send(engineSessionId, text('again'))).rejects.toMatchObject({
      code: 'session_busy',
    });
    await adapter.cancel(engineSessionId);
    await until(events, 'turn.settled');
    expect(events.slice(-2)).toEqual([
      {
        type: 'tool.finished',
        engineSessionId,
        toolCallId: 'call-shell',
        status: 'failed',
        output: 'total 8\n',
      },
      { type: 'turn.settled', engineSessionId, outcome: 'cancelled', stopReason: 'cancelled' },
    ]);
    await adapter.cancel(engineSessionId);
    await adapter.send(engineSessionId, text('Say hello'));
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ outcome: 'completed' }));
  });

  it('取消在时限内得不到确认：这边按取消结算并告警；下一条消息撞上没停的 run 时取消它再发', async () => {
    const { adapter, sdk, home, warnings } = setup({ cancelTimeoutMs: 30 });
    sdk.script = (message): RunScript =>
      message === 'stuck'
        ? { updates: [{ type: 'text-delta', text: 'working' }], hang: true, ignoreCancel: true }
        : { updates: PLAIN_UPDATES };
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('stuck'));
    await until(events, 'assistant.delta');
    await adapter.cancel(engineSessionId);
    expect(warnings).toContain('Cursor run did not stop in time; settling it as cancelled');
    await until(events, 'turn.settled');
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    // 部分回答保留成已提交消息。
    expect(events.some((event) => event.type === 'assistant.message')).toBe(true);

    sdk.activeRunConflicts.set(engineSessionId, 'run-1');
    await adapter.send(engineSessionId, text('Say hello'));
    expect(sdk.cancelledRuns).toEqual(['run-1']);
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ outcome: 'completed' }));
  });

  it('run 以 error 结束是 turn.failed；认证类是 missing_credentials；wait 抛错是 unknown；回答只是传输诊断也算失败', async () => {
    const { adapter, sdk, home } = setup();
    const scripts: Record<string, RunScript> = {
      error: { updates: [], result: { status: 'error', error: { message: 'model overloaded' } } },
      auth: {
        updates: [],
        result: { status: 'error', error: { message: 'Unauthenticated', code: 'unauthenticated' } },
      },
      transport: { updates: TRANSPORT_FAILURE_UPDATES },
      silent: { updates: [], result: { result: 'Only the final answer' } },
    };
    sdk.script = (message) => scripts[message] ?? { updates: PLAIN_UPDATES };
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    const terminal = async (message: string) => {
      const from = events.length;
      await adapter.send(engineSessionId, text(message));
      await vi.waitFor(() =>
        expect(
          events
            .slice(from)
            .some((event) => event.type === 'turn.failed' || event.type === 'turn.settled'),
        ).toBe(true),
      );
      return events.slice(from);
    };
    expect((await terminal('error')).at(-1)).toEqual({
      type: 'turn.failed',
      engineSessionId,
      category: 'provider',
      message: 'model overloaded',
    });
    expect((await terminal('auth')).at(-1)).toMatchObject({ category: 'missing_credentials' });
    expect((await terminal('transport')).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message: 'Error: ConnectError: [unavailable] upstream connect error',
    });
    const silent = await terminal('silent');
    expect(silent).toEqual([
      {
        type: 'assistant.message',
        engineSessionId,
        messageId: 'run-4:result',
        text: 'Only the final answer',
        replaces: [],
      },
      { type: 'turn.settled', engineSessionId, outcome: 'completed', stopReason: 'finished' },
    ]);

    const agent = sdk.agent(engineSessionId);
    const original = agent.send.bind(agent);
    agent.send = async (message, options) => {
      const run = await original(message, options);
      return {
        ...run,
        id: run.id,
        agentId: run.agentId,
        wait: async () => Promise.reject(new Error('stream reset')),
        cancel: () => run.cancel(),
      };
    };
    expect((await terminal('Say hello')).at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'unknown',
      message: 'stream reset',
    });
  });

  it('恢复：挂着时不问 SDK；SDK 没有这个 agent 报 session_lost；关闭后恢复能继续', async () => {
    const { adapter, sdk, home } = setup();
    await expect(
      adapter.resumeSession('agent-unknown', { cwd: home, providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({ code: 'session_lost', lostReason: 'not_found' });
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    await adapter.resumeSession(engineSessionId, {
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    expect(sdk.agents).toHaveLength(1);
    await adapter.close(engineSessionId);
    expect(sdk.agent(engineSessionId).closed).toBe(true);
    await expect(adapter.send(engineSessionId, text('hi'))).rejects.toMatchObject({
      code: 'session_closed',
    });
    expect(() => adapter.subscribe(engineSessionId)).toThrow(/not attached/);
    const resumed = await adapter.resumeSession(engineSessionId, {
      cwd: home,
      providerId: 'cursor',
      modelId: 'gpt-6',
    });
    expect(resumed.modelId).toBe('gpt-6');
    expect(sdk.agents).toHaveLength(2);
    expect(sdk.agent(engineSessionId).options.model).toEqual({ id: 'gpt-6' });
  });

  it('Windows 只有完全访问：别的模式的会话发消息时说明原因，不替用户升成完全访问', async () => {
    expect(cursorPermissionModes('win32')).toEqual(['full_access']);
    expect(cursorPermissionModes('darwin')).toEqual(['on_request', 'auto_review', 'full_access']);
    expect(cursorPermissionModes('linux')).toEqual(['on_request', 'auto_review', 'full_access']);
    const { adapter, sdk, home } = setup({ platform: 'win32' });
    expect(adapter.permissionModes).toEqual(['full_access']);
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    await expect(adapter.send(engineSessionId, text('Say hello'))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('full access'),
    });
    expect(sdk.agent(engineSessionId).sent).toEqual([]);
    const { events } = collect(adapter, engineSessionId);
    await adapter.configureSession(engineSessionId, {
      modelId: 'auto',
      permissionMode: 'full_access',
    });
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(sdk.agent(engineSessionId).options.local).toMatchObject({
      sandboxOptions: { enabled: false },
    });
  });

  it('换模型只影响下一个回合的 send；换权限模式在下一个回合前按新设置重新打开 agent', async () => {
    const { adapter, sdk, home } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.configureSession(engineSessionId, { modelId: 'gpt-6' });
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(sdk.agents).toHaveLength(1);
    expect(sdk.agent(engineSessionId).sent[0]?.options?.model).toEqual({ id: 'gpt-6' });

    await adapter.configureSession(engineSessionId, {
      modelId: 'gpt-6',
      permissionMode: 'full_access',
    });
    const from = events.length;
    await adapter.send(engineSessionId, text('Say hello'));
    await vi.waitFor(() =>
      expect(events.slice(from).some((e) => e.type === 'turn.settled')).toBe(true),
    );
    expect(sdk.agents).toHaveLength(2);
    expect(sdk.agents[0]?.closed).toBe(true);
    expect(sdk.agent(engineSessionId).options.local).toMatchObject({
      sandboxOptions: { enabled: false },
      autoReview: false,
    });
    await expect(adapter.configureSession('agent-x', { modelId: 'auto' })).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('没有审批：未决审批总是空，回复报 approval_not_found', async () => {
    const { adapter, home } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    expect(await adapter.listPendingApprovals()).toEqual([]);
    await expect(
      adapter.respondToApproval(engineSessionId, 'r1', { optionId: 'allow' }),
    ).rejects.toMatchObject({ code: 'approval_not_found' });
    await expect(
      adapter.respondToApproval('agent-x', 'r1', { optionId: 'allow' }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
  });

  it('登出：挂着的会话都停下、以 engine.exited 脱开（回合中的工具按失败收尾），重新登录后能恢复', async () => {
    const { adapter, sdk, home } = setup({ env: {} });
    const path = cursorCredentialsPath(home);
    await new CursorCredentialFile(path).save({
      version: 1,
      backendUrl: 'x',
      apiKey: 'stored-key',
      createdAtMs: 0,
    });
    sdk.script = () => ({ updates: TOOL_UPDATES.slice(0, 1), hang: true });
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events, done } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('work'));
    await until(events, 'tool.started');
    await adapter.accounts.logout('cursor');
    await done;
    expect(events.slice(-2)).toEqual([
      { type: 'tool.finished', engineSessionId, toolCallId: 'call-shell', status: 'failed' },
      {
        type: 'engine.exited',
        engineSessionId,
        exitCode: null,
        signal: null,
        stderrTail: 'signed out of Cursor; sign in again and resume the session',
      },
    ]);
    expect(sdk.agent(engineSessionId).runs[0]?.cancelCalls).toBe(1);
    await expect(adapter.send(engineSessionId, text('x'))).rejects.toMatchObject({
      code: 'session_closed',
    });
    await expect(
      adapter.resumeSession(engineSessionId, { cwd: home, providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({ code: 'missing_credentials' });
    await adapter.accounts.login('cursor', 'browser');
    sdk.completeLogin('new-key');
    await vi.waitFor(async () => expect(await adapter.accounts.requireApiKey()).toBe('new-key'));
    await adapter.resumeSession(engineSessionId, {
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    expect(sdk.agent(engineSessionId).options.apiKey).toBe('new-key');
  });

  it('dispose：进行中的 run 取消、agent 关闭、订阅结束，之后的调用报 disposed', async () => {
    const { adapter, sdk, home } = setup();
    sdk.script = () => ({ updates: [], hang: true });
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { done } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('work'));
    await adapter.dispose();
    await done;
    expect(sdk.agent(engineSessionId).closed).toBe(true);
    expect(sdk.agent(engineSessionId).runs[0]?.cancelCalls).toBe(1);
    await expect(
      adapter.createSession({ cwd: home, providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({ code: 'disposed' });
    await adapter.dispose();
  });

  it('SDK 建 agent 失败：认证类是 missing_credentials，其余 engine_unavailable', async () => {
    const { adapter, sdk, home } = setup();
    sdk.createAgent = async () => {
      throw sdkError('AuthenticationError', 'bad key');
    };
    await expect(
      adapter.createSession({ cwd: home, providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({
      code: 'missing_credentials',
      message: 'Cursor agent create failed: bad key',
    });
    sdk.createAgent = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      adapter.createSession({ cwd: home, providerId: 'cursor', modelId: 'auto' }),
    ).rejects.toMatchObject({ code: 'engine_unavailable' });
  });

  it('CURSOR_SDK_VERSION 与装上的 @cursor/sdk 一致', () => {
    const entry = fileURLToPath(import.meta.resolve('@cursor/sdk'));
    const manifest = join(dirname(entry), '..', '..', 'package.json');
    expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe(CURSOR_SDK_VERSION);
  });
});
