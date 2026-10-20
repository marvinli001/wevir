// MiniMax Responses 的工具往返；mock 按官方文档拒收非 auto、非函数工具与 M3.1 的 none，namespace 拒收只检验保守策略。

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
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，MiniMax\n*** End Patch';
const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_minimax_mock',
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

describe('MiniMax Responses 工具与推理回放', () => {
  it.each([
    {
      model: 'MiniMax-M3.1-Flash',
      effort: 'none',
      sent: 'low',
      baseURL: 'https://api.minimax.cn/v1',
    },
    {
      model: 'MiniMax-M3.1-Flash',
      effort: 'max',
      sent: 'max',
      baseURL: 'https://api.minimax.io/v1',
    },
    { model: 'MiniMax-M3', effort: 'high', sent: 'high', baseURL: 'https://api.minimax.cn/v1' },
  ])(
    '$model 的 $effort 按地址默认完成工具、后续回合与连接探测',
    async ({ model, effort, sent, baseURL }) => {
      let accepted = 0;
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, _record, res) => {
          let problem: string | undefined;
          if (body.tool_choice !== undefined && body.tool_choice !== 'auto')
            problem = 'only auto tool_choice is supported by this mock';
          else if (body.tools?.some((tool) => tool.type === 'namespace'))
            problem = 'namespace tools are unsupported by this mock';
          else if (body.tools?.some((tool) => tool.type === 'custom'))
            problem = 'only function tools are supported by this mock';
          else if (
            /^MiniMax-M3\.1/.test(body.model) &&
            (body.reasoning as { effort?: string } | undefined)?.effort === 'none'
          )
            problem = 'reasoning effort none is not supported (2013)';
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
          const output: ResponsesItem[] =
            accepted++ === 0
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
        id: 'minimax',
        kind: 'openai-compatible',
        displayName: 'MiniMax mock',
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
        prompt_cache_key: 'minimax-mock-cache',
      };
      // 不经过网关的对照分别触发三种拒绝，避免 mock 在修正前也接受整个请求。
      for (const [type, tool_choice, error] of [
        ['function', 'required', 'only auto'],
        ['namespace', 'auto', 'namespace'],
        ['custom', 'auto', 'only function'],
      ]) {
        const rejected = await postResponses(mock.baseURL, 'mock-token', {
          ...body,
          tools: body.tools?.filter((tool) => tool.type === type),
          tool_choice,
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain(error);
      }
      if (effort !== sent) {
        const rejected = await postResponses(mock.baseURL, 'mock-token', {
          ...body,
          tools: [],
          tool_choice: 'auto',
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain('2013');
      }
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
        expect(request.body.reasoning).toEqual({ effort: sent });
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
