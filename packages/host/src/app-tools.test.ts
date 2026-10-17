// 应用级工具（0.30.0，domain-model §3.15）：Host 的 `/mcp` 端点（app-mcp.ts）与工具（app-tools.ts），用 echo 引擎跑会话，按 MCP 的
// Streamable HTTP 直接调端点（引擎怎样挂上它见各适配器的测试）。

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
import { AppTools, engineSessionResolver, reportText } from './app-tools.js';
import { EventStore } from './event-store.js';
import { PluginRegistry } from './plugins.js';
import { ProcessManager } from './processes.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir, zip } from './test-utils.js';
import { ToolOutputStore } from './tool-output.js';

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

  override async createSession(config: SessionConfig): Promise<EngineSession> {
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
  tools = new AppTools({
    ...(plugins && { plugins }),
    ...(processes && { processes }),
    storage,
    events,
    sessions: manager,
    hostId: 'host_test' as HostId,
    sendWhileBusy: () => busyDelivery,
    onWarning: (message, fields) => errors.push({ message, fields }),
  });
  mcp = new AppMcpServer({
    tools: tools.tools,
    version: '0.0.0',
    onError: (e) => errors.push(e),
    engineSession: engineSessionResolver(storage, 'dsh'),
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
      'wevir_session_create',
      'wevir_session_send',
      'wevir_session_wait',
      'wevir_session_interrupt',
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
    expect(list.body.result.tools).toHaveLength(9);
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
