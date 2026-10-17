// 官方文档约束下的本机 HTTP mock；不代表真实 Kimi 服务已验收。
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
import { isObject } from './tools.js';
import type { GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好，Kimi\n*** End Patch';
const reasoning: ResponsesItem = {
  type: 'reasoning',
  id: 'rs_kimi',
  summary: [{ type: 'summary_text', text: '先检查，再修改。' }],
  encrypted_content: null,
};
const calls: ResponsesItem[] = [
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

function imageParts(body: ResponsesRequest): unknown[] {
  if (!Array.isArray(body.input)) return [];
  return body.input.flatMap((item) => {
    const parts = item.type === 'message' ? item.content : item.output;
    return Array.isArray(parts)
      ? parts.filter((part) => isObject(part) && part.type === 'input_image')
      : [];
  });
}

describe('Kimi Responses HTTP 往返', () => {
  it.each(['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'])(
    '%s 从非 auto / 网址图片的 400 到三步原生工具、推理与图片回放',
    async (baseURL) => {
      let accepted = 0;
      const streams: string[] = [];
      const mock = await startMockServer<ResponsesRequest>('/responses', async (body, _r, res) => {
        if (body.tools?.length && body.tool_choice !== undefined && body.tool_choice !== 'auto') {
          sendHttpError(res, { status: 400, message: 'tool_choice only supports auto' });
          return;
        }
        if (
          imageParts(body).some(
            (part) =>
              !isObject(part) ||
              typeof part.image_url !== 'string' ||
              !part.image_url.startsWith('data:'),
          )
        ) {
          sendHttpError(res, { status: 400, message: 'input_image requires a data URL' });
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
        if (body.model !== 'kimi-k3') {
          sendHttpError(res, { status: 400, message: 'Responses currently supports kimi-k3' });
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
        const stream =
          output
            .flatMap((item, output_index) => [
              sseEvent({ type: 'response.output_item.added', output_index, item }),
              sseEvent({ type: 'response.output_item.done', output_index, item }),
            ])
            .join('') +
          sseEvent({ type: 'response.completed', response: { id: `resp_${accepted}`, output } });
        streams.push(stream);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(stream);
      });
      cleanups.push(() => mock.close());
      const gw = await startModelGateway({
        fetch: async (url, init) => {
          // 只允许既定的上游请求；任何下载外部图片的尝试都会令测试失败。
          expect(String(url)).toBe(`${baseURL}/responses`);
          return fetch(`${mock.baseURL}/responses`, init);
        },
      });
      cleanups.push(() => gw.close());
      const provider: GatewayProvider = {
        id: 'kimi',
        kind: 'openai-compatible',
        displayName: 'Kimi mock',
        api: 'openai-responses',
        baseURL,
        models: [{ id: 'kimi-k3', supportsImages: true }],
        defaultModelId: 'kimi-k3',
        apiKey: 'mock-key',
      };
      gw.setProviders([provider, { ...provider, id: 'any', compat: { toolChoice: 'any' } }]);
      const first: ResponsesRequest = {
        ...codexRequest('1-first-turn').body,
        model: 'kimi-k3',
        reasoning: { effort: 'high' },
      };
      for (const tool_choice of ['required', { type: 'custom', name: 'apply_patch' }]) {
        const raw = await postResponses(gw.baseURL('any'), gw.token, { ...first, tool_choice });
        expect(raw.status).toBe(400);
        expect(await raw.text()).toContain('tool_choice only supports auto');
      }
      const urlImage = { type: 'input_image', image_url: 'https://images.example.com/a.png' };
      const raw = await postResponses(mock.baseURL, 'mock-key', {
        ...first,
        input: [{ type: 'message', role: 'user', content: [urlImage] }],
      });
      expect(raw.status).toBe(400);
      expect(await raw.text()).toContain('input_image requires a data URL');

      const dataImage = { type: 'input_image', image_url: 'data:image/png;base64,AAA' };
      const input: ResponsesItem[] = [
        ...(first.input as ResponsesItem[]),
        { type: 'message', role: 'user', content: [dataImage, urlImage] },
      ];
      for (const tool_choice of ['required', { type: 'custom', name: 'apply_patch' }, 'none']) {
        const response = await postResponses(gw.baseURL(provider.id), gw.token, {
          ...first,
          input,
          tool_choice,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        const text = await response.text();
        expect(text).toBe(streams.at(-1));
        const events = parseEvents(text);
        expect(codexProblems(events)).toEqual([]);
        const output = doneItems(events) as ResponsesItem[];
        input.push(
          ...output.map((item) => (item.type === 'reasoning' ? { ...item, content: null } : item)),
        );
        if (accepted === 1) {
          expect(output).toEqual([reasoning, ...calls]);
          input.push(
            { type: 'custom_tool_call_output', call_id: 'patch', output: 'file added' },
            { type: 'function_call_output', call_id: 'agent', output: [dataImage, urlImage] },
          );
        } else input.push({ type: 'message', role: 'user', content: '继续检查' });
      }
      expect(await gw.testProvider(provider, 'kimi-k3')).toMatchObject({ ok: true });
      const forwarded = mock.requests.slice(3);
      expect(forwarded).toHaveLength(4);
      for (const record of forwarded) {
        expect(record.authorization).toBe('Bearer mock-key');
        expect(record.body).not.toHaveProperty('client_metadata');
        expect(record.body.store).toBe(false);
      }
      expect(forwarded.slice(0, 3).map((record) => record.body.tool_choice)).toEqual([
        'auto',
        'auto',
        undefined,
      ]);
      for (const record of forwarded.slice(0, 3)) {
        expect(record.body.tools).toEqual(first.tools);
        expect(record.body.reasoning).toEqual({ effort: 'high' });
        expect(record.body).not.toHaveProperty('max_output_tokens');
        expect(
          imageParts(record.body).every(
            (part) => JSON.stringify(part) === JSON.stringify(dataImage),
          ),
        ).toBe(true);
      }
      for (const record of forwarded.slice(1, 3)) {
        const history = record.body.input as ResponsesItem[];
        const { encrypted_content: _drop, ...replayed } = reasoning;
        expect(history.find((item) => item.type === 'reasoning')).toEqual(replayed);
        expect(history.filter((item) => item.type.endsWith('_call'))).toEqual(calls);
        expect(
          history.find((item) => item.call_id === 'patch' && item.type.endsWith('_output')),
        ).toMatchObject({ output: 'file added' });
        expect(
          history.find((item) => item.call_id === 'agent' && item.type.endsWith('_output')),
        ).toMatchObject({ output: [dataImage] });
      }
      expect(forwarded[3]?.body).toHaveProperty('max_output_tokens', 16);
      expect(forwarded[3]?.body).not.toHaveProperty('reasoning');
    },
  );
});
