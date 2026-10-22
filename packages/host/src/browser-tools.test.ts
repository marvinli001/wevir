// 内置浏览器（0.33.0，domain-model §3.15）：startHost 组装出的 Host（echo 引擎声明能挂应用级工具），一个假桌面端经真实的
// WebSocket 登记为浏览器提供方，模型那一侧直接按 MCP 调 `/mcp` 端点：工具列表与 annotations、请求带会话与目录、结果与截图、
// 没有提供方、断开、参数在发出前就被拒、wevir_show 只开本机网页。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserRequest, SessionId } from '@wevir/protocol';
import { BROWSER_COMMANDS } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_READ_ONLY_TOOLS, browserToolResult, httpUrl } from './browser-tools.js';
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
    expect(browser.map((tool) => tool.name)).toContain('browser_evaluate');
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
    expect(result.content[0]?.text).toMatch(
      /^\[browser_no_host\] .*no Wevir window is connected.*Try again in a few seconds/,
    );
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
    // 参数错误也带错误码，说清楚哪里不对（0.46.0）。
    const texts = await Promise.all(
      (
        [
          ['browser_navigate', { browserId: 'tab_1', url: 'file:///etc/hosts' }],
          ['browser_new_tab', { url: 'not a url' }],
          ['browser_click', { browserId: 'tab_1', ref: 'garbage' }],
          ['browser_wait', { browserId: 'tab_1', text: 'a', url: 'b' }],
        ] as const
      ).map(async ([name, args]) => (await call(name, args)).content[0]?.text),
    );
    expect(texts).toEqual([
      '[browser_invalid_url] file: URLs are not supported: the Wevir browser only opens http and https pages, by design.',
      '[browser_invalid_url] "not a url" is not a URL. Pass an http(s) URL, or a host like localhost:5173.',
      '[browser_invalid_argument] ref must be a ref from browser_snapshot, like @e3 (got "garbage").',
      '[browser_invalid_argument] browser_wait needs exactly one of text, url, urlRegex, selector or networkIdle.',
    ]);
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

describe('浏览器工具（0.48.0）', () => {
  it('新工具的参数在 Host 核对：上传只收会话文件夹里的文件，下载要 ref 或 url 之一，等待只能一个条件', async () => {
    const { connect, call, cwd } = await setup();
    writeFileSync(join(cwd, 'a.txt'), 'hello');
    mkdirSync(join(cwd, 'docs'));
    // 会话文件夹外真实存在的文件（`/etc/hosts` 在 Windows 上不存在，会变成“不存在”而不是“越界”）。
    const outside = join(realpathSync(tempDir()), 'outside.txt');
    writeFileSync(outside, 'secret');
    const desktop = await fakeDesktop(connect, (request) => ({
      ok: true,
      result:
        request.command.command === 'upload'
          ? {
              command: 'upload',
              browserId: 'tab_1',
              files: [{ path: join(cwd, 'a.txt'), size: 5 }],
            }
          : request.command.command === 'evaluate'
            ? {
                command: 'evaluate',
                browserId: 'tab_1',
                value: '"T"',
                type: 'string',
                truncated: false,
                length: 3,
              }
            : { command: 'wait', browserId: 'tab_1', matched: 'url' },
    }));

    const uploaded = await call('browser_upload', { browserId: 'tab_1', paths: ['a.txt'] });
    expect(uploaded.isError).toBeUndefined();
    expect(uploaded.content[0]?.text).toBe(
      `Gave 1 file to the file chooser: ${join(cwd, 'a.txt')} (5 B).`,
    );
    expect(desktop.requests.at(-1)?.command).toEqual({
      command: 'upload',
      args: { browserId: 'tab_1', paths: [join(cwd, 'a.txt')] },
    });
    await call('browser_evaluate', { browserId: 'tab_1', function: '() => document.title' });
    await call('browser_wait', { browserId: 'tab_1', urlRegex: '/done$' });
    expect(desktop.requests.map((request) => request.command.command)).toEqual([
      'upload',
      'evaluate',
      'wait',
    ]);

    const refused = await Promise.all(
      (
        [
          ['browser_upload', { browserId: 'tab_1', paths: [outside] }],
          ['browser_upload', { browserId: 'tab_1', paths: ['../outside.txt'] }],
          ['browser_upload', { browserId: 'tab_1', paths: ['docs'] }],
          ['browser_upload', { browserId: 'tab_1', paths: ['missing.txt'] }],
          ['browser_upload', { browserId: 'tab_1', paths: [] }],
          ['browser_download', { browserId: 'tab_1' }],
          ['browser_download', { browserId: 'tab_1', ref: '@e1', url: 'http://a.test/x' }],
          ['browser_download', { browserId: 'tab_1', url: 'file:///etc/hosts' }],
          ['browser_evaluate', { browserId: 'tab_1' }],
          ['browser_wait', { browserId: 'tab_1', urlRegex: 'a', networkIdle: true }],
          ['browser_snapshot', { browserId: 'tab_1', selector: 'main', ref: '@e1' }],
          ['browser_snapshot', { browserId: 'tab_1', maxNodes: 6 }],
        ] as const
      ).map(async ([name, args]) => {
        const result = await call(name, args);
        expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
        return result.content[0]?.text ?? '';
      }),
    );
    expect(refused[0]).toMatch(/^\[browser_denied\] .*outside the session folder/);
    expect(refused[1]).toMatch(/^\[browser_denied\]|does not exist/);
    expect(refused[2]).toMatch(/is not a file/);
    expect(refused[3]).toMatch(/does not exist/);
    expect(refused[11]).toMatch(/maxNodes must be at least 100 \(got 6\)/);
    expect(desktop.requests).toHaveLength(3);
  });
});

