// TokenHub Responses 工具往返：mock 静默丢弃 custom，拒收 forced choice；namespace 拒收只检验保守策略。

import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { testProvider } from './provider-test.js';
import { sseEvent } from './sse.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('TokenHub provider.test 的 HTTP 402', () => {
  it.each([
    ['401007', 'The service has no available free trial quota and postpaid is not enabled.'],
    ['401008', 'The free trial quota is exhausted and postpaid is not enabled.'],
  ])('%s 保留 unknown，提示在控制台开通该模型', async (code, message) => {
    const key = 'tokenhub-mock-key-not-real';
    const mock = await startMockServer<ResponsesRequest>(
      '/responses',
      async (_body, _record, res) => {
        sendHttpError(res, { status: 402, code, message: `${message} ${key}` });
      },
    );
    cleanups.push(() => mock.close());
    const baseURL = 'https://tokenhub.tencentcloudmaas.com/v1';
    const gw = await startModelGateway({
      fetch: async (url, init) => {
        expect(String(url)).toBe(`${baseURL}/responses`);
        return fetch(`${mock.baseURL}/responses`, init);
      },
    });
    cleanups.push(() => gw.close());
    const provider: GatewayProvider = {
      id: 'tencent',
      kind: 'openai-compatible',
      displayName: 'TokenHub mock',
      api: 'openai-responses',
      baseURL,
      models: [{ id: 'hy3' }],
      defaultModelId: 'hy3',
      apiKey: key,
    };
    const result = await gw.testProvider(provider, 'hy3');
    expect(result).toMatchObject({
      ok: false,
      reason: 'unknown',
      httpStatus: 402,
      error: { category: 'unknown', code: 'tokenhub_model_not_enabled' },
    });
    expect(result.error?.message).toContain('在腾讯云控制台开通该模型的后付费');
    expect(result.error?.message).toContain(code);
    expect(result.error?.message).toContain('***');
    expect(result.error?.message).not.toContain(key);
    // 正式请求仍保留上游业务码与 HTTP 402，没有给 Codex 伪造新的协议错误。
    gw.setProviders([provider]);
    const response = await postResponses(gw.baseURL('tencent'), gw.token, {
      model: 'hy3',
      input: 'ping',
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code, message: expect.stringContaining('***') },
    });
  });

  it.each([
    ['https://tokenhub.tencentmaas.com/v1', '403004', '账户欠费，充值后'],
    ['https://tokenhub-us.tencentcloudmaas.tech/v1', undefined, '开通状态、额度与余额'],
    ['https://proxy.example.org/v1', '401007', '请求失败'],
  ])('%s / %s 不误报未开通', async (baseURL, code, expected) => {
    const provider: GatewayProvider = {
      id: 'test',
      kind: 'openai-compatible',
      displayName: 'mock',
      api: 'openai-responses',
      baseURL,
      models: [{ id: 'hy3' }],
      defaultModelId: 'hy3',
      apiKey: 'mock-key',
    };
    const result = await testProvider(provider, 'hy3', {
      fetch: async () =>
        new Response(JSON.stringify({ error: { code, message: 'payment required' } }), {
          status: 402,
        }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown', httpStatus: 402 });
    expect(result.error?.code).not.toBe('tokenhub_model_not_enabled');
    expect(result.error?.message).toContain(expected);
  });
});

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，TokenHub\n*** End Patch';
const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_tokenhub_mock',
  summary: [],
  content: [{ type: 'reasoning_text', text: '先修改文件，再继续。' }],
};
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
    arguments: '{"message":"检查文件"}',
  },
];

