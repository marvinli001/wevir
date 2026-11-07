import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionId } from '@wevir/protocol';
import { expect, it, vi } from 'vitest';
import { AppMcpServer } from './app-mcp.js';

it('keeps compact supply facts and stable tokens until session deletion', async () => {
  const onSupply = vi.fn();
  const mcp = new AppMcpServer({
    tools: [],
    version: 'test',
    instructions: (id) => `${id}${'x'.repeat(32_768)}`,
    onSupply,
  });
  const server = createServer((req, res) => mcp.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mcp.setPort((server.address() as AddressInfo).port);
  const call = async (token: string, method: string) =>
    fetch(mcp.url as string, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    });
  try {
    const first = mcp.grant('ses_first');
    if (!first) throw new Error('no endpoint');
    await (await call(first.token, 'initialize')).text();
    for (let i = 0; i < 40; i += 1) {
      const endpoint = mcp.grant(`ses_${i}` as SessionId);
      if (!endpoint) throw new Error('no endpoint');
      await (await call(endpoint.token, 'initialize')).text();
    }
    expect(mcp.grant('ses_first')).toEqual(first);
    await (await call(first.token, 'tools/list')).text();
    const instructions = `ses_first${'x'.repeat(32_768)}`;
    expect(onSupply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instructionBytes: Buffer.byteLength(instructions),
        instructionDigest: createHash('sha256').update(instructions).digest('hex'),
      }),
    );
    mcp.forget(['ses_first']);
    expect(mcp.sessionOf(first.token)).toBeUndefined();
    const rejected = await call(first.token, 'tools/list');
    expect(rejected.status).toBe(401);
    await rejected.text();
    expect(mcp.grant('ses_first')?.token).not.toBe(first.token);
  } finally {
    mcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
