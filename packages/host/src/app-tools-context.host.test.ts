// 应用级工具的会话上下文（记忆索引、会话须知）给只取 MCP 说明开头一段的引擎（Claude Code 只取前 4,096 个字符）：startHost 组装出的
// Host，引擎声明 `appToolsContextInPrompt` 时，建会话的配置带上记忆索引（`SessionConfig.appToolsContext`），MCP 说明只剩工具说明；
// 没声明的引擎照旧都在 MCP 说明里。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import {
  APP_TOOLS_CALL,
  APP_TOOLS_CALL_READONLY,
  APP_TOOLS_SEARCH,
  type AppToolsEndpoint,
  type AppToolsView,
  type AppToolTier,
  appToolsTierUrl,
  type EngineSession,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { MORE_TOOLS_INSTRUCTIONS } from './app-tools.js';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';
import { CORE_TIER_TOOLS } from './tool-presets.js';

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
  const create = async (extra: Record<string, unknown> = {}) =>
    (
      await client.request('session.create', {
        workspaceId,
        providerId: 'deepseek-official',
        ...extra,
      })
    ).session as { id: SessionId; engine: { sessionId: string } };
  const configOf = (session: { engine: { sessionId: string } }) =>
    adapter.configs.get(session.engine.sessionId) as SessionConfig;
  const mcp = async (
    session: { engine: { sessionId: string } },
    method: string,
    params: unknown = {},
    tier?: AppToolsView,
  ) => {
    const endpoint = configOf(session).appTools as AppToolsEndpoint;
    const url = tier === undefined ? endpoint.url : appToolsTierUrl(endpoint.url, tier);
    const response = await fetch(url, {
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

  it('分层的端点（Codex 的 wevir 与 wevir_more）：各列一层，调用不跨层，按需那层有自己的短说明', async () => {
    const h = await boot();
    const session = await h.create();
    const names = async (tier?: AppToolTier) =>
      ((await h.mcp(session, 'tools/list', {}, tier)).tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
    const all = await names();
    const core = await names('core');
    const more = await names('more');
    expect(core.length).toBeGreaterThan(5);
    expect(core.every((name) => CORE_TIER_TOOLS.includes(name))).toBe(true);
    expect(more.some((name) => CORE_TIER_TOOLS.includes(name))).toBe(false);
    expect([...core, ...more].sort()).toEqual([...all].sort());
    // 不分层的列表（Claude）里常驻的工具带 alwaysLoad，别的不带；分层的列表都不带。
    const listing = async (tier?: AppToolTier) =>
      (await h.mcp(session, 'tools/list', {}, tier)).tools as Array<{
        name: string;
        _meta?: Record<string, unknown>;
      }>;
    const alwaysLoaded = (await listing())
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name);
    expect(alwaysLoaded.sort()).toEqual([...core].sort());
    for (const tier of ['core', 'more'] as const) {
      expect((await listing(tier)).some((tool) => tool._meta !== undefined)).toBe(false);
    }
    const refused = await h.mcp(
      session,
      'tools/call',
      { name: 'wevir_session_list', arguments: {} },
      'more',
    );
    expect(refused.content[0].text).toBe('wevir_session_list is not available to this session.');
    const listed = await h.mcp(
      session,
      'tools/call',
      { name: 'wevir_session_list', arguments: {} },
      'core',
    );
    expect(listed.isError).toBeUndefined();
    const init = (tier?: AppToolTier) =>
      h.mcp(session, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, tier);
    expect((await init('more')).instructions).toBe(MORE_TOOLS_INSTRUCTIONS);
    expect((await init('core')).instructions).toBe((await init()).instructions);
  });

  it('dispatch 列法（OpenCode）：常驻那层加上搜索与两个分发工具；分发照常按会话过滤，只读分发拒绝会改东西的工具', async () => {
    const h = await boot();
    const session = await h.create();
    const names = async (tier?: AppToolsView, target = session) =>
      ((await h.mcp(target, 'tools/list', {}, tier)).tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
    const core = await names('core');
    expect((await names('dispatch')).sort()).toEqual(
      [...core, APP_TOOLS_SEARCH, APP_TOOLS_CALL_READONLY, APP_TOOLS_CALL].sort(),
    );
    // 别的列法里没有它们。
    for (const tier of [undefined, 'core', 'more'] as const) {
      expect(await names(tier)).not.toContain(APP_TOOLS_CALL);
    }
    const call = async (name: string, args: unknown, target = session) =>
      (await h.mcp(target, 'tools/call', { name, arguments: args }, 'dispatch')) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
    const found = await call(APP_TOOLS_SEARCH, { query: 'providers models' });
    const lines = found.content[0]?.text.split('\n') ?? [];
    expect(lines[0]).toContain(APP_TOOLS_CALL_READONLY);
    const entries = lines
      .slice(1)
      .map((line) => JSON.parse(line) as { name: string; readOnly?: boolean });
    expect(entries.find((entry) => entry.name === 'wevir_models')).toMatchObject({
      readOnly: true,
    });
    // 只搜按需那层，按名字排序。
    expect(entries.every((entry) => !CORE_TIER_TOOLS.includes(entry.name))).toBe(true);
    expect(entries.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name).sort());
    expect((await call(APP_TOOLS_SEARCH, { query: 'zzqx' })).content[0]?.text).toContain(
      'No matching tools',
    );

    const models = await call(APP_TOOLS_CALL_READONLY, { name: 'wevir_models', arguments: {} });
    expect(models.isError).toBeUndefined();
    expect(models.content[0]?.text).toContain('deepseek-official');
    const writable = (await names('more')).find(
      (name) => name === 'wevir_session_close' || name === 'wevir_session_archive',
    ) as string;
    expect(writable).toBeDefined();
    const refused = await call(APP_TOOLS_CALL_READONLY, { name: writable, arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toBe(
      `${writable} can change things: call it with ${APP_TOOLS_CALL}.`,
    );
    // 按需那层的工具不能在 dispatch 列法里直接调。
    expect((await call('wevir_models', {})).content[0]?.text).toBe(
      'wevir_models is not available to this session.',
    );

    // 会话看不到的工具（core 预设去掉的组）搜不到，经分发也调不了。
    const limited = await h.create({ toolPreset: { id: 'core' } });
    const visibleToLimited = new Set(await names(undefined, limited));
    const target = (await names('more')).find((name) => !visibleToLimited.has(name));
    expect(target, 'core 预设去掉的工具').toBeDefined();
    const missing = await call(APP_TOOLS_CALL, { name: target, arguments: {} }, limited);
    expect(missing.content[0]?.text).toBe(
      `${target} is not available to this session. Find tools with ${APP_TOOLS_SEARCH}.`,
    );
    const searched = await call(
      APP_TOOLS_SEARCH,
      { query: String(target).replace(/_/g, ' ') },
      limited,
    );
    expect(searched.content[0]?.text).not.toContain(`"name":"${target}"`);
  });
});
