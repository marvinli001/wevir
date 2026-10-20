// 按官方参数与暂定 custom 支持构造的本机 mock；不代表 StepFun 按量端点的真实能力。
import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { sseEvent } from './sse.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  parseEvents,
  postResponses,
} from './test-fixtures/codex.js';
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，StepFun\n*** End Patch';
const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_stepfun',
  summary: [{ type: 'summary_text', text: '先检查，再修改。' }],
  content: [{ type: 'reasoning_text', text: '完整推理，保持原顺序。' }],
  encrypted_content: null,
};
const agentReasoning: ResponsesItem = { ...reasoning, id: 'rs_stepfun_agent' };
const calls: ResponsesItem[] = [
  { type: 'custom_tool_call', id: 'ct_patch', call_id: 'patch', name: 'apply_patch', input: patch },
  {
    type: 'function_call',
    id: 'fc_agent',
    call_id: 'agent',
    name: 'multi_agent_v1__spawn_agent',
    arguments: '{"message":"检查文件"}',
  },
];

describe('StepFun Responses HTTP 往返', () => {
  it.each(['https://api.stepfun.com/v1', 'https://api.stepfun.ai/v1'])(
    '%s 从工具限制的 400 到三步工具与推理回放',
    async (baseURL) => {
      let accepted = 0;
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, _req, res) => {
          if (body.tools?.length && body.tool_choice !== undefined && body.tool_choice !== 'auto') {
            sendHttpError(res, { status: 400, message: 'tool_choice only supports auto' });
            return;
          }
          if (body.tools?.some((tool) => tool.type === 'namespace')) {
            sendHttpError(res, { status: 400, message: 'namespace is not supported by this mock' });
            return;
          }
          if (body.tools?.some((tool) => !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name ?? ''))) {
            sendHttpError(res, { status: 400, message: 'tool name must match StepFun rules' });
            return;
          }
          const history = Array.isArray(body.input) ? body.input : [];
          if (
            history.some(
              (item) =>
                item.type === 'reasoning' &&
                (item.content === null || item.encrypted_content === null),
            )
          ) {
            sendHttpError(res, { status: 400, message: 'null reasoning fields are invalid' });
            return;
          }
          const step = accepted++;
          const output: ResponsesItem[] =
            step < 2
              ? [step === 0 ? reasoning : agentReasoning, calls[step] as ResponsesItem]
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
                response: { id: `resp_${accepted}`, output },
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
        id: 'stepfun',
        kind: 'openai-compatible',
        displayName: 'StepFun mock',
        api: 'openai-responses',
        baseURL,
        models: [{ id: 'step-5-preview' }],
        defaultModelId: 'step-5-preview',
        apiKey: 'mock-key',
      };
      gw.setProviders([
        provider,
        { ...provider, id: 'native', compat: { toolChoice: 'any', supportsNamespaceTools: true } },
      ]);
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: 'step-5-preview',
        reasoning: { effort: 'high' },
      };
      for (const tool_choice of ['required', { type: 'custom', name: 'apply_patch' }]) {
        const rejected = await postResponses(gw.baseURL('native'), gw.token, {
          ...first,
          tool_choice,
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain('tool_choice only supports auto');
      }
      const namespace = await postResponses(gw.baseURL('native'), gw.token, first);
      expect(namespace.status).toBe(400);
      expect(await namespace.text()).toContain('namespace is not supported by this mock');

      const input = [...(first.input as ResponsesItem[])];
      const choices = ['required', { type: 'custom', name: 'apply_patch' }, 'none'];
      const results: ResponsesItem[] = [
        { type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' },
        { type: 'function_call_output', call_id: 'agent', output: 'checked' },
      ];
      for (const [step, tool_choice] of choices.entries()) {
        const response = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          input,
          tool_choice,
        });
        expect(response.status).toBe(200);
        const events = parseEvents(await response.text());
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        if (step < 2) {
          const restored = [
            step === 0 ? reasoning : agentReasoning,
            step === 0
              ? calls[0]
              : { ...calls[1], name: 'spawn_agent', namespace: 'multi_agent_v1' },
          ];
          expect(output).toEqual(restored);
          expect(events.at(-1)).toHaveProperty('response.output', restored);
          input.push(...output, results[step] as ResponsesItem);
        }
      }
      expect(await gw.testProvider(provider, 'step-5-preview')).toMatchObject({ ok: true });
      const forwarded = mock.requests.slice(3);
      expect(forwarded).toHaveLength(4);
      expect(forwarded.map((record) => record.body.tool_choice)).toEqual([
        'auto',
        'auto',
        undefined,
        undefined,
      ]);
      for (const record of forwarded) {
        expect(record.authorization).toBe('Bearer mock-key');
        expect(record.body).not.toHaveProperty('client_metadata');
        expect(record.body.store).toBe(false);
      }
      for (const record of forwarded.slice(0, 3)) {
        expect(record.body.tools?.find((tool) => tool.name === 'apply_patch')).toEqual(
          first.tools?.find((tool) => tool.name === 'apply_patch'),
        );
        expect(record.body.tools?.some((tool) => tool.type === 'namespace')).toBe(false);
        expect(record.body.reasoning).toEqual(first.reasoning);
        expect(record.body.prompt_cache_key).toBe(first.prompt_cache_key);
        expect(record.body).not.toHaveProperty('max_output_tokens');
        expect(record.body).not.toHaveProperty('thinking');
      }
      for (const [index, record] of forwarded.slice(1, 3).entries()) {
        const history = record.body.input as ResponsesItem[];
        expect(history.filter((item) => item.type === 'reasoning')).toEqual(
          [reasoning, agentReasoning]
            .slice(0, index + 1)
            .map(({ encrypted_content: _drop, ...item }) => item),
        );
        expect(history.filter((item) => item.type.endsWith('_call'))).toEqual(
          calls.slice(0, index + 1),
        );
        expect(history.filter((item) => item.type.endsWith('_call_output'))).toEqual(
          results.slice(0, index + 1),
        );
      }
      expect(forwarded[3]?.body).toHaveProperty('max_output_tokens', 16);
      expect(forwarded[3]?.body).not.toHaveProperty('reasoning');
    },
  );
});

