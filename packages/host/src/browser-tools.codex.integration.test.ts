// 内置浏览器（0.33.0）：只带 Codex 引擎的 Host（startHost + 真实 codex-app-server + mock 模型），一个假桌面端经真实的
// WebSocket 登记为浏览器提供方。mock 模型按脚本调 browser_new_tab → browser_snapshot → browser_click：请求经 Codex 的
// `mcp_servers.wevir` 到 Host 的 `/mcp`，再经 `browser.request` 到假桌面端，回答一路回到模型。完全访问时都不问；请求批准时
// 只读的快照不问，开标签页与点击各问一次。没有 codex-app-server 时跳过。

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { BrowserRequest, SessionId, WevirEvent } from '@wevir/protocol';
import { BROWSER_COMMANDS } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function binaryAvailable(): boolean {
  try {
    resolveCodexBinary();
    return true;
  } catch (error) {
    console.warn(`[浏览器工具 + codex] 跳过：${(error as Error).message}`);
    return false;
  }
}

/** Wevir 的工具：命名空间 `mcp__wevir` 或 `mcp__wevir_more` 里的，或顶层名字里带它的。 */
function wevirTool(tools: MockRequestBody['tools'], name: string) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = ((tool.tools ?? []) as Array<{ name?: string }>).find((t) => t.name === name);
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.endsWith(name)) {
      return { name: tool.name };
    }
  }
  throw new Error(`请求里没有 ${name}`);
}

const call = (body: MockRequestBody, name: string, args: unknown) => {
  const tool = wevirTool(body.tools, name);
  return {
    toolCalls: [
      {
        kind: 'function' as const,
        name: tool.name,
        ...(tool.namespace !== undefined && { namespace: tool.namespace }),
        args,
      },
    ],
  };
};

/** 工具输出：MCP 的内容项（`[{type:'text',text}]`）合成文本。 */
function outputText(output: string | undefined): string {
  try {
    const items = JSON.parse(output ?? '') as Array<{ text?: string }>;
    if (Array.isArray(items)) return items.map((item) => item.text ?? '').join('\n');
  } catch {
    // 本来就是文本
  }
  return output ?? '';
}

/** 开标签页 → 快照 → 点快照里的按钮 → 说出结果。 */
const script: MockScript = (view) => {
  if (!view.lastUserText.includes('[browser]')) return { text: ['你好。'] };
  const outputs = view.toolOutputs.map(outputText);
  if (outputs.length === 0) return call(view.body, 'browser_new_tab', { url: 'localhost:5173' });
  const browserId = /browserId=(\S+)/.exec(outputs[0] ?? '')?.[1] ?? 'missing';
  if (outputs.length === 1) return call(view.body, 'browser_snapshot', { browserId });
  if (outputs.length === 2) {
    const ref = /button "Add" \[ref=(@e\d+)\]/.exec(outputs[1] ?? '')?.[1] ?? '@e0';
    return call(view.body, 'browser_click', { browserId, ref });
  }
  return { text: [`done: ${outputs.at(-1) ?? ''}`] };
};

/** 假桌面端：登记为浏览器提供方，按命令回答。 */
async function fakeDesktop(url: string, token: string) {
  const client = await TestRpcClient.connect(url);
  cleanups.push(() => client.ws.close());
  expect(
    (await client.hello(token, { deviceId: 'dev-desk', clientId: 'desk-1', clientKind: 'desktop' }))
      .error,
  ).toBeUndefined();
  await client.request('browser.register', { commands: [...BROWSER_COMMANDS] });
  const requests: BrowserRequest[] = [];
  const answered = new Set<string>();
  client.ws.on('message', () => {
    for (const request of client.notifications('browser.request') as BrowserRequest[]) {
      if (answered.has(request.requestId)) continue;
      answered.add(request.requestId);
      requests.push(request);
      const { command } = request;
      const result =
        command.command === 'new_tab'
          ? { command: 'new_tab', browserId: 'tab_demo_1', url: command.args.url }
          : command.command === 'snapshot'
            ? {
                command: 'snapshot',
                browserId: command.args.browserId,
                url: 'http://localhost:5173/',
                title: 'Todo',
                format: 'aria-yaml',
                snapshot:
                  '- document "Todo"\n  - textbox "Item" [ref=@e1]\n  - button "Add" [ref=@e2]',
                truncated: false,
                stats: { nodeCount: 3, refCount: 2, textLength: 60 },
              }
            : command.command === 'click'
              ? {
                  command: 'click',
                  browserId: command.args.browserId,
                  ref: command.args.ref,
                  x: 10,
                  y: 10,
                }
              : undefined;
      void client.request(
        'browser.respond',
        result
          ? { requestId: request.requestId, ok: true, result }
          : {
              requestId: request.requestId,
              ok: false,
              error: { code: 'browser_unsupported', message: 'not in this test' },
            },
      );
    }
  });
  return requests;
}

