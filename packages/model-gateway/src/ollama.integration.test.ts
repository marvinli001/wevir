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
  for (const close of cleanups.splice(0).reverse()) await close();
});
const patch = '*** Begin Patch\n*** Add File: hello.txt\n+Hello Ollama\n*** End Patch';

describe('Ollama HTTP mock tool round trip', () => {
  it.each(['http://127.0.0.1:11434/v1', 'https://ollama.com/v1'])(
    '%s accepts converted tools, replays them with reasoning and retains Bearer',
    async (baseURL) => {
      const cloud = baseURL.startsWith('https://ollama.com');
      const provider: GatewayProvider = {
        id: 'ollama',
        kind: 'openai-compatible',
        displayName: 'Ollama',
        api: 'openai-responses',
        baseURL,
        models: [{ id: 'gpt-oss:20b' }],
        defaultModelId: 'gpt-oss:20b',
        apiKey: 'ollama',
      };
      let accepted = 0;
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, record, res) => {
          if (
            body.tools?.some(
              (tool) => tool.type === 'custom' || (cloud && tool.type === 'namespace'),
            ) ||
            (body.tool_choice !== undefined && body.tool_choice !== 'auto')
          )
            return sendHttpError(res, {
              status: 400,
              message: 'function tools and auto choice only',
            });
          expect(record.authorization).toBe('Bearer ollama');
          expect(body.store).toBe(false);
          expect(body).not.toHaveProperty('client_metadata');
          if (accepted > 0 && (body.tools?.length ?? 0) > 0) {
            const input = body.input as ResponsesItem[];
            expect(
              input.some(
                (item) =>
                  item.type === 'function_call' &&
                  item.name === 'apply_patch' &&
                  item.arguments === JSON.stringify({ input: patch }),
              ),
            ).toBe(true);
            expect(
              input.some(
                (item) => item.type === 'function_call_output' && item.call_id === 'patch',
              ),
            ).toBe(true);
            expect(input.find((item) => item.type === 'reasoning')).toMatchObject({
              summary: [{ type: 'summary_text', text: 'Plan' }],
            });
          }
          accepted++;
          const output: ResponsesItem[] =
            accepted === 1
              ? [
                  {
                    type: 'reasoning',
                    id: 'rs',
                    summary: [{ type: 'summary_text', text: 'Plan' }],
                  },
                  {
                    type: 'function_call',
                    id: 'fc_patch',
                    call_id: 'patch',
                    name: 'apply_patch',
                    arguments: JSON.stringify({ input: patch }),
                  },
                  {
                    type: 'function_call',
                    id: 'fc_agent',
                    call_id: 'agent',
                    name: cloud ? 'multi_agent_v1__spawn_agent' : 'spawn_agent',
                    ...(!cloud && { namespace: 'multi_agent_v1' }),
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    id: `msg_${accepted}`,
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Done' }],
                  },
                ];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            output.map((item) => sseEvent({ type: 'response.output_item.done', item })).join('') +
              sseEvent({
                type: 'response.completed',
                response: { id: `resp_${accepted}`, status: 'completed', output },
              }),
          );
        },
      );
      cleanups.push(() => mock.close());
      const gateway = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe(`${baseURL}/responses`);
          return fetch(`${mock.baseURL}/responses`, init);
        },
      });
      cleanups.push(() => gateway.close());
      gateway.setProviders([provider]);
      const first = {
        ...codexRequest('1-first-turn').body,
        model: provider.defaultModelId,
        tool_choice: 'required',
      };
      const rejected = await postResponses(mock.baseURL, 'ollama', first);
      expect(rejected.status).toBe(400);
      await rejected.body?.cancel();
      const response = await postResponses(gateway.baseURL(provider.id), gateway.token, first);
      expect(response.status).toBe(200);
      const events = await readEvents(response);
      expect(codexProblems(events)).toEqual([]);
      const calls = doneItems(events) as ResponsesItem[];
      expect(calls).toContainEqual(
        expect.objectContaining({ type: 'custom_tool_call', name: 'apply_patch', input: patch }),
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          type: 'function_call',
          name: 'spawn_agent',
          namespace: 'multi_agent_v1',
        }),
      );
      const input: ResponsesItem[] = [
        ...(first.input as ResponsesItem[]),
        ...calls,
        { type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' },
        { type: 'function_call_output', call_id: 'agent', output: 'started' },
      ];
      for (let step = 0; step < 2; step++) {
        const next = await postResponses(gateway.baseURL(provider.id), gateway.token, {
          ...first,
          input,
        });
        expect(codexProblems(await readEvents(next))).toEqual([]);
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue' }],
        });
      }
      expect(await gateway.testProvider(provider, provider.defaultModelId)).toMatchObject({
        ok: true,
      });
      expect(accepted).toBe(4);
    },
  );
});
