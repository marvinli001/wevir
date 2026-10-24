// 项目的连接器（0.74.0）：真实 codex-app-server + 网关 + mock 模型 + 测试里的 HTTP MCP 服务。`SessionConfig.connectors` 经
// `thread/start` 的 config 覆盖只挂在这一个 thread 上：同一个进程里的别的会话看不到它的工具；它的工具调用按用户连接器上报审批。
// 二进制不在时跳过。

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const binary = codexBinaryOrSkip('adapter-codex 项目连接器');
const dirs = new TempDirs();
const TOOL = 'docs_lookup';
let mock: MockModel;
let server: Server;
let url: string;
const calls: Array<{ tool: string; header: string | undefined }> = [];
/** 每次模型请求里有没有项目连接器的工具。 */
const seen: boolean[] = [];

function findTool(
  tools: MockRequestBody['tools'],
): { name: string; namespace?: string } | undefined {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = ((tool.tools ?? []) as Array<{ name?: string }>).find((t) => t.name === TOOL);
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.endsWith(TOOL)) return { name: tool.name };
  }
  return undefined;
}

const script: MockScript = (view) => {
  const tool = findTool(view.body.tools);
  seen.push(tool !== undefined);
  if (view.toolOutputs.length > 0) return { text: ['好了。'] };
  if (view.lastUserText.includes('[lookup]') && tool !== undefined)
    return {
      toolCalls: [
        {
          kind: 'function',
          name: tool.name,
          ...(tool.namespace !== undefined && { namespace: tool.namespace }),
          args: {},
        },
      ],
    };
  return { text: ['你好。'] };
};

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 项目连接器（真实 codex-app-server）',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
      server = createServer((req, res) => {
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
          if (message.method === 'initialize')
            return reply({
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'docs', version: '0.0.0' },
            });
          if (message.method === 'tools/list')
            return reply({
              tools: [
                {
                  name: TOOL,
                  description: 'Look up docs.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            });
          if (message.method === 'tools/call') {
            calls.push({ tool: message.params.name, header: req.headers['x-team'] as string });
            return reply({ content: [{ type: 'text', text: 'docs ok' }] });
          }
          return reply({});
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    });
    afterAll(async () => {
      await mock?.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      dirs.cleanup();
    });

    it('只挂在带它的会话上，调用经审批', async () => {
      const { home, workspace } = dirs.make('project-connectors');
      const adapter: CodexAdapter = newAdapter({
        home,
        providers: [
          // 项目连接器的工具在工具搜索打开时延迟；这里不测搜索，假模型按名字直接调。
          mockProvider(mock, { compat: { toolSearch: 'off' } }),
        ],
      });
      try {
        const base = { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL };
        const a = await adapter.createSession({
          ...base,
          connectors: [
            {
              name: 'proj_docs',
              config: { transport: 'http', url, headers: { 'X-Team': 'team-a' } },
              enabled: true,
            },
          ],
        });
        const b = await adapter.createSession(base);
        const eventsA = collectEvents(adapter, a.engineSessionId);
        const eventsB = collectEvents(adapter, b.engineSessionId);
        const run = async (id: string, events: AgentEvent[], text: string) => {
          const from = events.length;
          await adapter.send(id, { content: [{ type: 'text', text }] });
          return { from, done: finishTurn(events, from) };
        };

        seen.length = 0;
        await (await run(b.engineSessionId, eventsB, 'hello')).done;
        expect(seen).toEqual([false]);

        seen.length = 0;
        const turn = await run(a.engineSessionId, eventsA, '[lookup]');
        const request = await waitForEvent(
          eventsA,
          ofType('approval.requested'),
          '项目连接器的审批',
          turn.from,
        );
        await adapter.respondToApproval(a.engineSessionId, request.requestId, {
          optionId: 'accept',
        });
        const events = await turn.done;
        expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        expect(seen[0]).toBe(true);
        expect(calls).toEqual([{ tool: TOOL, header: 'team-a' }]);
      } finally {
        await adapter.dispose();
      }
    });
  },
);
