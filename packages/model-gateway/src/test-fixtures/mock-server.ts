// 两个 mock 上游共用的 HTTP 外壳：记录每个请求（头部的 Key 只记方案与长度）、中断与否。
// 改写自 spikes/codex-app-server/src/mock-responses.ts 的 startMockResponses / redactHeaders。

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest<B> {
  path: string;
  headers: Record<string, string>;
  /** 上游收到的 Authorization 原值（测试核对 Key 换成了上游的）。 */
  authorization: string | undefined;
  body: B;
  /** 响应没写完连接就断了（网关中断了上游）。 */
  aborted: boolean;
}

export interface MockServer<B> {
  /** 到 `/v1` 为止。 */
  baseURL: string;
  requests: RecordedRequest<B>[];
  /** 等到第 `index` 个请求被中断。 */
  waitAborted(index: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function redactHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const v = Array.isArray(value) ? value.join(', ') : (value ?? '');
    out[name] = /authorization|api-key|cookie/i.test(name)
      ? `<${v.split(' ')[0] ?? ''} …${v.length} chars>`
      : v;
  }
  return out;
}

export async function startMockServer<B>(
  path: string,
  respond: (body: B, record: RecordedRequest<B>, res: ServerResponse) => Promise<void>,
): Promise<MockServer<B>> {
  const requests: RecordedRequest<B>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith(path)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock: 不支持 ${req.method} ${req.url}` } }));
        return;
      }
      const record: RecordedRequest<B> = {
        path: req.url,
        headers: redactHeaders(req.headers),
        authorization: req.headers.authorization,
        body: JSON.parse(raw) as B,
        aborted: false,
      };
      requests.push(record);
      res.on('close', () => {
        if (!res.writableFinished) record.aborted = true;
      });
      respond(record.body, record, res).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    async waitAborted(index, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (requests[index]?.aborted !== true) {
        if (Date.now() > deadline) throw new Error(`mock：第 ${index} 个请求没有被中断`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendHttpError(
  res: ServerResponse,
  error: { status: number; message?: string; code?: string; body?: string },
): void {
  res.writeHead(error.status, { 'content-type': 'application/json' });
  res.end(
    error.body ??
      JSON.stringify({
        error: {
          message: error.message ?? 'mock error',
          type: 'invalid_request_error',
          ...(error.code === undefined ? {} : { code: error.code }),
        },
      }),
  );
}

/** 已写的数据发出去之后再断开连接（直接 destroy 会连响应头都没发出去）。 */
export async function disconnect(res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => res.write('', () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 20));
  res.destroy();
}

/** 一个刚刚空出来、没有人监听的本机端口（连接会被拒绝）。 */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
