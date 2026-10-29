// 配置 Wevir 本身的应用级工具（0.136.0，config-tools.ts）：startHost 组装出的 Host（echo 引擎声明能挂应用级工具），模型那一侧直接按
// MCP 调 `/mcp` 端点。照常的改动直接生效；只有用户能改的设置被拒绝；要用户批准的改动在回合里由 Host 补问，用户答应才改、拒绝不改，
// 没有进行中的回合时不改；环境只回变量名，值不进事件；会话只能改自己与自己开出的；`wevir_show` 能打开设置页。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
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

const SECRET = 'sk-config-tools-secret-value';

async function boot() {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const workspaceDir = join(root, 'project');
  mkdirSync(workspaceDir, { recursive: true });
  const adapter = new ToolEcho({ stepDelayMs: 100 });
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
      .session as { id: SessionId; title: string };
  /** 这个会话的 MCP 端点上调一个工具；返回 MCP 的结果（`isError`、文本与结构化内容）。 */
  const tool = async (sessionId: SessionId, name: string, args: Record<string, unknown> = {}) => {
    const { session } = await client.request('session.get', { sessionId });
    const endpoint = adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
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
      text: (result.content?.[0]?.text ?? '') as string,
      // biome-ignore lint/suspicious/noExplicitAny: 同上。
      data: result.structuredContent as Record<string, any> | undefined,
    };
  };
  const names = async (sessionId: SessionId) => {
    const { session } = await client.request('session.get', { sessionId });
    const endpoint = adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: 同上。
    const tools = ((await response.json()) as Record<string, any>).result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, { enum?: string[] }> };
    }>;
    return tools;
  };
  /** 开一个回合（echo 的 `slow` 让它持续几秒），返回事件订阅。 */
  const running = async (sessionId: SessionId) => {
    const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'slow slow slow slow slow slow slow slow' }],
    });
    await client.until(
      () => client.events(subscriptionId).find((event) => event.type === 'turn.started'),
      'running',
    );
    return subscriptionId as string;
  };
  /** 等 Host 补问的审批出现，按 `allow` 或 `deny` 答。 */
  const answer = async (subscriptionId: string, optionId: 'allow' | 'deny', seen = 0) => {
    const requested = await client.until(
      () =>
        client
          .events(subscriptionId)
          .filter(
            (event): event is Extract<WevirEvent, { type: 'approval.requested' }> =>
              event.type === 'approval.requested',
          )[seen],
      'approval.requested',
    );
    await client.request('approval.respond', {
      approvalId: requested.payload.approval.id,
      optionId,
    });
    return requested.payload.approval;
  };
  return { client, workspaceId, create, tool, names, running, answer };
}

