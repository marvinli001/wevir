// 项目环境就绪（0.70.0，Host 功能 `workspace_readiness`）：startHost 组装出的真实 Host（echo 引擎能挂应用级工具），工作区是一个不是 Git
// 仓库的目录。客户端经 WebSocket 读预检、存凭据、按方案安装并收 `readiness.changed`；Agent 那一侧按 MCP 调只读的
// `wevir_workspace_readiness`。安装用 npm 的本地 `file:` 依赖，不联网。POSIX 上跑。

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadinessReport, SessionId } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const WAIT_MS = 60_000;
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

describe.runIf(process.platform !== 'win32')('项目环境就绪经 Host API', () => {
  it('预检、凭据、安装与通知；Agent 的只读工具看到同一份结果', async () => {
    const root = realpathSync(tempDir());
    const home = join(root, 'home');
    const workspaceDir = join(root, 'project');
    mkdirSync(join(workspaceDir, 'local'), { recursive: true });
    writeFileSync(
      join(workspaceDir, 'local', 'package.json'),
      JSON.stringify({ name: 'local', version: '1.0.0' }),
    );
    writeFileSync(
      join(workspaceDir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { local: 'file:./local' } }),
    );
    writeFileSync(
      join(workspaceDir, '.npmrc'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: .npmrc 里的变量引用。
      '//npm.example.com/:_authToken=${PRIVATE_TOKEN}\naudit=false\nfund=false\n',
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
    const hello = await client.hello(token);
    expect(hello.result.features.workspace_readiness).toBe(true);
    const workspaceId = (await client.request('workspace.add', { rootPath: workspaceDir }))
      .workspace.id as string;

    const before = (await client.request('readiness.get', { workspaceId }))
      .report as ReadinessReport;
    expect(before).toMatchObject({ status: 'not_ready', root: workspaceDir });
    expect(before.items.find((item) => item.id === 'dependencies::')).toMatchObject({
      status: 'missing',
    });
    const plan = before.plans[0] as ReadinessReport['plans'][number];
    expect(plan).toMatchObject({
      command: 'npm install',
      writesLockfile: true,
      credentials: [{ name: 'PRIVATE_TOKEN', source: 'missing' }],
    });

    // 凭据：结果只有名字，报告里变成 Wevir 里有。
    expect(
      await client.request('readiness.setCredential', {
        workspaceId,
        name: 'PRIVATE_TOKEN',
        value: 'tok-123456',
      }),
    ).toEqual({ credentials: ['PRIVATE_TOKEN'] });
    const withCredential = (await client.request('readiness.get', { workspaceId }))
      .report as ReadinessReport;
    expect(withCredential.plans[0]?.credentials).toEqual([
      { name: 'PRIVATE_TOKEN', source: 'wevir' },
    ]);

    // Agent 的工具：只读，看到缺依赖与方案，不能装。
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
    const tool = async () => {
      const { session } = await client.request('session.get', { sessionId });
      const endpoint = adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
      const call = async (method: string, params: Record<string, unknown>) => {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${endpoint.token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        // biome-ignore lint/suspicious/noExplicitAny: 读任意形状的 MCP 回复。
        return ((await response.json()) as Record<string, any>).result;
      };
      const list = await call('tools/list', {});
      const entry = (
        list.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
      ).find((item) => item.name === 'wevir_workspace_readiness');
      expect(entry?.annotations?.readOnlyHint).toBe(true);
      const result = await call('tools/call', { name: 'wevir_workspace_readiness', arguments: {} });
      return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n');
    };
    const agentBefore = await tool();
    expect(agentBefore).toContain('NOT READY');
    expect(agentBefore).toContain('`npm install`');
    expect(agentBefore).toContain('only the user can start these');
    expect(agentBefore).not.toContain('tok-123456');

    // 安装：开始、结束各有通知，结束后重新预检。
    const { run } = await client.request('readiness.install', {
      workspaceId,
      planId: plan.id,
      acceptScripts: true,
    });
    expect(run).toMatchObject({ status: 'running', command: 'npm install', path: '' });
    const finished = await client.until(
      () =>
        client
          .notifications('readiness.changed')
          .map((params) => params.run)
          .find((item) => item?.id === run.id && item.status !== 'running'),
      'install finished',
      WAIT_MS,
    );
    expect(finished.status, finished.summary).toBe('succeeded');
    await client.until(
      () =>
        client
          .notifications('readiness.changed')
          .find((params) => params.report?.status === 'ready'),
      'ready report',
      WAIT_MS,
    );
    expect(existsSync(join(workspaceDir, 'node_modules', 'local', 'package.json'))).toBe(true);
    const output = await client.request('readiness.output', { runId: run.id });
    expect(output.text).not.toContain('tok-123456');
    expect(JSON.stringify(client.notifications('readiness.changed'))).not.toContain('tok-123456');

    const after = (await client.request('readiness.get', { workspaceId }))
      .report as ReadinessReport;
    expect(after.status).toBe('ready');
    expect(after.install).toMatchObject({ id: run.id, status: 'succeeded' });
    expect(await tool()).toContain(': ready');

    // 不在报告里的方案 ID：INVALID_PARAMS。
    const stale = await client.call('readiness.install', {
      workspaceId,
      planId: plan.id,
      acceptScripts: true,
    });
    expect(stale.error?.code).toBe(-32602);
  }, 120_000);
});
