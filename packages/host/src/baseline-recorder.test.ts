// 基线的转发代理：下游读到 `response.completed` 就断开时，已经收到的用量也要记下（不花额度，上游是本地服务）。

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Recorder, startForwardingRecorder } from './test-fixtures/baseline.js';

const completed = {
  type: 'response.completed',
  response: {
    id: 'resp_1',
    status: 'completed',
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 7 },
  },
};

/** 先发 `response.completed`，过 `endAfter` ms 才结束响应。 */
async function startUpstream(endAfter: number): Promise<Server> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created' })}\n\n`,
      );
      res.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
      const timer = setTimeout(() => res.end(), endAfter);
      res.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** 经代理发一个请求，读到 `response.completed` 就断开。 */
async function readUntilCompleted(proxy: Recorder): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(`${proxy.baseURL}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true }),
    signal: controller.signal,
  });
  if (response.body === null) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes('"response.completed"') && text.endsWith('\n\n')) controller.abort();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
}

describe('startForwardingRecorder', () => {
  let upstream: Server | undefined;
  let proxy: Recorder | undefined;

  afterEach(async () => {
    await proxy?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
    proxy = undefined;
  });

  for (const endAfter of [0, 500]) {
    it(`keeps the usage when the client leaves after response.completed (upstream ends after ${endAfter} ms)`, async () => {
      upstream = await startUpstream(endAfter);
      proxy = await startForwardingRecorder(
        `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      );
      await readUntilCompleted(proxy);
      await vi.waitFor(() => expect(proxy?.requests[0]?.usage).toBeDefined(), { timeout: 2000 });
      expect(proxy.requests[0]?.usage).toEqual({ input: 120, cachedInput: 100, output: 7 });
    });
  }
});