describe('StepFun 推理耗尽输出预算', () => {
  it.each(['step-5-preview', 'step-3.7-flash'])(
    '%s 原样保留 incomplete，连接探测不要求正文',
    async (model) => {
      const output: ResponsesItem[] = [
        { type: 'reasoning', id: 'rs_budget', summary: [], content: null, encrypted_content: null },
      ];
      const event = {
        type: 'response.incomplete',
        response: {
          id: 'resp_budget',
          status: 'incomplete',
          output,
          incomplete_details: { reason: 'max_output_tokens' },
          usage: {
            input_tokens: 10,
            output_tokens: 16,
            total_tokens: 26,
            output_tokens_details: { reasoning_tokens: 16 },
          },
        },
      };
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (_body, _record, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            sseEvent({ type: 'response.created', response: { id: 'resp_budget' } }) +
              sseEvent(event),
          );
        },
      );
      cleanups.push(() => mock.close());
      const gateway = await startModelGateway({
        fetch: async (_url, init) => fetch(`${mock.baseURL}/responses`, init),
      });
      cleanups.push(() => gateway.close());
      const provider: GatewayProvider = {
        id: 'stepfun',
        kind: 'openai-compatible',
        displayName: 'StepFun mock',
        api: 'openai-responses',
        baseURL: 'https://api.stepfun.com/v1',
        models: [{ id: model }],
        defaultModelId: model,
        apiKey: 'mock-key',
      };
      gateway.setProviders([provider]);
      const response = await postResponses(gateway.baseURL(provider.id), gateway.token, {
        ...codexRequest('1-first-turn').body,
        model,
        max_output_tokens: 16,
      });
      expect(response.status).toBe(200);
      const events = parseEvents(await response.text());
      expect(codexProblems(events)).toEqual([]);
      expect(events.at(-1)).toEqual(event);
      expect(await gateway.testProvider(provider, model)).toMatchObject({ ok: true });
      expect(mock.requests).toHaveLength(2);
      expect(mock.requests.every((record) => record.body.max_output_tokens === 16)).toBe(true);
    },
  );
});
