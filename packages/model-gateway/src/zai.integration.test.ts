// 官方文档与保守工具策略下的本机 mock；不代表两站标准 Key 的真实验收。
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

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，GLM\n*** End Patch';
const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_glm',
  summary: [{ type: 'summary_text', text: '先检查，再修改。' }],
  content: [{ type: 'reasoning_text', text: '完整推理，保持原顺序。' }],
  encrypted_content: null,
};
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

describe('Z.ai / 智谱 Responses HTTP 往返', () => {
  it.each(['https://api.z.ai/api/v1', 'https://open.bigmodel.cn/api/v1'])(
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
        id: 'glm',
        kind: 'openai-compatible',
        displayName: 'GLM mock',
        api: 'openai-responses',
        baseURL,
        models: [{ id: 'glm-5.3' }],
        defaultModelId: 'glm-5.3',
        apiKey: 'mock-key',
      };
      gw.setProviders([
        provider,
        { ...provider, id: 'native', compat: { toolChoice: 'any', supportsNamespaceTools: true } },
      ]);
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: 'glm-5.3',
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
      for (const tool_choice of ['required', { type: 'custom', name: 'apply_patch' }, 'none']) {
        const response = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          input,
          tool_choice,
        });
        expect(response.status).toBe(200);
        const events = parseEvents(await response.text());
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        if (accepted === 1) {
          const restored = [
            reasoning,
            calls[0],
            { ...calls[1], name: 'spawn_agent', namespace: 'multi_agent_v1' },
          ];
          expect(output).toEqual(restored);
          expect(events.at(-1)).toHaveProperty('response.output', restored);
          input.push(
            ...output,
            { type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' },
            { type: 'function_call_output', call_id: 'agent', output: 'checked' },
          );
        } else input.push(...output, { type: 'message', role: 'user', content: '继续检查' });
      }
      expect(await gw.testProvider(provider, 'glm-5.3')).toMatchObject({ ok: true });
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
      for (const record of forwarded.slice(1, 3)) {
        const history = record.body.input as ResponsesItem[];
        const { encrypted_content: _drop, ...replayed } = reasoning;
        expect(history.find((item) => item.type === 'reasoning')).toEqual(replayed);
        expect(history.filter((item) => item.type.endsWith('_call'))).toEqual(calls);
        expect(history.filter((item) => item.type.endsWith('_call_output'))).toEqual([
          { type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' },
          { type: 'function_call_output', call_id: 'agent', output: 'checked' },
        ]);
      }
      expect(forwarded[3]?.body).toHaveProperty('max_output_tokens', 16);
      expect(forwarded[3]?.body).not.toHaveProperty('reasoning');
    },
  );
});
