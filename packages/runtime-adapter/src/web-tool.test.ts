import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WEB_TOOL_TOKEN_ENV,
  type WebToolServer,
  webToolCommand,
  webToolNames,
  webToolScriptPath,
  writeWebToolScript,
} from './web-tool.js';

// 联网工具的桥脚本（0.34.0）：stdio 的 MCP 服务，tools/call 带着令牌转给 Host 的端点，端点不在或回错时给模型一条说明。

const TOKEN = 'token-for-tests';
const dirs: string[] = [];
let endpoint: Server;
let url: string;
const received: Array<{ authorization?: string; body: unknown }> = [];

beforeAll(async () => {
  endpoint = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
      if (request.url !== '/call') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'from host' }] }));
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
});
afterAll(async () => {
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startBridge(endpointUrl: string, token: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'wevir-web-tool-'));
  dirs.push(root);
  const server: WebToolServer = {
    script: webToolScriptPath(join(root, 'mcp')),
    node: process.execPath,
    endpoint: () => ({ url: endpointUrl, token: token ?? '' }),
    state: () => ({ enabled: true, search: true }),
  };
  writeWebToolScript(server);
  const { command, args, env } = webToolCommand(server, { url: endpointUrl, token: '' });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv[WEB_TOOL_TOKEN_ENV];
  if (token !== undefined) childEnv[WEB_TOOL_TOKEN_ENV] = token;
  // 不继承 Vitest worker 的 execArgv（AGENTS.md）。
  const child = spawn(command, args, { env: childEnv, stdio: 'pipe' });
  const replies = new Map<number, (value: unknown) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number };
    replies.get(message.id)?.(message);
  });
  let nextId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: 测试只读回复的字段。
  const call = (method: string, params: unknown = {}): Promise<any> => {
    const id = nextId++;
    const reply = new Promise((resolve) => replies.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  return { server, child, call };
}

describe('wevir_web 的桥脚本', () => {
  it('initialize、tools/list 两个工具；tools/call 带令牌转给端点，回复原样交回', async () => {
    const bridge = startBridge(url, TOKEN);
    try {
      expect(statSync(bridge.server.script).mode & 0o777).toBe(0o600);
      const init = await bridge.call('initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('wevir_web');
      const list = await bridge.call('tools/list');
      expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        WEB_SEARCH_TOOL,
        WEB_FETCH_TOOL,
      ]);
      const reply = await bridge.call('tools/call', {
        name: WEB_SEARCH_TOOL,
        arguments: { query: 'q' },
      });
      expect(reply.result).toEqual({ content: [{ type: 'text', text: 'from host' }] });
      expect(received.at(-1)).toEqual({
        authorization: `Bearer ${TOKEN}`,
        body: { name: WEB_SEARCH_TOOL, arguments: { query: 'q' } },
      });
      const unknown = await bridge.call('tools/call', { name: 'other', arguments: {} });
      expect(unknown.error.code).toBe(-32602);
    } finally {
      bridge.child.kill();
    }
  });

  it('没有令牌、端点不在：给模型一条说明（isError），不让引擎挂住', async () => {
    const noToken = startBridge(url, undefined);
    const gone = startBridge('http://127.0.0.1:9', TOKEN);
    try {
      const a = await noToken.call('tools/call', { name: WEB_FETCH_TOOL, arguments: {} });
      expect(a.result.isError).toBe(true);
      expect(a.result.content[0].text).toContain('Web access is not available');
      const b = await gone.call('tools/call', { name: WEB_FETCH_TOOL, arguments: { url: 'x' } });
      expect(b.result.isError).toBe(true);
      expect(b.result.content[0].text).toContain('did not answer');
    } finally {
      noToken.child.kill();
      gone.child.kill();
    }
  });

  it('一个会话登记哪些工具', () => {
    expect(webToolNames({ enabled: true, search: true })).toEqual([
      WEB_SEARCH_TOOL,
      WEB_FETCH_TOOL,
    ]);
    expect(webToolNames({ enabled: true, search: false })).toEqual([WEB_FETCH_TOOL]);
    expect(webToolNames({ enabled: false, search: true })).toEqual([]);
  });
});
