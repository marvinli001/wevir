// 应用级工具（0.30.0，domain-model §3.15）：Host 的 `/mcp` 端点（app-mcp.ts）与工具（app-tools.ts），用 echo 引擎跑会话，按 MCP 的
// Streamable HTTP 直接调端点（引擎怎样挂上它见各适配器的测试）。

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId, PendingDelivery, SessionId, SessionState, WevirEvent } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppMcpServer } from './app-mcp.js';
import {
  APP_TOOLS_INSTRUCTIONS,
  AppTools,
  engineSessionResolver,
  reportText,
} from './app-tools.js';
import { EventStore } from './event-store.js';
import { PluginRegistry } from './plugins.js';
import { ProcessManager } from './processes.js';
import { RoleStore } from './roles.js';
import { SessionManager } from './session-manager.js';
import { boardEventRecorder, TaskBoardStore } from './task-board.js';
import { identity, useStorages, useTempDir, zip } from './test-utils.js';
import { ToolOutputStore } from './tool-output.js';
import type { ToolPreset } from './tool-presets.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-16T00:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** echo 引擎，声明能挂应用级工具，记下每个引擎会话拿到的端点。 */
class ToolEcho extends EchoAdapter {
  readonly appTools = true;
  readonly endpoints = new Map<string, AppToolsEndpoint | undefined>();
  /** 建会话的过程中先调它（同 Codex：起 thread 时就连上应用级工具）。 */
  onCreate: ((config: SessionConfig) => Promise<void>) | undefined;

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    await this.onCreate?.(config);
    const session = await super.createSession(config);
    this.endpoints.set(session.engineSessionId, config.appTools);
    return session;
  }
}

async function setup(
  stepDelayMs = 0,
  withPlugins = false,
  withProcesses = false,
  busyDelivery: PendingDelivery = 'queue',
) {
  const root = realpathSync(tempDir());
  const storage = storages.open(join(root, 'data'));
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'notes.md'), '# notes\n');
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: workspace,
    displayName: 'project',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.providers.insert({
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }, { id: 'm2' }],
    defaultModelId: 'm',
    createdAt: T0,
    updatedAt: T0,
  });
  const errors: unknown[] = [];
  const events = new EventStore({ storage, deltaWindowMs: 5, onError: (e) => errors.push(e) });
  const adapter = new ToolEcho({ stepDelayMs });
  let tools: AppTools | undefined;
  let mcp: AppMcpServer | undefined;
  const manager = new SessionManager({
    storage,
    events,
    adapter,
    onError: (e) => errors.push(e),
    appTools: {
      grant: (sessionId) => mcp?.grant(sessionId),
      prepareEvent: (sessionId, event) =>
        tools?.plugins?.prepareEvent(sessionId, event) ?? Promise.resolve(event),
      resolved: (sessionId, toolCallId, approved) =>
        tools?.plugins?.resolved(sessionId, toolCallId, approved),
      dispose: () => tools?.plugins?.close(),
    },
    onTurnFinished: (info) => tools?.onTurnFinished(info),
  });
  const plugins = withPlugins
    ? new PluginRegistry({
        home: join(root, 'data'),
        userHome: join(root, 'user'),
        roots: () => [workspace],
        adapter,
      })
    : undefined;
  await plugins?.load();
  const toolOutput = new ToolOutputStore(join(root, 'data', 'tool-output'));
  const processes = withProcesses
    ? new ProcessManager({
        output: toolOutput,
        onNotice: (notice) => tools?.onProcessNotice(notice),
        env: { PATH: process.env.PATH, SHELL: '/bin/sh' },
      })
    : undefined;
  const rolesDir = join(root, 'data', 'roles');
  const projectRolesDir = join(workspace, '.wevir', 'roles');
  tools = new AppTools({
    roles: new RoleStore({ dir: rolesDir }),
    tasks: new TaskBoardStore({
      dir: join(root, 'data', 'tasks'),
      onChange: boardEventRecorder(events, (message, fields) => errors.push({ message, fields })),
    }),
    ...(plugins && { plugins }),
    ...(processes && { processes }),
    storage,
    events,
    sessions: manager,
    hostId: 'host_test' as HostId,
    sendWhileBusy: () => busyDelivery,
    onWarning: (message, fields) => errors.push({ message, fields }),
  });
  const appTools = tools;
  mcp = new AppMcpServer({
    tools: tools.tools,
    filterTools: (sessionId, list) => appTools.filterTools(sessionId, list),
    instructions: (sessionId) => appTools.instructions(sessionId),
    version: '0.0.0',
    onError: (e) => errors.push(e),
    engineSession: engineSessionResolver(storage, 'echo'),
    ...(withProcesses && {
      spill: (sessionId, toolName, result) => toolOutput.spill(sessionId, toolName, result),
    }),
  });
  const appMcp = mcp;
  const http: Server = createServer((req, res) => {
    if (!appMcp.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  appMcp.setPort(port);
  cleanups.push(async () => {
    appMcp.close();
    await processes?.close();
    await manager.dispose();
    await adapter.dispose();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  const create = async (extra: Partial<Parameters<SessionManager['create']>[0]> = {}) =>
    (await manager.create({ workspaceId: 'ws_1', providerId: 'mock', ...extra })).id;
  const tokenOf = (sessionId: SessionId): string => {
    const record = storage.sessions.get(sessionId);
    const endpoint = record && adapter.endpoints.get(record.engineSessionId);
    if (!endpoint) throw new Error(`no endpoint for ${sessionId}`);
    return endpoint.token;
  };
  let nextId = 0;
  const rpc = async (
    sessionId: SessionId,
    method: string,
    params: unknown = {},
    headers: Record<string, string> = {},
  ) => {
    nextId += 1;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokenOf(sessionId)}`,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: 测试里读任意形状的 JSON-RPC 回复。
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  /** 调工具，返回 `structuredContent`；`isError` 时返回错误文本。 */
  const call = async (sessionId: SessionId, name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc(sessionId, 'tools/call', { name, arguments: args });
    const result = body.result as {
      isError?: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: 同上，工具的结构化结果。
      structuredContent?: Record<string, any>;
      content: Array<{ text: string }>;
    };
    if (result.isError) return { error: result.content[0]?.text ?? '' };
    return result.structuredContent ?? {};
  };
  const state = (sessionId: SessionId): SessionState | undefined =>
    events.snapshot(sessionId)?.session.state;
  const settle = async (sessionId: SessionId) => {
    await vi.waitFor(() => expect(state(sessionId)).toBe('idle'), { timeout: 5000 });
  };
  const all = (sessionId: SessionId): WevirEvent[] => events.readSince(sessionId, 0);
  const send = (sessionId: SessionId, text: string) =>
    manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
  return {
    root,
    storage,
    events,
    manager,
    plugins,
    tools,
    adapter,
    errors,
    port,
    grantEngine: (kinds: readonly string[]) => appMcp.grantEngine(kinds),
    processes,
    toolOutput,
    workspace,
    rolesDir,
    projectRolesDir,
    create,
    tokenOf,
    rpc,
    call,
    state,
    settle,
    all,
    send,
  };
}

describe('应用级工具的端点', () => {
  it('每个会话一个令牌；没有令牌、带 Origin、Host 不对、不是 POST 都拒绝', async () => {
    const h = await setup();
    const a = await h.create();
    const b = await h.create();
    expect(h.tokenOf(a)).not.toBe(h.tokenOf(b));
    const url = `http://127.0.0.1:${h.port}/mcp`;
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer nope' })).status).toBe(401);
    const auth = { Authorization: `Bearer ${h.tokenOf(a)}` };
    expect((await post({ ...auth, Origin: 'http://evil.example' })).status).toBe(403);
    // fetch 不让改 Host 头，用 node:http（DNS 重绑定：浏览器带着别的域名打到本机端口）。
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: '/mcp',
          method: 'POST',
          headers: { ...auth, Host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(rebound).toBe(403);
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await post(auth)).status).toBe(200);
  });

  it('initialize、tools/list 与通知', async () => {
    const h = await setup();
    const a = await h.create();
    const init = await h.rpc(a, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    expect(init.body.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'wevir' },
    });
    const list = await h.rpc(a, 'tools/list');
    const tools = list.body.result.tools as Array<{ name: string; annotations: unknown }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'wevir_session_list',
      'wevir_session_read',
      'wevir_models',
      'wevir_roles',
      'wevir_tasks',
      'wevir_task_create',
      'wevir_task_update',
      'wevir_session_create',
      'wevir_session_send',
      'wevir_session_wait',
      'wevir_session_progress',
      'wevir_session_interrupt',
      'wevir_session_close',
      'wevir_session_archive',
      'wevir_show',
      'wevir_share_file',
    ]);
    expect(tools.find((tool) => tool.name === 'wevir_session_create')?.annotations).toMatchObject({
      destructiveHint: true,
    });
    const notification = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.tokenOf(a)}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);
    const unknown = await h.rpc(a, 'tools/call', { name: 'nope', arguments: {} });
    expect(unknown.body.error).toMatchObject({ code: -32602 });
  });
});

