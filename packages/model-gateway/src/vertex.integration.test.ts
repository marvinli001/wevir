import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { vertexProvider } from './test-fixtures/vertex.js';
import type { JsonObject, ResponsesItem } from './types.js';
import { GOOGLE_TOKEN_URL } from './vertex-auth.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const ACCESS = 'ya29.vertex-test-token';
const SIGNATURE = 'gemini-test-signature';
const PATCH = '*** Begin Patch\n*** Add File: vertex.txt\n+ok\n*** End Patch';

async function mockVertex(
  options: { tools?: boolean; authFailure?: boolean; upstreamError?: boolean } = {},
) {
  let exchanges = 0;
  const records: { url: string; body: JsonObject }[] = [];
  const errors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString();
      if (req.url === '/token') {
        exchanges++;
        const params = new URLSearchParams(raw);
        expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(params.get('assertion')?.split('.')).toHaveLength(3);
        res.writeHead(options.authFailure ? 400 : 200, { 'content-type': 'application/json' });
        res.end(
          options.authFailure
            ? JSON.stringify({
                error: 'invalid_grant',
                error_description: 'mock secret that must not escape',
              })
            : JSON.stringify({ access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 }),
        );
        return;
      }
      expect(req.headers.authorization).toBe(`Bearer ${ACCESS}`);
      expect(req.headers['x-api-key']).toBeUndefined();
      expect(req.headers['anthropic-version']).toBeUndefined();
      expect(req.headers['session-id']).toBeUndefined();
      expect(req.headers['thread-id']).toBeUndefined();
      const body = JSON.parse(raw) as JsonObject;
      records.push({ url: req.url ?? '', body });
      const claude = req.url?.endsWith(':streamRawPredict');
      if (claude) {
        expect(body).not.toHaveProperty('model');
        expect(body.anthropic_version).toBe('vertex-2023-10-16');
      } else {
        expect(req.url?.endsWith('/endpoints/openapi/chat/completions')).toBe(true);
        expect(String(body.model)).toMatch(/^google\/gemini-/);
      }
      if (options.upstreamError) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: `permission denied ${ACCESS}`, code: ACCESS } }),
        );
        return;
      }
      const messages = body.messages as JsonObject[];
      const history = JSON.stringify(messages);
      const hasResult = claude
        ? history.includes('tool_result')
        : messages.some((m) => m.role === 'tool');
      const call = options.tools && !hasResult;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (claude) {
        if (hasResult) {
          expect(history).toContain('claude-signed-thinking');
          expect(history).toContain('tool_use');
        }
        emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } });
        if (call) {
          emit({
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'thinking',
              thinking: 'thinking',
              signature: 'claude-signed-thinking',
            },
          });
          emit({ type: 'content_block_stop', index: 0 });
          emit({
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'call_patch',
              name: 'apply_patch',
              input: { input: PATCH },
            },
          });
          emit({ type: 'content_block_stop', index: 1 });
        } else {
          emit({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'done' },
          });
          emit({ type: 'content_block_stop', index: 0 });
        }
        emit({
          type: 'message_delta',
          delta: { stop_reason: call ? 'tool_use' : 'end_turn' },
          usage: { output_tokens: 5 },
        });
        emit({ type: 'message_stop' });
      } else {
        if (hasResult) expect(history).toContain(`"thought_signature":"${SIGNATURE}"`);
        emit({
          choices: [
            {
              delta: call
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_patch',
                        type: 'function',
                        function: {
                          name: 'apply_patch',
                          arguments: JSON.stringify({ input: PATCH }),
                        },
                        extra_content: { google: { thought_signature: SIGNATURE } },
                      },
                    ],
                  }
                : { content: 'done' },
              finish_reason: call ? 'tool_calls' : 'stop',
            },
          ],
        });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'mock failure');
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send: typeof fetch = (input, init) => {
    const url = String(input);
    if (
      url !== GOOGLE_TOKEN_URL &&
      !/^https:\/\/(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com\//.test(url)
    )
      throw new Error('unexpected destination');
    return fetch(`${base}${new URL(url).pathname}`, init);
  };
  return { send, records, errors, exchanges: () => exchanges };
}

