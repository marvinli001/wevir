// Gemini 的限制用本机 HTTP mock 重现；不代表真实服务或真实 Key 已验收。
import { afterEach, describe, expect, it } from 'vitest';
import { toChatRequest } from './chat/request.js';
import { startModelGateway } from './gateway.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import type {
  ChatRequest,
  GatewayProvider,
  JsonObject,
  ResponsesItem,
  ResponsesRequest,
} from './types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const provider = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'gemini',
  kind: 'openai-compatible',
  displayName: 'Google AI Studio',
  api: 'openai-completions',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: 'AQ.mock-not-a-real-key',
  models: [{ id: 'gemini-3.8-flash' }],
  defaultModelId: 'gemini-3.8-flash',
  ...patch,
});
const data = (delta: JsonObject, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const PATCH = '*** Begin Patch\n*** Add File: gemini.txt\n+ok\n*** End Patch';

async function mockGemini(schema = false) {
  const mock = await startMockServer<ChatRequest>(
    '/chat/completions',
    async (body, _record, res) => {
      const reject = (message: string) => sendHttpError(res, { status: 400, message });
      if (body.reasoning_effort === 'minimal') return reject('minimal is not supported');
      if (body.extra_body !== undefined) return reject('reasoning_effort overlaps thinking_config');
      if (
        schema &&
        body.tools?.some((t) => {
          const parameters = JSON.stringify(t.function.parameters);
          return (
            parameters.includes('"additionalProperties":') || parameters.includes('"properties":{}')
          );
        })
      )
        return reject('unsupported tool Schema');
      const steps = body.messages.filter((m) => m.tool_calls !== undefined);
      for (const message of steps) {
        const calls = message.tool_calls ?? [];
        const index = body.messages.indexOf(message);
        const results = body.messages.slice(index + 1, index + 1 + calls.length);
        if (
          results.some((m) => m.role !== 'tool') ||
          calls.some((c) => !results.some((m) => m.tool_call_id === c.id))
        )
          return reject('all calls must precede all results');
        const first = calls[0];
        if (
          JSON.stringify(first?.extra_content) !==
          JSON.stringify({
            google: {
              thought_signature: first?.id === 'c1' ? 'step-1-signature' : 'step-2-signature',
            },
          })
        )
          return reject('missing or wrong thought_signature');
        if (calls.slice(1).some((c) => c.extra_content !== undefined))
          return reject('parallel signatures must stay on their original call');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (schema || steps.length === 2 || body.messages[0]?.content === 'ping') {
        res.end(`${data({ content: '完成' }, 'stop')}data: [DONE]\n\n`);
        return;
      }
      const first = steps.length === 0;
      res.write(
        data({
          tool_calls: first
            ? [
                {
                  index: 0,
                  id: 'c1',
                  function: { name: 'apply_patch', arguments: JSON.stringify({ input: PATCH }) },
                },
                {
                  index: 1,
                  id: 'c2',
                  function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
                },
              ]
            : [
                {
                  index: 0,
                  id: 'c3',
                  function: { name: 'exec_command', arguments: '{"cmd":"cat gemini.txt"}' },
                },
              ],
        }),
      );
      // 参数先齐，最后的空文本分片才带第一个调用的签名；finish_reason 仍在后面。
      res.write(
        data({
          content: '',
          tool_calls: [
            {
              index: 0,
              extra_content: {
                google: { thought_signature: first ? 'step-1-signature' : 'step-2-signature' },
              },
            },
          ],
        }),
      );
      res.end(`${data({}, 'stop')}data: [DONE]\n\n`);
    },
  );
  cleanups.push(() => mock.close());
  const send: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.hostname !== 'generativelanguage.googleapis.com' ||
      !url.pathname.endsWith('/chat/completions')
    )
      throw new Error('mock only accepts the Gemini Chat endpoint');
    return fetch(`${mock.baseURL}/chat/completions`, init);
  };
  const gateway = await startModelGateway({ fetch: send });
  cleanups.push(() => gateway.close());
  return { mock, gateway };
}