describe('引擎令牌（OpenCode：一个进程服务所有会话）', () => {
  /** 带引擎令牌与引擎会话 ID 的请求。 */
  const engineRpc = async (
    port: number,
    token: string,
    engineSessionId: string | undefined,
    method: string,
    params: unknown = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(engineSessionId !== undefined && { 'x-wevir-engine-session': engineSessionId }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('json') === true;
    // biome-ignore lint/suspicious/noExplicitAny: 测试里读任意形状的 JSON-RPC 回复。
    const body: any = json ? JSON.parse(text) : text;
    return { status: response.status, body };
  };

  it('按引擎会话 ID 映射回 Wevir 会话，同按会话的令牌一样调用', async () => {
    const h = await setup();
    const a = await h.create();
    const b = await h.create();
    // 还没监听、没有种类、不认引擎会话时都不发。
    const idle = new AppMcpServer({ tools: [], version: '0', engineSession: () => undefined });
    expect(idle.grantEngine(['openai-compatible'])).toBeUndefined();
    expect(h.grantEngine([])).toBeUndefined();
    const grant = h.grantEngine;
    const endpoint = grant(['openai-compatible']);
    if (endpoint === undefined) throw new Error('no engine grant');
    expect(endpoint.url).toBe(`http://127.0.0.1:${h.port}/mcp`);
    // 同一组种类一直是同一个令牌，和会话的令牌不同。
    expect(grant(['openai-compatible'])?.token).toBe(endpoint.token);
    expect(endpoint.token).not.toBe(h.tokenOf(a));

    // 不带会话：能列工具（插件启动时），不能调用。
    const list = await engineRpc(h.port, endpoint.token, undefined, 'tools/list');
    expect(list.status).toBe(200);
    expect(list.body.result.tools).toHaveLength(16);
    const anonymous = await engineRpc(h.port, endpoint.token, undefined, 'tools/call', {
      name: 'wevir_session_list',
      arguments: {},
    });
    expect(anonymous.body.error).toMatchObject({ code: -32602 });

    // 带 b 的引擎会话 ID：调用方是 b。
    const engineB = h.storage.sessions.get(b)?.engineSessionId as string;
    const listed = await engineRpc(h.port, endpoint.token, engineB, 'tools/call', {
      name: 'wevir_session_list',
      arguments: {},
    });
    expect(listed.status).toBe(200);
    const sessions = listed.body.result.structuredContent.sessions as Array<{
      sessionId: string;
      isYou: boolean;
    }>;
    expect(sessions.find((session) => session.isYou)?.sessionId).toBe(b);
  });

  it('拒绝：令牌不对、不认识的会话、别的引擎的会话', async () => {
    const h = await setup();
    const a = await h.create();
    const engineA = h.storage.sessions.get(a)?.engineSessionId as string;
    const grant = h.grantEngine;
    const own = grant(['openai-compatible']);
    const other = grant(['opencode']);
    if (own === undefined || other === undefined) throw new Error('no engine grant');
    expect(other.token).not.toBe(own.token);
    const call = { name: 'wevir_session_list', arguments: {} };

    expect((await engineRpc(h.port, 'nope', engineA, 'tools/call', call)).status).toBe(401);
    expect((await engineRpc(h.port, own.token, 'ses_unknown', 'tools/call', call)).status).toBe(
      404,
    );
    // a 的 Provider 是 openai-compatible：只认 opencode 的引擎令牌冒充不了它。
    expect((await engineRpc(h.port, other.token, engineA, 'tools/call', call)).status).toBe(404);
    // 按会话的令牌不看这个请求头：照旧是令牌对应的会话。
    const b = await h.create();
    const engineB = h.storage.sessions.get(b)?.engineSessionId as string;
    const mixed = await h.rpc(a, 'tools/call', call, { 'x-wevir-engine-session': engineB });
    const sessions = mixed.body.result.structuredContent.sessions as Array<{
      sessionId: string;
      isYou: boolean;
    }>;
    expect(sessions.find((session) => session.isYou)?.sessionId).toBe(a);
  });
});

describe('应用级工具', () => {
  it('列出与读：带 isYou，读按位置翻页', async () => {
    const h = await setup();
    const a = await h.create();
    const b = await h.create();
    await h.send(b, 'hello there');
    await h.settle(b);
    const listed = await h.call(a, 'wevir_session_list');
    expect(listed.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
      [a, b].sort(),
    );
    expect(listed.sessions.find((s: { sessionId: string }) => s.sessionId === a)).toMatchObject({
      isYou: true,
      project: { name: 'project' },
    });
    const page = await h.call(a, 'wevir_session_read', { sessionId: b, limit: 1 });
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.items[0]).toMatchObject({ position: 1, role: 'user', kind: 'user_message' });
    expect(page.nextPosition).toBe(1);
    const rest = await h.call(a, 'wevir_session_read', { sessionId: b, afterPosition: 1 });
    expect(rest.items[0]).toMatchObject({ role: 'assistant' });
    expect(await h.call(a, 'wevir_session_read', { sessionId: 'ses_nope' })).toEqual({
      error: 'No Wevir session ses_nope.',
    });
  });

  it('新开会话：记下 openedBy 与 from，回合结束后结果作为 report 发回', async () => {
    const h = await setup();
    const parent = await h.create();
    const created = await h.call(parent, 'wevir_session_create', {
      message: 'write a summary',
      title: 'Summary',
      modelId: 'm2',
    });
    const child = created.sessionId as SessionId;
    expect(created).toMatchObject({ title: 'Summary', modelId: 'm2', reportBack: true });
    expect(h.events.snapshot(child)?.session.openedBy).toEqual({ sessionId: parent });
    const message = h.all(child).find((e) => e.type === 'user.message');
    expect(message?.payload).toMatchObject({
      from: { sessionId: parent, kind: 'message', reportBack: true },
    });
    // 子会话有自己的令牌。
    expect(h.tokenOf(child)).not.toBe(h.tokenOf(parent));
    await h.settle(child);
    await vi.waitFor(() =>
      expect(
        h.all(parent).some((e) => e.type === 'user.message' && e.payload.from?.kind === 'report'),
      ).toBe(true),
    );
    const report = h
      .all(parent)
      .find((e) => e.type === 'user.message' && e.payload.from?.kind === 'report');
    expect(report?.payload).toMatchObject({ from: { sessionId: child, kind: 'report' } });
    const text = report?.type === 'user.message' ? report.payload.content[0] : undefined;
    expect(text).toMatchObject({ type: 'text' });
    expect((text as { text: string }).text).toContain(`Session ${child} "Summary"`);
    await h.settle(parent);
    // 回报开始的回合结束时不再回报（不是别的会话要回报的消息）。
    expect(h.all(child).filter((e) => e.type === 'user.message')).toHaveLength(1);
  });

  it('新开会话的权限不能比自己宽；给权限更宽的会话发消息、给自己发消息都拒绝', async () => {
    const h = await setup();
    const narrow = await h.create();
    const wide = await h.create({ permissionMode: 'full_access' });
    expect(
      await h.call(narrow, 'wevir_session_create', { message: 'x', permissionMode: 'full_access' }),
    ).toEqual({ error: "permissionMode full_access is broader than this session's (on_request)." });
    expect(await h.call(narrow, 'wevir_session_send', { sessionId: wide, message: 'x' })).toEqual({
      error: `Session ${wide} runs with full_access, broader than this session's on_request.`,
    });
    const self = await h.call(narrow, 'wevir_session_send', { sessionId: narrow, message: 'x' });
    expect(self).toHaveProperty('error');
    // 反过来可以：宽的给窄的发。
    const sent = await h.call(wide, 'wevir_session_send', { sessionId: narrow, message: 'hi' });
    expect(sent).toMatchObject({ sessionId: narrow, started: true, reportBack: false });
    await h.settle(narrow);
    const created = await h.call(wide, 'wevir_session_create', { message: 'x' });
    expect(h.events.snapshot(created.sessionId)?.session.permissionMode).toBe('full_access');
  });

  it('等待拿到结果后不再回报；超时不打断对方', async () => {
    const h = await setup(20);
    const parent = await h.create();
    const created = await h.call(parent, 'wevir_session_create', { message: 'slow please' });
    const child = created.sessionId as SessionId;
    const early = await h.call(parent, 'wevir_session_wait', { sessionId: child, timeoutMs: 0 });
    expect(early).toMatchObject({ timedOut: true, state: 'running' });
    const waited = await h.call(parent, 'wevir_session_wait', {
      sessionId: child,
      timeoutMs: 10000,
    });
    expect(waited).toMatchObject({
      timedOut: false,
      state: 'idle',
      lastTurn: { outcome: 'completed' },
    });
    expect(typeof waited.answer).toBe('string');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      h.all(parent).some((e) => e.type === 'user.message' && e.payload.from?.kind === 'report'),
    ).toBe(false);
  });

  it('回报已经排进请求方的队列、之后又被等到时，撤回排队的回报', async () => {
    const h = await setup(20);
    const parent = await h.create();
    // 请求方正忙：回报只能排队（sendWhileBusy 是 queue）。
    await h.send(parent, 'slow please');
    const created = await h.call(parent, 'wevir_session_create', { message: 'hi' });
    const child = created.sessionId as SessionId;
    await h.settle(child);
    const queued = () =>
      h
        .all(parent)
        .flatMap((e) =>
          e.type === 'pending.added' || e.type === 'pending.updated' ? [e.payload.pending] : [],
        )
        .filter((p) => p.from?.kind === 'report');
    await vi.waitFor(() => expect(queued().length).toBeGreaterThan(0));
    const waited = await h.call(parent, 'wevir_session_wait', { sessionId: child });
    expect(waited).toMatchObject({ timedOut: false, lastTurn: { outcome: 'completed' } });
    expect(queued().at(-1)?.status).toBe('cancelled');
    await h.settle(parent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      h.all(parent).some((e) => e.type === 'user.message' && e.payload.from?.kind === 'report'),
    ).toBe(false);
  });

  it('Host 设置为插话时，回报也排队（排队的才撤得回），等到后不再送达', async () => {
    const h = await setup(20, false, false, 'steer');
    const parent = await h.create();
    // 请求方正忙：Host 默认的 sendWhileBusy 是 steer，但交给引擎的插话撤不回，回报不能走它。
    await h.send(parent, 'slow please');
    const created = await h.call(parent, 'wevir_session_create', { message: 'hi' });
    const child = created.sessionId as SessionId;
    await h.settle(child);
    const reports = () =>
      h
        .all(parent)
        .flatMap((e) =>
          e.type === 'pending.added' || e.type === 'pending.updated' ? [e.payload.pending] : [],
        )
        .filter((p) => p.from?.kind === 'report');
    await vi.waitFor(() => expect(reports().length).toBeGreaterThan(0));
    expect(reports().at(-1)).toMatchObject({ delivery: 'queue', status: 'waiting' });
    const waited = await h.call(parent, 'wevir_session_wait', { sessionId: child });
    expect(waited).toMatchObject({ timedOut: false, lastTurn: { outcome: 'completed' } });
    expect(reports().at(-1)?.status).toBe('cancelled');
    await h.settle(parent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const delivered = h
      .all(parent)
      .filter(
        (e) =>
          (e.type === 'user.message' && e.payload.from?.kind === 'report') ||
          (e.type === 'user.steered' && e.payload.pendingId === reports().at(-1)?.id),
      );
    expect(delivered).toEqual([]);
  });

  it('进度：进行中给现在在做什么、清单与已用时间，空闲的给上一个回合的结果；列表和等待超时也带', async () => {
    const h = await setup(30);
    const caller = await h.create();
    const idle = await h.create();
    expect(await h.call(caller, 'wevir_session_progress', { sessionId: idle })).not.toHaveProperty(
      'progress',
    );
    const opened = await h.call(caller, 'wevir_session_create', {
      message: 'slow plan tool',
      reportBack: false,
    });
    const child = opened.sessionId as SessionId;
    await vi.waitFor(() => expect(h.state(child)).toBe('running'));
    await vi.waitFor(async () => {
      const seen = await h.call(caller, 'wevir_session_progress', { sessionId: child });
      expect(seen.progress?.todos).toMatchObject({ total: 3 });
    });
    const running = await h.call(caller, 'wevir_session_progress', { sessionId: child });
    expect(running).toMatchObject({
      sessionId: child,
      state: 'running',
      progress: { doing: expect.any(String), toolsFinished: expect.any(Number) },
    });
    expect(running.progress.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(running.progress.todos.done).toBeLessThan(3);
    expect(running).not.toHaveProperty('lastTurn');

    // 列表：进行中的带 doing；等待超时：带 progress，不打断对方。
    const listed = await h.call(caller, 'wevir_session_list', { state: 'active' });
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId: child, doing: expect.any(String) }),
    ]);
    const waited = await h.call(caller, 'wevir_session_wait', { sessionId: child, timeoutMs: 0 });
    expect(waited).toMatchObject({ timedOut: true, progress: { turnId: running.progress.turnId } });

    // 做完以后没有 progress，有上一个回合的结局与回答。
    await h.settle(child);
    const done = await h.call(caller, 'wevir_session_progress', { sessionId: child });
    expect(done).not.toHaveProperty('progress');
    expect(done).toMatchObject({
      state: 'idle',
      lastTurn: { outcome: 'completed' },
      answer: expect.stringContaining('Echo'),
    });
    const after = await h.call(caller, 'wevir_session_list', { state: 'any' });
    expect(
      (after.sessions as Array<Record<string, unknown>>).find((s) => s.sessionId === child),
    ).not.toHaveProperty('doing');
  });

  it('请求方等着回报时，对方卡在等用户批准上：告诉请求方一次，用户批准后继续、结果照常回报', async () => {
    const h = await setup();
    // 请求方完全访问：它收到的通知里有 approve 一词，echo 不会因此自己请求审批；子会话收窄到请求批准。
    const caller = await h.create({ permissionMode: 'full_access' });
    const opened = await h.call(caller, 'wevir_session_create', {
      message: 'approve please',
      permissionMode: 'on_request',
    });
    const child = opened.sessionId as SessionId;
    await vi.waitFor(() => expect(h.state(child)).toBe('awaiting_approval'));
    // 子会话里的进度说明在等用户。
    const blocked = await h.call(caller, 'wevir_session_progress', { sessionId: child });
    expect(blocked.progress).toMatchObject({ waitingForUser: true });
    expect(blocked.progress.doing).toContain('waiting for the user to approve');
    // 请求方（空闲）收到一条 report，开了一个回合。
    await vi.waitFor(() => {
      const messages = h
        .all(caller)
        .filter((e) => e.type === 'user.message' && e.payload.from?.kind === 'report');
      expect(messages).toHaveLength(1);
    });
    const notice = h
      .all(caller)
      .find((e) => e.type === 'user.message' && e.payload.from?.kind === 'report');
    expect(notice?.type === 'user.message' && notice.payload.from).toMatchObject({
      sessionId: child,
      kind: 'report',
    });
    expect(
      notice?.type === 'user.message' && notice.payload.content[0]?.type === 'text'
        ? notice.payload.content[0].text
        : '',
    ).toMatch(/waiting for the user to approve/);
    await h.settle(caller);

    // 用户批准：子会话做完，最终结果照常回报（第二条 report），不再有“在等用户”的通知。
    const approval = h.events.snapshot(child)?.pendingApprovals[0];
    if (!approval) throw new Error('no approval');
    const allow = approval.options.find((option) => option.category === 'allow');
    if (!allow) throw new Error('no allow option');
    await h.manager.respondToApproval(
      { approvalId: approval.id, optionId: allow.optionId },
      identity,
    );
    await h.settle(child);
    await vi.waitFor(() => {
      const reports = h
        .all(caller)
        .filter((e) => e.type === 'user.message' && e.payload.from?.kind === 'report');
      expect(reports).toHaveLength(2);
    });
    const texts = h
      .all(caller)
      .flatMap((e) =>
        e.type === 'user.message' && e.payload.from?.kind === 'report'
          ? e.payload.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          : [],
      );
    expect(texts[1]).toContain('finished a turn you asked for');
    expect(h.errors).toEqual([]);
  });

  it('请求方的 wait 已经因为对方在等批准而返回：不再另发一条“在等用户”的回报', async () => {
    // 每一步慢一点，保证 wait 先挂上、对方后卡住（反过来的次序里请求方早被通知过，没有要抑制的）。
    const h = await setup(80);
    const caller = await h.create({ permissionMode: 'full_access' });
    const opened = await h.call(caller, 'wevir_session_create', {
      message: 'approve please',
      permissionMode: 'on_request',
    });
    const child = opened.sessionId as SessionId;
    // wait 在对方卡住的那一刻返回（也可能对方已经卡住，立刻返回）。
    const waited = await h.call(caller, 'wevir_session_wait', { sessionId: child });
    expect(waited).toMatchObject({ timedOut: false });
    expect(h.state(child)).toBe('awaiting_approval');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      h.all(caller).filter((e) => e.type === 'user.message' && e.payload.from?.kind === 'report'),
    ).toEqual([]);
  });

  it('不要求回报的会话卡在等用户上时，不打扰请求方', async () => {
    const h = await setup();
    const caller = await h.create();
    const opened = await h.call(caller, 'wevir_session_create', {
      message: 'approve please',
      reportBack: false,
    });
    const child = opened.sessionId as SessionId;
    await vi.waitFor(() => expect(h.state(child)).toBe('awaiting_approval'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.all(caller).filter((e) => e.type === 'user.message')).toEqual([]);
  });

  it('停下别的会话的回合', async () => {
    const h = await setup(30);
    const caller = await h.create();
    const target = await h.create();
    await h.send(target, 'slow work');
    await vi.waitFor(() => expect(h.state(target)).toBe('running'));
    const result = await h.call(caller, 'wevir_session_interrupt', { sessionId: target });
    expect(result).toMatchObject({ sessionId: target });
    await h.settle(target);
    const finished = h.all(target).find((e) => e.type === 'turn.finished');
    expect(finished?.payload).toMatchObject({ outcome: 'cancelled' });
  });

  it('关闭与归档只限自己开出来的会话（含它们再开的）：用户的会话、自己、子会话都拒绝；归档先关闭，可取消', async () => {
    const h = await setup(30);
    const caller = await h.create();
    const own = await h.create();
    const theirs = await h.create();
    // 用户自己的会话，不是 caller 开的。
    const opened = await h.call(caller, 'wevir_session_create', { message: 'slow work' });
    const child = opened.sessionId as SessionId;
    await vi.waitFor(() => expect(h.state(child)).toBe('running'));
    // 孙会话：child 开的，caller 也能收。
    const grand = (await h.manager.create(
      { workspaceId: 'ws_1', providerId: 'mock' },
      { openedBy: child },
    )) as { id: SessionId };

    for (const target of [own, theirs, caller]) {
      for (const name of ['wevir_session_close', 'wevir_session_archive']) {
        expect(
          await h.call(caller, name, { sessionId: target }),
          `${name} ${target}`,
        ).toHaveProperty('error');
      }
    }
    expect(h.storage.sessions.get(own)?.archivedAt).toBeUndefined();
    expect(h.state(own)).toBe('idle');

    // 关闭：进行中的回合被取消，会话仍在列表里（没归档）。
    const closed = await h.call(caller, 'wevir_session_close', { sessionId: child });
    expect(closed).toMatchObject({ sessionId: child, state: 'closed' });
    expect(closed).not.toHaveProperty('archived');
    const finished = h.all(child).find((e) => e.type === 'turn.finished');
    expect(finished?.payload).toMatchObject({ outcome: 'cancelled' });
    expect(h.storage.sessions.get(child)?.archivedAt).toBeUndefined();

    // 归档：先关闭再记时刻；孙会话也行；重复归档不改时刻。
    const archived = await h.call(caller, 'wevir_session_archive', { sessionId: grand.id });
    expect(archived).toMatchObject({ sessionId: grand.id, state: 'closed', archived: true });
    const at = h.storage.sessions.get(grand.id)?.archivedAt;
    expect(at).toBeDefined();
    await h.call(caller, 'wevir_session_archive', { sessionId: grand.id });
    expect(h.storage.sessions.get(grand.id)?.archivedAt).toBe(at);
    // 归档的默认不在列表里，includeArchived 才有。
    const visible = await h.call(caller, 'wevir_session_list', { state: 'any' });
    expect(
      (visible.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId),
    ).not.toContain(grand.id);
    const all = await h.call(caller, 'wevir_session_list', { includeArchived: true });
    expect((all.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toContain(
      grand.id,
    );
    // 取消归档。
    const restored = await h.call(caller, 'wevir_session_archive', {
      sessionId: grand.id,
      archived: false,
    });
    expect(restored).not.toHaveProperty('archived');
    expect(h.storage.sessions.get(grand.id)?.archivedAt).toBeUndefined();
  });

  it('wevir_show：会话目录里的文件写成 ui.show，目录外的拒绝', async () => {
    const h = await setup();
    const a = await h.create();
    const b = await h.create();
    expect(await h.call(a, 'wevir_show', { kind: 'file', path: 'notes.md', line: 1 })).toEqual({
      shown: true,
      target: { kind: 'file', path: 'notes.md', line: 1 },
    });
    expect(
      await h.call(a, 'wevir_show', { kind: 'file', path: join(h.workspace, 'notes.md') }),
    ).toMatchObject({ target: { kind: 'file', path: 'notes.md' } });
    expect(await h.call(a, 'wevir_show', { kind: 'file', path: '../secret' })).toHaveProperty(
      'error',
    );
    expect(await h.call(a, 'wevir_show', { kind: 'file', path: 'missing.md' })).toHaveProperty(
      'error',
    );
    await h.call(a, 'wevir_show', { kind: 'session', sessionId: b });
    await h.call(a, 'wevir_show', { kind: 'changes' });
    const shown = h.all(a).filter((e) => e.type === 'ui.show');
    expect(shown.map((e) => e.type === 'ui.show' && e.payload.target)).toEqual([
      { kind: 'file', path: 'notes.md', line: 1 },
      { kind: 'file', path: 'notes.md' },
      { kind: 'session', sessionId: b },
      { kind: 'changes' },
    ]);
  });

  it('wevir_share_file：会话文件夹里的文件写成 file.shared，带大小与类型，同一个文件只交一次；外面的、不在的、目录都拒绝', async () => {
    const h = await setup();
    const a = await h.create();
    mkdirSync(join(h.workspace, 'out'));
    writeFileSync(join(h.workspace, 'out', '周报.docx'), 'docx bytes');
    mkdirSync(join(h.workspace, '..', 'outside'));
    writeFileSync(join(h.workspace, '..', 'outside', 'x.txt'), 'x');
    symlinkSync(join(h.workspace, '..', 'outside', 'x.txt'), join(h.workspace, 'link.txt'));

    expect(
      await h.call(a, 'wevir_share_file', {
        paths: ['out/周报.docx', join(h.workspace, 'notes.md'), 'notes.md'],
      }),
    ).toEqual({
      shared: [
        { path: 'out/周报.docx', name: '周报.docx', size: 10 },
        { path: 'notes.md', name: 'notes.md', size: 8 },
      ],
    });
    for (const paths of [['../outside/x.txt'], ['link.txt'], ['missing.md'], ['out'], []]) {
      expect(await h.call(a, 'wevir_share_file', { paths }), JSON.stringify(paths)).toHaveProperty(
        'error',
      );
    }
    const shared = h.all(a).filter((e) => e.type === 'file.shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.type === 'file.shared' && shared[0].payload.files).toEqual([
      {
        path: 'out/周报.docx',
        name: '周报.docx',
        size: 10,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { path: 'notes.md', name: 'notes.md', size: 8, mimeType: 'text/markdown' },
    ]);
  });

  it('可选的模型与权限模式', async () => {
    const h = await setup();
    const a = await h.create({ permissionMode: 'auto_review' });
    const models = await h.call(a, 'wevir_models');
    expect(models).toMatchObject({
      current: { providerId: 'mock', modelId: 'm', permissionMode: 'auto_review' },
      // 没有显示名的模型用 ID 当名字，各家 Provider 的条目形状一样。
      providers: [
        {
          providerId: 'mock',
          models: [
            { id: 'm', name: 'm' },
            { id: 'm2', name: 'm2' },
          ],
        },
      ],
      permissionModes: ['on_request', 'auto_review'],
    });
  });
});

describe('共享任务清单', () => {
  const tasks = async (h: Awaited<ReturnType<typeof setup>>, id: SessionId, args = {}) =>
    (await h.call(id, 'wevir_tasks', args)) as {
      board: string;
      counts: Record<string, number>;
      // biome-ignore lint/suspicious/noExplicitAny: 测试里读任意形状的工具结果。
      tasks: Array<Record<string, any>>;
      error?: string;
    };

  it('一棵会话树共用一张清单：建、认领、依赖、备注、做完；别棵树看不到', async () => {
    const h = await setup();
    const lead = await h.create();
    const worker = (
      await h.call(lead, 'wevir_session_create', { message: 'help', reportBack: false })
    ).sessionId as SessionId;
    const grand = (
      await h.manager.create({ workspaceId: 'ws_1', providerId: 'mock' }, { openedBy: worker })
    ).id;
    const stranger = await h.create();

    const first = await h.call(lead, 'wevir_task_create', {
      subject: 'Write the parser',
      description: 'Handle quoted fields.',
    });
    expect(first).toMatchObject({
      board: lead,
      task: { id: 't1', status: 'pending', ready: true },
    });
    const second = await h.call(lead, 'wevir_task_create', {
      subject: 'Test the parser',
      blockedBy: ['t1'],
      owner: worker,
    });
    expect(second.task).toMatchObject({
      id: 't2',
      owner: worker,
      blockedBy: ['t1'],
      waitingFor: ['t1'],
    });
    expect(second.task).not.toHaveProperty('ready');

    // 孙会话和子会话看到的是同一张清单；别的树是另一张。
    const seen = await tasks(h, grand);
    expect(seen.board).toBe(lead);
    expect(seen.tasks.map((task) => task.id)).toEqual(['t1', 't2']);
    expect(seen.tasks[0]).toMatchObject({ ready: true });
    expect(seen.counts).toMatchObject({ pending: 2, completed: 0 });
    expect((await tasks(h, stranger)).tasks).toEqual([]);

    // 被依赖挡住的不能开始、不能完成；其他会话认领的只能加备注。
    const early = await h.call(worker, 'wevir_task_update', { id: 't2', status: 'in_progress' });
    expect(early.error).toMatch(/waits for t1 \(pending\)/);
    const taken = await h.call(grand, 'wevir_task_update', { id: 't2', status: 'cancelled' });
    expect(taken.error).toMatch(new RegExp(`owned by ${worker}`));
    expect(
      await h.call(grand, 'wevir_task_update', { id: 't2', note: 'I can pair on this' }),
    ).toMatchObject({ task: { notes: [{ sessionId: grand, text: 'I can pair on this' }] } });

    // 开始就认领（没人认领时）；认领后别人不能抢。
    const claimed = await h.call(grand, 'wevir_task_update', { id: 't1', status: 'in_progress' });
    expect(claimed.task).toMatchObject({ owner: grand, ownedByYou: true, status: 'in_progress' });
    const stolen = await h.call(worker, 'wevir_task_update', { id: 't1', owner: 'me' });
    expect(stolen.error).toMatch(new RegExp(`owned by ${grand}`));
    // 建它的会话可以收回。
    expect(await h.call(lead, 'wevir_task_update', { id: 't1', owner: 'none' })).toMatchObject({
      task: { id: 't1' },
    });
    expect((await h.call(lead, 'wevir_tasks', { id: 't1' })).task).not.toHaveProperty('owner');

    // 做完以后依赖解除，后一项可以开始。
    await h.call(grand, 'wevir_task_update', { id: 't1', status: 'completed', owner: 'me' });
    const ready = await tasks(h, worker, { owner: 'me' });
    expect(ready.tasks).toEqual([
      expect.objectContaining({ id: 't2', ready: true, ownedByYou: true }),
    ]);
    expect(
      (await h.call(worker, 'wevir_task_update', { id: 't2', status: 'in_progress' })).task,
    ).toMatchObject({
      status: 'in_progress',
    });
    // 默认只列没做完的；all 全列；单个任务带说明与备注。
    expect((await tasks(h, lead)).tasks.map((task) => task.id)).toEqual(['t2']);
    expect((await tasks(h, lead, { status: 'all' })).tasks.map((task) => task.id)).toEqual([
      't1',
      't2',
    ]);
    expect((await h.call(lead, 'wevir_tasks', { id: 't1' })).task).toMatchObject({
      description: 'Handle quoted fields.',
      createdBy: lead,
    });
  });

  it('参数与规则：自己依赖自己、成环、不存在的任务、树外的认领、空改动、删除', async () => {
    const h = await setup();
    const lead = await h.create();
    const stranger = await h.create();
    await h.call(lead, 'wevir_task_create', { subject: 'a' });
    await h.call(lead, 'wevir_task_create', { subject: 'b', blockedBy: ['t1'] });
    expect(
      (await h.call(lead, 'wevir_task_update', { id: 't1', addBlockedBy: ['t1'] })).error,
    ).toMatch(/cannot wait for itself/);
    expect(
      (await h.call(lead, 'wevir_task_update', { id: 't1', addBlockedBy: ['t2'] })).error,
    ).toMatch(/loop/);
    expect(
      (await h.call(lead, 'wevir_task_create', { subject: 'c', blockedBy: ['t9'] })).error,
    ).toMatch(/No task t9/);
    expect((await h.call(lead, 'wevir_task_update', { id: 't7', note: 'x' })).error).toMatch(
      /No task t7/,
    );
    expect(
      (await h.call(lead, 'wevir_task_create', { subject: 'd', owner: stranger })).error,
    ).toMatch(/not in this task list's session tree/);
    expect((await h.call(lead, 'wevir_task_update', { id: 't1' })).error).toMatch(
      /Nothing to change/,
    );
    expect((await h.call(lead, 'wevir_task_create', { subject: '   ' })).error).toMatch(/subject/);
    expect((await h.call(lead, 'wevir_task_update', { id: 't1', status: 'done' })).error).toMatch(
      /status must be/,
    );

    // 删掉 t1 后，t2 不再被它挡住；删除后编号不重用。
    expect(await h.call(lead, 'wevir_task_update', { id: 't1', delete: true })).toEqual({
      board: lead,
      deleted: 't1',
    });
    const left = await tasks(h, lead);
    expect(left.tasks).toEqual([expect.objectContaining({ id: 't2', ready: true })]);
    expect(left.tasks[0]).not.toHaveProperty('blockedBy');
    expect((await h.call(lead, 'wevir_task_create', { subject: 'e' })).task).toMatchObject({
      id: 't3',
    });
  });

  it('每次改动在根会话的事件流里写一条 tasks.board_updated（整张清单），快照带 taskBoard；失败的改动不写', async () => {
    const h = await setup();
    const lead = await h.create();
    const worker = (
      await h.call(lead, 'wevir_session_create', { message: 'help', reportBack: false })
    ).sessionId as SessionId;
    const boardEvents = () => h.all(lead).filter((event) => event.type === 'tasks.board_updated');
    const latest = () => {
      const event = boardEvents().at(-1);
      return event?.type === 'tasks.board_updated' ? event.payload.tasks : [];
    };
    expect(boardEvents()).toHaveLength(0);
    expect(h.events.snapshot(lead)?.taskBoard).toBeUndefined();

    await h.call(lead, 'wevir_task_create', { subject: 'Write the parser' });
    await h.call(worker, 'wevir_task_create', {
      subject: 'Test the parser',
      blockedBy: ['t1'],
      owner: 'me',
    });
    // 子会话改的清单写在根会话里，子会话自己没有。
    expect(boardEvents()).toHaveLength(2);
    expect(h.all(worker).some((event) => event.type === 'tasks.board_updated')).toBe(false);
    expect(h.events.snapshot(worker)?.taskBoard).toBeUndefined();
    expect(latest()).toEqual([
      expect.objectContaining({ id: 't1', status: 'pending', createdBy: lead, blockedBy: [] }),
      expect.objectContaining({ id: 't2', owner: worker, blockedBy: ['t1'] }),
    ]);
    expect(h.events.snapshot(lead)?.taskBoard).toEqual(latest());

    // 被拒绝的改动不写事件；备注在事件里只带最近 5 条。
    expect(
      (await h.call(worker, 'wevir_task_update', { id: 't2', status: 'in_progress' })).error,
    ).toMatch(/waits for t1/);
    expect(boardEvents()).toHaveLength(2);
    for (let i = 1; i <= 7; i += 1) {
      await h.call(worker, 'wevir_task_update', { id: 't2', note: `note ${i}` });
    }
    const t2 = latest().find((task) => task.id === 't2');
    expect(t2?.notes.map((note) => note.text)).toEqual([
      'note 3',
      'note 4',
      'note 5',
      'note 6',
      'note 7',
    ]);
    expect((await h.call(lead, 'wevir_tasks', { id: 't2' })).task.notes).toHaveLength(7);

    // 删光以后是一张空清单，不是没有。
    await h.call(lead, 'wevir_task_update', { id: 't1', delete: true });
    await h.call(worker, 'wevir_task_update', { id: 't2', delete: true });
    expect(latest()).toEqual([]);
    expect(h.events.snapshot(lead)?.taskBoard).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('清单存在数据目录里：Host 重启后还在；根会话不在了的清单启动时清掉', async () => {
    const h = await setup();
    const lead = await h.create();
    await h.call(lead, 'wevir_task_create', { subject: 'persisted' });
    const store = new TaskBoardStore({ dir: join(h.workspace, '..', 'data', 'tasks') });
    expect((await store.list(lead)).map((task) => task.subject)).toEqual(['persisted']);
    expect(await store.sweep((id) => id === lead)).toBe(0);
    expect(await store.sweep(() => false)).toBe(1);
    expect(await store.list(lead)).toEqual([]);
  });
});

describe('预设角色', () => {
  const role = (lines: string[], body = 'Do the thing carefully.') =>
    `---\n${lines.join('\n')}\n---\n${body}\n`;
  /** 列出某个会话看得到的工具名。 */
  const visible = async (h: Awaited<ReturnType<typeof setup>>, sessionId: SessionId) => {
    const list = await h.rpc(sessionId, 'tools/list');
    return (list.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  };

  it('wevir_roles：内置的、用户的、项目的（同名项目盖用户盖内置），坏文件另列', async () => {
    const h = await setup();
    mkdirSync(h.rolesDir, { recursive: true });
    mkdirSync(h.projectRolesDir, { recursive: true });
    writeFileSync(
      join(h.rolesDir, 'planner.md'),
      role(['description: Plans work', 'model: m2', 'permissionMode: on_request']),
    );
    writeFileSync(join(h.rolesDir, 'worker.md'), role(['description: User worker']));
    writeFileSync(join(h.projectRolesDir, 'worker.md'), role(['description: Project worker']));
    writeFileSync(join(h.rolesDir, 'broken.md'), 'no frontmatter here');
    writeFileSync(join(h.rolesDir, 'Bad Name.md'), role(['description: x']));
    const a = await h.create();
    const result = await h.call(a, 'wevir_roles');
    const byName = Object.fromEntries(
      (result.roles as Array<{ name: string; description: string; source: string }>).map((r) => [
        r.name,
        r,
      ]),
    );
    expect(Object.keys(byName)).toEqual(['advisor', 'explorer', 'planner', 'reviewer', 'worker']);
    expect(byName.explorer).toMatchObject({ source: 'builtin', tools: ['readonly'] });
    expect(byName.planner).toMatchObject({ source: 'user', modelId: 'm2' });
    expect(byName.worker).toMatchObject({ source: 'project', description: 'Project worker' });
    expect(result.problems).toEqual([
      expect.objectContaining({ file: 'Bad Name.md' }),
      expect.objectContaining({ file: 'broken.md' }),
    ]);
  });

  it('用角色开会话：角色的模型与档位，权限上限只收窄，说明放在第一条消息前，描述里带角色名', async () => {
    const h = await setup();
    mkdirSync(h.rolesDir, { recursive: true });
    writeFileSync(
      join(h.rolesDir, 'planner.md'),
      role(
        ['description: Plans work', 'provider: mock', 'model: m2', 'permissionMode: on_request'],
        'Plan first, then write the plan to PLAN.md.',
      ),
    );
    const caller = await h.create({ permissionMode: 'full_access' });
    const opened = await h.call(caller, 'wevir_session_create', {
      message: 'plan the migration',
      role: 'planner',
      reportBack: false,
    });
    const child = opened.sessionId as SessionId;
    expect(opened).toMatchObject({
      role: 'planner',
      modelId: 'm2',
      // 调用方是完全访问，角色的上限把它收窄到请求批准。
      permissionMode: 'on_request',
    });
    expect(h.storage.sessions.get(child)?.origin).toEqual({
      kind: 'agent',
      sessionId: caller,
      role: 'planner',
    });
    // 角色名也在协议里（0.52.0）：session.created 的 openedBy 与快照的 Session.openedBy。
    const created = h.all(child)[0];
    expect(created?.type === 'session.created' && created.payload.openedBy).toEqual({
      sessionId: caller,
      role: 'planner',
    });
    expect(h.events.snapshot(child)?.session.openedBy).toEqual({
      sessionId: caller,
      role: 'planner',
    });
    const first = h.all(child).find((e) => e.type === 'user.message');
    const text =
      first?.type === 'user.message' && first.payload.content[0]?.type === 'text'
        ? first.payload.content[0].text
        : '';
    expect(text).toMatch(/^You are working as the "planner" role \(Plans work\)/);
    // 开它的会话的 ID 写在说明里，角色（比如 advisor）要读它的对话。
    expect(text).toContain(`The session that opened you is ${caller};`);
    expect(text).toContain('Plan first, then write the plan to PLAN.md.');
    expect(text.endsWith('Your task:\n\nplan the migration')).toBe(true);

    // 明说的模型盖过角色的；明说的权限不能超过角色的上限；没这个角色报可选的。
    const other = await h.call(caller, 'wevir_session_create', {
      message: 'again',
      role: 'planner',
      modelId: 'm',
      reportBack: false,
    });
    expect(other).toMatchObject({ role: 'planner', modelId: 'm' });
    const wider = await h.call(caller, 'wevir_session_create', {
      message: 'x',
      role: 'planner',
      permissionMode: 'full_access',
    });
    expect(wider.error).toMatch(/broader than role planner allows/);
    const missing = await h.call(caller, 'wevir_session_create', { message: 'x', role: 'nope' });
    expect(missing.error).toMatch(
      /No role "nope"\. Available: advisor, explorer, planner, reviewer, worker/,
    );
    // 角色用的 Provider 不可用时说清楚。
    writeFileSync(
      join(h.rolesDir, 'remote.md'),
      role(['description: Uses a missing provider', 'provider: gone']),
    );
    const gone = await h.call(caller, 'wevir_session_create', { message: 'x', role: 'remote' });
    expect(gone.error).toMatch(/provider gone, which is not available/);
  });

  it('角色限制应用级工具：tools/list 不列、tools/call 拒绝；readonly 与前缀；没有角色的不受影响', async () => {
    const h = await setup();
    mkdirSync(h.rolesDir, { recursive: true });
    writeFileSync(
      join(h.rolesDir, 'no-browser.md'),
      role([
        'description: No browser or sessions',
        'disallowedTools: [browser_*, wevir_session_create]',
      ]),
    );
    const caller = await h.create();
    const plain = await visible(h, caller);
    expect(plain).toContain('wevir_session_create');

    const explorer = (
      await h.call(caller, 'wevir_session_create', {
        message: 'look around',
        role: 'explorer',
        reportBack: false,
      })
    ).sessionId as SessionId;
    const seen = await visible(h, explorer);
    expect(seen).toContain('wevir_session_list');
    expect(seen).toContain('wevir_session_progress');
    for (const hidden of ['wevir_session_create', 'wevir_session_send', 'wevir_session_close']) {
      expect(seen, hidden).not.toContain(hidden);
    }
    const blocked = await h.call(explorer, 'wevir_session_create', { message: 'spawn' });
    expect(blocked.error).toBe('wevir_session_create is not available to this session.');
    // 允许的照常用。
    expect(await h.call(explorer, 'wevir_session_list')).toHaveProperty('sessions');

    const limited = (
      await h.call(caller, 'wevir_session_create', {
        message: 'x',
        role: 'no-browser',
        reportBack: false,
      })
    ).sessionId as SessionId;
    const names = await visible(h, limited);
    expect(names).toContain('wevir_session_send');
    expect(names.some((name) => name.startsWith('browser_'))).toBe(false);
    expect(names).not.toContain('wevir_session_create');
    // 有 role 的会话仍然能列出角色。
    expect(names).toContain('wevir_roles');

    // 角色文件之后被删：收紧到只读工具，不放开。
    rmSync(join(h.rolesDir, 'no-browser.md'));
    const after = await visible(h, limited);
    expect(after).toContain('wevir_session_list');
    expect(after).not.toContain('wevir_session_send');
    expect(after).not.toContain('wevir_session_create');
  });

  it('引擎在会话写进存储之前就列工具，也按角色过滤', async () => {
    const h = await setup();
    const caller = await h.create();
    const listed: string[][] = [];
    h.adapter.onCreate = async (config) => {
      const response = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${config.appTools?.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
      listed.push(body.result.tools.map((tool) => tool.name));
    };
    const explorer = (
      await h.call(caller, 'wevir_session_create', {
        message: 'look around',
        role: 'explorer',
        reportBack: false,
      })
    ).sessionId as SessionId;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('wevir_session_list');
    expect(listed[0]).not.toContain('wevir_session_create');
    expect(listed[0]).toEqual(await visible(h, explorer));
  });

  it('角色会话分出的支线与分支带着同一个角色，建的过程中列工具也受限；被分的会话删了也不放开', async () => {
    const h = await setup();
    const caller = await h.create();
    const explorer = (
      await h.call(caller, 'wevir_session_create', {
        message: 'look around',
        role: 'explorer',
        reportBack: false,
      })
    ).sessionId as SessionId;
    await h.settle(explorer);
    const expected = await visible(h, explorer);
    expect(expected).not.toContain('wevir_session_create');
    const listed: string[][] = [];
    h.adapter.onCreate = undefined;
    const fork = h.adapter.fork.bind(h.adapter);
    h.adapter.fork = async (engineSessionId, config, options) => {
      const response = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.appTools?.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
      listed.push(body.result.tools.map((tool) => tool.name));
      const forked = await fork(engineSessionId, config, options);
      h.adapter.endpoints.set(forked.engineSessionId, config.appTools);
      return forked;
    };
    const side = (await h.manager.fork({ sessionId: explorer, side: true })).id;
    const branch = (await h.manager.fork({ sessionId: explorer })).id;
    expect(listed).toEqual([expected, expected]);
    expect(await visible(h, side)).toEqual(expected);
    expect(await visible(h, branch)).toEqual(expected);
    expect(h.storage.sessions.get(branch)?.origin).toEqual({
      kind: 'fork',
      sessionId: explorer,
      role: 'explorer',
    });
    const blocked = await h.call(branch, 'wevir_session_create', { message: 'spawn' });
    expect(blocked.error).toBe('wevir_session_create is not available to this session.');
    // 分支不是 Agent 开的会话：快照里没有 openedBy。
    expect(h.events.snapshot(branch)?.session.openedBy).toBeUndefined();
    // 被分的会话删了，分支仍然受同一个角色限制。
    await h.manager.close(explorer);
    h.storage.sessions.setArchived(explorer, T0);
    await h.manager.delete(explorer);
    expect(h.storage.sessions.get(explorer)).toBeUndefined();
    expect(await visible(h, branch)).toEqual(expected);
    // 没有角色的会话分出来的照常不限。
    await h.send(caller, 'hello');
    await h.settle(caller);
    const plainBranch = (await h.manager.fork({ sessionId: caller })).id;
    expect(h.storage.sessions.get(plainBranch)?.origin).toBeUndefined();
    expect(await visible(h, plainBranch)).toContain('wevir_session_create');
  });
});

describe('工具预设', () => {
  type Setup = Awaited<ReturnType<typeof setup>>;
  const CORE_NAMES = [
    'wevir_session_list',
    'wevir_session_read',
    'wevir_models',
    'wevir_roles',
    'wevir_tasks',
    'wevir_task_create',
    'wevir_task_update',
    'wevir_session_create',
    'wevir_session_send',
    'wevir_session_wait',
    'wevir_session_progress',
    'wevir_session_interrupt',
    'wevir_session_close',
    'wevir_session_archive',
    'wevir_show',
    'wevir_share_file',
  ];
  const visible = async (h: Setup, sessionId: SessionId) => {
    const list = await h.rpc(sessionId, 'tools/list');
    return (list.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  };
  const instructionsOf = async (h: Setup, sessionId: SessionId) =>
    (await h.rpc(sessionId, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })).body
      .result.instructions as string;
  const createWith = async (h: Setup, toolPreset?: ToolPreset) =>
    (
      await h.manager.create(
        { workspaceId: 'ws_1', providerId: 'mock' },
        toolPreset === undefined ? {} : { toolPreset },
      )
    ).id;

  it('core：tools/list 不列、tools/call 拒绝去掉的组；另加的组照常可用；说明里也没有去掉的组', async () => {
    const h = await setup(0, true);
    const core = await createWith(h, { id: 'core' });
    const withPlugins = await createWith(h, { id: 'core', groups: ['plugins'] });
    expect(await visible(h, core)).toEqual(CORE_NAMES);
    const blocked = await h.call(core, 'wevir_plugins_list');
    expect(blocked.error).toBe('wevir_plugins_list is not available to this session.');
    // 留下的照常用：读会话、任务清单。
    expect(await h.call(core, 'wevir_session_list')).toHaveProperty('sessions');
    expect(await h.call(core, 'wevir_tasks')).toHaveProperty('tasks');
    expect(await visible(h, withPlugins)).toEqual([
      ...CORE_NAMES,
      'wevir_plugins_list',
      'wevir_plugin_install',
      'wevir_skill_install',
      'wevir_connector_add',
    ]);
    expect(await h.call(withPlugins, 'wevir_plugins_list')).toHaveProperty('connectors');
    const text = await instructionsOf(h, core);
    for (const gone of ['- browser_*', '- lsp_*', '- wevir_process_*', '- wevir_plugins_list']) {
      expect(text).not.toContain(gone);
    }
    expect(text).toContain('- wevir_tasks');
    expect(text).toContain('- wevir_memory_*');
    expect(await instructionsOf(h, withPlugins)).toContain('- wevir_plugins_list');
    // 存的是规范写法。
    expect(h.storage.sessions.get(core)?.toolPreset).toEqual({ id: 'core' });
    expect(h.storage.sessions.get(withPlugins)?.toolPreset).toEqual({
      id: 'core',
      groups: ['plugins'],
    });
  });

  it('full 与没选的会话：工具目录与说明同以前逐字节相同', async () => {
    const h = await setup(0, true);
    const plain = await createWith(h);
    const full = await createWith(h, { id: 'full', groups: ['browser'] });
    expect(h.storage.sessions.get(plain)).not.toHaveProperty('toolPreset');
    expect(h.storage.sessions.get(full)?.toolPreset).toEqual({ id: 'full' });
    const raw = async (sessionId: SessionId) =>
      JSON.stringify((await h.rpc(sessionId, 'tools/list')).body.result);
    expect(await raw(full)).toBe(await raw(plain));
    expect(JSON.parse(await raw(plain)).tools).toHaveLength(h.tools.tools.length);
    expect(await instructionsOf(h, plain)).toBe(APP_TOOLS_INSTRUCTIONS);
    expect(await instructionsOf(h, full)).toBe(APP_TOOLS_INSTRUCTIONS);
    // 调用方不明（引擎令牌不带会话头）时照旧：全部列出，说明不变。
    expect(await h.tools.filterTools(undefined, h.tools.tools)).toBe(h.tools.tools);
    expect(h.tools.instructions(undefined)).toBe(APP_TOOLS_INSTRUCTIONS);
  });

  it('引擎在会话写进存储之前就取说明、列工具，也按预设', async () => {
    const h = await setup(0, true);
    const seen: Array<{ tools: string[]; instructions: string }> = [];
    h.adapter.onCreate = async (config) => {
      const post = async (method: string, params: unknown = {}) => {
        const response = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.appTools?.token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        // biome-ignore lint/suspicious/noExplicitAny: 测试里读 JSON-RPC 回复。
        return ((await response.json()) as any).result;
      };
      const init = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      const list = await post('tools/list');
      seen.push({
        instructions: init.instructions,
        tools: (list.tools as Array<{ name: string }>).map((tool) => tool.name),
      });
    };
    const core = await createWith(h, { id: 'core' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tools).toEqual(CORE_NAMES);
    expect(seen[0]?.tools).toEqual(await visible(h, core));
    expect(seen[0]?.instructions).toBe(await instructionsOf(h, core));
    expect(seen[0]?.instructions).not.toContain('- wevir_plugins_list');
  });

  it('与角色取交集；Agent 开的会话、子会话、分支与支线沿用预设', async () => {
    const h = await setup(0, true);
    const caller = await createWith(h, { id: 'core' });
    const explorer = (
      await h.call(caller, 'wevir_session_create', {
        message: 'look around',
        role: 'explorer',
        reportBack: false,
      })
    ).sessionId as SessionId;
    expect(h.storage.sessions.get(explorer)?.toolPreset).toEqual({ id: 'core' });
    const seen = await visible(h, explorer);
    // 只读角色 ∩ core：没有开会话（角色不许），也没有插件清单（只读，但 core 不带）。
    expect(seen).toContain('wevir_session_list');
    expect(seen).not.toContain('wevir_session_create');
    expect(seen).not.toContain('wevir_plugins_list');
    // full 的会话开出来的 explorer 有插件清单：预设只收窄，不放宽。
    const fullCaller = await createWith(h);
    const fullExplorer = (
      await h.call(fullCaller, 'wevir_session_create', {
        message: 'look around',
        role: 'explorer',
        reportBack: false,
      })
    ).sessionId as SessionId;
    expect(h.storage.sessions.get(fullExplorer)).not.toHaveProperty('toolPreset');
    expect(await visible(h, fullExplorer)).toContain('wevir_plugins_list');
    expect(await visible(h, fullExplorer)).not.toContain('wevir_session_create');

    // 引擎派出的子会话沿用父会话的（它的记录里没有这一项）。
    const record = h.storage.sessions.get(caller);
    if (record === undefined) throw new Error('no caller');
    h.storage.sessions.insert({
      ...record,
      id: 'ses_child',
      engineSessionId: 'engine-child',
      parentSessionId: caller,
      toolPreset: undefined,
    });
    expect(h.manager.toolPresetOf('ses_child' as SessionId)).toEqual({ id: 'core' });
    expect(
      (await h.tools.filterTools('ses_child' as SessionId, h.tools.tools)).map((tool) => tool.name),
    ).toEqual(CORE_NAMES);

    // 分支与支线抄被分会话的。
    await h.send(caller, 'hello');
    await h.settle(caller);
    const side = (await h.manager.fork({ sessionId: caller, side: true })).id;
    const branch = (await h.manager.fork({ sessionId: caller })).id;
    expect(h.storage.sessions.get(side)?.toolPreset).toEqual({ id: 'core' });
    expect(h.storage.sessions.get(branch)?.toolPreset).toEqual({ id: 'core' });
  });

  it('Host 重启后预设还在；以前建的会话没有这一项，按 full', async () => {
    const h = await setup(0, true);
    const core = await createWith(h, { id: 'core', groups: ['plugins'] });
    const plain = await createWith(h);
    // 新的连接与管理器（同重启：没有正在建的会话，只读存储）。
    const storage = storages.open(join(h.root, 'data'));
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const adapter = new EchoAdapter({});
    const manager = new SessionManager({ storage, events, adapter });
    cleanups.push(async () => {
      await manager.dispose();
      await adapter.dispose();
    });
    const tools = new AppTools({
      storage,
      events,
      sessions: manager,
      hostId: 'host_test' as HostId,
      sendWhileBusy: () => 'queue',
      roles: new RoleStore({ dir: h.rolesDir }),
    });
    expect(storage.sessions.get(core)?.toolPreset).toEqual({ id: 'core', groups: ['plugins'] });
    expect(manager.toolPresetOf(core)).toEqual({ id: 'core', groups: ['plugins'] });
    expect(manager.toolPresetOf(plain)).toBeUndefined();
    const all = [...h.tools.tools];
    expect((await tools.filterTools(core, all)).map((tool) => tool.name)).toEqual([
      ...CORE_NAMES,
      'wevir_plugins_list',
      'wevir_plugin_install',
      'wevir_skill_install',
      'wevir_connector_add',
    ]);
    expect(await tools.filterTools(plain, all)).toEqual(all);
    expect(tools.instructions(plain)).toBe(APP_TOOLS_INSTRUCTIONS);
  });
});

describe.runIf(process.platform !== 'win32')('后台进程与大输出落盘', () => {
  /** 调工具，返回文本与 isError。 */
  const callText = async (
    h: Awaited<ReturnType<typeof setup>>,
    sessionId: SessionId,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const { body } = await h.rpc(sessionId, 'tools/call', { name, arguments: args });
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    return {
      text: result.content.map((part) => part.text).join('\n'),
      isError: result.isError === true,
    };
  };

  it('工具列表与注解：起进程、写、结束要审批，列出、读、等待不用', async () => {
    const h = await setup(0, false, true);
    const a = await h.create();
    const list = await h.rpc(a, 'tools/list');
    const tools = list.body.result.tools as Array<{
      name: string;
      annotations: { readOnlyHint?: boolean };
    }>;
    const processTools = tools.filter((tool) => tool.name.startsWith('wevir_process_'));
    expect(
      Object.fromEntries(processTools.map((tool) => [tool.name, tool.annotations.readOnlyHint])),
    ).toEqual({
      wevir_process_start: false,
      wevir_process_list: true,
      wevir_process_output: true,
      wevir_process_wait: true,
      wevir_process_write: false,
      wevir_process_kill: false,
    });
    // 按名字放行的引擎（Claude、OpenCode）用同一张表。
    const { APP_TOOLS_NO_APPROVAL } = await import('@wevir/runtime-adapter');
    for (const tool of processTools) {
      expect(APP_TOOLS_NO_APPROVAL.includes(tool.name), tool.name).toBe(
        tool.annotations.readOnlyHint === true,
      );
    }
  });

  it('起进程等到某一行；退出时作为消息发回会话并开一个回合；目录外拒绝', async () => {
    const h = await setup(0, false, true);
    const a = await h.create();
    const outside = await callText(h, a, 'wevir_process_start', { command: 'true', cwd: '..' });
    expect(outside).toMatchObject({ isError: true });
    expect(outside.text).toContain("not inside this session's folder");

    const started = await callText(h, a, 'wevir_process_start', {
      command: 'echo "Local: http://localhost:5173"; sleep 0.5; echo stopping; exit 2',
      name: 'dev server',
      waitFor: 'Local:.*http',
    });
    expect(started.isError).toBe(false);
    expect(started.text).toContain('Started p1 "dev server"');
    expect(started.text).toContain('Matched /Local:.*http/: Local: http://localhost:5173');
    expect(started.text).toContain('Wevir will message you when it exits.');

    await vi.waitFor(
      () =>
        expect(
          h.all(a).some((e) => e.type === 'user.message' && e.payload.from?.process !== undefined),
        ).toBe(true),
      { timeout: 5000 },
    );
    const notice = h
      .all(a)
      .find((e) => e.type === 'user.message' && e.payload.from?.process !== undefined);
    expect(notice?.payload).toMatchObject({
      from: {
        sessionId: a,
        kind: 'report',
        process: { id: 'p1', name: 'dev server', event: 'exit', exitCode: 2 },
      },
    });
    const text = notice?.type === 'user.message' ? notice.payload.content[0] : undefined;
    expect((text as { text: string }).text).toMatch(
      /exited with code 2[\s\S]*stopping[\s\S]*Full log: /,
    );
    await h.settle(a);

    const listed = await callText(h, a, 'wevir_process_list');
    expect(listed.text).toContain('p1 "dev server"');
    expect(listed.text).toContain('exited with code 2');
  });

  it('notifyOn：输出匹配时把攒下的几行作为消息发回会话并开一个回合，发满 notifyLimit 条说明不再发', async () => {
    const h = await setup(0, false, true);
    const a = await h.create();
    const started = await callText(h, a, 'wevir_process_start', {
      command: 'sleep 0.2; echo "FAIL one"; echo ok; echo "FAIL two"; sleep 30',
      notifyOn: 'FAIL',
      notifyLimit: 1,
      notifyOnExit: false,
    });
    expect(started.text).toContain(
      'Wevir will message you when lines match /FAIL/ (at most 1 message).',
    );
    await vi.waitFor(
      () =>
        expect(
          h.all(a).some((e) => e.type === 'user.message' && e.payload.from?.process !== undefined),
        ).toBe(true),
      { timeout: 5000 },
    );
    const notice = h
      .all(a)
      .find((e) => e.type === 'user.message' && e.payload.from?.process !== undefined);
    expect(notice?.payload).toMatchObject({
      from: { kind: 'report', process: { id: 'p1', event: 'match' } },
    });
    const text = (
      (notice?.type === 'user.message' ? notice.payload.content[0] : undefined) as { text: string }
    ).text;
    expect(text).toContain(
      'printed 2 lines matching your notifyOn pattern /FAIL/:\nFAIL one\nFAIL two\n',
    );
    expect(text).toContain('notifyLimit reached');
    await h.settle(a);
    expect(h.all(a).some((e) => e.type === 'turn.started')).toBe(true);
    await callText(h, a, 'wevir_process_kill', { id: 'p1' });
  });

  it('读输出：最后几行、since、grep；大输出落盘后只回开头结尾与路径', async () => {
    const h = await setup(0, false, true);
    const a = await h.create();
    await callText(h, a, 'wevir_process_start', {
      command: 'i=1; while [ $i -le 3000 ]; do echo "row $i"; i=$((i+1)); done',
      notifyOnExit: false,
    });
    await callText(h, a, 'wevir_process_wait', { id: 'p1' });
    const tail = await callText(h, a, 'wevir_process_output', { id: 'p1', lines: 3 });
    expect(tail.text).toMatch(/row 2998\nrow 2999\nrow 3000$/);
    const grep = await callText(h, a, 'wevir_process_output', { id: 'p1', grep: '^row 29[0-9]9$' });
    expect(grep.text).toContain('10 matching lines:');
    expect(grep.text).toContain('2999: row 2999');

    const all = await callText(h, a, 'wevir_process_output', { id: 'p1', lines: 1000 });
    expect(all.text).toContain('too large to show here, so Wevir saved it to:');
    const path = all.text.split('\n')[1] as string;
    expect(path.startsWith(join(h.toolOutput.dir, a))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('row 2001\n');
    expect(all.text).toContain('row 3000');

    const since = await callText(h, a, 'wevir_process_output', { id: 'p1', since: 0 });
    expect(since.text).toContain('saved it to:');
  });

  it('写 stdin、结束（不发退出消息）、等待超时不结束进程', async () => {
    const h = await setup(0, false, true);
    const a = await h.create();
    await callText(h, a, 'wevir_process_start', { command: 'cat' });
    expect((await callText(h, a, 'wevir_process_write', { id: 'p1', input: 'ping\n' })).text).toBe(
      'Wrote 5 bytes to p1.',
    );
    const waited = await callText(h, a, 'wevir_process_wait', {
      id: 'p1',
      until: '/PING/i',
      timeoutMs: 2000,
    });
    expect(waited.text).toMatch(/Matched \/PING\/i: ping|Timed out/);
    const timedOut = await callText(h, a, 'wevir_process_wait', { id: 'p1', timeoutMs: 100 });
    expect(timedOut.text).toContain('Timed out waiting for it to exit; it is still running.');
    const killed = await callText(h, a, 'wevir_process_kill', { id: 'p1' });
    expect(killed.text).toMatch(/Sent SIGTERM; p1 was stopped by SIGTERM/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      h.all(a).some((e) => e.type === 'user.message' && e.payload.from?.process !== undefined),
    ).toBe(false);
    const bad = await callText(h, a, 'wevir_process_kill', { id: 'p9' });
    expect(bad).toMatchObject({ isError: true });
    expect((await callText(h, a, 'wevir_process_output', { id: 'p1', grep: '(' })).isError).toBe(
      true,
    );
  });
});

describe('reportText', () => {
  it('没有回答时也说明', () => {
    expect(reportText('ses_1' as SessionId, '', 'failed', undefined)).toContain(
      'It gave no final answer.',
    );
  });
});

describe('对话里安装插件（P3）', () => {
  const skillText = (name: string) =>
    `---\nname: ${name}\ndescription: Useful ${name} skill\n---\nFollow the instructions.\n`;
  const skill = (cwd: string, name: string) => {
    const path = join(cwd, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), skillText(name));
    return path;
  };
  const active = async (
    h: Awaited<ReturnType<typeof setup>>,
    permissionMode: 'on_request' | 'auto_review' | 'full_access' = 'full_access',
  ) => {
    const id = await h.create({ permissionMode });
    await h.send(id, 'slow');
    return id;
  };
  const pending = async (h: Awaited<ReturnType<typeof setup>>, id: SessionId) => {
    await vi.waitFor(() => expect(h.events.snapshot(id)?.pendingApprovals).toHaveLength(1));
    const approval = h.events.snapshot(id)?.pendingApprovals[0];
    if (!approval) throw new Error('missing approval');
    return approval;
  };
  const decide = async (h: Awaited<ReturnType<typeof setup>>, id: SessionId, allow: boolean) => {
    const approval = await pending(h, id);
    await h.manager.respondToApproval(
      { approvalId: approval.id, optionId: allow ? 'allow' : 'deny' },
      identity,
    );
    return approval;
  };
  const noStage = async (h: Awaited<ReturnType<typeof setup>>) =>
    vi.waitFor(() => {
      expect(
        readdirSync(h.plugins?.dir as string).filter((name) => name.startsWith('.install-')),
      ).toEqual([]);
    });

  it('工具注解和放行表：只有列表不问；连接器 schema 字段来自协议', async () => {
    const { APP_TOOLS_NO_APPROVAL } = await import('@wevir/runtime-adapter');
    const h = await setup(500, true);
    const names = [
      'wevir_plugins_list',
      'wevir_plugin_install',
      'wevir_skill_install',
      'wevir_connector_add',
    ];
    for (const name of names) {
      const tool = h.tools.tools.find((tool) => tool.name === name);
      expect(tool?.annotations.readOnlyHint).toBe(name === 'wevir_plugins_list');
      expect(APP_TOOLS_NO_APPROVAL.includes(name)).toBe(name === 'wevir_plugins_list');
    }
    const schema = h.tools.tools.find((tool) => tool.name === 'wevir_connector_add')?.inputSchema;
    expect(Object.keys(schema?.properties as object)).toEqual(
      expect.arrayContaining([
        'name',
        'transport',
        'command',
        'args',
        'env',
        'cwd',
        'url',
        'headers',
        'enabled',
        'toolTimeoutSec',
      ]),
    );
    const id = await h.create();
    expect(await h.call(id, 'wevir_plugins_list')).toMatchObject({
      plugins: [],
      connectors: [],
      skills: [],
    });
    expect(h.events.snapshot(id)?.pendingApprovals).toEqual([]);
  });

  it.each(['relative', 'absolute', 'file', 'zip'] as const)(
    '%s 来源：批准前不安装，批准后列得出且安装的是审核副本',
    async (form) => {
      const h = await setup(500, true);
      const id = await active(h);
      const source = skill(h.workspace, 'source-skill');
      let path =
        form === 'relative' ? 'source-skill' : form === 'file' ? join(source, 'SKILL.md') : source;
      if (form === 'zip') {
        path = join(h.workspace, 'skill.zip');
        writeFileSync(path, zip([{ name: 'packed/SKILL.md', data: skillText('source-skill') }]));
      }
      const operation = h.call(id, 'wevir_skill_install', { path });
      const approval = await pending(h, id);
      expect(approval.detail?.display.summary).toContain('Useful source-skill skill');
      expect((await h.plugins?.list())?.skills).toEqual([]);
      expect(existsSync(join(h.plugins?.dir as string, 'registry.json'))).toBe(false);
      // 审批期间改来源，发布的仍是用户看到的版本。
      writeFileSync(join(source, 'SKILL.md'), skillText('changed-after-review'));
      await decide(h, id, true);
      expect(await operation).toMatchObject({
        skills: [{ name: 'source-skill' }],
        availability: expect.any(String),
      });
      expect(await h.call(id, 'wevir_plugins_list')).toMatchObject({
        skills: [{ name: 'source-skill' }],
      });
      await noStage(h);
      expect(h.errors).toEqual([]);
    },
  );

  for (const format of ['wevir', 'claude', 'codex'] as const) {
    it.each(['folder', 'zip'] as const)(
      `${format} 插件 %s：审批内容和导入来源一致，重复安装失败时保留原注册表`,
      async (form) => {
        const h = await setup(500, true);
        const id = await active(h);
        const source = join(h.workspace, 'import');
        cpSync(
          fileURLToPath(new URL(`./test-fixtures/${format}-plugin/`, import.meta.url)),
          source,
          { recursive: true },
        );
        let path = 'import';
        if (form === 'zip') {
          const entries: Array<{ name: string; data: string }> = [];
          const visit = (folder: string, prefix: string) => {
            for (const entry of readdirSync(folder, { withFileTypes: true })) {
              const name = `${prefix}${entry.name}`;
              if (entry.isDirectory()) visit(join(folder, entry.name), `${name}/`);
              else entries.push({ name, data: readFileSync(join(folder, entry.name), 'utf8') });
            }
          };
          visit(source, 'export/');
          path = 'plugin.zip';
          writeFileSync(join(h.workspace, path), zip(entries));
        }
        const args = {
          path,
          ...(format === 'wevir' && {
            inputs: { TOKEN: 'test-token-for-package', REGION: 'test-region' },
          }),
        };
        const operation = h.call(id, 'wevir_plugin_install', args);
        expect((await pending(h, id)).detail?.display.summary).toContain(`"source": "${format}"`);
        await decide(h, id, true);
        expect(await operation).toMatchObject({ plugin: { source: format, enabled: true } });
        const before = readFileSync(join(h.plugins?.dir as string, 'registry.json'), 'utf8');
        const repeated = h.call(id, 'wevir_plugin_install', args);
        await decide(h, id, true);
        expect(await repeated).toMatchObject({
          error: expect.stringContaining('already installed'),
        });
        expect(readFileSync(join(h.plugins?.dir as string, 'registry.json'), 'utf8')).toBe(before);
        await noStage(h);
        expect(h.errors).toEqual([]);
      },
    );
  }

  it('会话文件夹本身也可以是包根目录，path 为 .', async () => {
    const h = await setup(500, true);
    const id = await active(h);
    skill(join(h.workspace, 'skills'), 'root-skill');
    writeFileSync(
      join(h.workspace, 'wevir-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'root-package',
        name: 'Root package',
        version: '1.0.0',
      }),
    );
    const operation = h.call(id, 'wevir_plugin_install', { path: '.' });
    await decide(h, id, true);
    expect(await operation).toMatchObject({ plugin: { name: 'Root package' } });
    expect((await h.plugins?.list())?.skills.map(({ name }) => name)).toEqual(['root-skill']);
    await noStage(h);
    expect(h.errors).toEqual([]);
  });

  it('相对/绝对越界、指向外部或内部的链接、父目录链接、包内链接、非法 frontmatter 与 ZIP 穿越都拒绝', async () => {
    const h = await setup(500, true);
    const id = await active(h);
    const outside = skill(tempDir(), 'outside-skill');
    const inside = skill(h.workspace, 'inside-skill');
    const malformed = skill(h.workspace, 'bad-skill');
    writeFileSync(join(malformed, 'SKILL.md'), 'no frontmatter');
    const paths = [outside, '../outside-skill', 'missing', malformed];
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(h.workspace, 'external-link'), 'dir');
      symlinkSync(inside, join(h.workspace, 'internal-link'), 'dir');
      symlinkSync(h.workspace, join(h.workspace, 'parent-link'), 'dir');
      const nested = skill(h.workspace, 'nested-link');
      symlinkSync(join(outside, 'SKILL.md'), join(nested, 'secret.md'));
      paths.push('external-link', 'internal-link', 'parent-link/inside-skill', nested);
    }
    const archive = join(h.workspace, 'bad.zip');
    writeFileSync(archive, zip([{ name: '../escaped/SKILL.md', data: skillText('escape') }]));
    paths.push(archive);
    for (const path of paths)
      expect(await h.call(id, 'wevir_skill_install', { path }), path).toHaveProperty('error');
    expect((await h.plugins?.list())?.skills).toEqual([]);
    expect(h.events.snapshot(id)?.pendingApprovals).toEqual([]);
    await noStage(h);
    expect(h.errors).toEqual([]);
  });

  it.each(['on_request', 'auto_review', 'full_access'] as const)(
    '%s：用户拒绝时注册表与安装目录保持原样',
    async (mode) => {
      const h = await setup(500, true);
      const id = await active(h, mode);
      skill(h.workspace, 'denied-skill');
      const operation = h.call(id, 'wevir_skill_install', { path: 'denied-skill' });
      await decide(h, id, false);
      expect(await operation).toHaveProperty('error');
      expect(existsSync(join(h.plugins?.dir as string, 'registry.json'))).toBe(false);
      expect(readdirSync(h.plugins?.skillsRoot as string)).toEqual([]);
      await noStage(h);
      expect(h.errors).toEqual([]);
    },
  );

  it('取消进行中的回合或断开工具调用时取消审批，不能用迟到的允许安装', async () => {
    const h = await setup(500, true);
    skill(h.workspace, 'cancelled-skill');
    for (const abortCall of [false, true]) {
      const id = await active(h);
      const controller = new AbortController();
      const tool = h.tools.tools.find((tool) => tool.name === 'wevir_skill_install');
      const operation = tool
        ?.call({ path: 'cancelled-skill' }, { sessionId: id, signal: controller.signal })
        .catch((error: unknown) => error);
      const approval = await pending(h, id);
      if (abortCall) controller.abort();
      else await h.manager.cancel(id);
      expect(await operation).toBeInstanceOf(Error);
      await expect(
        h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow' }, identity),
      ).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
    }
    expect((await h.plugins?.list())?.skills).toEqual([]);
    await noStage(h);
    expect(h.errors).toEqual([]);
  });

  it('Host 释放会话管理器时结束待批准调用并清理副本，不写注册表', async () => {
    const h = await setup(500, true);
    const id = await active(h);
    skill(h.workspace, 'shutdown-skill');
    const operation = h.call(id, 'wevir_skill_install', { path: 'shutdown-skill' });
    await pending(h, id);
    await h.manager.dispose();
    expect(await operation).toHaveProperty('error');
    expect(existsSync(join(h.plugins?.dir as string, 'registry.json'))).toBe(false);
    await noStage(h);
    expect(h.errors).toEqual([]);
  });

  it('Cursor 的 MCP 参数信封也生成同一次调用的脱敏审批', async () => {
    const h = await setup(500, true);
    const id = await active(h);
    const args = {
      name: 'cursor_connector',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'cursor-test-secret' },
    };
    const event = await h.tools.plugins?.prepareEvent(id, {
      type: 'tool.started',
      engineSessionId: 'cursor',
      toolCallId: 'cursor-mcp',
      toolName: 'mcp__wevir__wevir_connector_add',
      display: { kind: 'unknown' },
      input: { providerIdentifier: 'wevir', toolName: 'wevir_connector_add', args },
    });
    expect(JSON.stringify(event)).not.toContain('cursor-test-secret');
    expect(JSON.stringify(event)).toContain('server.mjs');
    const operation = h.call(id, 'wevir_connector_add', args);
    expect((await pending(h, id)).toolCallId).toBe('cursor-mcp');
    await decide(h, id, false);
    expect(await operation).toHaveProperty('error');
    expect((await h.plugins?.list())?.connectors).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('插件：缺必填输入时报键名且不安装；批准卡片列出名字/版本/各项且隐藏密钥；拒绝后不改原配置', async () => {
    const h = await setup(500, true);
    const id = await active(h);
    const root = join(h.workspace, 'package');
    skill(join(root, 'skills'), 'package-skill');
    writeFileSync(
      join(root, 'wevir-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'conversation-test',
        name: 'Conversation test',
        version: '1.2.3',
        inputs: [{ key: 'TOKEN', label: 'API token', secret: true, required: true }],
        connectors: {
          api: {
            transport: 'stdio',
            command: 'node',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 插件清单的字面占位符
            args: ['server.mjs', '--token', '${input:TOKEN}'],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 插件清单的字面占位符
            env: { TOKEN: '${input:TOKEN}' },
          },
        },
      }),
    );
    expect(await h.call(id, 'wevir_plugin_install', { path: 'package' })).toMatchObject({
      error: expect.stringContaining('Missing required plugin inputs: TOKEN'),
    });
    expect(h.events.snapshot(id)?.pendingApprovals).toEqual([]);
    const secret = 'only-a-test-token-8e93';
    const args = { path: 'package', inputs: { TOKEN: secret } };
    // 与真实引擎相同：落库之前准备并脱敏 tool.started。
    const event = await h.tools.plugins?.prepareEvent(id, {
      type: 'tool.started',
      engineSessionId: 'test',
      toolCallId: 'install-test',
      toolName: 'mcp__wevir__wevir_plugin_install',
      display: { kind: 'unknown' },
      input: { arguments: args },
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    const operation = h.call(id, 'wevir_plugin_install', args);
    const approval = await pending(h, id);
    expect(approval.detail?.display.summary).toContain('Conversation test');
    expect(approval.detail?.display.summary).toContain('1.2.3');
    expect(approval.detail?.display.summary).toContain('package-skill');
    expect(approval.detail?.display.summary).toContain('server.mjs');
    expect(JSON.stringify(approval)).not.toContain(secret);
    await decide(h, id, true);
    expect(await operation).toMatchObject({
      plugin: { name: 'Conversation test', inputs: [{ key: 'TOKEN', set: true }] },
    });
    const before = readFileSync(join(h.plugins?.dir as string, 'registry.json'), 'utf8');
    expect(JSON.stringify(await h.call(id, 'wevir_plugins_list'))).not.toContain(secret);
    const denied = h.call(id, 'wevir_connector_add', {
      name: 'denied',
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    await decide(h, id, false);
    expect(await denied).toHaveProperty('error');
    expect(readFileSync(join(h.plugins?.dir as string, 'registry.json'), 'utf8')).toBe(before);
    await noStage(h);
    expect(h.errors).toEqual([]);
  });

  it.each(['stdio', 'http'] as const)(
    '连接器 %s：命令/地址可见，env/headers/查询/凭据参数在卡片和列表里打码；校验失败不修改',
    async (transport) => {
      const h = await setup(500, true);
      const id = await active(h);
      const secret = 'test-credential-543ad';
      const config =
        transport === 'stdio'
          ? {
              transport,
              command: 'node',
              args: [
                'server.mjs',
                '--api-key',
                secret,
                'positional',
                secret,
                '--password="quoted value"',
                'Authorization: Bearer sample-bearer-value',
              ],
              env: { API_KEY: secret },
              cwd: h.workspace,
            }
          : {
              transport,
              url: `https://example.com/mcp?token=${secret}`,
              headers: { Authorization: `Bearer ${secret}` },
            };
      const operation = h.call(id, 'wevir_connector_add', { name: 'test_connector', ...config });
      const approval = await pending(h, id);
      const summary = approval.detail?.display.summary as string;
      expect(summary).toContain(transport === 'stdio' ? 'server.mjs' : 'example.com/mcp');
      for (const sensitive of [secret, 'quoted value', 'sample-bearer-value'])
        expect(summary).not.toContain(sensitive);
      await decide(h, id, true);
      const result = JSON.stringify(await operation);
      const list = JSON.stringify(await h.call(id, 'wevir_plugins_list'));
      for (const sensitive of [secret, 'quoted value', 'sample-bearer-value']) {
        expect(result).not.toContain(sensitive);
        expect(list).not.toContain(sensitive);
      }
      const before = readFileSync(join(h.plugins?.dir as string, 'registry.json'), 'utf8');
      for (const args of [
        { name: 'wevir_reserved', ...config },
        { name: 'bad', transport: 'stdio' },
        { name: 'bad', transport: 'http', url: 'file:///etc/passwd' },
      ])
        expect(await h.call(id, 'wevir_connector_add', args)).toHaveProperty('error');
      expect(readFileSync(join(h.plugins?.dir as string, 'registry.json'), 'utf8')).toBe(before);
      expect(h.errors).toEqual([]);
    },
  );
});
