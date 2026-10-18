// 按官方文档构造的严格本机上游；拒收规则不代表 SpaceXAI 的真实服务验收。
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
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import { isObject } from './tools.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_xai',
  summary: [],
  encrypted_content: 'mock-opaque-reasoning',
};
const patch = '*** Begin Patch\n*** Add File: hello.txt\n+Hello SpaceXAI\n*** End Patch';
const calls: ResponsesItem[] = [
  {
    type: 'function_call',
    id: 'fc_patch',
    call_id: 'call_patch',
    name: 'apply_patch',
    arguments: JSON.stringify({ input: patch }),
  },
  {
    type: 'function_call',
    id: 'fc_agent',
    call_id: 'call_agent',
    name: 'multi_agent_v1__spawn_agent',
    arguments: '{"message":"check"}',
  },
];

describe('SpaceXAI Responses 本机往返', () => {
  it.each(['https://api.x.ai/v1', 'https://us.api.x.ai/v1'])(
    '%s 的力度、工具、缓存与加密推理',
    async (baseURL) => {
      let accepted = 0;
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, _record, res) => {
          const effort = isObject(body.reasoning) ? body.reasoning.effort : undefined;
          let problem: string | undefined;
          if (effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(String(effort)))
            problem = 'unsupported reasoning effort';
          else if (body.tools?.some((tool) => tool.type !== 'function'))
            problem = 'this mock accepts only function tools';
          else if (
            Array.isArray(body.input) &&
            body.input.some(
              (item) =>
                item.namespace !== undefined ||
                item.type.startsWith('custom_tool_call') ||
                (item.type === 'reasoning' && item.content === null),
            )
          )
            problem = 'unsupported history';
          if (problem !== undefined) {
            sendHttpError(res, { status: 400, message: problem });
            return;
          }
          const output: ResponsesItem[] =
            accepted++ === 0
              ? [reasoning, ...calls]
              : [
                  {
                    type: 'message',
                    id: `msg_${accepted}`,
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'done' }],
                  },
                ];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            output
              .flatMap((item, output_index) => [
                sseEvent({ type: 'response.output_item.added', output_index, item }),
                sseEvent({ type: 'response.output_item.done', output_index, item }),
              ])
              .join('') +
              sseEvent({
                type: 'response.completed',
                response: { id: `resp_${accepted}`, status: 'completed', output },
              }),
          );
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe(`${baseURL}/responses`);
          return fetch(`${mock.baseURL}/responses`, init);
        },
      });
      cleanups.push(() => gw.close());
      const provider: GatewayProvider = {
        id: 'xai',
        kind: 'openai-compatible',
        displayName: 'SpaceXAI mock',
        api: 'openai-responses',
        baseURL,
        models: [{ id: 'grok-4.7' }],
        defaultModelId: 'grok-4.7',
        apiKey: 'placeholder-not-a-real-key',
      };
      gw.setProviders([provider]);
      const body: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: 'grok-4.7',
        reasoning: { effort: 'none', summary: 'auto' },
        prompt_cache_key: 'xai-mock-conversation',
        include: ['reasoning.encrypted_content'],
      };
      // 对照：不经过网关的无效力度与两种原生工具分别被严格 mock 拒收。
      for (const raw of [
        { ...body, tools: [] },
        ...['custom', 'namespace'].map((type) => ({
          ...body,
          reasoning: { effort: 'low' },
          tools: body.tools?.filter((tool) => tool.type === type),
        })),
      ]) {
        const rejected = await postResponses(mock.baseURL, 'mock-token', raw);
        expect(rejected.status).toBe(400);
        await rejected.body?.cancel();
      }
      const first = await postResponses(gw.baseURL(provider.id), gw.token, body);
      expect(first.status).toBe(200);
      const events = await readEvents(first);
      expect(codexProblems(events)).toEqual([]);
      const output = doneItems(events) as ResponsesItem[];
      expect(output).toEqual([
        reasoning,
        {
          type: 'custom_tool_call',
          id: 'fc_patch',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: patch,
        },
        { ...calls[1], name: 'spawn_agent', namespace: 'multi_agent_v1' },
      ]);
      expect(events.at(-1)?.response).toHaveProperty('output', output);
      const input: ResponsesItem[] = [
        ...(body.input as ResponsesItem[]),
        ...output.map((item) => (item.type === 'reasoning' ? { ...item, content: null } : item)),
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'file added' },
        { type: 'function_call_output', call_id: 'call_agent', output: 'agent started' },
      ];
      const second = await postResponses(gw.baseURL(provider.id), gw.token, {
        ...body,
        input,
        reasoning: { effort: 'max' },
      });
      expect(second.status).toBe(200);
      const secondEvents = await readEvents(second);
      expect(codexProblems(secondEvents)).toEqual([]);
      const third = await postResponses(gw.baseURL(provider.id), gw.token, {
        ...body,
        input: [
          ...input,
          ...(doneItems(secondEvents) as ResponsesItem[]),
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        ],
        reasoning: { effort: 'minimal' },
      });
      expect(third.status).toBe(200);
      expect(codexProblems(await readEvents(third))).toEqual([]);
      expect(await gw.testProvider(provider, provider.defaultModelId)).toMatchObject({ ok: true });
      const forwarded = mock.requests.slice(3);
      expect(forwarded).toHaveLength(4);
      expect(
        forwarded
          .slice(0, 3)
          .map((record) =>
            isObject(record.body.reasoning) ? record.body.reasoning.effort : undefined,
          ),
      ).toEqual(['low', 'xhigh', 'low']);
      for (const record of forwarded) {
        expect(record.body.store).toBe(false);
        expect(record.authorization).toBe(`Bearer ${provider.apiKey}`);
        expect(record.body).not.toHaveProperty('client_metadata');
        expect(record.headers).not.toHaveProperty('session-id');
        expect(record.headers).not.toHaveProperty('x-grok-conv-id');
      }
      for (const record of forwarded.slice(0, 3)) {
        expect(record.body.prompt_cache_key).toBe(body.prompt_cache_key);
        expect(record.body.include).toEqual(body.include);
        expect(record.body.tools?.every((tool) => tool.type === 'function')).toBe(true);
        expect(record.body).not.toHaveProperty('max_output_tokens');
      }
      for (const record of forwarded.slice(1, 3)) {
        const history = record.body.input as ResponsesItem[];
        expect(history.find((item) => item.type === 'reasoning')).toEqual(reasoning);
        expect(history.filter((item) => item.type === 'function_call')).toEqual([
          {
            type: 'function_call',
            call_id: 'call_patch',
            name: 'apply_patch',
            arguments: JSON.stringify({ input: patch }),
          },
          calls[1],
        ]);
        expect(history.filter((item) => item.type === 'function_call_output')).toHaveLength(2);
      }
      expect(forwarded[3]?.body).not.toHaveProperty('reasoning');
      expect(forwarded[3]?.body.max_output_tokens).toBe(16);
    },
  );

  it('官方顶层 code 样本通过网关和 provider.test，状态与脱敏原文保留', async () => {
    const secret = 'placeholder-not-a-real-key';
    const mock = await startMockServer<ResponsesRequest>(
      '/responses',
      async (_body, _record, res) => {
        sendHttpError(res, {
          status: 404,
          body: JSON.stringify({
            code: 'not-found',
            error: `The model missing does not exist; key ${secret}`,
          }),
        });
      },
    );
    cleanups.push(() => mock.close());
    const gw = await startModelGateway({
      fetch: (_url, init) => fetch(`${mock.baseURL}/responses`, init),
    });
    cleanups.push(() => gw.close());
    const provider: GatewayProvider = {
      id: 'xai',
      kind: 'openai-compatible',
      displayName: 'SpaceXAI mock',
      api: 'openai-responses',
      baseURL: 'https://api.x.ai/v1',
      models: [{ id: 'missing' }],
      defaultModelId: 'missing',
      apiKey: secret,
    };
    gw.setProviders([provider]);
    const response = await postResponses(gw.baseURL(provider.id), gw.token, {
      model: 'missing',
      input: 'ping',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'not-found', message: 'The model missing does not exist; key ***' },
    });
    const result = await gw.testProvider(provider, 'missing');
    expect(result).toMatchObject({
      ok: false,
      reason: 'model_not_found',
      httpStatus: 404,
      error: { code: 'not-found' },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
