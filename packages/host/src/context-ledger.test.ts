import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { AppMcpServer, type AppMcpServerOptions } from './app-mcp.js';
import { useTempDir } from './test-utils.js';
import { ToolOutputStore } from './tool-output.js';

describe('tool ledger observations', () => {
  const dir = useTempDir();
  it('measures the filtered list and raw/returned UTF-8 bytes across a spill', async () => {
    const supplied: Parameters<NonNullable<AppMcpServerOptions['onSupply']>>[0][] = [];
    const calls: Parameters<NonNullable<AppMcpServerOptions['onCall']>>[0][] = [];
    const output = new ToolOutputStore(dir());
    const raw = {
      content: [{ type: 'text' as const, text: '账本\n'.repeat(4_000) }],
      isError: true,
    };
    const tool = {
      name: 'visible',
      title: 'Visible',
      description: 'Visible',
      inputSchema: {},
      annotations: {},
      call: async () => raw,
    };
    const mcp = new AppMcpServer({
      tools: [tool, { ...tool, name: 'hidden' }],
      version: '0',
      instructions: '记忆',
      filterTools: (_, tools) => tools.filter((item) => item.name === 'visible'),
      onSupply: (value) => supplied.push(value),
      onCall: (value) => calls.push(value),
      turnOf: () => 'trn_1',
      spill: (session, name, result) => output.spill(session, name, result),
    });
    const server = createServer((req, res) => {
      mcp.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mcp.setPort((server.address() as AddressInfo).port);
    const grant = mcp.grant('ses_1' as SessionId);
    const rpc = async (method: string, params = {}) =>
      (
        await fetch(grant?.url as string, {
          method: 'POST',
          headers: { authorization: `Bearer ${grant?.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json() as Promise<{ result: unknown }>;
    try {
      await rpc('initialize');
      const list = await rpc('tools/list');
      expect(supplied[0]).toMatchObject({
        sessionId: 'ses_1',
        server: 'wevir',
        instructions: '记忆',
        tools: [{ name: 'visible' }],
      });
      expect(supplied[0]?.tools).toEqual((list.result as { tools: unknown[] }).tools);
      const returned = await rpc('tools/call', { name: 'visible' });
      expect(calls).toEqual([
        {
          sessionId: 'ses_1',
          turnId: 'trn_1',
          server: 'wevir',
          tool: 'visible',
          rawBytes: Buffer.byteLength(JSON.stringify(raw)),
          returnedBytes: Buffer.byteLength(JSON.stringify(returned.result)),
          spilled: true,
          isError: true,
        },
      ]);
      expect(calls[0]?.returnedBytes).toBeLessThan(calls[0]?.rawBytes ?? 0);
    } finally {
      mcp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
