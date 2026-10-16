// 应用级工具（0.30.0，codex-event-mapping.md §6.11）：真实 codex-app-server + 网关 + mock 模型 + 测试里的 HTTP MCP 服务（扮演
// Host 的 `/mcp`）。`thread/start` 的 config 覆盖挂上 `mcp_servers.wevir`，请求带这个会话的令牌；只读的工具不问用户，其余的经
// `mcpServer/elicitation/request` 上报为审批，完全访问时不问。二进制不在时跳过。

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentEvent, PermissionMode } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockRequestBody,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 应用级工具');
const dirs = new TempDirs();
let mock: MockModel;
let mcp: FakeMcp;
const adapters: CodexAdapter[] = [];

const TOOLS = [
  {
    name: 'wevir_session_list',
    description: 'List sessions.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'wevir_session_create',
    description: 'Open a session.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

interface FakeMcp {
  url: string;
  calls: Array<{ tool: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

/** 扮演 Host 的 `/mcp`：Streamable HTTP、只回 JSON，记下每次 `tools/call` 与它的令牌。 */
async function startFakeMcp(): Promise<FakeMcp> {
  const calls: FakeMcp['calls'] = [];
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    void body(req).then((message) => {
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: unknown) =>
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      switch (message.method) {
        case 'initialize':
          return reply({
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'wevir', version: '0.0.0' },
          });
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call':
          calls.push({ tool: message.params.name, authorization: req.headers.authorization });
          return reply({ content: [{ type: 'text', text: `${message.params.name} ok` }] });
        default:
          return reply({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 找到 Wevir 的工具：命名空间 `mcp__wevir` 里的，或顶层名字里带它的。 */
function wevirTool(
  tools: MockRequestBody['tools'],
  name: string,
): { name: string; namespace?: string } {
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

const script: MockScript = (view) => {
  if (view.toolOutputs.length > 0) return { text: ['好了。'] };
  for (const name of ['wevir_session_list', 'wevir_session_create']) {
    if (view.lastUserText.includes(`[${name}]`)) {
      const tool = wevirTool(view.body.tools, name);
      return {
        toolCalls: [
          {
            kind: 'function',
            name: tool.name,
            ...(tool.namespace !== undefined && { namespace: tool.namespace }),
            args: name === 'wevir_session_create' ? { message: 'hi' } : {},
          },
        ],
      };
    }
  }
  return { text: ['你好。'] };
};

async function open(permissionMode: PermissionMode = 'on_request', token = 'token-a') {
  const { home, workspace } = dirs.make('app-tools');
  const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    permissionMode,
    appTools: { url: mcp.url, token },
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId) };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  return { from, done: finishTurn(events, from) };
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 应用级工具（真实 codex-app-server）',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
      mcp = await startFakeMcp();
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
      mcp.calls.length = 0;
    });
    afterAll(async () => {
      await mock?.close();
      await mcp?.close();
      dirs.cleanup();
    });

    it('只读的工具不问用户，请求带这个会话的令牌', async () => {
      const { adapter, id, events } = await open('on_request', 'token-read');
      const turn = await (await run(adapter, id, events, '[wevir_session_list]')).done;
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(turn.find(ofType('tool.started'))).toMatchObject({
        toolName: 'mcp__wevir__wevir_session_list',
      });
      expect(mcp.calls).toEqual([
        { tool: 'wevir_session_list', authorization: 'Bearer token-read' },
      ]);
    });

    it('其余的工具经 MCP 确认上报为审批：允许后才调用，拒绝时不调用', async () => {
      const { adapter, id, events } = await open();
      const allowed = await run(adapter, id, events, '[wevir_session_create]');
      const request = await waitForEvent(
        events,
        ofType('approval.requested'),
        '应用级工具的审批',
        allowed.from,
      );
      const started = events.slice(allowed.from).find(ofType('tool.started'));
      expect(request.toolCallId).toBe(started?.toolCallId);
      expect(request.options.map((option) => option.optionId)).toEqual(['accept', 'decline']);
      expect(mcp.calls).toEqual([]);
      await adapter.respondToApproval(id, request.requestId, { optionId: 'accept' });
      const turn = await allowed.done;
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(mcp.calls.map((call) => call.tool)).toEqual(['wevir_session_create']);

      const declined = await run(adapter, id, events, '[wevir_session_create] again');
      const second = await waitForEvent(
        events,
        ofType('approval.requested'),
        '第二次审批',
        declined.from,
      );
      await adapter.respondToApproval(id, second.requestId, { optionId: 'decline' });
      await declined.done;
      expect(mcp.calls.map((call) => call.tool)).toEqual(['wevir_session_create']);
    });

    it('完全访问时不问', async () => {
      const { adapter, id, events } = await open('full_access');
      const turn = await (await run(adapter, id, events, '[wevir_session_create]')).done;
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(mcp.calls.map((call) => call.tool)).toEqual(['wevir_session_create']);
    });
  },
);