describe('TokenHub Responses 工具与推理回放', () => {
  it.each([
    { model: 'hy3', effort: 'low', baseURL: 'https://tokenhub.tencentcloudmaas.com/v1' },
    {
      model: 'hy4-preview',
      effort: 'none',
      baseURL: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
    },
    { model: 'hy3', effort: 'high', baseURL: 'https://tokenhub-us.tencentcloudmaas.tech/v1' },
  ])(
    '$model 的 $effort 按地址默认完成工具、后续回合与连接探测',
    async ({ model, effort, baseURL }) => {
      let accepted = 0;
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, _record, res) => {
          let problem: string | undefined;
          if (body.tool_choice !== undefined && body.tool_choice !== 'auto')
            problem = 'only auto tool_choice is supported by this mock';
          else if (body.tools?.some((tool) => tool.type === 'namespace'))
            problem = 'namespace tools are unsupported by this mock';
          else if (
            Array.isArray(body.input) &&
            body.input.some(
              (item) =>
                item.namespace !== undefined ||
                item.type.startsWith('custom_tool_call') ||
                (item.type === 'reasoning' &&
                  (item.content === null || item.encrypted_content === null)),
            )
          )
            problem = 'unsupported history item';
          if (problem !== undefined) {
            sendHttpError(res, { status: 400, message: problem });
            return;
          }
          const output: ResponsesItem[] = !body.tools?.some(
            (tool) => tool.type === 'function' && tool.name === 'apply_patch',
          )
            ? [
                {
                  type: 'message',
                  id: 'msg_ignored',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'No usable patch tool' }],
                },
              ]
            : accepted++ === 0
              ? [reasoning, ...calls]
              : [
                  {
                    type: 'message',
                    id: `msg_${accepted}`,
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '完成' }],
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
      // 只替换 HTTP 目的地，保留正式按量地址供路由与默认 compat 判断；所有请求都落到本机。
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe(`${baseURL}/responses`);
          return fetch(`${mock.baseURL}/responses`, init);
        },
      });
      cleanups.push(() => gw.close());
      const provider: GatewayProvider = {
        id: 'tokenhub',
        kind: 'openai-compatible',
        displayName: 'TokenHub mock',
        api: 'openai-responses',
        baseURL,
        models: [{ id: model }],
        defaultModelId: model,
        apiKey: 'placeholder-not-a-real-key',
      };
      gw.setProviders([provider]);
      const body: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model,
        reasoning: { effort, summary: 'auto' },
        tool_choice: 'required',
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'tokenhub-mock-cache',
      };
      // 对照：forced choice 报错；namespace 的 mock 限制不作为真实服务证据。
      for (const [type, tool_choice, error] of [
        ['function', 'required', 'only auto'],
        ['namespace', 'auto', 'namespace'],
      ]) {
        const rejected = await postResponses(mock.baseURL, 'mock-token', {
          ...body,
          tools: body.tools?.filter((tool) => tool.type === type),
          tool_choice,
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain(error);
      }
      // 官方兼容模式会静默丢弃 custom，HTTP 200 也不等于模型能调用 apply_patch。
      const ignored = await postResponses(mock.baseURL, 'mock-token', {
        ...body,
        tools: body.tools?.filter((tool) => tool.type === 'custom'),
        tool_choice: 'auto',
      });
      expect(ignored.status).toBe(200);
      expect(doneItems(await readEvents(ignored)).map((item) => item.type)).toEqual(['message']);
      const controls = mock.requests.length;
      const first = await postResponses(gw.baseURL(provider.id), gw.token, body);
      expect(first.status).toBe(200);
      const firstEvents = await readEvents(first);
      expect(codexProblems(firstEvents)).toEqual([]);
      const output = doneItems(firstEvents) as ResponsesItem[];
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
      expect(firstEvents.at(-1)?.response).toHaveProperty('output', output);
      const input: ResponsesItem[] = [
        ...(body.input as ResponsesItem[]),
        ...output.map((item) =>
          item.type === 'reasoning' ? { ...item, encrypted_content: null } : item,
        ),
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'file added' },
        { type: 'function_call_output', call_id: 'call_agent', output: 'agent started' },
      ];
      const second = await postResponses(gw.baseURL(provider.id), gw.token, {
        ...body,
        input,
        tool_choice: 'none',
      });
      expect(second.status).toBe(200);
      const secondEvents = await readEvents(second);
      expect(codexProblems(secondEvents)).toEqual([]);
      const nextInput: ResponsesItem[] = [
        ...input,
        ...(doneItems(secondEvents) as ResponsesItem[]),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续检查' }] },
      ];
      const third = await postResponses(gw.baseURL(provider.id), gw.token, {
        ...body,
        input: nextInput,
        tool_choice: { type: 'custom', name: 'apply_patch' },
      });
      expect(third.status).toBe(200);
      expect(codexProblems(await readEvents(third))).toEqual([]);
      expect(await gw.testProvider(provider, model)).toMatchObject({ ok: true });

      const forwarded = mock.requests.slice(controls);
      expect(forwarded).toHaveLength(4);
      for (const request of forwarded) {
        expect(request.body).toMatchObject({ model, stream: true, store: false });
        expect(request.authorization).toBe(`Bearer ${provider.apiKey}`);
        expect(request.body).not.toHaveProperty('client_metadata');
      }
      for (const request of forwarded.slice(0, 3)) {
        expect(request.body.reasoning).toEqual({ effort, summary: 'auto' });
        expect(request.body.include).toEqual(body.include);
        expect(request.body.prompt_cache_key).toBe(body.prompt_cache_key);
        expect(request.body).not.toHaveProperty('thinking');
        expect(request.body).not.toHaveProperty('reasoning_effort');
        expect(request.body).not.toHaveProperty('max_output_tokens');
      }
      expect(forwarded[0]?.body.tool_choice).toBe('auto');
      expect(forwarded[1]?.body).not.toHaveProperty('tool_choice');
      expect(forwarded[2]?.body.tool_choice).toBe('auto');
      const tools = forwarded[0]?.body.tools;
      expect(tools?.every((tool) => tool.type === 'function')).toBe(true);
      expect(tools?.find((tool) => tool.name === 'apply_patch')?.description).toContain(
        'begin_patch',
      );
      expect(tools?.some((tool) => tool.name === 'multi_agent_v1__spawn_agent')).toBe(true);
      expect(tools?.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name ?? ''))).toBe(true);
      for (const request of forwarded.slice(1, 3)) {
        expect(request.body.tools).toEqual(tools);
        const history = request.body.input as ResponsesItem[];
        expect(history.find((item) => item.type === 'reasoning')).toEqual(reasoning);
        expect(history.filter((item) => item.type === 'function_call')).toEqual([
          {
            type: 'function_call',
            call_id: 'call_patch',
            name: 'apply_patch',
            arguments: calls[0]?.arguments,
          },
          calls[1],
        ]);
        expect(history.filter((item) => item.type === 'function_call_output')).toEqual([
          { type: 'function_call_output', call_id: 'call_patch', output: 'file added' },
          { type: 'function_call_output', call_id: 'call_agent', output: 'agent started' },
        ]);
      }
      expect(forwarded[2]?.body.input).toEqual([
        ...((forwarded[1]?.body.input ?? []) as ResponsesItem[]),
        ...doneItems(secondEvents),
        nextInput.at(-1),
      ]);
      expect(forwarded[3]?.body).toEqual({
        model,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        stream: true,
        store: false,
        max_output_tokens: 16,
      });
    },
  );
});
