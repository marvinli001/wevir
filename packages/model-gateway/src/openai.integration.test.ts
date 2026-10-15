// 官方 Responses 的无状态历史：只做 HTTP mock 验证，真实服务另跑 adapter-codex 的契约第 3 层。

import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('OpenAI Responses 无状态历史', () => {
  it.each([false, true])(
    'include 加密推理=%s：响应字节不变，工具结果与下一回合保留完整历史、缓存与推理参数',
    async (includeEncrypted) => {
      const recorded = codexRequest('1-first-turn').body;
      const reasoning = (id: string): ResponsesItem => ({
        type: 'reasoning',
        id,
        summary: [{ type: 'summary_text', text: '检查文件后回答。' }],
        encrypted_content: `opaque-test-${id}+/==`,
      });
      const message = (id: string, text: string): ResponsesItem => ({
        type: 'message',
        id,
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
      const output: ResponsesItem[][] = [
        [
          reasoning('rs_tool'),
          {
            type: 'custom_tool_call',
            call_id: 'call_patch',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Add File: notes.md\n+# 笔记\n*** End Patch',
          },
        ],
        [reasoning('rs_answer'), message('msg_first', '已创建 notes.md。')],
        [message('msg_next', '上一回合创建了 notes.md。')],
      ];
      const firstInput = recorded.input as ResponsesItem[];
      const toolInput: ResponsesItem[] = [
        ...firstInput,
        ...(output[0] ?? []),
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Success. notes.md' },
      ];
      const nextInput: ResponsesItem[] = [
        ...toolInput,
        ...(output[1] ?? []),
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '刚才做了什么？' }],
        },
      ];
      const inputs = [firstInput, toolInput, nextInput];
      const streams = output.map((items, index) => {
        const events = [
          { type: 'response.created', response: { id: `resp_${index}`, output: [] } },
          ...items.map((item, output_index) => ({
            type: 'response.output_item.done',
            output_index,
            item,
          })),
          {
            type: 'response.completed',
            response: { id: `resp_${index}`, output: items, reasoning: { context: 'all_turns' } },
          },
        ];
        // 注释与 CRLF 能检出意外的 SSE 解析 / 重编码；密文只是测试占位值。
        return (
          ': upstream heartbeat\r\n\r\n' +
          events
            .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
            .join('')
        );
      });
      let step = 0;
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, _record, res) => {
          const index = step++;
          const expectedReasoning = output
            .slice(0, index)
            .flat()
            .filter((i) => i.type === 'reasoning');
          const receivedReasoning = Array.isArray(body.input)
            ? body.input.filter((i) => i.type === 'reasoning')
            : [];
          if (
            body.client_metadata !== undefined ||
            JSON.stringify(receivedReasoning) !== JSON.stringify(expectedReasoning)
          ) {
            return sendHttpError(res, {
              status: 400,
              message: 'replay complete encrypted reasoning without null content',
            });
          }
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.end(streams[index]);
        },
      );
      cleanups.push(() => mock.close());
      const logs: unknown[] = [];
      const gw = await startModelGateway({
        logger: {
          info: (msg, fields) => logs.push({ msg, fields }),
          warn: (msg, fields) => logs.push({ msg, fields }),
        },
      });
      cleanups.push(() => gw.close());
      const provider: GatewayProvider = {
        id: 'openai',
        kind: 'openai-compatible',
        displayName: 'OpenAI',
        api: 'openai-responses',
        baseURL: mock.baseURL,
        models: [{ id: 'gpt-6.1-sol' }],
        defaultModelId: 'gpt-6.1-sol',
        apiKey: 'placeholder-openai-api-key',
      };
      gw.setProviders([provider]);
      const { include: _include, ...base } = recorded;
      for (const [index, input] of inputs.entries()) {
        const body: ResponsesRequest = {
          ...base,
          model: 'gpt-6.1-sol',
          // 模拟锁定 Codex 给没有 content 的推理项补 null；密文必须仍原样带回。
          input: input.map((item) =>
            item.type === 'reasoning' ? { ...item, content: null } : item,
          ),
          reasoning: { effort: 'low', summary: 'auto', context: 'all_turns', mode: 'standard' },
          prompt_cache_options: { ttl: '30m' },
          ...(includeEncrypted && { include: ['reasoning.encrypted_content'] }),
        };
        const res = await postResponses(gw.baseURL(provider.id), gw.token, body, {
          headers: { 'X-OpenAI-Internal-Codex-Responses-Lite': 'true' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        const raw = await res.text();
        expect(raw).toBe(streams[index]);
        const events = parseEvents(raw);
        expect(codexProblems(events)).toEqual([]);
        expect(doneItems(events)).toEqual(output[index]);
        const { client_metadata: _metadata, ...expected } = body;
        expect(mock.requests[index]?.body).toEqual({ ...expected, input });
        expect(mock.requests[index]?.authorization).toBe(`Bearer ${provider.apiKey}`);
        expect(mock.requests[index]?.headers).not.toHaveProperty(
          'x-openai-internal-codex-responses-lite',
        );
      }
      expect(mock.requests).toHaveLength(3);
      const logText = JSON.stringify(logs);
      for (const value of [provider.apiKey, gw.token, 'opaque-test-', '检查文件后回答。']) {
        expect(logText).not.toContain(value);
      }
    },
  );
});
