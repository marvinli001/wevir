// 按官方文档构造的 HTTP 限制；不代表已用真实 Key 验收。
import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { sseEvent } from './sse.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  parseEvents,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import type { ChatRequest, GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，DeepSeek\n*** End Patch';
const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_deepseek',
  summary: [],
  content: [{ type: 'reasoning_text', text: '先检查，再修改。' }],
};
const nativeCalls: ResponsesItem[] = [
  { type: 'custom_tool_call', id: 'ct_patch', call_id: 'patch', name: 'apply_patch', input: patch },
  {
    type: 'function_call',
    id: 'fc_agent',
    call_id: 'agent',
    name: 'spawn_agent',
    namespace: 'multi_agent_v1',
    arguments: '{"message":"检查文件"}',
  },
];

describe('DeepSeek Responses 原生历史', () => {
  it.each(['deepseek-official', 'openai-compatible'] as const)(
    '%s 修正工具选择，保留 apply_patch、namespace 与三步明文推理，SSE 字节不变',
    async (kind) => {
      let accepted = 0;
      const streams: string[] = [];
      const mock = await startMockServer<ResponsesRequest>('/responses', async (body, _r, res) => {
        if (
          body.tools?.length &&
          (body.tool_choice === 'required' || typeof body.tool_choice === 'object')
        ) {
          sendHttpError(res, {
            status: 400,
            message: 'Thinking mode does not support this tool_choice',
          });
          return;
        }
        if (body.tools?.some((t) => t.type === 'custom' && t.name !== 'apply_patch')) {
          sendHttpError(res, { status: 400, message: 'only apply_patch custom tool is supported' });
          return;
        }
        if (
          Array.isArray(body.input) &&
          body.input.some(
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
            ? [reasoning, ...nativeCalls]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: '完成' }],
                },
              ];
        const stream =
          output
            .flatMap((item, output_index) => [
              sseEvent({ type: 'response.output_item.added', output_index, item }),
              sseEvent({ type: 'response.output_item.done', output_index, item }),
            ])
            .join('') +
          sseEvent({ type: 'response.completed', response: { id: `r_${accepted}`, output } });
        streams.push(stream);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(stream);
      });
      cleanups.push(() => mock.close());
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe('https://api.deepseek.com/responses');
          return fetch(`${mock.baseURL}/responses`, init);
        },
      });
      cleanups.push(() => gw.close());
      const provider: GatewayProvider = {
        id: 'deepseek',
        kind,
        displayName: 'DeepSeek mock',
        api: 'openai-responses',
        // official 的此字段只供 dsh；Codex 路由必须仍用 Responses。
        baseURL:
          kind === 'deepseek-official'
            ? 'https://api.deepseek.com/anthropic'
            : 'https://api.deepseek.com',
        models: [{ id: 'deepseek-flash' }],
        defaultModelId: 'deepseek-flash',
        apiKey: 'mock-key',
      };
      gw.setProviders([
        provider,
        { ...provider, id: 'unrestricted', compat: { toolChoice: 'any' } },
      ]);
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: provider.defaultModelId,
        reasoning: { effort: 'high' },
        tool_choice: 'required',
      };
      const rejected = await postResponses(mock.baseURL, 'mock-key', {
        ...first,
        tools: [{ type: 'custom', name: 'unsupported_custom' }],
        tool_choice: 'auto',
      });
      expect(rejected.status).toBe(400);
      await rejected.body?.cancel();
      for (const tool_choice of ['required', { type: 'function', name: 'exec_command' }]) {
        const raw = await postResponses(gw.baseURL('unrestricted'), gw.token, {
          ...first,
          tool_choice,
        });
        expect(raw.status).toBe(400);
        expect(await raw.text()).toContain('Thinking mode does not support this tool_choice');
      }
      const input = [...(first.input as ResponsesItem[])];
      for (const tool_choice of ['required', { type: 'function', name: 'exec_command' }, 'none']) {
        const res = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          input,
          tool_choice,
        });
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).toBe(streams.at(-1));
        const events = parseEvents(raw);
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        input.push(...output);
        if (input.some((item) => item.type === 'custom_tool_call_output')) {
          input.push({ type: 'message', role: 'user', content: '继续检查' });
        } else {
          expect(output).toEqual([reasoning, ...nativeCalls]);
          const replayed = input.find((item) => item.type === 'reasoning');
          if (replayed) replayed.encrypted_content = null;
          input.push(
            { type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' },
            { type: 'function_call_output', call_id: 'agent', output: 'agent started' },
          );
        }
      }
      expect(await gw.testProvider(provider, provider.defaultModelId)).toMatchObject({ ok: true });
      const forwarded = mock.requests.slice(3);
      expect(forwarded).toHaveLength(4);
      for (const record of forwarded) {
        expect(record.authorization).toBe('Bearer mock-key');
        expect(record.body).not.toHaveProperty('client_metadata');
        expect(record.body.store).toBe(false);
      }
      expect(forwarded.slice(0, 3).map((r) => r.body.tool_choice)).toEqual([
        'auto',
        'auto',
        undefined,
      ]);
      for (const record of forwarded.slice(0, 3)) {
        expect(record.body.tools).toEqual(first.tools);
        expect(record.body).not.toHaveProperty('max_output_tokens');
      }
      for (const record of forwarded.slice(1, 3)) {
        const history = record.body.input as ResponsesItem[];
        expect(history.find((item) => item.type === 'reasoning')).toEqual(reasoning);
        expect(history.filter((item) => item.type.endsWith('_call'))).toEqual(nativeCalls);
      }
      expect(forwarded[3]?.body).toHaveProperty('max_output_tokens', 16);
    },
  );
});