describe.skipIf(!binaryAvailable())(
  '浏览器工具（startHost + 真实 codex-app-server + mock 模型 + 假桌面端）',
  { timeout: 120_000 },
  () => {
    async function start() {
      const model = await startMockModel(script);
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
      const workspace = join(tempDir(), 'workspace');
      mkdirSync(workspace);
      // 只有 Codex 引擎：不挂订阅来源的引擎，不碰本机的 claude 等登录（cli.ts 的 createAdapter 会探测它们）。
      const host = await startHost({
        home,
        adapter: new CodexRuntime({
          home,
          binary: resolveCodexBinary(),
          clientInfo: { name: 'wevir', version: '0.0.0' },
        }),
        engine: 'codex',
        logger: createLogger({ level: 'error', mirror: () => {} }),
      });
      cleanups.push(() => host.shutdown());
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const ready = { url: host.url };
      const client = await TestRpcClient.connect(ready.url);
      cleanups.push(() => client.ws.close());
      const hello = await client.hello(info.token as string);
      expect(hello.result.features.browser_tools).toBe(true);
      const requests = await fakeDesktop(ready.url, info.token as string);
      const { workspace: ws } = await client.request('workspace.add', { rootPath: workspace });
      await client.request('provider.upsert', {
        id: 'wevir-mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'wevir-mock-key-not-a-secret',
      });
      return { client, requests, ws };
    }

    async function turn(
      client: TestRpcClient,
      sessionId: SessionId,
      onApproval?: (
        approval: Extract<WevirEvent, { type: 'approval.requested' }>,
      ) => 'allow' | 'reject',
    ) {
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      const sent = await client.request('session.send', {
        sessionId,
        content: [{ type: 'text', text: '[browser] 打开本地页面并点 Add' }],
      });
      const answered = new Set<string>();
      const finished = client.until(
        () => {
          const events = client.events(subscriptionId);
          for (const event of events) {
            if (event.type !== 'approval.requested' || answered.has(event.payload.approval.id))
              continue;
            answered.add(event.payload.approval.id);
            const category = onApproval?.(event) ?? 'allow';
            const optionId = event.payload.approval.options.find(
              (option) => option.category === category,
            )?.optionId;
            void client.request('approval.respond', {
              approvalId: event.payload.approval.id,
              optionId,
            });
          }
          return events.find((e) => e.type === 'turn.finished' && e.payload.turnId === sent.turnId);
        },
        'turn.finished',
        90_000,
      );
      await finished;
      return client.events(subscriptionId);
    }

    it('完全访问：工具一路调到桌面端，带这个会话与目录，回答回到模型', async () => {
      const { client, requests, ws } = await start();
      const { session } = await client.request('session.create', {
        workspaceId: ws.id,
        providerId: 'wevir-mock',
        permissionMode: 'full_access',
      });
      const events = await turn(client, session.id as SessionId);
      expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(requests.map((request) => request.command.command)).toEqual([
        'new_tab',
        'snapshot',
        'click',
      ]);
      expect(requests[0]).toMatchObject({
        sessionId: session.id,
        cwd: session.cwd,
        command: { args: { url: 'http://localhost:5173/' } },
      });
      expect(requests[2]?.command).toEqual({
        command: 'click',
        args: { browserId: 'tab_demo_1', ref: '@e2' },
      });
      const answer = events.filter((e) => e.type === 'assistant.message').at(-1);
      expect((answer?.payload as { text: string } | undefined)?.text).toContain('Clicked @e2.');
      const tools = events.flatMap((e) => (e.type === 'tool.started' ? [e.payload.toolName] : []));
      expect(tools).toEqual([
        'mcp__wevir_more__browser_new_tab',
        'mcp__wevir_more__browser_snapshot',
        'mcp__wevir_more__browser_click',
      ]);
    });

    it('请求批准：快照不问，开标签页与点击各问一次；拒绝的不发给桌面端', async () => {
      const { client, requests, ws } = await start();
      const { session } = await client.request('session.create', {
        workspaceId: ws.id,
        providerId: 'wevir-mock',
        permissionMode: 'on_request',
      });
      const asked: string[] = [];
      await turn(client, session.id as SessionId, (approval) => {
        asked.push(approval.payload.approval.detail?.toolName ?? '');
        return approval.payload.approval.detail?.toolName.endsWith('browser_click')
          ? 'reject'
          : 'allow';
      });
      expect(asked).toEqual(['mcp__wevir_more__browser_new_tab', 'mcp__wevir_more__browser_click']);
      expect(requests.map((request) => request.command.command)).toEqual(['new_tab', 'snapshot']);
    });
  },
);
