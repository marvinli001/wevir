// R2：wevir-host --adapter codex 接通。runHostCli 在进程内运行（信号与 stdout 是假的），适配器由默认的 createAdapter
// 建：真实 CodexRuntime（网关进程：codex-app-server + Host 进程里的模型网关；ChatGPT 进程不用到就不启动）。Provider 是 @wevir/adapter-codex/testing 的本地
// Responses mock，经 provider.upsert 登记，不需要 Key。客户端只走 Host API：建会话 → 一问一答 → 一次工具调用 →
// SIGTERM 优雅退出，codex-app-server 随适配器回收。没有 codex-app-server 时跳过并打印下载命令。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_VERSION, type CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import { MOCK_MODEL, startMockModel } from '@wevir/adapter-codex/testing';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter, EXIT_CODE, runHostCli } from './cli.js';
import { EngineRouter } from './engine-router.js';
import { LOG_FILE } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { fakeProcess, TestRpcClient, useTempDir, waitReady } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function binaryAvailable(): boolean {
  try {
    resolveCodexBinary();
    return true;
  } catch (error) {
    console.warn(`[wevir-host --adapter codex] 跳过：${(error as Error).message}`);
    return false;
  }
}

describe.skipIf(!binaryAvailable())(
  'wevir-host --adapter codex（runHostCli + 真实 codex-app-server + mock 模型）',
  () => {
    it('一问一答、一次工具调用、SIGTERM 优雅退出并回收 codex-app-server', async () => {
      const model = await startMockModel();
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
      const workspace = join(tempDir(), 'workspace');
      mkdirSync(workspace);

      let adapter: CodexRuntime | undefined;
      const fake = fakeProcess(['--home', home, '--adapter', 'codex']);
      const exit = runHostCli(fake.proc, {
        createAdapter: (kind, context) => {
          const created = createAdapter(kind, context);
          // 挂了订阅引擎时 Codex 在 EngineRouter 的 codex 路由里（engines.ts）。
          adapter = (
            created instanceof EngineRouter
              ? created.routes.find((route) => route.name === 'codex')?.adapter
              : created
          ) as CodexRuntime;
          return created;
        },
      });
      let stopped = false;
      cleanups.push(async () => {
        if (!stopped) fake.emit('SIGTERM', 'SIGTERM');
        await exit;
      });
      const ready = await waitReady(fake.out);
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(ready.url);
      cleanups.push(() => client.ws.close());
      expect((await client.hello(info.token as string)).error).toBeUndefined();

      const { workspace: ws } = await client.request('workspace.add', { rootPath: workspace });
      await client.request('provider.upsert', {
        id: 'wevir-mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'wevir-mock-key-not-a-secret',
      });
      const { session } = await client.request('session.create', {
        workspaceId: ws.id,
        providerId: 'wevir-mock',
      });
      const sessionId = session.id as SessionId;
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      const turnDone = (turnId: string) =>
        client.until(
          () =>
            client
              .events(subscriptionId)
              .find((e) => e.type === 'turn.finished' && e.payload.turnId === turnId),
          'turn.finished',
          30_000,
        );

      const first = await client.request('session.send', {
        sessionId,
        content: [{ type: 'text', text: '打个招呼' }],
      });
      await turnDone(first.turnId);
      const second = await client.request('session.send', {
        sessionId,
        content: [{ type: 'text', text: '列一下工作区的文件（调用工具）' }],
      });
      await turnDone(second.turnId);

      const events: WevirEvent[] = client.events(subscriptionId);
      expect(events[0]).toMatchObject({
        type: 'session.created',
        payload: { providerId: 'wevir-mock', modelId: MOCK_MODEL, engineVersion: CODEX_VERSION },
      });
      const inTurn = (turnId: string) =>
        events.filter((e) => (e.payload as { turnId?: string }).turnId === turnId);
      // 一问一答：增量先到，已提交的消息随后替换它们。
      const one = inTurn(first.turnId);
      const firstDelta = one.findIndex((e) => e.type === 'assistant.delta');
      const message = one.findIndex((e) => e.type === 'assistant.message');
      expect(firstDelta).toBeGreaterThan(-1);
      expect(firstDelta).toBeLessThan(message);
      expect(one[message]).toMatchObject({ payload: { text: '你好！我是 Wevir 的 mock 模型。' } });
      expect(one.find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
        outcome: 'completed',
      });
      // 工具调用：ls 是列目录，归为 search（Windows 上 Codex 用 PowerShell，解析结果可能不同，只看命令）。
      const two = inTurn(second.turnId);
      expect(two.find((e) => e.type === 'tool.started')?.payload).toMatchObject({
        toolName: 'commandExecution',
        display: { command: 'ls', ...(process.platform !== 'win32' && { kind: 'search' }) },
      });
      expect(two.find((e) => e.type === 'tool.finished')?.payload).toMatchObject({
        status: 'completed',
      });
      expect(two.find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
        outcome: 'completed',
      });
      expect(events.some((e) => e.type === 'usage.updated')).toBe(true);
      const { session: snapshot } = await client.request('session.get', { sessionId });
      expect(snapshot.engine).toMatchObject({ kind: 'codex' });

      // 会话标题：先是首条消息截断的，第一个回合开始后用会话的模型生成（mock 回 JSON）。这个连接没有声明
      // title_source_generated，来源降级成 first_prompt；声明了的连接看到 generated（host-api.md §10）。
      const titles = await client.until(
        () => {
          const changed = client
            .events(subscriptionId)
            .filter((e) => e.type === 'session.title_changed');
          return changed.length >= 2 ? changed : undefined;
        },
        '模型生成的标题',
        30_000,
      );
      expect(titles.map((e) => e.payload)).toEqual([
        { title: '打个招呼', source: 'first_prompt' },
        {
          title: 'Mock：打个招呼',
          source: 'first_prompt',
          description: 'mock 生成的标题：打个招呼',
        },
      ]);
      const modern = await TestRpcClient.connect(ready.url);
      cleanups.push(() => modern.ws.close());
      expect(
        (await modern.hello(info.token as string, undefined, { title_source_generated: true }))
          .error,
      ).toBeUndefined();
      const { session: current } = await modern.request('session.get', { sessionId });
      expect(current).toMatchObject({ title: 'Mock：打个招呼', titleSource: 'generated' });

      stopped = true;
      fake.emit('SIGTERM', 'SIGTERM');
      expect(await exit).toBe(EXIT_CODE.ok);
      expect(adapter?.gateway.process.state).toBe('disposed');
      expect(adapter?.gateway.process.pid).toBeUndefined();
      expect(adapter?.gateway.gateway).toBeUndefined();
      // ChatGPT 进程没有用到，也就从没启动。
      expect(adapter?.chatgpt.process.pid).toBeUndefined();
      expect(existsSync(join(home, 'engines', 'codex-chatgpt'))).toBe(false);
      expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);
      expect(existsSync(join(home, 'engines', 'codex', 'config.toml'))).toBe(true);
      const logText = readFileSync(join(home, 'logs', LOG_FILE), 'utf8');
      const log = logText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(log.find((l) => l.msg === 'starting')).toMatchObject({ adapter: 'codex' });
      expect(log.some((l) => l.msg === 'gateway request')).toBe(true);
      expect(log.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
    }, 60_000);
  },
);
