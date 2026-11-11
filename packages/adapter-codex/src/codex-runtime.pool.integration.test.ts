import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { EnginePluginConfig, ProviderConfig } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntime, type CodexRuntimeOptions } from './codex-runtime.js';
import { CODEX_VERSION } from './paths.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  NO_RETRIES,
  ofType,
  runTurn,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  defaultMockScript,
  MOCK_MODEL,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('Codex 服务商进程池');
const dirs = new TempDirs();
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});
afterAll(() => dirs.cleanup());

async function model(script: MockScript = defaultMockScript) {
  const mock = await startMockModel(script);
  cleanup.push(() => mock.close());
  return mock;
}

function runtime(providers: ProviderConfig[], options: Partial<CodexRuntimeOptions> = {}) {
  const paths = dirs.make('pool');
  const logger = collectingLogger();
  const adapter = new CodexRuntime({
    home: paths.home,
    binary,
    providers,
    providerExtra: NO_RETRIES,
    logger,
    ...options,
  });
  cleanup.push(() => adapter.dispose());
  const config = (providerId: string) => ({
    providerId,
    modelId: MOCK_MODEL,
    cwd: paths.workspace,
  });
  return { ...paths, adapter, config, logger };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(binary === undefined)(
  'Codex 服务商进程池（真实二进制）',
  { timeout: 60_000 },
  () => {
    it('CLI 服务商覆盖生效：共享家目录、不同 pid、并发回合不串流，关闭后恢复原 thread', async () => {
      const a = await model((view) => ({ text: [`A:${view.lastUserText}`], delayMs: 20 }));
      const b = await model((view) => ({ text: [`B:${view.lastUserText}`], delayMs: 20 }));
      const h = runtime([mockProvider(a, { id: 'a' }), mockProvider(b, { id: 'b' })]);
      expect(h.adapter.gatewayAdapters.size).toBe(0);
      await expect(h.adapter.createSession(h.config('missing'))).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(h.adapter.gatewayAdapters.size).toBe(0);
      const [sa, sb] = await Promise.all([
        h.adapter.createSession(h.config('a')),
        h.adapter.createSession(h.config('b')),
      ]);
      const pa = h.adapter.gatewayAdapters.get('a');
      const pb = h.adapter.gatewayAdapters.get('b');
      expect(pa?.paths.codexHome).toBe(pb?.paths.codexHome);
      expect(pa?.process.pid).not.toBe(pb?.process.pid);
      expect(pa?.gateway).toBe(pb?.gateway);
      for (const [id, process] of [
        ['a', pa?.process],
        ['b', pb?.process],
      ] as const) {
        const response = await process?.request<{ config: { model_provider: string } }>(
          'config/read',
          {},
        );
        expect(response?.config.model_provider).toBe(`wevir_${id}`);
      }
      const ea = collectEvents(h.adapter, sa.engineSessionId);
      const eb = collectEvents(h.adapter, sb.engineSessionId);
      const results = await Promise.all([
        runTurn(h.adapter, sa.engineSessionId, 'alpha', ea),
        runTurn(h.adapter, sb.engineSessionId, 'beta', eb),
      ]);
      expect(results.map((events) => events.find(ofType('assistant.message'))?.text)).toEqual([
        'A:alpha',
        'B:beta',
      ]);
      for (const [events, id] of [
        [ea, sa.engineSessionId],
        [eb, sb.engineSessionId],
      ] as const)
        expect(events.every((event) => event.engineSessionId === id)).toBe(true);
      await h.adapter.close(sa.engineSessionId);
      await h.adapter.resumeSession(sa.engineSessionId, h.config('a'));
      const resumed = await runTurn(
        h.adapter,
        sa.engineSessionId,
        'again',
        collectEvents(h.adapter, sa.engineSessionId),
      );
      expect(resumed.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(JSON.stringify(a.requests.at(-1)?.body.input)).toContain('alpha');
      expect(pb?.process.pid).toBeDefined();
    });

    it('子智能体和分支留在父进程，另一个服务商独立运行', async () => {
      const mock = await model();
      const h = runtime([mockProvider(mock, { id: 'a' }), mockProvider(mock, { id: 'b' })]);
      const sa = await h.adapter.createSession(h.config('a'));
      const sb = await h.adapter.createSession(h.config('b'));
      const events = collectEvents(h.adapter, sa.engineSessionId);
      const turn = await runTurn(h.adapter, sa.engineSessionId, '派一个子智能体去做', events);
      const child = turn.find(ofType('subagent.started'));
      expect(child).toBeDefined();
      const childId = child?.childEngineSessionId as string;
      expect(h.adapter.gatewayAdapters.get('a')?.hasSession(childId)).toBe(true);
      expect(h.adapter.gatewayAdapters.get('b')?.hasSession(childId)).toBe(false);
      await waitForEvent(collectEvents(h.adapter, childId), ofType('turn.settled'), '子智能体完成');
      const branch = await h.adapter.fork(sa.engineSessionId, h.config('a'), {
        kind: 'branch',
        dropTurns: 0,
      });
      expect(h.adapter.gatewayAdapters.get('a')?.hasSession(branch.engineSessionId)).toBe(true);
      expect(h.adapter.gatewayAdapters.get('b')?.hasSession(branch.engineSessionId)).toBe(false);
      expect(
        (
          await runTurn(
            h.adapter,
            sb.engineSessionId,
            'hi',
            collectEvents(h.adapter, sb.engineSessionId),
          )
        ).at(-1)?.type,
      ).toBe('turn.settled');
    });

    it('两个进程同时启动目标，共用状态库且各自完成', async () => {
      const mock = await model((view) => {
        if (view.toolOutputs.length > 0) return { text: ['完成。'] };
        if (
          JSON.stringify(view.body.input.at(-1)).includes(
            'Continue working toward the active thread goal.',
          )
        )
          return {
            toolCalls: [{ kind: 'function', name: 'update_goal', args: { status: 'complete' } }],
          };
        return { text: ['已开始。'] };
      });
      const h = runtime([mockProvider(mock, { id: 'a' }), mockProvider(mock, { id: 'b' })]);
      const sessions = await Promise.all(
        ['a', 'b'].map((id) => h.adapter.createSession(h.config(id))),
      );
      const events = sessions.map((s) => collectEvents(h.adapter, s.engineSessionId));
      await Promise.all(
        sessions.map((s, i) =>
          h.adapter.startGoal(s.engineSessionId, {
            objective: `Complete goal ${i}`,
            input: { content: [{ type: 'text', text: `Start ${i}` }] },
          }),
        ),
      );
      await Promise.all(
        events.map((stream) =>
          waitForEvent(
            stream,
            (event): event is Extract<(typeof stream)[number], { type: 'goal.updated' }> =>
              event.type === 'goal.updated' && event.goal?.status === 'complete',
            '目标完成',
          ),
        ),
      );
      expect(h.logger.warnings.join('\n')).not.toContain('database is locked');
    });

    it('并发启动和服务商配置更新保持同一网关与完整配置，内容不变时不重写', async () => {
      const mock = await model();
      const providers = [mockProvider(mock, { id: 'a' }), mockProvider(mock, { id: 'b' })];
      const updated = [...providers, mockProvider(mock, { id: 'c' })];
      const h = runtime(providers);
      await Promise.all([
        h.adapter.createSession(h.config('a')),
        h.adapter.configureProviders(updated),
        h.adapter.createSession(h.config('b')),
      ]);
      const paths = h.adapter.gatewayHome.paths;
      const toml = readFileSync(paths.configFile, 'utf8');
      for (const provider of updated)
        expect(toml).toContain(
          `base_url = "${h.adapter.gatewayHome.gateway?.baseURL(provider.id)}"`,
        );
      expect(JSON.parse(readFileSync(paths.catalogFile, 'utf8'))).toBeDefined();
      const pids = ['a', 'b'].map((id) => h.adapter.gatewayAdapters.get(id)?.process.pid);
      const third = await h.adapter.createSession(h.config('c'));
      expect(['a', 'b'].map((id) => h.adapter.gatewayAdapters.get(id)?.process.pid)).toEqual(pids);
      expect(
        (
          await runTurn(
            h.adapter,
            third.engineSessionId,
            'new provider',
            collectEvents(h.adapter, third.engineSessionId),
          )
        ).at(-1)?.type,
      ).toBe('turn.settled');
      const before = [statSync(paths.configFile).mtimeMs, statSync(paths.catalogFile).mtimeMs];
      await h.adapter.configureProviders(updated);
      expect([statSync(paths.configFile).mtimeMs, statSync(paths.catalogFile).mtimeMs]).toEqual(
        before,
      );
    });

    it('一个进程启用 skill 后，另一个既有 thread 的新回合实际看到它且不重复写文件', async () => {
      const mock = await model();
      const h = runtime(['a', 'b', 'c'].map((id) => mockProvider(mock, { id })));
      const path = join(h.root, 'skills', 'pool-canary', 'SKILL.md');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        '---\nname: pool-canary\ndescription: POOL_SKILL_CANARY_DESCRIPTION\n---\nPOOL_SKILL_CANARY_BODY\n',
      );
      let config: EnginePluginConfig = {
        skillsRoot: join(h.root, 'skills'),
        connectors: [],
        skills: [{ name: 'pool-canary', path, enabled: false }],
      };
      h.adapter.bindPlugins({ read: async () => config, changed: () => {} });
      const sa = await h.adapter.createSession(h.config('a'));
      const sb = await h.adapter.createSession(h.config('b'));
      const events = collectEvents(h.adapter, sb.engineSessionId);
      await runTurn(h.adapter, sb.engineSessionId, 'before', events);
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).not.toContain(
        'POOL_SKILL_CANARY_DESCRIPTION',
      );
      config = { ...config, skills: [{ name: 'pool-canary', path, enabled: true }] };
      await h.adapter.gatewayAdapters.get('a')?.reloadPlugins();
      const process = h.adapter.gatewayAdapters.get('b')?.process;
      if (process === undefined) throw new Error('缺少服务商进程');
      const request = vi.spyOn(process, 'request');
      const modified = statSync(h.adapter.gatewayHome.paths.configFile).mtimeMs;
      const third = await h.adapter.createSession(h.config('c'));
      expect(statSync(h.adapter.gatewayHome.paths.configFile).mtimeMs).toBe(modified);
      await runTurn(
        h.adapter,
        third.engineSessionId,
        'new process',
        collectEvents(h.adapter, third.engineSessionId),
      );
      expect(
        JSON.stringify(mock.requests.at(-1)?.body.input).includes('POOL_SKILL_CANARY_DESCRIPTION'),
      ).toBe(true);
      await runTurn(h.adapter, sb.engineSessionId, 'after', events);
      expect(
        JSON.stringify(mock.requests.at(-1)?.body.input).includes('POOL_SKILL_CANARY_DESCRIPTION'),
      ).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === 'config/batchWrite')).toEqual([
        ['config/batchWrite', { edits: [], reloadUserConfig: true }],
      ]);
      expect(statSync(h.adapter.gatewayHome.paths.configFile).mtimeMs).toBe(modified);
      await h.adapter.close(sa.engineSessionId);
    });

    it('插件页包含其他服务商 thread 上独有的项目连接器', async () => {
      const server = createServer(async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'docs', version: '0.0.0' },
              }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }] }
              : {};
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      const mock = await model();
      const h = runtime([mockProvider(mock, { id: 'a' }), mockProvider(mock, { id: 'b' })]);
      h.adapter.bindPlugins({
        read: async () => ({ skillsRoot: h.workspace, skills: [], connectors: [] }),
        changed: () => {},
      });
      await h.adapter.createSession(h.config('a'));
      await h.adapter.createSession({
        ...h.config('b'),
        connectors: [
          {
            name: 'project_docs',
            enabled: true,
            config: {
              transport: 'http',
              url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
            },
          },
        ],
      });
      await vi.waitFor(async () =>
        expect(await h.adapter.listConnectorStatus()).toEqual([
          expect.objectContaining({ name: 'project_docs', status: 'connected' }),
        ]),
      );
    });

    it('取消未确认只脱开该服务商，另一个进程继续对话', async () => {
      const mock = await model(() => ({ text: ['slow', 'response'], delayMs: 100 }));
      const h = runtime([mockProvider(mock, { id: 'a' }), mockProvider(mock, { id: 'b' })], {
        cancelTimeoutMs: 0,
        idleTimeoutMs: 100,
      });
      const sa = await h.adapter.createSession(h.config('a'));
      const sb = await h.adapter.createSession(h.config('b'));
      const aEvents = collectEvents(h.adapter, sa.engineSessionId);
      const bEvents = collectEvents(h.adapter, sb.engineSessionId);
      const pid = h.adapter.gatewayAdapters.get('b')?.process.pid;
      await h.adapter.send(sa.engineSessionId, { content: [{ type: 'text', text: 'slow' }] });
      await expect(h.adapter.cancel(sa.engineSessionId)).rejects.toMatchObject({
        code: 'cancel_unconfirmed',
      });
      await waitForEvent(aEvents, ofType('engine.exited'), '取消未确认重启');
      expect(
        (await runTurn(h.adapter, sb.engineSessionId, 'unaffected', bEvents)).at(-1)?.type,
      ).toBe('turn.settled');
      expect(h.adapter.gatewayAdapters.get('b')?.process.pid).toBe(pid);
      expect(bEvents.some(ofType('engine.exited'))).toBe(false);
      await vi.waitFor(() => expect(h.adapter.gatewayAdapters.has('a')).toBe(false));
    });

    it('空闲回收后恢复并续聊，开着的会话和另一个服务商不被回收', async () => {
      const mock = await model();
      const h = runtime([mockProvider(mock, { id: 'a' }), mockProvider(mock, { id: 'b' })], {
        idleTimeoutMs: 100,
      });
      const sa = await h.adapter.createSession(h.config('a'));
      const sb = await h.adapter.createSession(h.config('b'));
      await runTurn(
        h.adapter,
        sa.engineSessionId,
        'saved',
        collectEvents(h.adapter, sa.engineSessionId),
      );
      const old = h.adapter.gatewayAdapters.get('a');
      const bPid = h.adapter.gatewayAdapters.get('b')?.process.pid;
      const gateway = h.adapter.gatewayHome.gateway;
      await h.adapter.close(sa.engineSessionId);
      // 只读能力查询不能取消已排好的回收。
      expect(h.adapter.acceptsImages(h.config('a'))).toBe(false);
      await vi.waitFor(() => expect(old?.process.state).toBe('disposed'));
      expect(h.adapter.gatewayAdapters.has('a')).toBe(false);
      expect(h.adapter.gatewayAdapters.get('b')?.process.pid).toBe(bPid);
      expect(h.adapter.gatewayHome.gateway).toBe(gateway);
      await h.adapter.resumeSession(sa.engineSessionId, h.config('a'));
      expect(h.adapter.gatewayAdapters.get('a')?.process.pid).not.toBe(old?.process.pid);
      const turn = await runTurn(
        h.adapter,
        sa.engineSessionId,
        'restored',
        collectEvents(h.adapter, sa.engineSessionId),
      );
      expect(turn.at(-1)?.type).toBe('turn.settled');
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain('saved');
      await pause(150);
      expect(h.adapter.gatewayAdapters.get('a')?.process.pid).toBeDefined();
      expect(h.adapter.gatewayAdapters.get('b')?.hasSession(sb.engineSessionId)).toBe(true);
    });

    it('服务商删除并重启后仍可永久删除其旧会话', async () => {
      const mock = await model();
      const h = runtime([mockProvider(mock, { id: 'a' })]);
      const session = await h.adapter.createSession(h.config('a'));
      await runTurn(
        h.adapter,
        session.engineSessionId,
        'persist',
        collectEvents(h.adapter, session.engineSessionId),
      );
      await h.adapter.dispose();
      const restarted = new CodexRuntime({
        home: h.home,
        binary,
        providers: [],
        logger: collectingLogger(),
      });
      cleanup.push(() => restarted.dispose());
      await restarted.deleteSession(session.engineSessionId, { providerId: 'a' });
      await restarted.configureProviders([mockProvider(mock, { id: 'a' })]);
      await expect(
        restarted.resumeSession(session.engineSessionId, h.config('a')),
      ).rejects.toMatchObject({ code: 'session_lost' });
    });
  },
);

