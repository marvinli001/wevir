// 应用级工具（0.30.0，domain-model §3.15）：Host 的 `/mcp` 端点（app-mcp.ts）与工具（app-tools.ts），用 echo 引擎跑会话，按 MCP 的
// Streamable HTTP 直接调端点（引擎怎样挂上它见各适配器的测试）。

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HostId, SessionId, SessionState, WevirEvent } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppMcpServer } from './app-mcp.js';
import { AppTools, engineSessionResolver, reportText } from './app-tools.js';
import { EventStore } from './event-store.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

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

async function setup(stepDelayMs = 0) {
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
    appTools: { grant: (sessionId) => mcp?.grant(sessionId) },
    onTurnFinished: (info) => tools?.onTurnFinished(info),
  });
  tools = new AppTools({
    storage,
    events,
    sessions: manager,
    hostId: 'host_test' as HostId,
    sendWhileBusy: () => 'queue',
    onWarning: (message, fields) => errors.push({ message, fields }),
  });
  mcp = new AppMcpServer({
    tools: tools.tools,
    version: '0.0.0',
    onError: (e) => errors.push(e),
    engineSession: engineSessionResolver(storage, 'dsh'),
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
    await manager.dispose();
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
    adapter,
    errors,
    port,
    grantEngine: (kinds: readonly string[]) => appMcp.grantEngine(kinds),
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
    expect(list.body.result.tools).toHaveLength(8);
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

  it('可选的模型与权限模式', async () => {
    const h = await setup();
    const a = await h.create({ permissionMode: 'auto_review' });
    const models = await h.call(a, 'wevir_models');
    expect(models).toMatchObject({
      current: { providerId: 'mock', modelId: 'm', permissionMode: 'auto_review' },
      providers: [{ providerId: 'mock', models: [{ id: 'm' }, { id: 'm2' }] }],
      permissionModes: ['on_request', 'auto_review'],
    });
  });
});

describe('reportText', () => {
  it('没有回答时也说明', () => {
    expect(reportText('ses_1' as SessionId, '', 'failed', undefined)).toContain(
      'It gave no final answer.',
    );
  });
});
