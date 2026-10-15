// 联网工具（0.34.0，codex-event-mapping.md §6.12，docs/architecture/web-tools.md）：真实 codex-app-server + 网关 + mock 模型 +
// 假的 Host 端点。`wevir_web` 登记在 config.toml（令牌不在文件里，经 env_vars 转给桥脚本），每个会话按 `thread/start` 那一刻的
// 设置收窄工具；模型调用 web_search 时桥脚本带着令牌转给端点，不问用户，结果回到模型，展示成搜索。二进制不在时跳过。

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import {
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WEB_TOOL_SERVER,
  type WebToolServer,
  type WebToolState,
  webToolScriptPath,
} from '@wevir/runtime-adapter/web-tool';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  ofType,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockRequestBody,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 联网工具');
const dirs = new TempDirs();
const TOKEN = 'web-token-for-tests-0123456789abcdef';
let mock: MockModel;
let endpoint: Server;
let endpointUrl: string;
const calls: Array<{ authorization: string | undefined; body: unknown }> = [];
const adapters: CodexAdapter[] = [];

/** 请求里发给模型的工具：顶层的名字，以及命名空间里的 `<namespace>/<名字>`。 */
function toolNames(tools: MockRequestBody['tools']): string[] {
  return (tools ?? []).flatMap((tool) =>
    tool.type === 'namespace'
      ? ((tool.tools ?? []) as Array<{ name?: string }>).map((t) => `${tool.name}/${t.name}`)
      : [tool.name ?? tool.type],
  );
}

const SEARCH = `mcp__${WEB_TOOL_SERVER}/${WEB_SEARCH_TOOL}`;
const FETCH = `mcp__${WEB_TOOL_SERVER}/${WEB_FETCH_TOOL}`;

const script: MockScript = (view) => {
  if (view.toolOutputs.length > 0) return { text: ['根据搜索结果回答。'] };
  if (view.lastUserText.includes('[search]')) {
    return {
      toolCalls: [
        {
          kind: 'function',
          namespace: `mcp__${WEB_TOOL_SERVER}`,
          name: WEB_SEARCH_TOOL,
          args: { query: 'Codex 最新版本', count: 3 },
        },
      ],
    };
  }
  return { text: ['你好。'] };
};

function webTool(dir: string, state: WebToolState): WebToolServer {
  return {
    script: webToolScriptPath(join(dir, 'mcp')),
    node: process.execPath,
    endpoint: () => ({ url: endpointUrl, token: TOKEN }),
    state: () => state,
  };
}

async function open(state: WebToolState) {
  const { root, home, workspace } = dirs.make('web');
  const adapter = newAdapter({
    home,
    providers: [mockProvider(mock)],
    webTool: webTool(root, state),
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId), home };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  return finishTurn(events, from);
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 联网工具（真实 codex-app-server）',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
      endpoint = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          calls.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: 'Search results for "Codex 最新版本" (Bocha, 1):\n\n[1] Codex releases\nURL: https://github.com/openai/codex/releases',
                },
              ],
            }),
          );
        });
      });
      await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
      endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      endpoint?.closeAllConnections();
      await new Promise((resolve) => endpoint?.close(resolve));
      dirs.cleanup();
    });

    it('两个工具都在；web_search 带令牌转到 Host 端点、不问用户，结果回到模型，展示成搜索', async () => {
      const { adapter, id, events, home } = await open({ enabled: true, search: true });
      const before = mock.requests.length;
      const turn = await run(adapter, id, events, '[search] Codex 现在是哪个版本？');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(toolNames(mock.requests[before]?.body.tools)).toEqual(
        expect.arrayContaining([SEARCH, FETCH]),
      );
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(calls.at(-1)).toEqual({
        authorization: `Bearer ${TOKEN}`,
        body: { name: WEB_SEARCH_TOOL, arguments: { query: 'Codex 最新版本', count: 3 } },
      });
      expect(turn.find(ofType('tool.started'))).toMatchObject({
        toolName: `mcp__${WEB_TOOL_SERVER}__${WEB_SEARCH_TOOL}`,
        display: { kind: 'search', summary: 'Codex 最新版本', query: 'Codex 最新版本' },
      });
      expect(turn.find(ofType('tool.finished'))).toMatchObject({
        status: 'completed',
        output: expect.stringContaining('[1] Codex releases'),
      });
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain(
        'https://github.com/openai/codex/releases',
      );
      // 令牌只在进程环境里，不写进 config.toml。
      const config = readFileSync(join(home, 'engines', 'codex', 'config.toml'), 'utf8');
      expect(config).toContain(`[mcp_servers.${WEB_TOOL_SERVER}]`);
      expect(config).toContain('env_vars = ["WEVIR_WEB_TOKEN"]');
      expect(config).not.toContain(TOKEN);
    });

    it('没配搜索的 Key：只登记 web_fetch', async () => {
      const { adapter, id, events } = await open({ enabled: true, search: false });
      const before = mock.requests.length;
      await run(adapter, id, events, '你好');
      const names = toolNames(mock.requests[before]?.body.tools);
      expect(names).toContain(FETCH);
      expect(names).not.toContain(SEARCH);
    });

    it('联网关着：两个工具都不登记', async () => {
      const { adapter, id, events } = await open({ enabled: false, search: true });
      const before = mock.requests.length;
      await run(adapter, id, events, '你好');
      const names = toolNames(mock.requests[before]?.body.tools);
      expect(names.some((name) => name.includes(WEB_TOOL_SERVER))).toBe(false);
      // Codex 托管的搜索也没有发给模型服务。
      expect(names).not.toContain('web_search');
    });
  },
);
