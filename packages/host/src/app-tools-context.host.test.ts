// 应用级工具的会话上下文（记忆索引、会话须知）给只取 MCP 说明开头一段的引擎（Claude Code 只取前 4,096 个字符）：startHost 组装出的
// Host，引擎声明 `appToolsContextInPrompt` 时，建会话的配置带上记忆索引（`SessionConfig.appToolsContext`），MCP 说明只剩工具说明；
// 没声明的引擎照旧都在 MCP 说明里。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
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
  readonly configs = new Map<string, SessionConfig>();
  inPrompt = false;

  appToolsContextInPrompt(): boolean {
    return this.inPrompt;
  }

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.configs.set(session.engineSessionId, config);
    return session;
  }
}

async function boot() {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const workspaceDir = join(root, 'project');
  mkdirSync(workspaceDir, { recursive: true });
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
  expect((await client.hello(token)).error).toBeUndefined();
  const workspaceId = (await client.request('workspace.add', { rootPath: workspaceDir })).workspace
    .id as string;
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const create = async () =>
    (await client.request('session.create', { workspaceId, providerId: 'deepseek-official' }))
      .session as { id: SessionId; engine: { sessionId: string } };
  const configOf = (session: { engine: { sessionId: string } }) =>
    adapter.configs.get(session.engine.sessionId) as SessionConfig;
  const mcp = async (
    session: { engine: { sessionId: string } },
    method: string,
    params: unknown = {},
  ) => {
    const endpoint = configOf(session).appTools as AppToolsEndpoint;
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
  const instructions = async (session: { engine: { sessionId: string } }) =>
    (await mcp(session, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
      .instructions as string;
  return { adapter, create, configOf, mcp, instructions };
}

describe('应用级工具的会话上下文', () => {
  it('引擎把上下文放进系统说明时：配置带记忆索引，MCP 说明只剩工具说明且不超过 4,096 字符', async () => {
    const h = await boot();
    const writer = await h.create();
    const saved = await h.mcp(writer, 'tools/call', {
      name: 'wevir_memory_save',
      arguments: {
        scope: 'global',
        name: 'avoid-rm-f',
        type: 'feedback',
        description: 'rm -f hides missing files; check first',
        content: 'Why: a typo deleted nothing and no error showed.',
      },
    });
    expect(saved.isError).toBeUndefined();

    // 没声明的引擎：照旧，索引在 MCP 说明里，配置不带上下文。
    const plain = await h.create();
    expect(await h.instructions(plain)).toContain('avoid-rm-f');
    expect(h.configOf(plain).appToolsContext).toBeUndefined();

    h.adapter.inPrompt = true;
    const claude = await h.create();
    const text = await h.instructions(claude);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain('avoid-rm-f');
    expect(text).toContain('- wevir_memory_*');
    expect(h.configOf(claude).appToolsContext).toContain(
      'avoid-rm-f (feedback): rm -f hides missing files',
    );
  });

  it('没有记忆时不带上下文', async () => {
    const h = await boot();
    h.adapter.inPrompt = true;
    const session = await h.create();
    expect(h.configOf(session)).not.toHaveProperty('appToolsContext');
    expect(h.configOf(session).appTools).toBeDefined();
  });
});
