// 内置浏览器（0.33.0，domain-model §3.15）：startHost 组装出的 Host（echo 引擎声明能挂应用级工具），一个假桌面端经真实的
// WebSocket 登记为浏览器提供方，模型那一侧直接按 MCP 调 `/mcp` 端点：工具列表与 annotations、请求带会话与目录、结果与截图、
// 没有提供方、断开、参数在发出前就被拒、wevir_show 只开本机网页。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserRequest, SessionId } from '@wevir/protocol';
import { BROWSER_COMMANDS } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_READ_ONLY_TOOLS, httpUrl } from './browser-tools.js';
import { type RunningHost, startHost } from './host-process.js';
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

async function setup() {
  const home = join(realpathSync(tempDir()), 'home');
  const adapter = new ToolEcho({ stepDelayMs: 1 });
  const host: RunningHost = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
  });
  cleanups.push(() => host.shutdown());
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const connect = async () => {
    const client = await TestRpcClient.connect(host.url);
    cleanups.push(() => client.ws.close());
    const hello = await client.hello(token);
    expect(hello.error).toBeUndefined();
    return { client, hello: hello.result };
  };
  const { client: admin, hello } = await connect();
  const workspaceDir = join(realpathSync(tempDir()), 'project');
  mkdirSync(workspaceDir, { recursive: true });
  const { workspace } = await admin.request('workspace.add', { rootPath: workspaceDir });
  await admin.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const { session } = await admin.request('session.create', {
    workspaceId: workspace.id,
    providerId: 'deepseek-official',
  });
  const sessionId = session.id as SessionId;
  const snapshot = await admin.request('session.get', { sessionId });
  const endpoint = [...adapter.endpoints.values()].at(-1);
  if (!endpoint) throw new Error('no app tools endpoint');
  let nextId = 0;
  const mcp = async (method: string, params: unknown = {}) => {
    nextId += 1;
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: 读任意形状的 MCP 回复。
    return ((await response.json()) as Record<string, any>).result;
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    mcp('tools/call', { name, arguments: args }) as Promise<{
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      // biome-ignore lint/suspicious/noExplicitAny: 结构化结果。
      structuredContent?: Record<string, any>;
    }>;
  return { host, connect, hello, sessionId, cwd: snapshot.session.cwd as string, mcp, call };
}

/** 假桌面端：登记为提供方，按 `answer` 回答每个请求。 */
async function fakeDesktop(
  connect: () => Promise<{ client: TestRpcClient }>,
  answer: (request: BrowserRequest) => Record<string, unknown> | undefined,
) {
  const { client } = await connect();
  await client.request('browser.register', { commands: [...BROWSER_COMMANDS] });
  const answered = new Set<string>();
  const requests: BrowserRequest[] = [];
  client.ws.on('message', () => {
    for (const request of client.notifications('browser.request') as BrowserRequest[]) {
      if (answered.has(request.requestId)) continue;
      answered.add(request.requestId);
      requests.push(request);
      const response = answer(request);
      if (response)
        void client.request('browser.respond', { requestId: request.requestId, ...response });
    }
  });
  return { client, requests };
}

