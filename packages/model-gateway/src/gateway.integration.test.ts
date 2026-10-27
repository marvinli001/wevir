import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPRESS_MIN_BYTES, type GatewayLogger, startModelGateway } from './gateway.js';
import {
  CODEX_METADATA_HEADERS,
  codexProblems,
  codexRequest,
  doneItems,
  parseEvents,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { startMockChat } from './test-fixtures/mock-chat.js';
import { signature, startMockMessages } from './test-fixtures/mock-messages.js';
import { startMockResponses } from './test-fixtures/mock-responses.js';
import { closedPort, type MockServer } from './test-fixtures/mock-server.js';
import type { Script } from './test-fixtures/model-script.js';
import type {
  ChatRequest,
  GatewayProvider,
  MessagesRequest,
  ResponsesItem,
  ResponsesRequest,
} from './types.js';
import { GATEWAY_VERSION } from './upstream.js';

const UPSTREAM_KEY = 'sk-upstream-key-for-tests';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface LogLine {
  level: 'info' | 'warn';
  msg: string;
  fields?: Record<string, unknown>;
}

async function gateway(options: { deepseekBaseURL?: string } = {}) {
  const lines: LogLine[] = [];
  const logger: GatewayLogger = {
    info: (msg, fields) => lines.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => lines.push({ level: 'warn', msg, fields }),
  };
  const gw = await startModelGateway({ logger, ...options });
  cleanups.push(() => gw.close());
  return { gw, lines };
}

async function responsesUpstream(script: Script): Promise<MockServer<ResponsesRequest>> {
  const mock = await startMockResponses(script);
  cleanups.push(() => mock.close());
  return mock;
}

async function chatUpstream(script: Script): Promise<MockServer<ChatRequest>> {
  const mock = await startMockChat(script);
  cleanups.push(() => mock.close());
  return mock;
}

async function messagesUpstream(script: Script): Promise<MockServer<MessagesRequest>> {
  const mock = await startMockMessages(script);
  cleanups.push(() => mock.close());
  return mock;
}

const responsesProvider = (
  baseURL: string,
  patch: Partial<GatewayProvider> = {},
): GatewayProvider => ({
  id: 'resp',
  kind: 'openai-compatible',
  displayName: 'Responses',
  api: 'openai-responses',
  baseURL,
  models: [{ id: 'wevir-mock' }],
  defaultModelId: 'wevir-mock',
  apiKey: UPSTREAM_KEY,
  ...patch,
});

const chatProvider = (baseURL: string, patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  ...responsesProvider(baseURL),
  id: 'chat',
  api: 'openai-completions',
  ...patch,
});

/** mock 的 baseURL 到 `/v1` 为止；Anthropic 风格的 baseURL 不带 `/v1`，网关自己加。 */
const messagesProvider = (
  baseURL: string,
  patch: Partial<GatewayProvider> = {},
): GatewayProvider => ({
  ...responsesProvider(baseURL.replace(/\/v1$/, '')),
  id: 'claude',
  api: 'anthropic-messages',
  ...patch,
});

/** 等到某个条件成立（日志在响应结束之后才写）。 */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const requestLogs = (lines: LogLine[]) => lines.filter((l) => l.msg === 'gateway request');

