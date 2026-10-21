import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentEvent, isAdapterError, isTurnTerminal } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { CODEX_VERSION } from './paths.js';
import { codexBinaryOrSkip, newAdapter, TempDirs } from './test-fixtures/harness.js';
import {
  defaultMockScript,
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

// 真实 codex-app-server + 网关 + mock 模型：握手、Provider 变更（不重启 / 空闲时重启 / 等回合结束）、版本核对。契约条款在
// codex-adapter.contract.integration.test.ts；审批、恢复与取消、计划与错误、标题、子会话在
// codex-adapter.{approval,resume,turn,subagent}.integration.test.ts。

const binary = codexBinaryOrSkip('adapter-codex 集成测试');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = defaultMockScript;
const adapters: CodexAdapter[] = [];

function adapter(options: Partial<Parameters<typeof newAdapter>[0]> = {}): {
  adapter: CodexAdapter;
  workspace: string;
  home: string;
} {
  const { home, workspace } = dirs.make('it');
  const created = newAdapter({ home, providers: [mockProvider(mock)], ...options });
  adapters.push(created);
  return { adapter: created, workspace, home };
}

/** 订阅并发一条消息，等这个回合的终结事件；返回回合内的全部事件。 */
async function turn(
  a: CodexAdapter,
  id: string,
  text: string,
  events: AgentEvent[],
): Promise<AgentEvent[]> {
  const from = events.length;
  await a.send(id, { content: [{ type: 'text', text }] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const done = events.slice(from).findIndex(isTurnTerminal);
    if (done >= 0) return events.slice(from, from + done + 1);
    if (Date.now() > deadline)
      throw new Error(`回合没有结束：${events.slice(from).map((e) => e.type)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function collect(a: CodexAdapter, id: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of a.subscribe(id)) events.push(event);
  })();
  return events;
}

async function waitFor(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(binary === undefined)(
  'CodexAdapter + 真实 codex-app-server',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => script(view));
    });
    afterEach(async () => {
      script = defaultMockScript;
      await Promise.allSettled(adapters.splice(0).map((a) => a.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('握手：clientInfo 是 wevir 与 Host 版本，CODEX_HOME 在数据目录里；配置带 --strict-config 通过', async () => {
      const { adapter: a } = adapter({ clientInfo: { name: 'wevir', version: '9.8.7' } });
      const init = await a.process.start();
      // originator 是 clientInfo.name，后面带 Codex 的版本；clientInfo 的名字与版本在末尾（codex-notes §2.1）。
      expect(init.userAgent).toMatch(/^wevir\/0\.163\.0 .*\(wevir; 9\.8\.7\)$/);
      expect(init.codexHome).toBe(a.paths.codexHome);
      const toml = readFileSync(a.paths.configFile, 'utf8');
      expect(toml).toContain(`base_url = "${a.gateway?.baseURL('mock')}"`);
    });

    it('会话：thread/start 的模型与版本；用量的上下文大小取模型目录；选不上的 Provider 与模型报 invalid_input', async () => {
      const { adapter: a, workspace } = adapter();
      const session = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      expect(session).toMatchObject({ modelId: MOCK_MODEL, engineVersion: CODEX_VERSION });
      const events = collect(a, session.engineSessionId);
      const result = await turn(a, session.engineSessionId, 'hi', events);
      expect(result.find((e) => e.type === 'usage.updated')).toMatchObject({
        contextSize: 128_000,
      });
      // 每次请求的用量（0.62.0）：模型是会话的，回合开始量起的时长与首个 token。
      expect(result.filter((e) => e.type === 'usage.recorded')).toEqual([
        expect.objectContaining({
          model: MOCK_MODEL,
          requestId: expect.stringMatching(/:\d+$/),
          durationMs: expect.any(Number),
          firstTokenMs: expect.any(Number),
        }),
      ]);
      // 基础提示词是 Wevir 的 base.md，按会话的 Provider 与模型渲染（模型请求里的第一条 developer 消息）。
      const first = mock.requests.at(-1)?.body.input[0];
      expect(JSON.stringify(first)).toContain('底层模型是 Wevir Mock，由 Wevir Mock 提供');

      for (const config of [
        { cwd: workspace, providerId: 'nope', modelId: MOCK_MODEL },
        { cwd: workspace, providerId: 'mock', modelId: 'nope' },
      ]) {
        const error = await a.createSession(config).catch((e: unknown) => e);
        expect(isAdapterError(error, 'invalid_input')).toBe(true);
      }
      // 不是 Codex 的 thread ID：引擎里不可能有这个会话（resume-error.ts）。
      const resumed = await a
        .resumeSession('not-open', { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL })
        .catch((e: unknown) => e);
      expect(isAdapterError(resumed, 'session_lost')).toBe(true);
    });

    it('新增 Provider（模型目录不变）：不重启进程，新会话经 thread/start 的覆盖用上它', async () => {
      const { adapter: a, workspace } = adapter();
      const first = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const firstEvents = collect(a, first.engineSessionId);
      const pid = a.process.pid;
      await a.configureProviders([
        mockProvider(mock),
        mockProvider(mock, { id: 'mock-two', displayName: 'Mock Two' }),
      ]);
      expect(a.process.pid).toBe(pid);
      const second = await a.createSession({
        cwd: workspace,
        providerId: 'mock-two',
        modelId: MOCK_MODEL,
      });
      const events = collect(a, second.engineSessionId);
      const result = await turn(a, second.engineSessionId, 'hi', events);
      expect(result.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(JSON.stringify(mock.requests.at(-1)?.body.input[0])).toContain('由 Mock Two 提供');
      // 原来的会话没受影响。
      expect(firstEvents.some((e) => e.type === 'engine.exited')).toBe(false);
      expect((await turn(a, first.engineSessionId, 'hi', firstEvents)).at(-1)?.type).toBe(
        'turn.settled',
      );
    });

    it('模型目录变了：空闲时立即重启，会话以 engine.exited(config_changed) 脱开，新模型有 apply_patch', async () => {
      const { adapter: a, workspace } = adapter();
      const old = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const oldEvents = collect(a, old.engineSessionId);
      const pid = a.process.pid;
      const added = mockProvider(mock, {
        models: [
          { id: MOCK_MODEL, contextWindow: 128_000 },
          { id: 'wevir-mock-2', contextWindow: 64_000 },
        ],
      });
      await a.configureProviders([added]);
      expect(a.process.pid).not.toBe(pid);
      await waitFor(() => oldEvents.some((e) => e.type === 'engine.exited'), 'engine.exited');
      expect(oldEvents.at(-1)).toMatchObject({
        type: 'engine.exited',
        reason: 'config_changed',
        exitCode: null,
      });

      const session = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: 'wevir-mock-2',
      });
      const events = collect(a, session.engineSessionId);
      const result = await turn(a, session.engineSessionId, 'hi', events);
      expect(result.find((e) => e.type === 'usage.updated')).toMatchObject({ contextSize: 64_000 });
      const tools = (mock.requests.at(-1)?.body.tools ?? []).map((t) => t.name ?? t.type);
      expect(tools).toContain('apply_patch');
    });

    it('模型目录变了而有回合在跑：等回合结束再重启', async () => {
      const { adapter: a, workspace } = adapter();
      const session = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const events = collect(a, session.engineSessionId);
      script = () => ({ text: Array.from({ length: 10 }, () => 'slow '), delayMs: 50 });
      await a.send(session.engineSessionId, { content: [{ type: 'text', text: 'slow' }] });
      const pid = a.process.pid;
      await a.configureProviders([
        mockProvider(mock, { models: [{ id: MOCK_MODEL }, { id: 'another' }] }),
      ]);
      expect(a.process.pid).toBe(pid);
      await waitFor(() => events.some((e) => e.type === 'turn.settled'), 'turn.settled');
      await waitFor(() => events.some((e) => e.type === 'engine.exited'), 'engine.exited');
      const settled = events.findIndex((e) => e.type === 'turn.settled');
      expect(events.findIndex((e) => e.type === 'engine.exited')).toBeGreaterThan(settled);
      await waitFor(() => a.process.state === 'ready' && a.process.pid !== pid, '新进程');
    });

    it('Provider 的 compat 交给网关：supportsCustomTools false 时 apply_patch 摊平成函数，补丁照常生效', async () => {
      const { adapter: a, workspace } = adapter({
        providers: [mockProvider(mock, { compat: { supportsCustomTools: false } })],
      });
      const session = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const events = collect(a, session.engineSessionId);
      const result = await turn(a, session.engineSessionId, '写个补丁', events);
      const tools = mock.requests.at(-1)?.body.tools ?? [];
      expect(tools.some((tool) => tool.type === 'custom')).toBe(false);
      expect(tools.some((tool) => tool.type === 'function' && tool.name === 'apply_patch')).toBe(
        true,
      );
      expect(result.find((e) => e.type === 'tool.finished')).toMatchObject({ status: 'completed' });
      expect(readFileSync(join(workspace, 'wevir-mock.txt'), 'utf8')).toContain(
        'hello from the Wevir mock model',
      );
    });

    it.skipIf(process.platform === 'win32')(
      '二进制版本不对：建会话失败，说明锁定的版本',
      async () => {
        const { root } = dirs.make('fake-bin');
        const fake = join(root, 'codex-app-server');
        writeFileSync(fake, '#!/bin/sh\necho "codex-app-server 0.1.0"\n');
        chmodSync(fake, 0o755);
        const { adapter: a, workspace } = adapter({ binary: fake });
        const error = await a
          .createSession({ cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL })
          .catch((e: unknown) => e);
        expect(isAdapterError(error, 'engine_unavailable')).toBe(true);
        expect(String((error as Error).message)).toContain(`适配器锁定的是 ${CODEX_VERSION}`);
      },
    );
  },
);