describe.skipIf(binary === undefined)('进程池回收与资源', { timeout: 60_000 }, () => {
  it('共享插件读取尚未结束时不回收，完成后重新计算空闲时间', async () => {
    const mock = await model();
    const h = runtime([mockProvider(mock, { id: 'a' })], { idleTimeoutMs: 100 });
    const session = await h.adapter.createSession(h.config('a'));
    await h.adapter.close(session.engineSessionId);
    const process = h.adapter.gatewayAdapters.get('a')?.process;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(async () => release());
    h.adapter.bindPlugins({
      read: async () => {
        await gate;
        return { skillsRoot: h.workspace, connectors: [], skills: [] };
      },
      changed: () => {},
    });
    const reloading = h.adapter.reloadPlugins();
    await pause(200);
    expect(process?.state).toBe('ready');
    release();
    await reloading;
    await vi.waitFor(() => expect(process?.state).toBe('disposed'));
  });

  it('关闭父会话后可回收已完成子智能体占用的进程', async () => {
    const mock = await model();
    const h = runtime([mockProvider(mock, { id: 'a' })], { idleTimeoutMs: 100 });
    const session = await h.adapter.createSession(h.config('a'));
    const events = await runTurn(
      h.adapter,
      session.engineSessionId,
      '派一个子智能体去做',
      collectEvents(h.adapter, session.engineSessionId),
    );
    const child = events.find(ofType('subagent.started'));
    if (child === undefined) throw new Error('没有子智能体');
    await waitForEvent(
      collectEvents(h.adapter, child.childEngineSessionId),
      ofType('turn.settled'),
      '子智能体完成',
    );
    const process = h.adapter.gatewayAdapters.get('a')?.process;
    await h.adapter.close(session.engineSessionId);
    await vi.waitFor(() => expect(process?.state).toBe('disposed'));
  });

  it('运行时退出等待已从池中移除的回收进程', async () => {
    const mock = await model();
    const h = runtime([mockProvider(mock, { id: 'a' })], { idleTimeoutMs: 50 });
    const session = await h.adapter.createSession(h.config('a'));
    const adapter = h.adapter.gatewayAdapters.get('a');
    if (adapter === undefined) throw new Error('没有服务商进程');
    const original = adapter.dispose.bind(adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(async () => release());
    vi.spyOn(adapter, 'dispose').mockImplementation(async () => {
      await gate;
      await original();
    });
    await h.adapter.close(session.engineSessionId);
    await vi.waitFor(() => expect(h.adapter.gatewayAdapters.size).toBe(0));
    let finished = false;
    const disposing = h.adapter.dispose().then(() => {
      finished = true;
    });
    await pause(20);
    expect(finished).toBe(false);
    release();
    await disposing;
    expect(adapter.process.state).toBe('disposed');
    expect(h.adapter.gatewayHome.gateway).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.env.WEVIR_MEASURE_CODEX !== '1')(
    '测量一到三个服务商的 RSS 与冷启动',
    async () => {
      const mock = await model();
      const providers = ['a', 'b', 'c'].map((id) => mockProvider(mock, { id }));
      for (const count of [1, 2, 3]) {
        const h = runtime(providers);
        const coldStartMs: number[] = [];
        for (const provider of providers.slice(0, count)) {
          const started = performance.now();
          const session = await h.adapter.createSession(h.config(provider.id));
          coldStartMs.push(Number((performance.now() - started).toFixed(2)));
          await runTurn(
            h.adapter,
            session.engineSessionId,
            'resource probe',
            collectEvents(h.adapter, session.engineSessionId),
          );
        }
        await pause(100);
        const pids = [...h.adapter.gatewayAdapters.values()].map(
          (adapter) => adapter.process.pid as number,
        );
        const rss = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .map((line) => {
            const [pid, rssKiB] = line.trim().split(/\s+/).map(Number);
            return { pid, rssKiB };
          });
        console.log(
          `CODEX_RESOURCE ${JSON.stringify({ version: CODEX_VERSION, providers: count, rss, totalRSSMiB: Number((rss.reduce((sum, entry) => sum + (entry.rssKiB ?? 0), 0) / 1024).toFixed(2)), coldStartMs })}`,
        );
        await h.adapter.dispose();
      }
    },
  );
});