describe('令牌与路由', () => {
  it('令牌错误或缺失 → 401，不碰上游；令牌对 → 正常', async () => {
    const mock = await responsesUpstream(() => ({ text: ['好'] }));
    const { gw, lines } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL)]);
    const body = codexRequest('1-first-turn').body;
    for (const token of ['wrong', '', `${gw.token}x`]) {
      const res = await postResponses(gw.baseURL('resp'), token, body);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { message: 'wevir gateway: 令牌不对', code: 'invalid_api_key' },
      });
    }
    const missing = await fetch(`${gw.baseURL('resp')}/responses`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    expect(mock.requests).toHaveLength(0);
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(4);
    const ok = await postResponses(gw.baseURL('resp'), gw.token, body);
    expect(ok.status).toBe(200);
    expect(codexProblems(await readEvents(ok))).toEqual([]);
    expect(gw.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('两个网关实例的令牌不同', async () => {
    const a = await gateway();
    const b = await gateway();
    expect(a.gw.token).not.toBe(b.gw.token);
  });

  it('不认识的路径 404、非 POST 405、没有的 Provider 404、配置不对 400、没有 Key 401、坏 JSON 400', async () => {
    const { gw } = await gateway();
    gw.setProviders([
      chatProvider('http://127.0.0.1:9/v1', { id: 'gemini', api: 'gemini-native' }),
      chatProvider('http://127.0.0.1:9/v1', { id: 'nokey', apiKey: undefined }),
      chatProvider('http://127.0.0.1:9/v1'),
    ]);
    const auth = { authorization: `Bearer ${gw.token}` };
    const root = gw.baseURL('chat').replace(/\/v1\/p\/chat$/, '');
    expect((await fetch(`${root}/v1/responses`, { method: 'POST', headers: auth })).status).toBe(
      404,
    );
    expect((await fetch(`${gw.baseURL('chat')}/responses`, { headers: auth })).status).toBe(405);
    const body = { model: 'm', input: 'hi' };
    expect((await postResponses(gw.baseURL('nope'), gw.token, body)).status).toBe(404);
    const unsupported = await postResponses(gw.baseURL('gemini'), gw.token, body);
    expect(unsupported.status).toBe(400);
    expect(((await unsupported.json()) as { error: { message: string } }).error.message).toContain(
      '不认识的协议 gemini-native',
    );
    expect((await postResponses(gw.baseURL('nokey'), gw.token, body)).status).toBe(401);
    expect((await postResponses(gw.baseURL('chat'), gw.token, '{oops')).status).toBe(400);
    expect((await postResponses(gw.baseURL('chat'), gw.token, { input: 'no model' })).status).toBe(
      400,
    );
  });

  it('baseURL 里的 Provider ID 编码后可以还原', async () => {
    const { gw } = await gateway();
    expect(gw.baseURL('deepseek-official')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1\/p\/deepseek-official$/,
    );
  });
});