describe('DeepSeek Chat 思考工具限制', () => {
  it.each([
    { model: 'deepseek-flash', baseURL: 'https://api.deepseek.com' },
    { model: 'deepseek-v4-pro', baseURL: 'https://api.deepseek.com' },
    { model: 'deepseek-flash', baseURL: 'https://proxy.example.com/v1', proxy: true },
  ])(
    '$model / $baseURL 从非 auto 的 400 到工具和跨回合往返成功',
    async ({ model, baseURL, proxy }) => {
      let accepted = 0;
      const data = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
      const mock = await startMockServer<ChatRequest>(
        '/chat/completions',
        async (body, _r, res) => {
          if (
            body.tools &&
            (body.tool_choice === 'required' || typeof body.tool_choice === 'object')
          ) {
            sendHttpError(res, {
              status: 400,
              message: 'forced tool_choice is unsupported in thinking mode',
            });
            return;
          }
          if (
            body.messages.some(
              (m) => m.role === 'assistant' && typeof m.reasoning_content !== 'string',
            )
          ) {
            sendHttpError(res, {
              status: 400,
              message: 'all assistant reasoning_content is required',
            });
            return;
          }
          const index = accepted++;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            data({ reasoning_content: index === 0 ? '先检查，再修改。' : '已完成检查。' }) +
              (index === 0
                ? data(
                    {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'patch',
                          type: 'function',
                          function: {
                            name: 'apply_patch',
                            arguments: JSON.stringify({ input: patch }),
                          },
                        },
                      ],
                    },
                    'tool_calls',
                  )
                : data({ content: '完成' }, 'stop')) +
              'data: [DONE]\n\n',
          );
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          expect(String(url)).toBe(`${baseURL}/chat/completions`);
          return fetch(`${mock.baseURL}/chat/completions`, init);
        },
      });
      cleanups.push(() => gw.close());
      const provider: GatewayProvider = {
        id: 'deepseek-chat',
        kind: 'openai-compatible',
        displayName: 'DeepSeek mock',
        api: 'openai-completions',
        baseURL,
        models: [{ id: model }],
        defaultModelId: model,
        apiKey: 'mock-key',
        ...(proxy && { compat: { thinkingFormat: 'deepseek', toolChoice: 'auto_only' } }),
      };
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model,
        reasoning: { effort: 'high' },
      };
      gw.setProviders([{ ...provider, compat: { ...provider.compat, toolChoice: 'any' } }]);
      for (const tool_choice of ['required', { type: 'function', name: 'exec_command' }]) {
        const res = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          tool_choice,
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('forced tool_choice');
      }
      gw.setProviders([provider]);
      const input = [...(first.input as ResponsesItem[])];
      for (const tool_choice of ['required', { type: 'custom', name: 'apply_patch' }, 'none']) {
        const res = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          input,
          tool_choice,
        });
        expect(res.status).toBe(200);
        const events = await readEvents(res);
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        // Codex 回放时可能只留下 encrypted_content，第二步仍应恢复全部推理。
        input.push(
          ...output.map((item) => (item.type === 'reasoning' ? { ...item, content: null } : item)),
        );
        if (input.some((item) => item.type === 'custom_tool_call_output'))
          input.push({ type: 'message', role: 'user', content: '继续检查' });
        else {
          expect(output.find((item) => item.type === 'custom_tool_call')).toMatchObject({
            name: 'apply_patch',
            input: patch,
            call_id: 'patch',
          });
          input.push({ type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' });
        }
      }
      expect(await gw.testProvider(provider, model)).toMatchObject({ ok: true });
      const forwarded = mock.requests.slice(2);
      expect(forwarded).toHaveLength(4);
      expect(forwarded[0]?.body.tool_choice).toBe('auto');
      expect(forwarded[1]?.body.tool_choice).toBe('auto');
      expect(forwarded[2]?.body).not.toHaveProperty('tool_choice');
      for (const record of forwarded.slice(1, 3)) {
        expect(record.body.thinking).toEqual({ type: 'enabled' });
        expect(record.body.messages.find((m) => m.tool_calls)?.reasoning_content).toBe(
          '先检查，再修改。',
        );
        for (const m of record.body.messages.filter((message) => message.role === 'assistant'))
          expect(typeof m.reasoning_content).toBe('string');
      }
      expect(
        forwarded[2]?.body.messages
          .filter((m) => m.role === 'assistant')
          .map((m) => m.reasoning_content),
      ).toEqual(['先检查，再修改。', '已完成检查。']);
      expect(forwarded[3]?.body.max_tokens).toBe(16);
    },
  );
});
