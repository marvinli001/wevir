import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { CursorCredentialFile, cursorCredentialsPath } from './credentials.js';
import {
  agentOptions,
  CursorAdapter,
  type CursorAdapterOptions,
  cursorPermissionModes,
  disallowedTools,
  permissionPolicy,
  SETTING_SOURCES,
} from './cursor-adapter.js';
import { CURSOR_SDK_VERSION } from './sdk.js';
import { FakeCursorSdk, type RunScript, sdkError } from './test-fixtures/fake-sdk.js';
import { PLAIN_UPDATES, TOOL_UPDATES, TRANSPORT_FAILURE_UPDATES } from './test-fixtures/updates.js';

/** mcp.json 里的字面占位符 `${name}`。 */
const v = (name: string) => `\${${name}}`;

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
    userHome: home, // 不读本机的 ~/.cursor
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

function holdSteer() {
  let acknowledge = () => {};
  const promise = new Promise<'complete_delivered'>((resolve) => {
    acknowledge = () => resolve('complete_delivered');
  });
  return { promise, acknowledge };
}

describe('CursorAdapter', () => {
  it('等 SDK 确认内容已进入回合才发出 turn.steered', async () => {
    const { adapter, sdk, home } = setup();
    sdk.script = () => ({ updates: [], hang: true });
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Working'));
    const agent = sdk.agent(engineSessionId);
    const [run] = agent.runs;
    assert(run);
    const ack = holdSteer();
    const steer = vi.spyOn(run, 'steer').mockReturnValue(ack.promise);

    const delivery = adapter.steer(engineSessionId, 'inserted', text('Change direction'));
    expect(steer).toHaveBeenCalledExactlyOnceWith('Change direction');
    expect(events).toEqual([]);
    ack.acknowledge();
    await delivery;
    await until(events, 'turn.steered');
    await adapter.cancel(engineSessionId);

    expect(agent.sent).toHaveLength(1);
    expect(events).toMatchObject([
      { type: 'turn.steered', steerId: 'inserted' },
      { type: 'turn.settled', outcome: 'cancelled' },
    ]);
  });

  it('SDK 拒绝插话时交回 Host 排队，回合继续运行', async () => {
    const { adapter, sdk, home } = setup();
    sdk.script = () => ({ updates: [], hang: true });
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Working'));
    const [run] = sdk.agent(engineSessionId).runs;
    assert(run);
    const steer = vi.spyOn(run, 'steer');
    await expect(
      adapter.steer(engineSessionId, 'rejected', text('Try later')),
    ).rejects.toMatchObject({ code: 'steer_rejected' });
    steer.mockRejectedValueOnce(new Error('SDK transport lost'));
    await expect(adapter.steer(engineSessionId, 'error', text('Try again'))).rejects.toMatchObject({
      code: 'steer_rejected',
      message: expect.stringContaining('SDK transport lost'),
    });
    await expect(
      adapter.steer(engineSessionId, 'image', {
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', path: join(home, 'image.png'), mimeType: 'image/png' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'steer_rejected' });
    expect(steer).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
    expect(run.cancelCalls).toBe(0);
  });

  it('回合取消后忽略迟到的插话确认', async () => {
    const { adapter, sdk, home } = setup();
    sdk.script = () => ({ updates: [], hang: true });
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Working'));
    const ack = holdSteer();
    const [run] = sdk.agent(engineSessionId).runs;
    assert(run);
    vi.spyOn(run, 'steer').mockReturnValue(ack.promise);
    const rejected = expect(
      adapter.steer(engineSessionId, 'late', text('Change direction')),
    ).rejects.toMatchObject({ code: 'steer_rejected' });
    await adapter.cancel(engineSessionId);
    await rejected;
    await adapter.send(engineSessionId, text('Next turn'));
    ack.acknowledge();
    await adapter.cancel(engineSessionId);

    expect(events).toMatchObject([
      { type: 'turn.settled', outcome: 'cancelled' },
      { type: 'turn.settled', outcome: 'cancelled' },
    ]);
  });

  it('手动压缩调用 summarize，报压缩事件，摘要不成为助手回复，之后能继续对话', async () => {
    const { adapter, sdk, home } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'composer-2',
    });
    sdk.script = () => ({ updates: [], result: { result: 'Internal summary' } });
    const { events } = collect(adapter, engineSessionId);
    await adapter.compact(engineSessionId);
    await until(events, 'turn.settled');
    expect(sdk.agent(engineSessionId).summarizeCalls).toBe(1);
    expect(sdk.agent(engineSessionId).sent).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      'context.compacting',
      'context.compacted',
      'turn.settled',
    ]);
    expect(events[0]).toMatchObject({ compactionId: 'run-1', trigger: 'manual' });
    expect(events[1]).toMatchObject({ compactionId: 'run-1', trigger: 'manual' });
    await adapter.send(engineSessionId, text('Continue'));
    await until(events, 'assistant.message');
    expect(sdk.agent(engineSessionId).sent[0]?.message).toBe('Continue');
  });

  it.each(['error', 'cancelled'] as const)('压缩 %s 不报压缩完成', async (status) => {
    const { adapter, sdk, home } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'composer-2',
    });
    sdk.script = () => ({
      updates: [],
      result: { status, error: { message: 'Summarize failed' }, result: 'Internal summary' },
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.compact(engineSessionId);
    await until(events, status === 'error' ? 'turn.failed' : 'turn.settled');
    expect(
      events.some(
        (event) => event.type === 'context.compacted' || event.type === 'assistant.message',
      ),
    ).toBe(false);
  });

  it('压缩与普通回合互斥；停止压缩后可以继续', async () => {
    const { adapter, sdk, home } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'composer-2',
    });
    sdk.script = () => ({ updates: [], hang: true });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Working'));
    await expect(adapter.compact(engineSessionId)).rejects.toMatchObject({ code: 'session_busy' });
    await adapter.cancel(engineSessionId);
    events.length = 0;
    await adapter.compact(engineSessionId);
    await expect(adapter.send(engineSessionId, text('Busy'))).rejects.toMatchObject({
      code: 'session_busy',
    });
    await adapter.cancel(engineSessionId);
    await until(events, 'turn.settled');
    expect(events.at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect(events.some((event) => event.type === 'context.compacted')).toBe(false);
  });

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
      model: {
        id: 'composer-2',
        params: [
          { id: 'effort', value: 'high' },
          { id: 'fast', value: 'false' },
        ],
      },
      local: { cwd: home, autoReview: true, sandboxOptions: { enabled: true } },
    });
    const { events } = collect(adapter, session.engineSessionId);
    await adapter.send(session.engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(agent.sent[0]?.message).toBe('Say hello');
    expect(agent.sent[0]?.options).toMatchObject({
      mode: 'agent',
      model: {
        id: 'composer-2',
        params: [
          { id: 'effort', value: 'high' },
          { id: 'fast', value: 'false' },
        ],
      },
    });
    expect(events.at(-1)).toEqual({
      type: 'turn.settled',
      engineSessionId: 'agent-1',
      outcome: 'completed',
      stopReason: 'finished',
    });

    // 快速模式（0.148.0）：configureSession 之后的 send 带 fast: true。
    await adapter.configureSession(session.engineSessionId, {
      modelId: 'composer-2',
      fast: true,
      permissionMode: 'auto_review',
    });
    await adapter.send(session.engineSessionId, text('Again'));
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'turn.settled')).toHaveLength(2),
    );
    // 没选档位时带默认变体的档位（T3 d3ef7e8e52）。
    expect(agent.sent[1]?.options?.model).toEqual({
      id: 'composer-2',
      params: [
        { id: 'fast', value: 'true' },
        { id: 'effort', value: 'medium' },
      ],
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

    // 本地存储从旧到新列 run：遗留的那个排在 50 个已结束的后面，在第二页。
    sdk.finishedRunCount = 50;
    sdk.activeRunConflicts.set(engineSessionId, 'run-1');
    await adapter.send(engineSessionId, text('Say hello'));
    expect(sdk.cancelledRuns).toEqual(['run-1']);
    expect(sdk.listRunsCalls.map((call) => call.options.cursor)).toEqual([undefined, '50']);
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

  it('回合结束后 SDK 恢复没有进展而报错：回合照常完成、不把恢复写的结果当回答；结束后又开始工作时仍然失败；说明文字之后的传输诊断算失败', async () => {
    const { adapter, sdk, home, warnings } = setup();
    const resumeFailure = {
      status: 'error' as const,
      error: { message: 'Agent turn stopped after repeated resume attempts made no progress' },
    };
    const scripts: Record<string, RunScript> = {
      regenerated: {
        updates: [
          { type: 'text-delta', text: 'The answer.' },
          { type: 'turn-ended' },
          { type: 'text-delta', text: 'A regenerated closing.' },
          { type: 'turn-ended' },
        ],
        result: resumeFailure,
      },
      continued: {
        updates: [
          { type: 'text-delta', text: 'The answer.' },
          { type: 'turn-ended' },
          { type: 'text-delta', text: 'Following up on the stop hook.' },
        ],
        result: resumeFailure,
      },
      silent: {
        updates: [{ type: 'turn-ended' }],
        result: { ...resumeFailure, result: 'A regenerated closing.' },
      },
      commentary: {
        updates: [
          { type: 'text-delta', text: 'Checking the build first.' },
          { type: 'step-completed', stepId: 1, stepDurationMs: 1 },
          { type: 'text-delta', text: 'Error: RetriableError: WritableIterable is closed' },
        ],
      },
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
    const answers = (turn: AgentEvent[]) =>
      turn.flatMap((event) => (event.type === 'assistant.message' ? [event.text] : []));

    const regenerated = await terminal('regenerated');
    expect(regenerated.at(-1)).toEqual({
      type: 'turn.settled',
      engineSessionId,
      outcome: 'completed',
      stopReason: 'finished',
    });
    expect(warnings).toContain('Cursor gave up resuming a run whose turn had already ended');
    expect((await terminal('continued')).at(-1)).toEqual({
      type: 'turn.failed',
      engineSessionId,
      category: 'provider',
      message: 'Agent turn stopped after repeated resume attempts made no progress',
    });
    const silent = await terminal('silent');
    expect(silent.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(answers(silent)).toEqual([]);
    expect((await terminal('commentary')).at(-1)).toEqual({
      type: 'turn.failed',
      engineSessionId,
      category: 'provider',
      message: 'Error: RetriableError: WritableIterable is closed',
    });
  });

  it('用量到了上限：先重读账号的用量再报 turn.failed，带 usageLimit；wait 抛出 RateLimitError 也一样；别的错误不重读', async () => {
    const { adapter, sdk, home } = setup();
    const scripts: Record<string, RunScript> = {
      limit: {
        updates: [],
        result: {
          status: 'error',
          error: { message: "You've hit your usage limit", code: 'PRO_USER_USAGE_LIMIT' },
        },
      },
      error: { updates: [], result: { status: 'error', error: { message: 'model overloaded' } } },
    };
    sdk.script = (message) => scripts[message] ?? { updates: PLAIN_UPDATES };
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    const failedBeforeRefresh: boolean[] = [];
    const refresh = vi.spyOn(adapter.accounts, 'refreshUsage').mockImplementation(async () => {
      failedBeforeRefresh.push(events.some((event) => event.type === 'turn.failed'));
    });
    const terminal = async (message: string) => {
      const from = events.length;
      await adapter.send(engineSessionId, text(message));
      await vi.waitFor(() =>
        expect(events.slice(from).some((event) => event.type === 'turn.failed')).toBe(true),
      );
      return events.slice(from).at(-1);
    };

    expect(await terminal('limit')).toEqual({
      type: 'turn.failed',
      engineSessionId,
      category: 'provider',
      message: "You've hit your usage limit",
      usageLimit: {},
    });
    expect(refresh).toHaveBeenCalledWith('cursor');
    expect(failedBeforeRefresh).toEqual([false]);

    expect(await terminal('error')).not.toHaveProperty('usageLimit');
    expect(refresh).toHaveBeenCalledTimes(1);

    const agent = sdk.agent(engineSessionId);
    const original = agent.send.bind(agent);
    agent.send = async (message, options) => {
      const run = await original(message, options);
      return {
        ...run,
        id: run.id,
        agentId: run.agentId,
        wait: async () =>
          Promise.reject(sdkError('RateLimitError', 'Too many requests', { status: 429 })),
        cancel: () => run.cancel(),
      };
    };
    expect(await terminal('Say hello')).toEqual({
      type: 'turn.failed',
      engineSessionId,
      category: 'provider',
      message: 'Too many requests',
      usageLimit: {},
    });
    expect(refresh).toHaveBeenCalledTimes(2);
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

  it('角色关掉的引擎工具 → disallowedTools（连带 task），新建、恢复与换权限重开都带', async () => {
    expect(disallowedTools(undefined)).toEqual([]);
    expect(disallowedTools([])).toEqual([]);
    expect(disallowedTools(['edit'])).toEqual(['edit', 'delete', 'applyAgentDiff', 'task']);
    expect(agentOptions({ apiKey: 'k', cwd: '/w', modelId: 'auto' })).not.toHaveProperty(
      'disallowedTools',
    );
    const { adapter, sdk, home } = setup();
    const engineTools = { denied: ['edit' as const, 'web' as const], deniedNames: [] };
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
      engineTools,
    });
    const expected = ['edit', 'delete', 'applyAgentDiff', 'webSearch', 'webFetch', 'fetch', 'task'];
    expect(sdk.agent(engineSessionId).options.disallowedTools).toEqual(expected);
    const { events } = collect(adapter, engineSessionId);
    await adapter.configureSession(engineSessionId, {
      modelId: 'auto',
      permissionMode: 'full_access',
    });
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(sdk.agents).toHaveLength(2);
    expect(sdk.agent(engineSessionId).options.disallowedTools).toEqual(expected);
    await adapter.close(engineSessionId);
    await adapter.resumeSession(engineSessionId, {
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
      engineTools,
    });
    expect(sdk.agents).toHaveLength(3);
    expect(sdk.agent(engineSessionId).options.disallowedTools).toEqual(expected);
    expect(adapter.engineToolEnforcement.classes).toEqual(['read', 'edit', 'shell', 'web']);
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

  it('关闭缓存有界，淘汰后仍可按持久化 ID 恢复', async () => {
    const { adapter, home } = setup();
    const config = { cwd: home, providerId: 'cursor', modelId: 'auto' };
    let first = '';
    for (let i = 0; i < 40; i += 1) {
      const { engineSessionId } = await adapter.createSession(config);
      if (i === 0) first = engineSessionId;
      await adapter.close(engineSessionId);
    }
    expect(() => adapter.subscribe(first)).toThrow();
    expect(await adapter.resumeSession(first, config)).toMatchObject({ engineSessionId: first });
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

  it('回合结束时从检查点报上下文用量（T3 c165587702）；没有检查点、上限是 0 或读不到时不报，回合照常结束', async () => {
    const { adapter, sdk, home, warnings } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    sdk.checkpoints.set(engineSessionId, {
      tokenDetails: { usedTokens: 8_304, maxTokens: 200_000 },
    });
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(sdk.loadCheckpointCalls).toEqual([{ agentId: engineSessionId, cwd: home }]);
    const fill = events.findIndex((event) => event.type === 'usage.updated');
    expect(events[fill]).toEqual({
      type: 'usage.updated',
      engineSessionId,
      contextUsed: 8_304,
      contextSize: 200_000,
    });
    expect(fill).toBeLessThan(events.findIndex((event) => event.type === 'turn.settled'));

    for (const checkpoint of [
      null,
      { tokenDetails: { usedTokens: 0, maxTokens: 0 } },
      new Error('store locked'),
    ]) {
      events.length = 0;
      sdk.checkpoints.set(engineSessionId, checkpoint);
      await adapter.send(engineSessionId, text('Say hello'));
      await until(events, 'turn.settled');
      expect(events.some((event) => event.type === 'usage.updated')).toBe(false);
    }
    expect(warnings).toContain('Cursor context usage unavailable');
  });

  it('在第一个检查点之前取消的 run 被 Cursor 丢掉：下一条消息带上它的请求；有了自己的检查点或压缩不带（T3 d313b2aff3、0b308312d5）', async () => {
    const { adapter, sdk, home } = setup();
    sdk.script = (message): RunScript =>
      message.startsWith('hang') || message.startsWith('Your previous turn')
        ? { updates: [], hang: true }
        : { updates: PLAIN_UPDATES };
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
    });
    const { events } = collect(adapter, engineSessionId);
    const settled = () => events.filter((event) => event.type === 'turn.settled').length;
    const sent = () => sdk.agent(engineSessionId).sent.map((entry) => entry.message);

    await adapter.send(engineSessionId, text('hang: refactor the parser'));
    await adapter.cancel(engineSessionId);
    await vi.waitFor(() => expect(settled()).toBe(1));
    // 压缩不带，也不清掉。
    sdk.script = () => ({ updates: [] });
    await adapter.compact(engineSessionId);
    await vi.waitFor(() => expect(settled()).toBe(2));
    sdk.script = (message): RunScript =>
      message.endsWith('also add tests') ? { updates: [], hang: true } : { updates: PLAIN_UPDATES };
    await adapter.send(engineSessionId, text('also add tests'));
    expect(sent().at(-1)).toBe(
      'Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\nhang: refactor the parser\n\nThe new message, which may continue or change that request:\n\nalso add tests',
    );
    // 这一次也在检查点之前取消：带上的是整段（含更早的请求）。
    await adapter.cancel(engineSessionId);
    await vi.waitFor(() => expect(settled()).toBe(3));
    await adapter.send(engineSessionId, text('go on'));
    await vi.waitFor(() => expect(settled()).toBe(4));
    expect(sent().at(-1)).toMatch(
      /^Your previous turn[\s\S]*hang: refactor the parser[\s\S]*also add tests[\s\S]*go on$/,
    );
    // 送出之后不再带。
    await adapter.send(engineSessionId, text('next'));
    await vi.waitFor(() => expect(settled()).toBe(5));
    expect(sent().at(-1)).toBe('next');

    // run 存过自己的检查点：请求还在对话里，不带。
    sdk.script = (message): RunScript =>
      message === 'kept' ? { updates: [], hang: true } : { updates: PLAIN_UPDATES };
    await adapter.send(engineSessionId, text('kept'));
    const kept = sdk.agent(engineSessionId).runs.at(-1);
    await adapter.cancel(engineSessionId);
    await vi.waitFor(() => expect(settled()).toBe(6));
    sdk.checkpointedRuns.add(kept?.id ?? '');
    await adapter.send(engineSessionId, text('after kept'));
    await vi.waitFor(() => expect(settled()).toBe(7));
    expect(sent().at(-1)).toBe('after kept');
  });

  it('mcp.json 里用了工作区变量的服务展开后随每次 send 交出，应用级工具一起给；没有这类服务时 send 不带 mcpServers（T3 cc97303381）', async () => {
    const { adapter, sdk, home } = setup();
    const { engineSessionId } = await adapter.createSession({
      cwd: home,
      providerId: 'cursor',
      modelId: 'auto',
      appTools: { url: 'http://127.0.0.1:4100/mcp', token: 't' },
    });
    const { events } = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(sdk.agent(engineSessionId).sent[0]?.options).not.toHaveProperty('mcpServers');

    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      `{ "mcpServers": { "repro": { "command": "node", "args": ["${v('workspaceFolder')}/server.mjs"] } } }`,
    );
    events.length = 0;
    await adapter.send(engineSessionId, text('Say hello'));
    await until(events, 'turn.settled');
    expect(sdk.agent(engineSessionId).sent[1]?.options?.mcpServers).toEqual({
      repro: { command: 'node', args: [`${home}/server.mjs`], cwd: home },
      wevir: {
        type: 'http',
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer t' },
      },
    });
  });

  it('CURSOR_SDK_VERSION 与装上的 @cursor/sdk 一致', () => {
    const entry = fileURLToPath(import.meta.resolve('@cursor/sdk'));
    const manifest = join(dirname(entry), '..', '..', 'package.json');
    expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe(CURSOR_SDK_VERSION);
  });
});