describe('Responses 透传', () => {
  it('请求体只去掉 client_metadata；请求头只有网关自己的；Key 换成上游的；响应流原样转回', async () => {
    const mock = await responsesUpstream(() => ({ reasoning: ['想'], text: ['你', '好'] }));
    const { gw } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL)]);
    const body = codexRequest('1-first-turn').body;
    const res = await postResponses(gw.baseURL('resp'), gw.token, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events = await readEvents(res);
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events).map((i) => i.type)).toEqual(['reasoning', 'message']);

    const upstream = mock.requests[0];
    const { client_metadata: _drop, ...rest } = body;
    expect(upstream?.body).toEqual(rest);
    expect(upstream?.path).toBe('/v1/responses');
    // 网关自己设的四个头，加上 fetch（undici）与 HTTP 本身的头；Codex 的一个都不在。
    const allowed = new Set([
      ...['accept', 'authorization', 'content-type', 'user-agent'],
      ...[
        'accept-encoding',
        'accept-language',
        'sec-fetch-mode',
        'connection',
        'content-length',
        'host',
      ],
    ]);
    expect(Object.keys(upstream?.headers ?? {}).filter((h) => !allowed.has(h))).toEqual([]);
    for (const name of Object.keys(CODEX_METADATA_HEADERS).filter((h) => h !== 'user-agent')) {
      expect(upstream?.headers).not.toHaveProperty(name);
    }
    expect(upstream?.headers['user-agent']).toBe(`wevir-gateway/${GATEWAY_VERSION}`);
    expect(upstream?.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(JSON.stringify(upstream?.body)).not.toContain(gw.token);
  });

  it('deepseek-official 透传到 DeepSeek 的 Responses 地址', async () => {
    const mock = await responsesUpstream(() => ({ text: ['ok'] }));
    const { gw } = await gateway({ deepseekBaseURL: mock.baseURL.replace(/\/v1$/, '') });
    gw.setProviders([
      {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        models: [],
        defaultModelId: 'deepseek-flash',
        apiKey: UPSTREAM_KEY,
      },
    ]);
    const res = await postResponses(
      gw.baseURL('deepseek-official'),
      gw.token,
      codexRequest('2-tool-results').body,
    );
    expect(codexProblems(await readEvents(res))).toEqual([]);
    expect(mock.requests[0]?.path).toBe('/responses');
    expect(mock.requests[0]?.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
  });

  it('方言修正：压缩请求的 tool_choice 去掉', async () => {
    const mock = await responsesUpstream(() => ({ text: ['摘要'] }));
    const { gw } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL)]);
    await (
      await postResponses(gw.baseURL('resp'), gw.token, codexRequest('4-compact').body)
    ).text();
    expect(mock.requests[0]?.body.tools).toEqual([]);
    expect(mock.requests[0]?.body).not.toHaveProperty('tool_choice');
  });

  it('方言修正：不支持自定义工具的上游看到函数，Codex 收到 custom_tool_call', async () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch';
    const mock = await responsesUpstream(() => ({
      toolCalls: [
        { kind: 'custom', name: 'apply_patch', input: patch },
        {
          kind: 'function',
          name: 'spawn_agent',
          namespace: 'multi_agent_v1',
          args: { message: 'hi' },
        },
      ],
    }));
    const { gw } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL, { compat: { supportsCustomTools: false } })]);
    const res = await postResponses(
      gw.baseURL('resp'),
      gw.token,
      codexRequest('2-tool-results').body,
    );
    const events = await readEvents(res);
    expect(codexProblems(events)).toEqual([]);
    const upstream = mock.requests[0]?.body;
    expect(upstream?.tools?.find((t) => t.name === 'apply_patch')?.type).toBe('function');
    expect(
      (upstream?.input as ResponsesItem[] | undefined)?.some((i) => i.type === 'custom_tool_call'),
    ).toBe(false);
    expect(doneItems(events)).toEqual([
      expect.objectContaining({ type: 'custom_tool_call', name: 'apply_patch', input: patch }),
      expect.objectContaining({
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
      }),
    ]);
    const added = events.filter((e) => e.type === 'response.output_item.added').map((e) => e.item);
    expect(added[0]).toMatchObject({ type: 'custom_tool_call' });
  });

  it('gzip 压缩的请求体', async () => {
    const mock = await responsesUpstream(() => ({ text: ['ok'] }));
    const { gw } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL)]);
    const body = codexRequest('1-first-turn').body;
    const res = await fetch(`${gw.baseURL('resp')}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.token}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: gzipSync(JSON.stringify(body)),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(mock.requests[0]?.body.model).toBe(body.model);
    const bad = await fetch(`${gw.baseURL('resp')}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.token}`, 'content-encoding': 'compress' },
      body: '{}',
    });
    expect(bad.status).toBe(415);
  });
});

describe('请求体压缩（compat.requestCompression）', () => {
  /** 超过 COMPRESS_MIN_BYTES 的请求：在最后一条用户输入后面补一大段文本。 */
  function largeRequest(): ResponsesRequest {
    const body = codexRequest('1-first-turn').body;
    return {
      ...body,
      input: [
        ...(body.input as ResponsesItem[]),
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'x'.repeat(COMPRESS_MIN_BYTES) }],
        },
      ],
    };
  }

  it('没开：不压缩；开了：大请求带 Content-Encoding: gzip，小请求不压缩，上游收到的请求体相同', async () => {
    const mock = await responsesUpstream(() => ({ text: ['ok'] }));
    const { gw, lines } = await gateway();
    gw.setProviders([
      responsesProvider(mock.baseURL),
      responsesProvider(mock.baseURL, { id: 'gz', compat: { requestCompression: 'gzip' } }),
    ]);
    const large = largeRequest();
    for (const [id, body] of [
      ['resp', large],
      ['gz', large],
      ['gz', codexRequest('1-first-turn').body],
    ] as const) {
      const res = await postResponses(gw.baseURL(id), gw.token, body);
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(mock.requests.map((r) => r.headers['content-encoding'])).toEqual([
      undefined,
      'gzip',
      undefined,
    ]);
    expect(mock.requests[1]?.body).toEqual(mock.requests[0]?.body);
    await until(() => requestLogs(lines).length === 3);
    expect(requestLogs(lines).map((l) => l.fields?.encoding)).toEqual([
      undefined,
      'gzip',
      undefined,
    ]);
  });

  it('上游拒绝压缩（415）：不压缩重发一次，之后这个 Provider 不再压缩', async () => {
    const mock = await responsesUpstream((view) =>
      view.index === 0 ? { httpError: { status: 415 } } : { text: ['ok'] },
    );
    const { gw, lines } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL, { compat: { requestCompression: 'gzip' } })]);
    for (let i = 0; i < 2; i++) {
      const res = await postResponses(gw.baseURL('resp'), gw.token, largeRequest());
      expect(res.status).toBe(200);
      expect(codexProblems(await readEvents(res))).toEqual([]);
    }
    expect(mock.requests.map((r) => r.headers['content-encoding'])).toEqual([
      'gzip',
      undefined,
      undefined,
    ]);
    await until(() => requestLogs(lines).length === 2);
    expect(requestLogs(lines)[0]?.fields).toMatchObject({
      outcome: 'completed',
      encoding: 'identity',
      gzipRejected: 415,
    });
  });

  it('压缩与不压缩都是 400：错误原样转回，不记成不收压缩；收过压缩之后的 400 不重发', async () => {
    const mock = await responsesUpstream((view) =>
      view.index < 2 || view.index === 3
        ? { httpError: { status: 400, message: 'bad request' } }
        : { text: ['ok'] },
    );
    const { gw } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL, { compat: { requestCompression: 'gzip' } })]);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await postResponses(gw.baseURL('resp'), gw.token, largeRequest());
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses).toEqual([400, 200, 400]);
    // 第一次：压缩 400、不压缩 400；第二次仍压缩且成功；第三次压缩 400，已知收压缩，不重发。
    expect(mock.requests.map((r) => r.headers['content-encoding'])).toEqual([
      'gzip',
      undefined,
      'gzip',
      'gzip',
    ]);
  });
});

describe('Chat 转换', () => {
  it('录制的请求转换后到达上游；推理、文本与 usage 映射回 Responses', async () => {
    const mock = await chatUpstream(() => ({ reasoning: ['先', '想'], text: ['已', '完成'] }));
    const { gw } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const res = await postResponses(
      gw.baseURL('chat'),
      gw.token,
      codexRequest('2-tool-results').body,
    );
    const events = await readEvents(res);
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events)).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: '先想' }],
      }),
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'output_text', text: '已完成' }],
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 64 },
          total_tokens: 120,
        },
      },
    });
    const upstream = mock.requests[0];
    expect(upstream?.path).toBe('/v1/chat/completions');
    expect(upstream?.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(upstream?.body.messages.map((m) => m.role)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(upstream?.body.messages[4]?.reasoning_content).toBe('先建文件，再看目录。');
    for (const name of Object.keys(CODEX_METADATA_HEADERS).filter((h) => h !== 'user-agent')) {
      expect(upstream?.headers).not.toHaveProperty(name);
    }
  });

  it('apply_patch 与 namespace 工具往返：上游回摊平的函数，Codex 收到 custom_tool_call 与带 namespace 的 function_call', async () => {
    const patch = '*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch';
    const mock = await chatUpstream(() => ({
      reasoning: ['要改文件'],
      toolCalls: [
        { kind: 'custom', name: 'apply_patch', input: patch },
        {
          kind: 'function',
          name: 'wait_agent',
          namespace: 'multi_agent_v1',
          args: { targets: ['x'] },
        },
      ],
    }));
    const { gw } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const events = await readEvents(
      await postResponses(gw.baseURL('chat'), gw.token, codexRequest('1-first-turn').body),
    );
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events).slice(1)).toEqual([
      { type: 'custom_tool_call', call_id: expect.any(String), name: 'apply_patch', input: patch },
      {
        type: 'function_call',
        call_id: expect.any(String),
        name: 'wait_agent',
        namespace: 'multi_agent_v1',
        arguments: '{"targets":["x"]}',
      },
    ]);
  });

  it('并行调用的分片交错到达', async () => {
    const piece = (index: number, args: string, id?: string) => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              id === undefined
                ? { index, function: { arguments: args } }
                : {
                    index,
                    id,
                    type: 'function',
                    function: { name: 'exec_command', arguments: args },
                  },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    const mock = await chatUpstream(() => ({
      rawChunks: [
        piece(0, '{"cmd":', 'a'),
        piece(1, '{"cmd":', 'b'),
        piece(1, '"ls"}'),
        piece(0, '"pwd"}'),
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ],
    }));
    const { gw } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const events = await readEvents(
      await postResponses(gw.baseURL('chat'), gw.token, codexRequest('1-first-turn').body),
    );
    expect(doneItems(events).map((i) => [i.call_id, i.arguments])).toEqual([
      ['a', '{"cmd":"pwd"}'],
      ['b', '{"cmd":"ls"}'],
    ]);
  });

  it('finish_reason=length → response.incomplete；流里的错误与提前断开 → response.failed（带原文）', async () => {
    const replies = [
      { text: ['截'], finishReason: 'length' },
      { text: ['半'], failed: { code: 'server_error', message: 'upstream exploded: 原文' } },
      { text: ['断'], disconnect: true },
    ];
    let i = 0;
    const mock = await chatUpstream(() => replies[i++] ?? {});
    const { gw } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const body = codexRequest('1-first-turn').body;
    const length = await readEvents(await postResponses(gw.baseURL('chat'), gw.token, body));
    expect(codexProblems(length)).toEqual([]);
    expect(length.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    });
    const failed = await readEvents(await postResponses(gw.baseURL('chat'), gw.token, body));
    expect(failed.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'server_error', message: 'upstream exploded: 原文' } },
    });
    const cut = await readEvents(await postResponses(gw.baseURL('chat'), gw.token, body));
    expect(codexProblems(cut)).toEqual([]);
    expect(cut.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { message: expect.any(String) } },
    });
  });
});

describe('Messages 转换', () => {
  it('录制的请求转换后到达上游（x-api-key、anthropic-version，不带 Codex 的头）；思考、文本与 usage 映射回 Responses', async () => {
    const mock = await messagesUpstream(() => ({ reasoning: ['先', '想'], text: ['已', '完成'] }));
    const { gw } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    const res = await postResponses(
      gw.baseURL('claude'),
      gw.token,
      codexRequest('2-tool-results').body,
    );
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(codexProblems(events)).toEqual([]);
    expect(doneItems(events)).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: '先想' }],
        encrypted_content: expect.stringMatching(/^wevir-gw:anthropic:v1:/),
      }),
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'output_text', text: '已完成' }],
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 64, cache_write_tokens: 6 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 7 },
          total_tokens: 120,
        },
      },
    });
    const upstream = mock.requests[0];
    expect(upstream?.path).toBe('/v1/messages');
    expect(upstream?.apiKey).toBe(UPSTREAM_KEY);
    expect(upstream?.authorization).toBeUndefined();
    expect(upstream?.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream?.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    for (const name of Object.keys(CODEX_METADATA_HEADERS).filter((h) => h !== 'user-agent')) {
      expect(upstream?.headers).not.toHaveProperty(name);
    }
  });

  it('工具调用与跨回合思考：思考块连同签名原样带回（同一回合的工具结果之后、下一回合），上游按 Anthropic 的规则都接受', async () => {
    const patch = '*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch';
    const replies = [
      {
        reasoning: ['要改', '文件'],
        toolCalls: [
          { kind: 'custom' as const, name: 'apply_patch', input: patch },
          {
            kind: 'function' as const,
            name: 'wait_agent',
            namespace: 'multi_agent_v1',
            args: { targets: ['x'] },
          },
        ],
      },
      { reasoning: ['改好了'], text: ['完成'] },
      { reasoning: ['记得'], text: ['上一轮改了 b.txt'] },
    ];
    let i = 0;
    const mock = await messagesUpstream(() => replies[i++] ?? {});
    const { gw } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    const first = codexRequest('1-first-turn').body;
    const turn = async (body: ResponsesRequest) => {
      const res = await postResponses(gw.baseURL('claude'), gw.token, body);
      expect(res.status).toBe(200);
      const events = await readEvents(res);
      expect(codexProblems(events)).toEqual([]);
      expect(events.at(-1)?.type).toBe('response.completed');
      return doneItems(events) as ResponsesItem[];
    };

    // 第一步：模型想了想，调了 apply_patch 与子 agent 的 wait_agent。
    const calls = await turn(first);
    expect(calls.slice(1)).toEqual([
      { type: 'custom_tool_call', call_id: expect.any(String), name: 'apply_patch', input: patch },
      {
        type: 'function_call',
        call_id: expect.any(String),
        name: 'wait_agent',
        namespace: 'multi_agent_v1',
        arguments: '{"targets":["x"]}',
      },
    ]);
    // 第二步：Codex 把输出项原样放回 input，加上两个工具的结果。
    const second: ResponsesRequest = {
      ...first,
      input: [
        ...(first.input as ResponsesItem[]),
        ...calls,
        { type: 'custom_tool_call_output', call_id: calls[1]?.call_id, output: 'Success.' },
        { type: 'function_call_output', call_id: calls[2]?.call_id, output: '{"done":true}' },
      ],
    };
    const answer = await turn(second);
    // 第三步：下一回合。
    const third: ResponsesRequest = {
      ...first,
      input: [
        ...(second.input as ResponsesItem[]),
        ...answer,
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '上一轮做了什么？' }],
        },
      ],
    };
    const recall = await turn(third);
    expect(recall.at(-1)).toMatchObject({
      content: [{ type: 'output_text', text: '上一轮改了 b.txt' }],
    });

    expect(mock.requests.map((r) => r.body.messages.map((m) => m.role))).toEqual([
      ['user'],
      ['user', 'assistant', 'user'],
      ['user', 'assistant', 'user', 'assistant', 'user'],
    ]);
    const thinking = (text: string) => ({
      type: 'thinking',
      thinking: text,
      signature: signature(text),
    });
    expect(mock.requests[1]?.body.messages[1]?.content.map((b) => b.type)).toEqual([
      'thinking',
      'tool_use',
      'tool_use',
    ]);
    expect(mock.requests[1]?.body.messages[1]?.content[0]).toEqual(thinking('要改文件'));
    expect(mock.requests[1]?.body.messages[2]?.content.map((b) => b.type)).toEqual([
      'tool_result',
      'tool_result',
    ]);
    const history = mock.requests[2]?.body.messages ?? [];
    expect(history[1]?.content[0]).toEqual(thinking('要改文件'));
    expect(history[3]?.content).toEqual([thinking('改好了'), { type: 'text', text: '完成' }]);
  });

  it('上游不给签名：下一个请求不带思考块，其余照常', async () => {
    const replies = [{ reasoning: ['无签名'], text: ['答'], noSignature: true }, { text: ['好'] }];
    let i = 0;
    const mock = await messagesUpstream(() => replies[i++] ?? {});
    const { gw } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    const body = { model: 'm', input: 'hi', reasoning: { effort: 'high' } };
    const items = doneItems(
      await readEvents(await postResponses(gw.baseURL('claude'), gw.token, body)),
    );
    const next = await postResponses(gw.baseURL('claude'), gw.token, {
      ...body,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ...items,
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再说' }] },
      ],
    });
    expect(next.status).toBe(200);
    expect(mock.requests[1]?.body.messages[1]?.content).toEqual([{ type: 'text', text: '答' }]);
  });

  it('压缩请求（没有工具、历史里有工具调用）：上游接受占位工具', async () => {
    const mock = await messagesUpstream(() => ({ text: ['摘要'] }));
    const { gw } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    const events = await readEvents(
      await postResponses(gw.baseURL('claude'), gw.token, codexRequest('4-compact').body),
    );
    expect(events.at(-1)?.type).toBe('response.completed');
    expect(mock.requests[0]?.body.tool_choice).toEqual({ type: 'none' });
  });

  it('stop_reason=max_tokens / refusal → response.incomplete；流里的 error 与提前断开 → response.failed（带原文）', async () => {
    const replies = [
      { text: ['截'], finishReason: 'max_tokens' },
      { text: ['拒'], finishReason: 'refusal' },
      { text: ['半'], failed: { code: 'overloaded_error', message: 'Overloaded: 原文' } },
      { text: ['断'], disconnect: true },
    ];
    let i = 0;
    const mock = await messagesUpstream(() => replies[i++] ?? {});
    const { gw } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    const body = codexRequest('1-first-turn').body;
    const next = async () => readEvents(await postResponses(gw.baseURL('claude'), gw.token, body));
    const length = await next();
    expect(codexProblems(length)).toEqual([]);
    expect(length.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    });
    expect((await next()).at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' } },
    });
    expect((await next()).at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'overloaded_error', message: 'Overloaded: 原文' } },
    });
    const cut = await next();
    expect(codexProblems(cut)).toEqual([]);
    expect(cut.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { message: expect.stringMatching(/流中断|结束前断开/) } },
    });
  });

  it('非 2xx：状态码原样，Anthropic 风格的正文整理成 {"error":{"message","type"}}，回显的 Key 遮掉；请求结构不对时上游的 400 原文转回', async () => {
    const errors = [
      { status: 529, code: 'overloaded_error', message: 'Overloaded' },
      { status: 401, code: 'authentication_error', message: `invalid x-api-key ${UPSTREAM_KEY}` },
    ];
    let i = 0;
    const mock = await messagesUpstream(() => ({ httpError: errors[i++] }));
    const { gw, lines } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    const body = codexRequest('1-first-turn').body;
    const r529 = await postResponses(gw.baseURL('claude'), gw.token, body);
    expect(r529.status).toBe(529);
    expect(await r529.json()).toEqual({
      error: { message: 'Overloaded', type: 'overloaded_error' },
    });
    const r401 = await postResponses(gw.baseURL('claude'), gw.token, body);
    expect(r401.status).toBe(401);
    expect(JSON.stringify(await r401.json())).not.toContain(UPSTREAM_KEY);
    // 历史里有工具调用但没有对应的结果：mock 照 Anthropic 回 400。
    const broken = await postResponses(gw.baseURL('claude'), gw.token, {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] },
        { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{}' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y' }] },
      ],
      tools: [{ type: 'function', name: 'exec_command' }],
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({
      error: {
        message: expect.stringContaining('without `tool_result` blocks'),
        type: 'invalid_request_error',
      },
    });
    await until(() => requestLogs(lines).length === 3);
    expect(requestLogs(lines).map((l) => l.fields?.upstreamStatus)).toEqual([529, 401, 400]);
  });

  it('日志口径与 Chat 相同：不记请求体、响应体、Key、思考与签名', async () => {
    const mock = await messagesUpstream(() => ({ reasoning: ['秘密思考'], text: ['秘密回答'] }));
    const { gw, lines } = await gateway();
    gw.setProviders([messagesProvider(mock.baseURL)]);
    await (
      await postResponses(gw.baseURL('claude'), gw.token, codexRequest('2-tool-results').body)
    ).text();
    await until(() => requestLogs(lines).length === 1);
    expect(requestLogs(lines)[0]?.fields).toEqual({
      method: 'POST',
      providerId: 'claude',
      outcome: 'completed',
      upstreamStatus: 200,
      durationMs: expect.any(Number),
    });
    const all = JSON.stringify(lines);
    for (const secret of [UPSTREAM_KEY, gw.token, '秘密', signature('秘密思考'), 'notes.md']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('上游错误', () => {
  it('非 2xx：状态码原样，正文整理成 {"error":{"message"}}，保留 code，回显的 Key 遮掉', async () => {
    const errors = [
      { status: 429, message: 'Too many requests', code: 'rate_limit_exceeded' },
      { status: 500, body: '<html>Internal Server Error</html>' },
      { status: 401, message: `Incorrect API key provided: ${UPSTREAM_KEY}` },
    ];
    let i = 0;
    const chat = await chatUpstream(() => ({ httpError: errors[i++] }));
    let j = 0;
    const resp = await responsesUpstream(() => ({ httpError: errors[j++] }));
    const { gw, lines } = await gateway();
    gw.setProviders([chatProvider(chat.baseURL), responsesProvider(resp.baseURL)]);
    for (const id of ['chat', 'resp']) {
      const body = codexRequest('1-first-turn').body;
      const r429 = await postResponses(gw.baseURL(id), gw.token, body);
      expect(r429.status).toBe(429);
      expect(await r429.json()).toEqual({
        error: {
          message: 'Too many requests',
          type: 'invalid_request_error',
          code: 'rate_limit_exceeded',
        },
      });
      const r500 = await postResponses(gw.baseURL(id), gw.token, body);
      expect(r500.status).toBe(500);
      expect(await r500.json()).toEqual({
        error: { message: '<html>Internal Server Error</html>' },
      });
      const r401 = await postResponses(gw.baseURL(id), gw.token, body);
      expect(r401.status).toBe(401);
      expect(JSON.stringify(await r401.json())).not.toContain(UPSTREAM_KEY);
    }
    await until(() => requestLogs(lines).length === 6);
    expect(requestLogs(lines).map((l) => l.fields?.upstreamStatus)).toEqual([
      429, 500, 401, 429, 500, 401,
    ]);
  });

  it('Responses 上游流里的 response.failed 原样转回', async () => {
    const mock = await responsesUpstream(() => ({
      failed: { code: 'context_length_exceeded', message: '太长' },
    }));
    const { gw } = await gateway();
    gw.setProviders([responsesProvider(mock.baseURL)]);
    const events = await readEvents(
      await postResponses(gw.baseURL('resp'), gw.token, codexRequest('1-first-turn').body),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'context_length_exceeded', message: '太长' } },
    });
  });

  it('连不上上游 → 502', async () => {
    const { gw, lines } = await gateway();
    gw.setProviders([chatProvider(`http://127.0.0.1:${await closedPort()}/v1`)]);
    const res = await postResponses(gw.baseURL('chat'), gw.token, { model: 'm', input: 'hi' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      '连不上上游',
    );
    await until(() => requestLogs(lines).length === 1);
    expect(requestLogs(lines)[0]?.fields).toMatchObject({
      outcome: 'network_error',
      error: 'ECONNREFUSED',
    });
  });
});