describe('Gemini Chat 方言的真实 HTTP 往返', () => {
  it.each(['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-4-argon'])(
    '%s：minimal 从 400 到 low；并行调用后再调用，全部签名与连续结果保留',
    async (model) => {
      const { mock, gateway } = await mockGemini();
      gateway.setProviders([provider()]);
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model,
        reasoning: { effort: 'minimal' },
      };
      const raw = toChatRequest(first, provider({ baseURL: mock.baseURL })).request;
      const rejected = await fetch(`${mock.baseURL}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify(raw),
      });
      expect(rejected.status).toBe(400);
      await rejected.text();
      let body = first;
      for (let step = 0; step < 3; step++) {
        const response = await postResponses(gateway.baseURL('gemini'), gateway.token, body);
        expect(response.status).toBe(200);
        const events = await readEvents(response);
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        if (step === 0)
          expect(output.find((i) => i.type === 'custom_tool_call')?.input).toBe(PATCH);
        if (step === 2) {
          expect(output.at(-1)).toMatchObject({
            type: 'message',
            content: [{ type: 'output_text', text: '完成' }],
          });
          break;
        }
        const results = output
          .filter((i) => i.type.endsWith('tool_call') || i.type === 'function_call')
          .map((i) => ({
            type:
              i.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output',
            call_id: i.call_id,
            output: 'ok',
          }));
        body = { ...body, input: [...(body.input as ResponsesItem[]), ...output, ...results] };
      }
      const history = mock.requests.at(-1)?.body;
      expect(history?.reasoning_effort).toBe('low');
      const steps = history?.messages.filter((m) => m.tool_calls !== undefined);
      expect(steps?.map((m) => m.tool_calls?.[0]?.extra_content)).toEqual([
        { google: { thought_signature: 'step-1-signature' } },
        { google: { thought_signature: 'step-2-signature' } },
      ]);
      // 确认 mock 真会拒收丢签名或打散同批结果的请求。
      for (const bad of ['signature', 'order']) {
        const broken = structuredClone(history) as ChatRequest;
        const index = broken.messages.findIndex((m) => m.tool_calls !== undefined);
        if (bad === 'signature') delete broken.messages[index]?.tool_calls?.[0]?.extra_content;
        else broken.messages.splice(index + 2, 0, { role: 'user', content: 'interleaved' });
        const response = await fetch(`${mock.baseURL}/chat/completions`, {
          method: 'POST',
          body: JSON.stringify(broken),
        });
        expect(response.status).toBe(400);
        await response.text();
      }
    },
  );

  it('拒收 additionalProperties 与空 properties 的 mock：默认 400，显式开关后录制工具请求通过', async () => {
    const { mock, gateway } = await mockGemini(true);
    const body = codexRequest('1-first-turn').body;
    body.model = 'gemini-3.8-flash';
    body.tools?.push({
      type: 'function',
      name: 'no_args',
      parameters: { type: 'object', properties: {} },
    });
    for (const geminiToolSchema of [undefined, false, true]) {
      gateway.setProviders([provider({ compat: { geminiToolSchema } })]);
      const response = await postResponses(gateway.baseURL('gemini'), gateway.token, body);
      expect(response.status).toBe(geminiToolSchema === true ? 200 : 400);
      if (response.ok) expect(codexProblems(await readEvents(response))).toEqual([]);
      else await response.text();
    }
    const tools = mock.requests.at(-1)?.body.tools;
    expect(tools?.find((t) => t.function.name === 'no_args')?.function.parameters).toMatchObject({
      properties: { _wevir_unused: { type: 'boolean' } },
    });
  });

  it.each(['AQ.mock-not-a-real-key', 'AIza-mock-not-a-real-key'])(
    'provider.test 不按 Key 前缀拦截（%s）',
    async (apiKey) => {
      const { mock, gateway } = await mockGemini();
      const result = await gateway.testProvider(provider({ apiKey }), 'gemini-3.8-flash');
      expect(result.ok).toBe(true);
      expect(mock.requests[0]?.authorization).toBe(`Bearer ${apiKey}`);
      expect(mock.requests[0]?.body).not.toHaveProperty('tools');
    },
  );
});
