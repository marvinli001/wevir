import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { probeRequest, testProvider } from './provider-test.js';
import { startMockChat } from './test-fixtures/mock-chat.js';
import { startMockMessages } from './test-fixtures/mock-messages.js';
import { startMockResponses } from './test-fixtures/mock-responses.js';
import { closedPort } from './test-fixtures/mock-server.js';
import type { Reply } from './test-fixtures/model-script.js';
import type { GatewayProvider } from './types.js';

const KEY = 'sk-probe-key';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const provider = (
  api: string,
  baseURL: string,
  patch: Partial<GatewayProvider> = {},
): GatewayProvider => ({
  id: 'p',
  kind: 'openai-compatible',
  displayName: 'P',
  api,
  baseURL,
  models: [{ id: 'm' }],
  defaultModelId: 'm',
  apiKey: KEY,
  ...patch,
});

async function chat(reply: Reply) {
  const mock = await startMockChat(() => reply);
  cleanups.push(() => mock.close());
  return mock;
}

async function messages(reply: Reply) {
  const mock = await startMockMessages(() => reply);
  cleanups.push(() => mock.close());
  return mock;
}

async function responses(reply: Reply) {
  const mock = await startMockResponses(() => reply);
  cleanups.push(() => mock.close());
  return mock;
}

/** 一个按给定状态、类型与正文回应的上游。 */
async function raw(status: number, contentType: string, body: string, hang = false) {
  const server = createServer((req, res) => {
    req.resume();
    if (hang) return;
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe('testProvider：与正式请求同一条路', () => {
  it('Chat 转换：探测请求按转换规则发出，收到第一条上游数据即成功', async () => {
    const mock = await chat({ text: ['pong'] });
    const result = await testProvider(provider('openai-completions', mock.baseURL), 'm');
    expect(result).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(mock.requests[0]?.body).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16,
    });
    expect(mock.requests[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it('Messages 转换：探测请求是 max_tokens 16 的一句 ping，Key 在 x-api-key', async () => {
    const mock = await messages({ text: ['pong'] });
    const result = await testProvider(provider('anthropic-messages', mock.baseURL), 'm');
    expect(result).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(mock.requests[0]?.path).toBe('/v1/messages');
    expect(mock.requests[0]?.body).toEqual({
      model: 'm',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }],
        },
      ],
      stream: true,
    });
    expect(mock.requests[0]?.apiKey).toBe(KEY);
    expect(mock.requests[0]?.authorization).toBeUndefined();
    expect(mock.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('Responses 透传：探测请求与 Codex 的请求同形', async () => {
    const mock = await responses({ text: ['pong'] });
    const result = await testProvider(provider('openai-responses', mock.baseURL), 'm');
    expect(result.ok).toBe(true);
    expect(mock.requests[0]?.body).toEqual(probeRequest('m'));
  });

  it('deepseek-official 走 DeepSeek 的 Responses 地址；网关实例的 testProvider 用同一个地址', async () => {
    const mock = await responses({ text: ['pong'] });
    const deepseek: GatewayProvider = {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-flash',
      apiKey: KEY,
    };
    const gw = await startModelGateway({ deepseekBaseURL: mock.baseURL.replace(/\/v1$/, '') });
    cleanups.push(() => gw.close());
    expect((await gw.testProvider(deepseek, 'deepseek-flash')).ok).toBe(true);
    expect(mock.requests[0]?.path).toBe('/responses');
  });
});

describe('testProvider：失败归类（providers.md §6.2）', () => {
  it('没有 Key → missing_key，不发请求', async () => {
    const mock = await chat({ text: ['x'] });
    const result = await testProvider(
      provider('openai-completions', mock.baseURL, { apiKey: undefined }),
      'm',
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_key',
      error: { category: 'missing_credentials' },
    });
    expect(mock.requests).toHaveLength(0);
  });

  it('配置不对 → unknown，不发请求', async () => {
    const result = await testProvider(provider('gemini', 'https://example.com'), 'm');
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
    expect(result.error?.message).toContain('不认识的协议 gemini');
  });

  const http: Array<[number, Reply['httpError'], string]> = [
    [401, { status: 401, message: `invalid key ${KEY}` }, 'auth'],
    [404, { status: 404, message: 'Model Not Exist' }, 'model_not_found'],
    [400, { status: 400, message: 'The model `m` does not exist' }, 'model_not_found'],
    [404, { status: 404, body: 'Not Found' }, 'protocol'],
    [422, { status: 422, message: 'unknown field' }, 'protocol'],
    [429, { status: 429, message: 'slow down' }, 'rate_limited'],
    [503, { status: 503, message: 'overloaded' }, 'server'],
  ];
  for (const [status, httpError, reason] of http) {
    it(`HTTP ${status}（${httpError?.message ?? httpError?.body}）→ ${reason}`, async () => {
      for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
        const mock =
          api === 'openai-completions'
            ? await chat({ httpError })
            : api === 'anthropic-messages'
              ? await messages({ httpError })
              : await responses({ httpError });
        const result = await testProvider(provider(api, mock.baseURL), 'm');
        expect(result).toMatchObject({ ok: false, reason, httpStatus: status });
        expect(result.error?.message).not.toContain(KEY);
      }
    });
  }

  it('200 但流里是错误：Chat 的 error chunk 与 Responses 的 response.failed 都按原文归类', async () => {
    const chatMock = await chat({
      failed: { code: 'model_not_found', message: 'model m not found' },
    });
    expect(await testProvider(provider('openai-completions', chatMock.baseURL), 'm')).toMatchObject(
      {
        ok: false,
        reason: 'model_not_found',
        httpStatus: 200,
      },
    );
    const respMock = await responses({
      failed: { code: 'invalid_api_key', message: 'Unauthorized' },
    });
    expect(await testProvider(provider('openai-responses', respMock.baseURL), 'm')).toMatchObject({
      ok: false,
      reason: 'auth',
    });
    const messagesMock = await messages({
      failed: { code: 'not_found_error', message: 'model: m not found' },
    });
    expect(
      await testProvider(provider('anthropic-messages', messagesMock.baseURL), 'm'),
    ).toMatchObject({ ok: false, reason: 'model_not_found', httpStatus: 200 });
  });

  it('连不上 → network；超时 → timeout', async () => {
    const refused = await testProvider(
      provider('openai-completions', `http://127.0.0.1:${await closedPort()}/v1`),
      'm',
    );
    expect(refused).toMatchObject({ ok: false, reason: 'network' });
    expect(refused.error?.message).toContain('ECONNREFUSED');
    const hanging = await raw(200, 'text/event-stream', '', true);
    expect(
      await testProvider(provider('openai-completions', hanging), 'm', { timeoutMs: 200 }),
    ).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });

  it('200 但是网页，或不是所选协议的流 → protocol', async () => {
    const html = await raw(200, 'text/html', '<html>login</html>');
    expect(await testProvider(provider('openai-responses', html), 'm')).toMatchObject({
      ok: false,
      reason: 'protocol',
    });
    const wrong = await raw(200, 'text/event-stream', 'data: {"choices":[]}\n\n');
    for (const api of ['openai-responses', 'anthropic-messages']) {
      const result = await testProvider(provider(api, wrong), 'm');
      expect(result).toMatchObject({ ok: false, reason: 'protocol' });
      expect(result.error?.message).toContain('不是所选协议');
    }
  });
});
