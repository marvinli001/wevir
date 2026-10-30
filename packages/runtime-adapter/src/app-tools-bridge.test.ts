// 应用级工具的 stdio 桥（0.30.0）：用 Node 跑生成的脚本，对着一个本机 HTTP 服务转发 JSON-RPC。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_TOOLS_TOKEN_ENV,
  APP_TOOLS_URL_ENV,
  acpAppToolsServer,
  appToolsBridge,
  writeAppToolsBridgeScript,
} from './app-tools-bridge.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** 本机的假 Host。`tools/call` 不回复，挂到客户端断开，断开的请求 id 记进 `aborted`。 */
async function startServer(): Promise<{
  url: string;
  seen: string[];
  methods: string[];
  aborted: unknown[];
}> {
  const seen: string[] = [];
  const methods: string[] = [];
  const aborted: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(req.headers.authorization ?? '');
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      methods.push(message.method);
      if (message.method === 'tools/call') {
        res.on('close', () => {
          if (!res.writableFinished) aborted.push(message.id);
        });
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.method } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    seen,
    methods,
    aborted,
  };
}

function runBridge(url: string, token: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-bridge-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = appToolsBridge(dir);
  writeAppToolsBridgeScript(bridge);
  const server = acpAppToolsServer(bridge, { url, token });
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  cleanups.push(() => {
    child.kill();
  });
  const lines: unknown[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(JSON.parse(line)));
  return { child, lines, server };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe('应用级工具的 stdio 桥', () => {
  it('把每条请求带着令牌转给 Host，回复写回 stdout；通知不回', async () => {
    const { url, seen } = await startServer();
    const { child, lines, server } = runBridge(url, 'tok');
    expect(server.env.map((e) => e.name)).toEqual([
      'ELECTRON_RUN_AS_NODE',
      APP_TOOLS_URL_ENV,
      APP_TOOLS_TOKEN_ENV,
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await until(() => lines.length === 2 && seen.length === 3);
    expect(lines).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 1, result: { echo: 'initialize' } },
        { jsonrpc: '2.0', id: 2, result: { echo: 'tools/list' } },
      ]),
    );
    expect(seen).toEqual(['Bearer tok', 'Bearer tok', 'Bearer tok']);
  });

  it('Host 不在时回 JSON-RPC 错误，不退出', async () => {
    const { child, lines } = runBridge('http://127.0.0.1:9/mcp', 'tok');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
    await until(() => lines.length === 1);
    expect(lines[0]).toMatchObject({ id: 7, error: { code: -32603 } });
    expect(child.exitCode).toBeNull();
  });

  it('引擎取消请求（notifications/cancelled）时中止对 Host 的那个请求，不再回复；通知照样转发', async () => {
    const { url, methods, aborted } = await startServer();
    const { child, lines } = runBridge(url, 'tok');
    const call = { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'x' } };
    child.stdin.write(`${JSON.stringify(call)}\n`);
    await until(() => methods.includes('tools/call'));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } })}\n`,
    );
    await until(() => aborted.length === 1 && methods.includes('notifications/cancelled'));
    expect(aborted).toEqual(['call-1']);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await until(() => lines.length === 1);
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 2, result: { echo: 'tools/list' } }]);
  });

  it('stdin 关闭时中止进行中的请求并退出', async () => {
    const { url, methods, aborted } = await startServer();
    const { child, lines } = runBridge(url, 'tok');
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call' })}\n`);
    await until(() => methods.includes('tools/call'));
    child.stdin.end();
    expect(await exited).toBe(0);
    await until(() => aborted.length === 1);
    expect(aborted).toEqual([5]);
    expect(lines).toEqual([]);
  });
});
