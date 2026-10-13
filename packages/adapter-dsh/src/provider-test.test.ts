// provider.test 的单元测试：Provider 换成本地脚本化的 HTTP 服务，覆盖成功与各类失败的归类。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderConfig } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { deepseekMessagesUrl, testProvider } from './provider-test.js';

const KEY = 'sk-wevir-probe-0123456789';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function serve(
  handler: (seen: Seen, res: ServerResponse) => void,
): Promise<{ baseURL: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: body === '' ? {} : (JSON.parse(body) as Record<string, unknown>),
      };
      seen.push(record);
      handler(record, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

function sse(res: ServerResponse, ...events: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  // 不结束：探测收到第一条数据就该断开。
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const compatible = (baseURL: string, patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'gateway',
  kind: 'openai-compatible',
  displayName: 'Gateway',
  api: 'openai-completions',
  baseURL,
  models: [{ id: 'm1' }],
  defaultModelId: 'm1',
  apiKey: KEY,
  ...patch,
});

const chunk = { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'p' } }] };

describe('testProvider：openai-completions', () => {
  it('成功：流式的最小请求，Bearer Key，非 OpenAI 地址用 max_tokens', async () => {
    const { baseURL, seen } = await serve((_, res) => sse(res, chunk));
    const result = await testProvider(compatible(baseURL), 'm1');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen[0]?.url).toBe('/v1/chat/completions');
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body).toEqual({
      model: 'm1',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      max_tokens: 1,
    });
  });

  it('compat 指定 max_completion_tokens 时照用；baseURL 末尾的斜线不影响路径', async () => {
    const { baseURL, seen } = await serve((_, res) => sse(res, chunk));
    const provider = compatible(`${baseURL}/`, {
      compat: { maxTokensField: 'max_completion_tokens' },
    });
    expect((await testProvider(provider, 'm1')).ok).toBe(true);
    expect(seen[0]?.url).toBe('/v1/chat/completions');
    expect(seen[0]?.body.max_completion_tokens).toBe(1);
  });

  it('服务端无视 stream、回整个 JSON 也算成功', async () => {
    const { baseURL } = await serve((_, res) =>
      json(res, 200, { object: 'chat.completion', choices: [{ index: 0, message: {} }] }),
    );
    expect((await testProvider(compatible(baseURL), 'm1')).ok).toBe(true);
  });

  it('401 → auth，消息里有服务端原文、没有 Key', async () => {
    const { baseURL } = await serve((_, res) =>
      json(res, 401, {
        error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error' },
      }),
    );
    const result = await testProvider(compatible(baseURL), 'm1');
    expect(result).toMatchObject({
      ok: false,
      reason: 'auth',
      httpStatus: 401,
      error: { category: 'provider' },
    });
    expect(result.error?.message).toContain('HTTP 401');
    expect(result.error?.message).toContain('Incorrect API key provided');
    expect(result.error?.message).not.toContain(KEY);
  });

  it('模型不存在：404 / 400 的原文提到模型 → model_not_found', async () => {
    const { baseURL } = await serve((seen, res) =>
      seen.body.model === 'gone'
        ? json(res, 404, {
            error: { message: 'The model `gone` does not exist', code: 'model_not_found' },
          })
        : json(res, 400, { error: { message: 'Model Not Exist' } }),
    );
    const gone = await testProvider(compatible(baseURL), 'gone');
    expect(gone).toMatchObject({ ok: false, reason: 'model_not_found', httpStatus: 404 });
    expect(gone.error?.message).toContain('gone');
    expect(await testProvider(compatible(baseURL), 'm1')).toMatchObject({
      reason: 'model_not_found',
      httpStatus: 400,
    });
  });

  it('路径不存在（404 且与模型无关）→ protocol', async () => {
    const { baseURL } = await serve((_, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 page not found');
    });
    const result = await testProvider(compatible(baseURL), 'm1');
    expect(result).toMatchObject({ ok: false, reason: 'protocol', httpStatus: 404 });
    expect(result.error?.message).toContain('/v1/chat/completions');
  });

  it('200 但返回网页 → protocol（baseURL 可能少了路径）', async () => {
    const { baseURL } = await serve((_, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>console</body></html>\n');
    });
    const result = await testProvider(compatible(baseURL), 'm1');
    expect(result).toMatchObject({ ok: false, reason: 'protocol', httpStatus: 200 });
    expect(result.error?.message).toMatch(/网页/);
  });

  it('200 但流里不是 chat.completion.chunk → protocol', async () => {
    const { baseURL } = await serve((_, res) => sse(res, { type: 'response.created' }));
    expect(await testProvider(compatible(baseURL), 'm1')).toMatchObject({
      ok: false,
      reason: 'protocol',
    });
  });

  it('200 但流里是 error → 按原文归类', async () => {
    const { baseURL } = await serve((_, res) =>
      sse(res, { error: { message: 'model not found: m1' } }),
    );
    expect(await testProvider(compatible(baseURL), 'm1')).toMatchObject({
      ok: false,
      reason: 'model_not_found',
    });
  });

  it('429 → rate_limited，5xx → server', async () => {
    const { baseURL } = await serve((seen, res) =>
      seen.body.model === 'busy'
        ? json(res, 429, { error: { message: 'insufficient_quota' } })
        : json(res, 502, { error: { message: 'bad gateway' } }),
    );
    expect(await testProvider(compatible(baseURL), 'busy')).toMatchObject({
      reason: 'rate_limited',
      httpStatus: 429,
    });
    expect(await testProvider(compatible(baseURL), 'm1')).toMatchObject({
      reason: 'server',
      httpStatus: 502,
    });
  });

  it('连接被拒绝 → network', async () => {
    const { baseURL } = await serve(() => {});
    await servers.pop()?.();
    const result = await testProvider(compatible(baseURL), 'm1');
    expect(result).toMatchObject({ ok: false, reason: 'network', error: { category: 'provider' } });
    expect(result.error?.message).toContain('ECONNREFUSED');
    expect(result.httpStatus).toBeUndefined();
  });

  it('找不到主机 → network', async () => {
    const result = await testProvider(compatible('http://wevir-no-such-host.invalid/v1'), 'm1');
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('时限内没有响应 → timeout', async () => {
    const { baseURL } = await serve(() => {});
    const result = await testProvider(compatible(baseURL), 'm1', { timeoutMs: 200 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('没有 Key 时不发请求 → missing_key / missing_credentials', async () => {
    const { baseURL, seen } = await serve((_, res) => sse(res, chunk));
    const result = await testProvider(compatible(baseURL, { apiKey: undefined }), 'm1');
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_key',
      error: { category: 'missing_credentials' },
    });
    expect(seen).toHaveLength(0);
  });
});

describe('testProvider：其他协议', () => {
  it('openai-responses：/responses，流里是 response.* 事件', async () => {
    const { baseURL, seen } = await serve((_, res) => sse(res, { type: 'response.created' }));
    const result = await testProvider(compatible(baseURL, { api: 'openai-responses' }), 'm1');
    expect(result.ok).toBe(true);
    expect(seen[0]?.url).toBe('/v1/responses');
    expect(seen[0]?.body).toMatchObject({ model: 'm1', stream: true, max_output_tokens: 16 });
  });

  it('deepseek-official：Anthropic Messages，x-api-key，关掉思考', async () => {
    const { baseURL, seen } = await serve((_, res) =>
      sse(res, { type: 'message_start', message: { id: 'msg_1' } }),
    );
    const result = await testProvider(
      {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        baseURL: baseURL.replace(/\/v1$/, '/anthropic'),
        models: [],
        defaultModelId: 'deepseek-flash',
        apiKey: KEY,
      },
      'deepseek-flash',
    );
    expect(result.ok).toBe(true);
    expect(seen[0]?.url).toBe('/anthropic/v1/messages');
    expect(seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.body).toMatchObject({
      model: 'deepseek-flash',
      max_tokens: 1,
      stream: true,
      thinking: { type: 'disabled' },
    });
  });

  it('Messages 地址的拼法与 llm-deepseek 一致', () => {
    expect(deepseekMessagesUrl('https://api.deepseek.com/anthropic')).toBe(
      'https://api.deepseek.com/anthropic/v1/messages',
    );
    expect(deepseekMessagesUrl('https://gw.example/v1/')).toBe('https://gw.example/v1/messages');
  });

  it('配置不合法（anthropic-messages 只预留）时不发请求', async () => {
    const { baseURL, seen } = await serve((_, res) => sse(res, chunk));
    const result = await testProvider(compatible(baseURL, { api: 'anthropic-messages' }), 'm1');
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
    expect(seen).toHaveLength(0);
  });
});
