// 开发服务器预览（0.84.0，Host 功能 `dev_preview`）：startHost 组装出的真实 Host（echo 引擎能挂应用级工具）。客户端经 WebSocket
// 存运行配置、启动、等 `process.changed` 里的就绪、停止；不认 `dev_preview` 的连接看不到预览进程。Agent 那一侧按 MCP 调
// `wevir_preview_list` 与带命令的 `wevir_preview_start`（保存后启动、等就绪；端口被另一项预览占着时说出是哪项、不留配置）、
// `wevir_preview_delete`。POSIX 上跑。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { HostProcess, SessionId } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ToolEcho extends EchoAdapter {
  readonly appTools = true;
  readonly endpoints = new Map<string, AppToolsEndpoint | undefined>();

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.endpoints.set(session.engineSessionId, config.appTools);
    return session;
  }
}

const SERVER = `const http = require('node:http');
const port = Number(process.argv[2]);
http.createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1', () => console.log('Local: http://localhost:' + port + '/'));
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe.runIf(process.platform !== 'win32')('开发服务器预览经 Host API', () => {
  it('配置、启动、就绪、复用与停止；旧连接看不到预览进程；Agent 的工具保存并启动', async () => {
    const root = realpathSync(tempDir());
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'server.cjs'), SERVER);
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { dev: 'vite --port 4321' } }),
    );

    const adapter = new ToolEcho({ stepDelayMs: 1 });
    const host = await startHost({
      adapter,
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
      home,
    });
    cleanups.push(() => host.shutdown());
    const token = (
      JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
    ).token;
    const client = await TestRpcClient.connect(host.url);
    cleanups.push(() => client.ws.close());
    const hello = await client.hello(token, undefined, { dev_preview: true });
    expect(hello.result.features.dev_preview).toBe(true);
    const old = await TestRpcClient.connect(host.url);
    cleanups.push(() => old.ws.close());
    await old.hello(token);

    const workspaceId = (await client.request('workspace.add', { rootPath: project })).workspace
      .id as string;
    await client.request('provider.upsert', {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-chat',
    });
    const sessionId = (
      await client.request('session.create', { workspaceId, providerId: 'deepseek-official' })
    ).session.id as SessionId;

    // 候选来自 package.json；保存一项后它从候选里消失，别的连接收到 preview.changed。
    const before = await client.request('preview.list', { sessionId });
    expect(before).toMatchObject({
      root: project,
      configs: [],
      candidates: [{ name: 'dev', command: 'npm run dev', port: 4321, origin: 'package_script' }],
    });
    await old.request('preview.list', { sessionId });
    const port = await freePort();
    const node = JSON.stringify(process.execPath);
    const saved = await client.request('preview.save', {
      workspaceId,
      config: { name: 'web', command: `${node} server.cjs ${port}`, port },
    });
    expect(saved.configs).toMatchObject([{ name: 'web', addedBy: 'user', cwd: '' }]);
    await old.until(() => old.notifications('preview.changed')[0], 'preview.changed');

    // 启动：进程带 preview，就绪经 process.changed 推来；旧连接的列表与通知里都没有它。
    const started = await client.request('preview.start', { sessionId, name: 'web' });
    expect(started).toMatchObject({
      status: 'started',
      process: {
        source: { kind: 'preview', sessionId, startedBy: 'user' },
        preview: { name: 'web', root: project, port, ready: false },
      },
    });
    const id = (started.process as HostProcess).id;
    await client.until(
      () =>
        client
          .notifications('process.changed')
          .find(
            (change: { process?: HostProcess }) =>
              change.process?.id === id && change.process.preview?.ready === true,
          ),
      'preview ready',
      15_000,
    );
    const listed = await client.request('process.list', { sessionId });
    expect(listed.processes.map((p: HostProcess) => p.id)).toContain(id);
    expect((await old.request('process.list', { sessionId })).processes).toEqual([]);
    expect(
      old
        .notifications('process.changed')
        .filter((change: { process?: HostProcess }) => change.process?.id === id),
    ).toEqual([]);
    expect(await client.request('preview.start', { sessionId, name: 'web' })).toMatchObject({
      status: 'reused',
      process: { id, preview: { ready: true } },
    });

    // Agent：列出看到在跑的配置；带命令启动另一项（保存、就绪、浏览器没登记时说明开不了）。
    const { session } = await client.request('session.get', { sessionId });
    const endpoint = adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: 读任意形状的 MCP 回复。
      const result = ((await response.json()) as Record<string, any>).result;
      return {
        isError: result.isError === true,
        text: (result.content as Array<{ text: string }>).map((part) => part.text).join('\n'),
      };
    };
    const list = await call('wevir_preview_list', {});
    expect(list.text).toContain(`- web: \`${node} server.cjs ${port}\``);
    expect(list.text).toContain(`ready at http://localhost:${port}`);
    expect(list.text).toContain('- dev: `npm run dev`');

    const apiPort = await freePort();
    const agent = await call('wevir_preview_start', {
      name: 'api',
      command: `${node} server.cjs ${apiPort}`,
      port: apiPort,
      timeoutMs: 15_000,
    });
    expect(agent.isError).toBe(false);
    expect(agent.text).toContain('Saved run configuration "api".');
    expect(agent.text).toContain(`Started "api": ready at http://localhost:${apiPort}`);
    expect(agent.text).toContain('Could not open it in the browser');
    const configs = (await client.request('preview.list', { sessionId })).configs;
    expect(configs.map((c: { name: string; addedBy: string }) => [c.name, c.addedBy])).toEqual([
      ['web', 'user'],
      ['api', 'agent'],
    ]);
    const blocked = await call('wevir_preview_start', {});
    expect(blocked).toMatchObject({ isError: true });
    expect(blocked.text).toContain('Pass name: web, api');

    // 端口被这个会话起的另一项预览占着：说出是哪一项，这次的配置不留下。
    const dup = await call('wevir_preview_start', {
      name: 'api-dup',
      command: `${node} server.cjs ${apiPort}`,
      port: apiPort,
      timeoutMs: 5_000,
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain(
      `Not started: port ${apiPort} is already in use by run configuration "api" (process `,
    );
    expect(dup.text).toContain('The configuration was not saved.');
    expect(
      (await client.request('preview.list', { sessionId })).configs.map(
        (c: { name: string }) => c.name,
      ),
    ).toEqual(['web', 'api']);

    // 删除：用户保存的不删；agent 保存的删掉，在跑的照跑。
    const userOwned = await call('wevir_preview_delete', { name: 'web' });
    expect(userOwned.isError).toBe(true);
    expect(userOwned.text).toContain('"web" was saved by the user');
    const deleted = await call('wevir_preview_delete', { name: 'api' });
    expect(deleted.isError).toBe(false);
    expect(deleted.text).toContain(
      'Deleted run configuration "api". It is still running (ready at',
    );

    // 停止走 process.stop。
    await client.request('process.stop', { processId: id });
    await client.until(
      () =>
        client
          .notifications('process.changed')
          .find(
            (change: { process?: HostProcess }) =>
              change.process?.id === id && change.process.status === 'exited',
          ),
      'preview exited',
      15_000,
    );
    expect(await client.request('preview.remove', { workspaceId, name: 'web' })).toMatchObject({
      configs: [],
    });
  });
});
