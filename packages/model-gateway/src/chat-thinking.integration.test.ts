// 真实 HTTP mock：缺思考字段、思考开关不对或没有原样带回历史时返回 400。

import { afterEach, describe, expect, it } from 'vitest';
import { type ChatThinkingFormat, decodeChatReplay } from './chat/thinking.js';
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const provider = (baseURL: string, format?: ChatThinkingFormat): GatewayProvider => ({
  id: 'thinking',
  kind: 'openai-compatible',
  displayName: 'Thinking',
  api: 'openai-completions',
  baseURL,
  apiKey: 'mock-key',
  models: [{ id: 'wevir-mock' }],
  defaultModelId: 'wevir-mock',
  compat: { thinkingFormat: format, toolChoice: 'auto_only' },
});
const data = (delta: JsonObject, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;

describe('带工具的第二步请求', () => {
  it.each(['deepseek', 'zai', 'minimax', 'tencent'] as const)(
    '%s 默认补 reasoning_content，mock 从 400 到 200',
    async (format) => {
      const mock = await startMockServer<ChatRequest>(
        '/chat/completions',
        async (body, _record, res) => {
          if (
            body.messages.some(
              (message) =>
                message.role === 'assistant' && typeof message.reasoning_content !== 'string',
            )
          ) {
            sendHttpError(res, {
              status: 400,
              message: 'assistant messages require reasoning_content',
            });
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            data({ reasoning_content: '已检查' }) +
              data({ content: '完成' }, 'stop') +
              'data: [DONE]\n\n',
          );
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway();
      cleanups.push(() => gw.close());
      const recorded = codexRequest('2-tool-results').body;
      const body: ResponsesRequest = {
        ...recorded,
        input: [
          { type: 'message', role: 'user', content: '之前的问题' },
          { type: 'message', role: 'assistant', content: '之前没有思考的回答' },
          ...(recorded.input as ResponsesItem[]),
        ],
        tool_choice: 'required',
      };
      gw.setProviders([provider(mock.baseURL)]);
      const rejected = await postResponses(gw.baseURL('thinking'), gw.token, body);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain('reasoning_content');
      gw.setProviders([provider(mock.baseURL, format)]);
      const accepted = await postResponses(gw.baseURL('thinking'), gw.token, body);
      expect(accepted.status).toBe(200);
      const events = await readEvents(accepted);
      expect(codexProblems(events)).toEqual([]);
      const fixed = mock.requests[1]?.body;
      expect(fixed?.messages[1]?.reasoning_content).toBe('');
      expect(
        fixed?.messages.find((message) => message.tool_calls !== undefined)?.reasoning_content,
      ).toBe('先建文件，再看目录。');
      expect(fixed?.tool_choice).toBe('auto');
      if (format === 'minimax') expect(fixed?.reasoning_split).toBe(true);
      if (format === 'zai')
        expect(fixed?.thinking).toEqual({ type: 'enabled', clear_thinking: false });
      if (format === 'deepseek' || format === 'tencent')
        expect(fixed?.thinking).toEqual({ type: 'enabled' });
    },
  );
});

describe('MiniMax 的两种推理返回与历史回传', () => {
  it.each(['content', 'reasoning_details'] as const)(
    '%s → Responses → 带工具结果的下一步，原始字段保留',
    async (field) => {
      const raw = '\n<think>先建文件\n再确认。</think>\n准备执行。';
      const details = [
        {
          type: 'reasoning.text',
          id: 'r1',
          index: 0,
          format: 'MiniMax-response-v1',
          text: '先建文件\n再确认。',
          signature: 'mock-signature',
        },
      ];
      const mock = await startMockServer<ChatRequest>(
        '/chat/completions',
        async (body, _record, res) => {
          const history = body.messages.find((message) => message.tool_calls !== undefined);
          if (
            body.reasoning_split !== true ||
            (history !== undefined &&
              (history.reasoning_content !== details[0]?.text ||
                (field === 'content'
                  ? history.content !== raw
                  : JSON.stringify(history.reasoning_details) !== JSON.stringify(details))))
          ) {
            sendHttpError(res, {
              status: 400,
              message: 'the complete assistant thinking must be replayed',
            });
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (history !== undefined) {
            res.end(`${data({ content: '已完成' }, 'stop')}data: [DONE]\n\n`);
            return;
          }
          const reasoning =
            field === 'content'
              ? data({ content: '\n<th' }) + data({ content: raw.slice(4) })
              : data({ reasoning_details: details });
          res.end(
            reasoning +
              data(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_patch',
                      type: 'function',
                      function: {
                        name: 'apply_patch',
                        arguments: JSON.stringify({
                          input: '*** Begin Patch\n*** Add File: ok.txt\n+ok\n*** End Patch',
                        }),
                      },
                    },
                  ],
                },
                'tool_calls',
              ) +
              'data: [DONE]\n\n',
          );
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway();
      cleanups.push(() => gw.close());
      gw.setProviders([provider(mock.baseURL, 'minimax')]);
      const first = codexRequest('1-first-turn').body;
      const response = await postResponses(gw.baseURL('thinking'), gw.token, first);
      expect(response.status).toBe(200);
      const events = await readEvents(response);
      expect(codexProblems(events)).toEqual([]);
      const output = doneItems(events) as ResponsesItem[];
      expect(output.find((item) => item.type === 'custom_tool_call')?.call_id).toBe('call_patch');
      if (field === 'content') {
        expect(
          events
            .filter((event) => event.type === 'response.output_text.delta')
            .map((event) => event.delta)
            .join(''),
        ).toBe('\n准备执行。');
      }
      expect(output.some((item) => decodeChatReplay(item.encrypted_content) !== undefined)).toBe(
        true,
      );
      const second: ResponsesRequest = {
        ...first,
        input: [
          ...(first.input as ResponsesItem[]),
          // 锁定 Codex 带回时明文可能没有，只剩 encrypted_content。
          ...output.map((item) => (item.type === 'reasoning' ? { ...item, content: null } : item)),
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch',
            output: 'Success. Updated ok.txt',
          },
        ],
      };
      const followup = await postResponses(gw.baseURL('thinking'), gw.token, second);
      expect(followup.status).toBe(200);
      expect(codexProblems(await readEvents(followup))).toEqual([]);
      const assistant = mock.requests[1]?.body.messages.find(
        (message) => message.tool_calls !== undefined,
      );
      expect(assistant?.reasoning_content).toBe(details[0]?.text);
      if (field === 'content') expect(assistant?.content).toBe(raw);
      else expect(assistant?.reasoning_details).toEqual(details);
    },
  );
});
