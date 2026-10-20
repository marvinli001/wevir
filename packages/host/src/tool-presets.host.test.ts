// 工具预设（0.61.0，Host 功能 `tool_presets`）：startHost 组装出的 Host（echo 引擎声明能挂应用级工具），经真实的 WebSocket 建会话、
// 读清单，模型那一侧直接按 MCP 调 `/mcp` 端点：列出的工具、调用与说明都按预设；不带预设的旧客户端与 full 一样，同以前逐字节相同；
// Host 重启后预设还在。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_TOOLS_INSTRUCTIONS } from './app-tools.js';
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

async function boot(home: string, workspaceDir: string) {
  const adapter = new ToolEcho({ stepDelayMs: 1 });
  const host = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
  });
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await host.shutdown();
  };
  cleanups.push(shutdown);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(host.url);
  cleanups.push(() => client.ws.close());
  const hello = await client.hello(token);
  expect(hello.error).toBeUndefined();
  const workspaces = (await client.request('workspace.list')).workspaces as Array<{
    id: string;
  }>;
  const workspaceId =
    workspaces[0]?.id ??
    (await client.request('workspace.add', { rootPath: workspaceDir })).workspace.id;
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  /** 这个会话的 MCP 端点上调一个方法。 */
  const mcp = async (sessionId: SessionId, method: string, params: unknown = {}) => {
    const { session } = await client.request('session.get', { sessionId });
    const endpoint = adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
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
  const create = async (extra: Record<string, unknown> = {}) =>
    (
      await client.request('session.create', {
        workspaceId,
        providerId: 'deepseek-official',
        ...extra,
      })
    ).session as { id: SessionId; toolPreset?: unknown };
  const names = async (sessionId: SessionId) =>
    ((await mcp(sessionId, 'tools/list')).tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
  const instructions = async (sessionId: SessionId) =>
    (await mcp(sessionId, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
      .instructions as string;
  return { hello: hello.result, client, create, mcp, names, instructions, shutdown };
}

describe('工具预设经 Host API', () => {
  const dirs = () => {
    const root = realpathSync(tempDir());
    const workspaceDir = join(root, 'project');
    mkdirSync(workspaceDir, { recursive: true });
    return { home: join(root, 'home'), workspaceDir };
  };

  it('功能位与清单：两个预设各自的组，每组在这个 Host 上实际有的工具', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    expect(h.hello.features.tool_presets).toBe(true);
    const list = await h.client.request('tools.presets');
    expect(list.presets).toEqual([
      {
        id: 'full',
        groups: [
          'sessions',
          'catalog',
          'tasks',
          'memory',
          'workbench',
          'browser',
          'lsp',
          'processes',
          'plugins',
        ],
      },
      { id: 'core', groups: ['sessions', 'catalog', 'tasks', 'memory', 'workbench'] },
    ]);
    const counts = Object.fromEntries(
      (list.groups as Array<{ id: string; tools: string[] }>).map((group) => [
        group.id,
        group.tools.length,
      ]),
    );
    expect(counts).toEqual({
      sessions: 14,
      catalog: 2,
      tasks: 3,
      memory: 4,
      workbench: 2,
      browser: 25,
      lsp: 7,
      processes: 7,
      plugins: 4,
    });
  });

  it('建会话时选 core：Session 与 session.created 带规范写法，列出、调用与说明都按它；不带的与 full 同以前一样', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    const plain = await h.create();
    const full = await h.create({ toolPreset: { id: 'full' } });
    const core = await h.create({ toolPreset: { id: 'core', groups: ['lsp', 'memory', 'lsp'] } });
    expect(plain).not.toHaveProperty('toolPreset');
    expect(full.toolPreset).toEqual({ id: 'full' });
    expect(core.toolPreset).toEqual({ id: 'core', groups: ['lsp'] });
    expect(
      (await h.client.request('session.get', { sessionId: core.id })).session.toolPreset,
    ).toEqual({ id: 'core', groups: ['lsp'] });
    const { subscriptionId } = await h.client.request('events.subscribe', {
      sessionId: core.id,
      sinceSeq: 0,
    });
    const created = await h.client.until(
      () => h.client.events(subscriptionId).find((event) => event.type === 'session.created'),
      'session.created',
    );
    expect(created.type === 'session.created' && created.payload.toolPreset).toEqual({
      id: 'core',
      groups: ['lsp'],
    });

    const coreNames = await h.names(core.id);
    expect(coreNames).toHaveLength(25 + 7);
    expect(coreNames.filter((name) => name.startsWith('browser_'))).toEqual([]);
    expect(coreNames).toContain('lsp_hover');
    expect(coreNames).toContain('wevir_memory_save');
    expect(coreNames).toContain('wevir_tasks');
    const refused = await h.mcp(core.id, 'tools/call', {
      name: 'wevir_process_list',
      arguments: {},
    });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ text: 'wevir_process_list is not available to this session.' }],
    });
    const memory = await h.mcp(core.id, 'tools/call', { name: 'wevir_memory_list', arguments: {} });
    expect(memory.isError).toBeUndefined();
    const text = await h.instructions(core.id);
    expect(text).not.toContain('- browser_*');
    expect(text).not.toContain('- wevir_process_*');
    expect(text).toContain('- lsp_*');
    expect(text).toContain('- wevir_memory_*');

    // full 与不带预设：工具目录与说明同以前逐字节相同。
    const raw = async (sessionId: SessionId) =>
      JSON.stringify(await h.mcp(sessionId, 'tools/list'));
    expect(await raw(full.id)).toBe(await raw(plain.id));
    expect(await h.names(plain.id)).toHaveLength(67);
    expect(await h.instructions(plain.id)).toBe(APP_TOOLS_INSTRUCTIONS);
    expect(await h.instructions(full.id)).toBe(APP_TOOLS_INSTRUCTIONS);

    // 认不出的预设或组：INVALID_PARAMS，不建会话。
    const bad = await h.client.call('session.create', {
      workspaceId: (await h.client.request('workspace.list')).workspaces[0].id,
      providerId: 'deepseek-official',
      toolPreset: { id: 'core', groups: ['terminal'] },
    });
    expect(bad.error?.code).toBe(-32602);
  });

  it('Host 重启后预设还在', async () => {
    const { home, workspaceDir } = dirs();
    const first = await boot(home, workspaceDir);
    const core = await first.create({ toolPreset: { id: 'core', groups: ['browser'] } });
    const plain = await first.create();
    await first.shutdown();
    const second = await boot(home, workspaceDir);
    const get = async (sessionId: SessionId) =>
      (await second.client.request('session.get', { sessionId })).session;
    expect((await get(core.id)).toolPreset).toEqual({ id: 'core', groups: ['browser'] });
    expect(await get(plain.id)).not.toHaveProperty('toolPreset');
  });
});
