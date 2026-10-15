// Azure 的限制由本机 HTTP mock 复现；Bearer Key 与真实工具能力仍需真实部署验收。
import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { sseEvent } from './sse.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { startMockMessages } from './test-fixtures/mock-messages.js';
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，Azure\n*** End Patch';
const p = (baseURL: string, model = 'my-coding-deployment'): GatewayProvider => ({
  id: 'azure',
  kind: 'openai-compatible',
  displayName: 'Azure mock',
  api: 'openai-responses',
  baseURL,
  models: [{ id: model, maxTokens: 128000 }],
  defaultModelId: model,
  apiKey: 'placeholder-azure-key',
});

describe('Azure Responses HTTP 往返', () => {
  it.each(['openai.azure.com', 'services.ai.azure.com', 'cognitiveservices.azure.com'])(
    '%s：命名空间描述、加密推理、custom 与 content_filters，连接探测也走同一条路',
    async (domain) => {
      const provider = p(`https://example-resource.${domain}/openai/v1`);
      const reasoning: ResponsesItem = {
        type: 'reasoning',
        id: 'rs_azure',
        summary: [],
        encrypted_content: 'opaque-azure-reasoning',
      };
      const calls: ResponsesItem[] = [
        { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: patch },
        {
          type: 'function_call',
          call_id: 'call_agent',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: '{"task":"check"}',
        },
      ];
      const contentFilters = [
        { source_type: 'prompt', blocked: false, content_filter_results: {} },
      ];
      let accepted = 0;
      const streams: string[] = [];
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, record, res) => {
          const empty = body.tools?.some(
            (tool) => tool.type === 'namespace' && !tool.description?.trim(),
          );
          if (empty)
            return sendHttpError(res, { status: 400, message: 'namespace description empty' });
          if (
            body.store === false &&
            !(body.include as string[] | undefined)?.includes('reasoning.encrypted_content')
          )
            return sendHttpError(res, {
              status: 400,
              message: 'encrypted reasoning include required',
            });
          if (record.authorization !== `Bearer ${provider.apiKey}`)
            return sendHttpError(res, { status: 401, message: 'mock expects Bearer key' });
          accepted += 1;
          const output: ResponsesItem[] =
            accepted === 1
              ? [reasoning, ...calls]
              : [
                  {
                    type: 'message',
                    id: `msg_${accepted}`,
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '完成' }],
                  },
                ];
          const stream =
            output.map((item) => sseEvent({ type: 'response.output_item.done', item })).join('') +
            sseEvent({
              type: 'response.completed',
              response: {
                id: `resp_${accepted}`,
                status: 'completed',
                output,
                content_filters: contentFilters,
              },
            });
          streams.push(stream);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(stream);
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe(`${provider.baseURL}/responses`);
          return fetch(`${mock.baseURL}/responses`, init);
        },
      });
      cleanups.push(() => gw.close());
      gw.setProviders([provider]);
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: provider.defaultModelId,
      };
      // 空描述是按报告注入的限制案例；不声称锁定 Codex 的正常请求会发空描述。
      first.tools = first.tools?.map((tool) =>
        tool.type === 'namespace' ? { ...tool, description: '' } : tool,
      );
      const rejected = await postResponses(mock.baseURL, 'mock-token', first);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain('namespace description empty');
      const missingInclude = await postResponses(mock.baseURL, 'mock-token', {
        ...first,
        tools: [],
        include: [],
      });
      expect(missingInclude.status).toBe(400);
      expect(await missingInclude.text()).toContain('encrypted reasoning include required');
      const response = await postResponses(gw.baseURL(provider.id), gw.token, first, {
        headers: {
          'X-OpenAI-Internal-Codex-Responses-Lite': 'true',
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(streams[0]);
      let input: ResponsesItem[] = [
        ...(first.input as ResponsesItem[]),
        { ...reasoning, content: null },
        ...calls,
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'file added' },
        { type: 'function_call_output', call_id: 'call_agent', output: 'agent started' },
      ];
      for (let step = 0; step < 2; step += 1) {
        const next = await postResponses(gw.baseURL(provider.id), gw.token, { ...first, input });
        expect(next.status).toBe(200);
        const events = await readEvents(next);
        expect(codexProblems(events)).toEqual([]);
        expect(events.at(-1)?.response).toHaveProperty('content_filters', contentFilters);
        input = [
          ...input,
          ...(doneItems(events) as ResponsesItem[]),
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '再检查一次' }],
          },
        ];
      }
      expect(await gw.testProvider(provider, provider.defaultModelId)).toMatchObject({ ok: true });
      const sent = mock.requests.slice(2);
      expect(sent).toHaveLength(4);
      for (const record of sent) {
        expect(record.authorization).toBe(`Bearer ${provider.apiKey}`);
        expect(record.apiKey).toBeUndefined();
        expect(record.body.model).toBe(provider.defaultModelId);
        expect(record.body).not.toHaveProperty('client_metadata');
        expect(record.headers).not.toHaveProperty('x-openai-internal-codex-responses-lite');
        expect(record.headers).not.toHaveProperty('session-id');
        expect(record.body.include).toEqual(['reasoning.encrypted_content']);
      }
      expect(sent[0]?.body.tools).toEqual(
        first.tools?.map((tool) =>
          tool.type === 'namespace' ? { ...tool, description: 'Tools in this namespace.' } : tool,
        ),
      );
      for (const record of sent.slice(1, 3)) {
        const history = record.body.input as ResponsesItem[];
        expect(history.find((item) => item.type === 'reasoning')).toEqual(reasoning);
        expect(history.filter((item) => item.type.endsWith('_call'))).toEqual(calls);
      }
    },
  );

  it('Azure 的 HTTP 400 content_filter 保留状态码、code 与脱敏错误正文', async () => {
    const provider = p('https://example-resource.openai.azure.com/openai/v1');
    const mock = await startMockServer<ResponsesRequest>(
      '/responses',
      async (_body, _record, res) => {
        sendHttpError(res, {
          status: 400,
          code: 'content_filter',
          message: `blocked ${provider.apiKey}`,
        });
      },
    );
    cleanups.push(() => mock.close());
    const gw = await startModelGateway({
      fetch: (_url, init) => fetch(`${mock.baseURL}/responses`, init),
    });
    cleanups.push(() => gw.close());
    gw.setProviders([provider]);
    const response = await postResponses(gw.baseURL(provider.id), gw.token, {
      model: provider.defaultModelId,
      input: 'blocked',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'content_filter', message: 'blocked ***' },
    });
  });
});