describe('Vertex：HTTP OAuth + 模型网关', () => {
  it('Gemini、Claude 与 testProvider 共用同一服务账号的令牌；不转发内部头', async () => {
    const mock = await mockVertex();
    const logs: unknown[] = [];
    const gateway = await startModelGateway({
      fetch: mock.send,
      logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    });
    cleanups.push(() => gateway.close());
    const gemini = vertexProvider();
    const claude = vertexProvider('anthropic-messages');
    gateway.setProviders([gemini, claude]);
    const results = await Promise.all([
      gateway.testProvider(gemini, gemini.defaultModelId),
      gateway.testProvider(claude, claude.defaultModelId),
      ...[gemini, claude].map(async (provider) =>
        readEvents(
          await postResponses(gateway.baseURL(provider.id), gateway.token, {
            model: provider.defaultModelId,
            input: 'ping',
          }),
        ),
      ),
    ]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(mock.exchanges()).toBe(1);
    expect(mock.records).toHaveLength(4);
    expect(mock.errors).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(ACCESS);
    expect(JSON.stringify(logs)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(logs)).not.toContain(gateway.token);
  });

  it.each(['openai-completions', 'anthropic-messages'])(
    '%s：录制 Codex 请求经过 apply_patch 与下一回合，签名完整带回',
    async (api) => {
      const mock = await mockVertex({ tools: true });
      const gateway = await startModelGateway({ fetch: mock.send });
      cleanups.push(() => gateway.close());
      const provider = vertexProvider(api);
      gateway.setProviders([provider]);
      const recorded = codexRequest('1-first-turn').body;
      let input = recorded.input as ResponsesItem[];
      const send = async () =>
        readEvents(
          await postResponses(gateway.baseURL(provider.id), gateway.token, {
            ...recorded,
            model: provider.defaultModelId,
            input,
          }),
        );
      const first = await send();
      expect(codexProblems(first)).toEqual([]);
      expect(doneItems(first)).toContainEqual(
        expect.objectContaining({ type: 'custom_tool_call', name: 'apply_patch', input: PATCH }),
      );
      input = [
        ...input,
        ...(doneItems(first) as ResponsesItem[]),
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Success' },
      ];
      const second = await send();
      expect(codexProblems(second)).toEqual([]);
      input = [
        ...input,
        ...(doneItems(second) as ResponsesItem[]),
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Continue carefully' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next task' }] },
      ];
      const third = await send();
      expect(codexProblems(third)).toEqual([]);
      expect(mock.records).toHaveLength(3);
      expect(mock.errors).toEqual([]);
      expect(mock.exchanges()).toBe(1);
    },
  );

  it('交换失败归 auth、正式请求回 401，原文与凭据不进响应和日志', async () => {
    const mock = await mockVertex({ authFailure: true });
    const logs: unknown[] = [];
    const gateway = await startModelGateway({
      fetch: mock.send,
      logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    });
    cleanups.push(() => gateway.close());
    const provider = vertexProvider();
    gateway.setProviders([provider]);
    expect(await gateway.testProvider(provider, provider.defaultModelId)).toMatchObject({
      ok: false,
      reason: 'auth',
    });
    const response = await postResponses(gateway.baseURL(provider.id), gateway.token, {
      model: provider.defaultModelId,
      input: 'ping',
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_api_key' } });
    expect(JSON.stringify(logs)).not.toContain('mock secret');
    expect(mock.records).toHaveLength(0);
  });

  it('模型上游回显访问令牌时，HTTP 错误各字段与探测结果都遮掉它', async () => {
    const mock = await mockVertex({ upstreamError: true });
    const gateway = await startModelGateway({ fetch: mock.send });
    cleanups.push(() => gateway.close());
    const provider = vertexProvider();
    gateway.setProviders([provider]);
    const response = await postResponses(gateway.baseURL(provider.id), gateway.token, {
      model: provider.defaultModelId,
      input: 'ping',
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(ACCESS);
    const result = await gateway.testProvider(provider, provider.defaultModelId);
    expect(result).toMatchObject({ ok: false, reason: 'auth' });
    expect(JSON.stringify(result)).not.toContain(ACCESS);
  });
});