describe('配置 Wevir 本身的应用级工具', { timeout: 60_000 }, () => {
  it('列出六个工具，wevir_show 能打开设置页', async () => {
    const h = await boot();
    const session = await h.create();
    const tools = await h.names(session.id);
    for (const name of [
      'wevir_config_read',
      'wevir_config_settings',
      'wevir_config_update',
      'wevir_config_checks',
      'wevir_config_install',
      'wevir_config_session',
    ]) {
      expect(tools.map((item) => item.name)).toContain(name);
    }
    const show = tools.find((item) => item.name === 'wevir_show');
    expect(show?.inputSchema.properties.kind?.enum).toContain('settings');

    const { subscriptionId } = await h.client.request('events.subscribe', {
      sessionId: session.id,
      sinceSeq: 0,
    });
    const shown = await h.tool(session.id, 'wevir_show', { kind: 'settings', page: 'providers' });
    expect(shown.isError).toBe(false);
    const event = await h.client.until(
      () => h.client.events(subscriptionId).find((item) => item.type === 'ui.show'),
      'ui.show',
    );
    expect(event.payload).toMatchObject({ target: { kind: 'settings', page: 'providers' } });
    expect((await h.tool(session.id, 'wevir_show', { kind: 'settings' })).text).toContain(
      'page is required',
    );
  });

  it('设置：照常的直接改，只有用户能改的拒绝，要批准的由 Host 补问', async () => {
    const h = await boot();
    const session = await h.create();
    const read = await h.tool(session.id, 'wevir_config_read', { section: 'settings' });
    expect(read.data?.access.userOnly).toEqual(
      expect.arrayContaining(['computerUse', 'remote', 'iosSimulator']),
    );
    expect(read.data?.access.needsApproval).toContain('agentInstructions');

    const plain = await h.tool(session.id, 'wevir_config_settings', {
      settings: { promptSuggestions: false, outputStyle: 'concise' },
    });
    expect(plain.isError).toBe(false);
    expect((await h.client.request('settings.get')).settings).toMatchObject({
      promptSuggestions: false,
      outputStyle: 'concise',
    });

    const userOnly = await h.tool(session.id, 'wevir_config_settings', {
      settings: { computerUse: true },
    });
    expect(userOnly).toMatchObject({ isError: true });
    expect(userOnly.text).toContain('Only the user can change computerUse');
    expect(userOnly.text).toContain('"computerUse"');
    expect((await h.client.request('settings.get')).settings.computerUse).not.toBe(true);
    expect(
      (await h.tool(session.id, 'wevir_config_settings', { settings: { theme: 'dark' } })).text,
    ).toContain('Unknown settings: theme');
    // Host 校验：认不出的输出风格。
    expect(
      (await h.tool(session.id, 'wevir_config_settings', { settings: { outputStyle: 'loud' } }))
        .text,
    ).toContain('INVALID_PARAMS');

    // 没有进行中的回合：没人能批准，不改。
    const idle = await h.tool(session.id, 'wevir_config_settings', {
      settings: { agentInstructions: 'Always answer in French.' },
    });
    expect(idle.text).toContain('denied or cancelled');
    expect((await h.client.request('settings.get')).settings.agentInstructions ?? '').toBe('');

    const subscriptionId = await h.running(session.id);
    const denied = h.tool(session.id, 'wevir_config_settings', {
      settings: { agentInstructions: 'Always answer in French.' },
    });
    const approval = await h.answer(subscriptionId, 'deny');
    expect(approval.detail?.toolName).toBe('mcp__wevir__wevir_config_settings');
    expect((await denied).text).toContain('denied or cancelled');
    expect((await h.client.request('settings.get')).settings.agentInstructions ?? '').toBe('');

    const allowed = h.tool(session.id, 'wevir_config_settings', {
      settings: { agentInstructions: 'Always answer in French.' },
    });
    await h.answer(subscriptionId, 'allow', 1);
    expect((await allowed).isError).toBe(false);
    expect((await h.client.request('settings.get')).settings.agentInstructions).toBe(
      'Always answer in French.',
    );
  });

  it('环境：每次改动都要批准，只回变量名，值不进事件', async () => {
    const h = await boot();
    const session = await h.create();
    const subscriptionId = await h.running(session.id);
    const created = h.tool(session.id, 'wevir_config_update', {
      target: 'environment',
      action: 'add',
      name: 'staging',
      folders: [{ projectId: h.workspaceId, worktree: 'none' }],
      variables: [{ name: 'API_TOKEN', value: SECRET }],
    });
    const approval = await h.answer(subscriptionId, 'allow');
    expect(JSON.stringify(approval)).not.toContain(SECRET);
    expect(JSON.stringify(approval.detail?.input)).toContain('API_TOKEN (new value)');
    const result = await created;
    expect(result.isError).toBe(false);
    expect(result.data?.environment.variables).toEqual(['API_TOKEN']);
    expect(result.text).not.toContain(SECRET);

    const listed = await h.tool(session.id, 'wevir_config_read', { section: 'environments' });
    expect(listed.data?.environments[0]).toMatchObject({
      name: 'staging',
      variables: ['API_TOKEN'],
    });
    expect(listed.text).not.toContain(SECRET.slice(-6));
    expect(JSON.stringify(h.client.events(subscriptionId))).not.toContain(SECRET);

    const removed = h.tool(session.id, 'wevir_config_update', {
      target: 'environment',
      action: 'remove',
      environmentId: listed.data?.environments[0].id,
    });
    await h.answer(subscriptionId, 'deny', 1);
    expect((await removed).text).toContain('denied or cancelled');
    expect((await h.client.request('environment.list')).environments).toHaveLength(1);
  });

  it('项目、审批规则与检查', async () => {
    const h = await boot();
    const session = await h.create();
    const renamed = await h.tool(session.id, 'wevir_config_update', {
      target: 'project',
      action: 'update',
      name: 'Renamed',
    });
    expect(renamed.data?.project).toMatchObject({ id: h.workspaceId, displayName: 'Renamed' });
    const projects = await h.tool(session.id, 'wevir_config_read', { section: 'projects' });
    expect(projects.data?.currentProjectId).toBe(h.workspaceId);

    // 移除项目要批准；没有回合时不移除。
    const remove = await h.tool(session.id, 'wevir_config_update', {
      target: 'project',
      action: 'remove',
      projectId: h.workspaceId,
    });
    expect(remove.text).toContain('denied or cancelled');

    const subscriptionId = await h.running(session.id);
    const rule = h.tool(session.id, 'wevir_config_update', {
      target: 'approval_rule',
      action: 'add',
      prefix: ['pnpm', 'test'],
    });
    const approval = await h.answer(subscriptionId, 'allow');
    expect(approval.detail?.input).toMatchObject({ prefix: 'pnpm test', scope: 'project' });
    expect((await rule).data?.rule).toMatchObject({
      prefix: ['pnpm', 'test'],
      workspaceId: h.workspaceId,
    });
    const rules = await h.tool(session.id, 'wevir_config_read', { section: 'approval_rules' });
    expect(rules.data?.rules).toHaveLength(1);

    const saved = await h.tool(session.id, 'wevir_config_checks', {
      action: 'save',
      check: { name: 'Unit tests', command: 'pnpm test', kind: 'test', trigger: 'manual' },
    });
    expect(saved.isError).toBe(false);
    expect(saved.data?.check).toMatchObject({ name: 'Unit tests', source: { kind: 'user' } });
    const checks = await h.tool(session.id, 'wevir_config_read', { section: 'checks' });
    expect(checks.data?.checks.map((check: { name: string }) => check.name)).toEqual([
      'Unit tests',
    ]);
    const bad = await h.tool(session.id, 'wevir_config_checks', {
      action: 'save',
      check: { name: 'x' },
    });
    expect(bad.isError).toBe(true);
  });

  it('会话：只改自己与自己开出的，不碰权限模式', async () => {
    const h = await boot();
    const session = await h.create();
    const other = await h.create();
    const own = await h.tool(session.id, 'wevir_config_session', { title: 'Config work' });
    expect(own.data).toMatchObject({ sessionId: session.id, title: 'Config work' });
    expect((await h.client.request('session.get', { sessionId: session.id })).session.title).toBe(
      'Config work',
    );
    const foreign = await h.tool(session.id, 'wevir_config_session', {
      sessionId: other.id,
      title: 'Hijacked',
    });
    expect(foreign.text).toContain('was not opened by this session');
    expect((await h.client.request('session.get', { sessionId: other.id })).session.title).not.toBe(
      'Hijacked',
    );
    const nothing = await h.tool(session.id, 'wevir_config_session', {});
    expect(nothing.text).toContain('Nothing to change');
  });
});