describe('浏览器工具（0.89.0）：收尾与接管', () => {
  it('收尾不用批准、接管要批准；keep 在 Host 核对（状态、重复），结果写出每个标签页的去向', async () => {
    const { connect, call, mcp } = await setup();
    const { tools } = await mcp('tools/list');
    const byName = new Map(
      (tools as Array<{ name: string; annotations: { readOnlyHint?: boolean } }>).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    expect(byName.get('browser_finalize_tabs')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('browser_claim_tab')?.annotations.readOnlyHint).toBe(false);
    expect(APP_TOOLS_NO_APPROVAL).toContain('browser_finalize_tabs');
    expect(APP_TOOLS_NO_APPROVAL).not.toContain('browser_claim_tab');
    expect(byName.get('browser_close_tab')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(APP_TOOLS_NO_APPROVAL).toContain('browser_close_tab');

    const desktop = await fakeDesktop(connect, (request) => ({
      ok: true,
      result:
        request.command.command === 'finalize_tabs'
          ? {
              command: 'finalize_tabs',
              tabs: [
                {
                  browserId: 'tab_1',
                  url: 'http://a.test/doc',
                  title: 'Doc',
                  outcome: 'deliverable',
                },
                { browserId: 'tab_2', url: 'http://a.test/pay', title: '', outcome: 'handoff' },
                {
                  browserId: 'tab_3',
                  url: 'http://a.test/mine',
                  title: 'Mine',
                  outcome: 'released',
                },
                { browserId: 'tab_4', url: 'http://a.test/q', title: 'Search', outcome: 'closed' },
              ],
            }
          : {
              command: 'claim_tab',
              browserId: 'tab_3',
              url: 'http://a.test/mine',
              title: 'Mine',
              previousController: 'user',
            },
    }));

    const finalized = await call('browser_finalize_tabs', {
      keep: [
        { browserId: 'tab_1', status: 'deliverable' },
        { browserId: 'tab_2', status: 'handoff' },
      ],
    });
    expect(finalized.isError).toBeUndefined();
    expect(finalized.content[0]?.text).toBe(
      [
        'Finished with the browser tabs:',
        '- Left open for the user as a deliverable: browserId=tab_1 title="Doc" url=http://a.test/doc',
        '- Handed to the user to continue: browserId=tab_2 title="Untitled" url=http://a.test/pay',
        '- Handed back to the user: browserId=tab_3 title="Mine" url=http://a.test/mine',
        '- Closed: browserId=tab_4 title="Search" url=http://a.test/q',
      ].join('\n'),
    );
    expect(desktop.requests.at(-1)?.command).toEqual({
      command: 'finalize_tabs',
      args: {
        keep: [
          { browserId: 'tab_1', status: 'deliverable' },
          { browserId: 'tab_2', status: 'handoff' },
        ],
      },
    });
    await call('browser_finalize_tabs');
    expect(desktop.requests.at(-1)?.command).toEqual({
      command: 'finalize_tabs',
      args: { keep: [] },
    });

    const claimed = await call('browser_claim_tab', { browserId: 'tab_3' });
    expect(claimed.content[0]?.text).toBe(
      'You now control browser tab tab_3 (http://a.test/mine). The user gets it back as soon as they click or type in it.',
    );

    const refused = await Promise.all(
      (
        [
          { keep: [{ browserId: 'tab_1', status: 'keep' }] },
          {
            keep: [
              { browserId: 'tab_1', status: 'handoff' },
              { browserId: 'tab_1', status: 'deliverable' },
            ],
          },
          { keep: 'tab_1' },
          { keep: [{ status: 'handoff' }] },
        ] as const
      ).map(async (args) => {
        const result = await call('browser_finalize_tabs', args);
        expect(result.isError, JSON.stringify(args)).toBe(true);
        return result.content[0]?.text ?? '';
      }),
    );
    expect(refused[0]).toBe(
      '[browser_invalid_argument] status of tab_1 must be "deliverable" or "handoff" (got "keep").',
    );
    expect(refused[1]).toBe('[browser_invalid_argument] keep lists tab_1 twice.');
    expect(desktop.requests).toHaveLength(3);
  });

  it('列标签页写出谁开的与收尾的去向；已经归 agent 的接管说明没变', () => {
    const first = (payload: Parameters<typeof browserToolResult>[0]) =>
      (browserToolResult(payload).content[0] as { text: string }).text;
    expect(
      first({
        ok: true,
        result: {
          command: 'list_tabs',
          tabs: [
            {
              browserId: 'tab_1',
              url: 'http://a.test/',
              title: 'A',
              isActive: true,
              isLoading: false,
              controller: 'user',
              origin: 'agent',
              disposition: 'handoff',
            },
          ],
        },
      }),
    ).toBe(
      '1 browser tab:\n- browserId=tab_1 active controller=user opened_by=agent left_as=handoff title="A" url=http://a.test/',
    );
    expect(
      first({
        ok: true,
        result: {
          command: 'claim_tab',
          browserId: 'tab_1',
          url: 'http://a.test/',
          title: 'A',
          previousController: 'agent',
        },
      }),
    ).toBe('Browser tab tab_1 (http://a.test/) is already yours to act on.');
    expect(first({ ok: true, result: { command: 'finalize_tabs', tabs: [] } })).toBe(
      'No browser tabs of yours to finish with.',
    );
  });
});

describe('browserToolResult（0.48.0）', () => {
  const text = (payload: Parameters<typeof browserToolResult>[0]) => {
    const first = browserToolResult(payload).content[0];
    return first?.type === 'text' ? (first as { text: string }).text : '';
  };

  it('evaluate 写出类型与截断', () => {
    expect(
      text({
        ok: true,
        result: {
          command: 'evaluate',
          browserId: 'tab_1',
          value: '[1,2',
          type: 'array',
          truncated: true,
          length: 9,
        },
      }),
    ).toBe(
      'Returned array (first 4 of 9 characters; pass a larger maxBytes, up to 200000, or return less):\n[1,2',
    );
  });

  it('query 写出数量、引用、可见性与位置', () => {
    expect(
      text({
        ok: true,
        result: {
          command: 'query',
          browserId: 'tab_1',
          selector: 'a',
          count: 3,
          elements: [
            {
              ref: '@e4',
              tag: 'a',
              id: 'home',
              classes: 'nav link',
              text: 'Home',
              visible: true,
              box: { x: 1, y: 2, width: 30, height: 10 },
              attributes: { href: '/' },
            },
          ],
        },
      }).split('\n'),
    ).toEqual([
      '3 elements match "a"; the first 1:',
      '- @e4 <a#home.nav.link> "Home" visible at 1,2 size 30x10 href="/"',
      'The refs work with browser_click and the other tools until the page changes.',
    ]);
    expect(
      text({
        ok: true,
        result: { command: 'query', browserId: 'tab_1', selector: '.x', count: 0, elements: [] },
      }),
    ).toBe('No element matches ".x".');
  });

  it('network 写出过滤后的列表与一条请求的详情', () => {
    expect(
      text({
        ok: true,
        result: {
          command: 'network',
          browserId: 'tab_1',
          entries: [
            {
              id: '3',
              url: 'http://a.test/x.png',
              method: 'GET',
              status: 404,
              type: 'image',
              startTime: 0,
              duration: 12,
            },
          ],
          total: 9,
          matched: 1,
        },
      }).split('\n'),
    ).toEqual([
      '1 of 9 requests on this page matches.',
      '[network] id=3 GET http://a.test/x.png 404 image 12ms',
      'Call browser_network with id for headers and timing, and body=true for the response body.',
    ]);
    const detail = text({
      ok: true,
      result: {
        command: 'network',
        browserId: 'tab_1',
        entries: [],
        total: 9,
        matched: 9,
        detail: {
          id: '2',
          url: 'http://a.test/api',
          method: 'POST',
          status: 200,
          type: 'fetch',
          mimeType: 'application/json',
          requestHeaders: { Authorization: '[redacted, 13 characters]' },
          responseHeaders: { 'Content-Type': 'application/json' },
          postData: '{"q":1}',
          startTime: 100,
          duration: 20,
          waitingMs: 15,
          body: { size: 2, text: '{}' },
        },
      },
    });
    expect(detail).toContain('Authorization: [redacted, 13 characters]');
    expect(detail).toContain('waited 15 ms for the response');
    expect(detail).toContain('{"q":1}');
    expect(detail).toContain('Response body (2 B):\n{}');
  });

  it('dialogs 与 download 的说明', () => {
    expect(
      text({
        ok: true,
        result: {
          command: 'dialogs',
          browserId: 'tab_1',
          policy: {
            confirm: 'accept',
            prompt: 'accept',
            promptText: 'Alice',
            beforeunload: 'dismiss',
          },
        },
      }),
    ).toBe(
      'Dialogs in browser tab tab_1 from now on: confirm accept, prompt accept with "Alice", beforeunload dismiss (stay on the page); alerts are accepted. This lasts until the tab closes or the user takes it over.',
    );
    const download = (state: string, extra: Record<string, unknown> = {}) =>
      text({
        ok: true,
        result: {
          command: 'download',
          browserId: 'tab_1',
          url: 'http://a.test/r.csv',
          filename: 'r.csv',
          size: 2048,
          state,
          ...extra,
        },
      } as Parameters<typeof browserToolResult>[0]);
    expect(download('completed', { path: '/work/downloads/r.csv', mimeType: 'text/csv' })).toBe(
      'Downloaded "r.csv" from http://a.test/r.csv (2 KB, text/csv) to /work/downloads/r.csv.',
    );
    expect(download('too_large')).toBe(
      'The download of "r.csv" from http://a.test/r.csv was cancelled: it is larger than 500 MB.',
    );
    expect(download('interrupted')).toContain(
      'The download of "r.csv" from http://a.test/r.csv ended as interrupted after 2 KB; nothing was saved. The server probably refused it',
    );
    expect(download('interrupted')).toContain('browser_network');
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

describe('browserToolResult', () => {
  const text = (
    payload: Parameters<typeof browserToolResult>[0],
    command?: Parameters<typeof browserToolResult>[1],
  ) => {
    const first = browserToolResult(payload, command).content[0];
    return first?.type === 'text' ? (first as { text: string }).text : '';
  };

  it('写出命令引起的跳转、新标签页、下载、选文件框与对话框（0.46.0）', () => {
    const lines = text({
      ok: true,
      result: { command: 'click', browserId: 'tab_1', ref: '@e2' },
      effects: {
        navigation: { url: 'http://a.test/missing.json', status: 404 },
        openedTabs: [{ browserId: 'tab_2', url: 'http://a.test/r3' }],
        downloads: [{ url: 'http://a.test/download.bin', filename: 'smoke.bin', state: 'blocked' }],
        fileChooser: { multiple: false },
      },
      dialogs: [{ type: 'alert', message: 'hi', action: 'accepted', timestamp: 1 }],
    }).split('\n');
    expect(lines).toEqual([
      'Clicked @e2.',
      'The page navigated to http://a.test/missing.json (HTTP 404, an error page); take a new browser_snapshot.',
      'The page opened a new tab in the background: browserId=tab_2 url=http://a.test/r3.',
      'The page started a download of "smoke.bin" (http://a.test/download.bin); the Wevir browser blocked it and nothing was saved; to keep it, call browser_download with the same ref or the URL.',
      'The page asked to choose a file; nothing was chosen. To give it files from the session folder, call browser_upload without ref.',
      'The page opened a dialog, answered automatically (browser_dialogs sets how): accepted alert "hi".',
    ]);
  });

  it('快照分段时写出行号；日志写出总数与省略了多少', () => {
    const part = text({
      ok: true,
      result: {
        command: 'snapshot',
        browserId: 'tab_1',
        url: 'http://a.test/big',
        title: 'Big',
        format: 'aria-yaml',
        snapshot: '- text: "row 1"',
        truncated: true,
        stats: {
          nodeCount: 6405,
          refCount: 2,
          textLength: 10,
          totalLines: 6402,
          startLine: 80,
          shownLines: 70,
        },
      },
    });
    expect(part.split('\n')[0]).toBe(
      'Snapshot part: lines 81–150 of 6402, 2 refs in the whole page.',
    );
    const tall = text({
      ok: true,
      result: {
        command: 'screenshot',
        browserId: 'tab_1',
        mimeType: 'image/png',
        dataBase64: 'AAAA',
        width: 537,
        height: 8000,
      },
    });
    expect(tall).toMatch(
      /^Captured a screenshot of browser tab tab_1 \(537x8000\)\. Full-page screenshots stop at 8000 px of height/,
    );
    const short = text({
      ok: true,
      result: {
        command: 'screenshot',
        browserId: 'tab_1',
        mimeType: 'image/png',
        dataBase64: 'AAAA',
        width: 537,
        height: 900,
      },
    });
    expect(short).toBe('Captured a screenshot of browser tab tab_1 (537x900).');
    const pastEnd = text({
      ok: true,
      result: {
        command: 'snapshot',
        browserId: 'tab_1',
        url: 'http://a.test/big',
        title: 'Big',
        format: 'aria-yaml',
        snapshot: '# The snapshot has 1266 lines; offset 1300 is past the end.',
        truncated: true,
        stats: {
          nodeCount: 1300,
          refCount: 2,
          textLength: 10,
          totalLines: 1266,
          startLine: 1266,
          shownLines: 0,
        },
      },
    });
    expect(pastEnd.split('\n')[0]).toBe(
      'Snapshot part: none (the offset is past the last line, 1266), 2 refs in the whole page.',
    );
    const logs = text({
      ok: true,
      result: {
        command: 'logs',
        browserId: 'tab_1',
        console: [{ level: 'log', message: 'line 999', timestamp: 1 }],
        network: [
          {
            url: 'http://a.test/api',
            method: 'POST',
            type: 'fetch',
            startTime: 1,
            duration: 0,
            pending: true,
          },
          {
            url: 'http://a.test/x',
            method: 'GET',
            startTime: 1,
            duration: 2,
            failed: 'net::ERR_ABORTED',
          },
          {
            url: 'http://a.test/missing.json',
            method: 'GET',
            status: 404,
            type: 'fetch',
            startTime: 3,
            duration: 0,
            pending: true,
          },
        ],
        consoleTotal: 1000,
        networkTotal: 3,
      },
    });
    expect(logs.split('\n')).toEqual([
      '1 of 1000 console messages (the first 999 left out), 3 network entries since this page loaded.',
      '[console.log] line 999',
      '[network] POST http://a.test/api fetch pending',
      '[network] GET http://a.test/x failed net::ERR_ABORTED',
      '[network] GET http://a.test/missing.json 404 fetch body still loading',
    ]);
  });

  it('超时的提示按命令给，快照超时不再建议取快照', () => {
    const timeout = {
      ok: false as const,
      error: { code: 'browser_timeout', message: 'The browser did not answer within 30 s.' },
    };
    expect(text(timeout, 'snapshot')).toBe(
      '[browser_timeout] The browser did not answer within 30 s. If the tab keeps not answering, close it with browser_close_tab and open the page again.',
    );
    expect(text(timeout, 'click')).toMatch(
      /Take a browser_snapshot to see the page before trying again\.$/,
    );
    // 桌面端的说明里已经有下一步时不再补。
    const busy = {
      ok: false as const,
      error: {
        code: 'browser_timeout',
        message: 'The page is not responding. Close the tab with browser_close_tab.',
      },
    };
    expect(text(busy, 'snapshot')).toBe(`[browser_timeout] ${busy.error.message}`);
  });

  it('打开与跳转写出 HTTP 状态码，出错的状态说明是错误页', () => {
    expect(
      text({
        ok: true,
        result: { command: 'navigate', browserId: 'tab_1', url: 'http://a.test/x', status: 404 },
      }),
    ).toBe('Loaded http://a.test/x (HTTP 404, an error page).');
    expect(
      text({
        ok: true,
        result: { command: 'navigate', browserId: 'tab_1', url: 'http://a.test/' },
      }),
    ).toBe('Loaded http://a.test/.');
    expect(
      text({
        ok: true,
        result: { command: 'new_tab', browserId: 'tab_1', url: 'http://a.test/', status: 200 },
      }),
    ).toContain('url=http://a.test/ (HTTP 200).');
  });

  it('网络记录统一写成 地址 状态 类型 耗时，有方法时放在前面', () => {
    const logs = text({
      ok: true,
      result: {
        command: 'logs',
        browserId: 'tab_1',
        console: [],
        network: [
          {
            url: 'http://a.test/missing.json',
            status: 404,
            type: 'fetch',
            startTime: 1,
            duration: 1.2,
          },
          { url: 'http://a.test/', type: 'navigation', startTime: 0, duration: 60 },
          { url: 'http://a.test/old', method: 'GET', startTime: 0, duration: 3 },
        ],
      },
    });
    expect(logs.split('\n').slice(1)).toEqual([
      '[network] http://a.test/missing.json 404 fetch 1ms',
      '[network] http://a.test/ status=unknown navigation 60ms',
      '[network] GET http://a.test/old status=unknown 3ms',
    ]);
  });

  it('过期引用的提示只说一次（旧桌面端的消息里已经有）', () => {
    const fresh = text({
      ok: false,
      error: {
        code: 'browser_stale_ref',
        message: 'Browser element reference @e9 is not in the latest snapshot of this tab.',
      },
    });
    expect(fresh).toBe(
      '[browser_stale_ref] Browser element reference @e9 is not in the latest snapshot of this tab. Take a new browser_snapshot and try again.',
    );
    const old = text({
      ok: false,
      error: {
        code: 'browser_stale_ref',
        message: 'Browser element reference @e9 is stale. Take a new snapshot and try again.',
      },
    });
    expect(old.match(/try again/g)).toHaveLength(1);
  });
});