describe('取消与配置更新', () => {
  for (const mode of ['chat', 'resp', 'claude'] as const) {
    it(`${mode}：Codex 断开时中断上游，记为 client_closed`, async () => {
      const script: Script = () => ({
        text: Array.from({ length: 200 }, (_, n) => `${n} `),
        delayMs: 20,
      });
      const mock =
        mode === 'chat'
          ? await chatUpstream(script)
          : mode === 'claude'
            ? await messagesUpstream(script)
            : await responsesUpstream(script);
      const { gw, lines } = await gateway();
      gw.setProviders([
        mode === 'chat'
          ? chatProvider(mock.baseURL)
          : mode === 'claude'
            ? messagesProvider(mock.baseURL)
            : responsesProvider(mock.baseURL),
      ]);
      const abort = new AbortController();
      const res = await postResponses(
        gw.baseURL(mode),
        gw.token,
        codexRequest('1-first-turn').body,
        {
          signal: abort.signal,
        },
      );
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let text = '';
      while (!text.includes('output_text.delta')) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      abort.abort();
      await mock.waitAborted(0);
      await until(() => requestLogs(lines).length === 1);
      expect(requestLogs(lines)[0]?.fields).toMatchObject({
        outcome: 'client_closed',
        upstreamStatus: 200,
      });
    });
  }

  it('setProviders 之后的请求按新配置走，进行中的请求不受影响', async () => {
    const slow = await chatUpstream(() => ({ text: ['慢', '慢', '来'], delayMs: 60 }));
    const other = await chatUpstream(() => ({ text: ['新地址'] }));
    const { gw } = await gateway();
    gw.setProviders([chatProvider(slow.baseURL)]);
    const pending = postResponses(gw.baseURL('chat'), gw.token, { model: 'm', input: 'hi' });
    await until(() => slow.requests.length === 1);
    gw.setProviders([chatProvider(other.baseURL, { apiKey: 'sk-new' })]);
    const first = await readEvents(await pending);
    expect(doneItems(first)[0]).toMatchObject({
      content: [{ type: 'output_text', text: '慢慢来' }],
    });
    const second = await readEvents(
      await postResponses(gw.baseURL('chat'), gw.token, { model: 'm', input: 'hi' }),
    );
    expect(doneItems(second)[0]).toMatchObject({
      content: [{ type: 'output_text', text: '新地址' }],
    });
    expect(other.requests[0]?.authorization).toBe('Bearer sk-new');
    gw.setProviders([]);
    expect(
      (await postResponses(gw.baseURL('chat'), gw.token, { model: 'm', input: 'hi' })).status,
    ).toBe(404);
  });

  it('改 setProviders 传入的对象不影响网关', async () => {
    const mock = await chatUpstream(() => ({ text: ['x'] }));
    const { gw } = await gateway();
    const provider = chatProvider(mock.baseURL);
    gw.setProviders([provider]);
    provider.apiKey = 'sk-mutated';
    await (await postResponses(gw.baseURL('chat'), gw.token, { model: 'm', input: 'hi' })).text();
    expect(mock.requests[0]?.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
  });

  it('close() 中断进行中的上游请求', async () => {
    const mock = await chatUpstream(() => ({
      text: Array.from({ length: 100 }, () => 'x'),
      delayMs: 20,
    }));
    const { gw } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const res = await postResponses(gw.baseURL('chat'), gw.token, { model: 'm', input: 'hi' });
    await until(() => mock.requests.length === 1);
    await gw.close();
    await mock.waitAborted(0);
    await res.text().catch(() => '');
  });
});

describe('日志口径', () => {
  it('只记方法、Provider ID、结果、上游状态码与耗时；不记请求体、响应体、Key 与令牌', async () => {
    const mock = await chatUpstream(() => ({ reasoning: ['秘密推理'], text: ['秘密回答'] }));
    const { gw, lines } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const body = codexRequest('2-tool-results').body;
    await (await postResponses(gw.baseURL('chat'), gw.token, body)).text();
    await (await postResponses(gw.baseURL('chat'), 'bad-token', body)).text();
    await until(() => requestLogs(lines).length === 1);
    expect(requestLogs(lines)[0]?.fields).toEqual({
      method: 'POST',
      providerId: 'chat',
      outcome: 'completed',
      upstreamStatus: 200,
      durationMs: expect.any(Number),
    });
    const all = JSON.stringify(lines);
    for (const secret of [UPSTREAM_KEY, gw.token, 'bad-token', '秘密', '先建文件', 'notes.md']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('事件流的编码', () => {
  it('网关发出的每条 SSE 都能被解析，Codex 不认识的事件不会出现', async () => {
    const mock = await chatUpstream(() => ({
      reasoning: ['r'],
      text: ['t'],
      toolCalls: [{ kind: 'function', name: 'exec_command', args: {} }],
    }));
    const { gw } = await gateway();
    gw.setProviders([chatProvider(mock.baseURL)]);
    const text = await (
      await postResponses(gw.baseURL('chat'), gw.token, codexRequest('1-first-turn').body)
    ).text();
    const events = parseEvents(text);
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        'response.created',
        'response.output_item.added',
        'response.reasoning_text.delta',
        'response.output_item.done',
        'response.output_text.delta',
        'response.completed',
      ]),
    );
    expect(text.split('\n\n').filter(Boolean)).toHaveLength(events.length);
  });
});