describe('Foundry Claude Messages HTTP 往返', () => {
  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'coding-deployment'])(
    '%s：部署名原样发送，工具、签名和下一回合可带回，认证用 x-api-key',
    async (model) => {
      let step = 0;
      const mock = await startMockMessages(() =>
        ++step === 1
          ? {
              reasoning: ['检查文件'],
              toolCalls: [{ kind: 'custom', name: 'apply_patch', input: patch }],
            }
          : { text: ['完成'] },
      );
      cleanups.push(() => mock.close());
      const provider: GatewayProvider = {
        ...p('https://example-resource.services.ai.azure.com/anthropic', model),
        api: 'anthropic-messages',
        compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
      };
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe(`${provider.baseURL}/v1/messages`);
          return fetch(`${mock.baseURL}/messages`, init);
        },
      });
      cleanups.push(() => gw.close());
      gw.setProviders([provider]);
      const first = { ...codexRequest('1-first-turn').body, model };
      let input = first.input as ResponsesItem[];
      for (let i = 0; i < 3; i += 1) {
        const response = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          input,
        });
        expect(response.status).toBe(200);
        const events = await readEvents(response);
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        if (i === 0) {
          expect(output[1]).toMatchObject({
            type: 'custom_tool_call',
            name: 'apply_patch',
            input: patch,
          });
          input = [
            ...input,
            ...output,
            { type: 'custom_tool_call_output', call_id: output[1]?.call_id, output: 'file added' },
          ];
        } else
          input = [
            ...input,
            ...output,
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
          ];
      }
      expect(await gw.testProvider(provider, model)).toMatchObject({ ok: true });
      expect(mock.requests).toHaveLength(4);
      for (const record of mock.requests) {
        expect(record.body.model).toBe(model);
        expect(record.apiKey).toBe(provider.apiKey);
        expect(record.authorization).toBeUndefined();
        expect(record.headers['anthropic-version']).toBe('2023-06-01');
      }
      for (const record of mock.requests.slice(1, 3)) {
        expect(record.body.messages[1]?.content[0]).toMatchObject({
          type: 'thinking',
          thinking: '检查文件',
          signature: expect.any(String),
        });
        expect(record.body.messages[2]?.content[0]).toMatchObject({ type: 'tool_result' });
      }
      expect(mock.requests[0]?.body).toMatchObject({
        max_tokens: 128000,
        thinking: { type: 'adaptive' },
      });
      expect(mock.requests[3]?.body.max_tokens).toBe(16);
    },
  );
});