describe('浏览器工具', () => {
  it('hello 声明 browser_tools；工具列表里有 browser_*，只读的标了 readOnlyHint 且与免批准表一致', async () => {
    const { hello, mcp } = await setup();
    expect(hello.features.browser_tools).toBe(true);
    const { tools } = await mcp('tools/list');
    const browser = (
      tools as Array<{ name: string; annotations: { readOnlyHint?: boolean } }>
    ).filter((tool) => tool.name.startsWith('browser_'));
    expect(browser.map((tool) => tool.name)).toContain('browser_click');
    expect(browser.map((tool) => tool.name)).not.toContain('browser_evaluate');
    const readOnly = browser
      .filter((tool) => tool.annotations.readOnlyHint === true)
      .map((tool) => tool.name);
    expect(readOnly.sort()).toEqual([...BROWSER_READ_ONLY_TOOLS].sort());
    for (const name of BROWSER_READ_ONLY_TOOLS) expect(APP_TOOLS_NO_APPROVAL).toContain(name);
    expect(APP_TOOLS_NO_APPROVAL).not.toContain('browser_click');
  });

  it('没有桌面端时工具明确返回不可用', async () => {
    const { call } = await setup();
    const result = await call('browser_list_tabs');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^\[browser_no_host\] .*desktop app is not open/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('请求经 browser.request 交给桌面端，带会话与目录；回答成为工具结果', async () => {
    const { connect, call, sessionId, cwd } = await setup();
    const desktop = await fakeDesktop(connect, (request) =>
      request.command.command === 'new_tab'
        ? {
            ok: true,
            result: { command: 'new_tab', browserId: 'tab_1', url: request.command.args.url },
          }
        : request.command.command === 'snapshot'
          ? {
              ok: true,
              result: {
                command: 'snapshot',
                browserId: 'tab_1',
                url: 'http://localhost:5173/',
                title: 'Todo',
                format: 'aria-yaml',
                snapshot: '- button "Add" [ref=@e1]',
                truncated: false,
                stats: { nodeCount: 2, refCount: 1, textLength: 24 },
              },
              dialogs: [{ type: 'alert', message: 'hi', action: 'accepted', timestamp: 1 }],
            }
          : undefined,
    );
    const opened = await call('browser_new_tab', { url: 'localhost:5173' });
    expect(opened.isError).toBeUndefined();
    expect(opened.content[0]?.text).toContain('browserId=tab_1');
    expect(desktop.requests[0]).toMatchObject({
      sessionId,
      cwd,
      command: { command: 'new_tab', args: { url: 'http://localhost:5173/' } },
    });
    const snapshot = await call('browser_snapshot', { browserId: 'tab_1' });
    expect(snapshot.content[0]?.text).toContain('- button "Add" [ref=@e1]');
    expect(snapshot.content[0]?.text).toContain('accepted alert "hi"');
  });

  it('截图带图片；错误带代码；参数不对时不发给桌面端', async () => {
    const { connect, call } = await setup();
    const desktop = await fakeDesktop(connect, (request) =>
      request.command.command === 'screenshot'
        ? {
            ok: true,
            result: {
              command: 'screenshot',
              browserId: 'tab_1',
              mimeType: 'image/png',
              dataBase64: 'iVBORw0KGgo=',
              width: 1280,
              height: 800,
            },
          }
        : { ok: false, error: { code: 'browser_stale_ref', message: 'Ref @e9 is stale.' } },
    );
    const shot = await call('browser_screenshot', { browserId: 'tab_1' });
    expect(shot.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    expect(shot.structuredContent).toBeUndefined();
    const stale = await call('browser_click', { browserId: 'tab_1', ref: '@e9' });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toMatch(/new browser_snapshot/);
    const before = desktop.requests.length;
    for (const [name, args] of [
      ['browser_navigate', { browserId: 'tab_1', url: 'file:///etc/passwd' }],
      ['browser_navigate', { browserId: 'tab_1', url: 'javascript:alert(1)' }],
      ['browser_click', { browserId: 'tab_1', ref: 'button' }],
      ['browser_wait', { browserId: 'tab_1', text: 'a', url: 'b' }],
      ['browser_click', { ref: '@e1' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
    }
    expect(desktop.requests).toHaveLength(before);
  });

  it('桌面端断开时在途的调用失败', async () => {
    const { connect, call } = await setup();
    const desktop = await fakeDesktop(connect, () => undefined);
    const pending = call('browser_reload', { browserId: 'tab_1' });
    await desktop.client.until(
      () => (desktop.client.notifications('browser.request').length > 0 ? true : undefined),
      'browser.request',
    );
    desktop.client.ws.close();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^\[browser_no_host\]/);
  });

  it('wevir_show 的 browser 只开本机网页，或显示这个会话的标签页', async () => {
    const { connect, call } = await setup();
    const desktop = await fakeDesktop(connect, (request) =>
      request.command.command === 'show'
        ? {
            ok: true,
            result: {
              command: 'show',
              browserId: request.command.args.browserId ?? 'tab_2',
              url: request.command.args.url ?? 'http://127.0.0.1:3000/',
              shown: true,
            },
          }
        : undefined,
    );
    const remote = await call('wevir_show', { kind: 'browser', url: 'https://example.com/' });
    expect(remote.isError).toBe(true);
    expect(remote.content[0]?.text).toMatch(/only opens local pages/);
    const local = await call('wevir_show', { kind: 'browser', url: '127.0.0.1:3000' });
    expect(local.content[0]?.text).toContain('Showing browser tab tab_2');
    expect(desktop.requests.at(-1)?.command).toEqual({
      command: 'show',
      args: { url: 'http://127.0.0.1:3000/' },
    });
    await call('wevir_show', { kind: 'browser', browserId: 'tab_1' });
    expect(desktop.requests.at(-1)?.command).toEqual({
      command: 'show',
      args: { browserId: 'tab_1' },
    });
    expect((await call('wevir_show', { kind: 'browser' })).isError).toBe(true);
  });

  it('不是这条连接的回答、迟到的回答都不收', async () => {
    const { connect } = await setup();
    const { client } = await connect();
    expect(
      await client.request('browser.respond', {
        requestId: 'brq_01JA2B3C4D5E6F7G8H9JKMNPQR',
        ok: true,
        result: { command: 'reload', browserId: 'tab_1' },
      }),
    ).toEqual({ accepted: false });
    await client.request('browser.unregister');
  });
});

describe('httpUrl', () => {
  it('没写协议的当 http，别的协议拒绝', () => {
    expect(httpUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(httpUrl(' https://example.com/a?b ')).toBe('https://example.com/a?b');
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@b',
      'a b',
      '',
      'wevir://app/',
    ]) {
      expect(() => httpUrl(bad), bad).toThrow();
    }
  });
});
