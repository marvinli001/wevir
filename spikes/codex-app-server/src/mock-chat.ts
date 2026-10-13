// 脚本化的 OpenAI Chat Completions 流式服务（POST …/chat/completions），代表只有 Chat 接口的上游。
// 推理按 DeepSeek 的方式放在 delta.reasoning_content；用法块按 stream_options.include_usage 最后单独发。

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockServer, RecordedRequest } from './mock-responses.ts';
import { redactHeaders } from './mock-responses.ts';
import { type ModelView, nextCallId, type Script } from './model-script.ts';

export interface ChatMessage {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  [key: string]: unknown;
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : '';

export function viewOfChat(body: ChatRequest, index: number): ModelView {
  let lastUser = -1;
  let lastUserText = '';
  body.messages.forEach((m, i) => {
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (!text.trimStart().startsWith('<')) {
        lastUser = i;
        lastUserText = text;
      }
    }
  });
  return {
    index,
    lastUserText,
    toolOutputs: body.messages
      .slice(lastUser + 1)
      .filter((m) => m.role === 'tool')
      .map((m) => textOf(m.content)),
    allText: JSON.stringify(body.messages),
  };
}

export async function startMockChat(script: Script): Promise<MockServer<ChatRequest>> {
  const requests: RecordedRequest<ChatRequest>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock: 不支持 ${req.method} ${req.url}` } }));
        return;
      }
      const body = JSON.parse(raw) as ChatRequest;
      const view = viewOfChat(body, requests.length);
      const record: RecordedRequest<ChatRequest> = {
        path: req.url,
        headers: redactHeaders(req.headers),
        body,
        view,
        aborted: false,
      };
      requests.push(record);
      res.on('close', () => {
        if (!res.writableFinished) record.aborted = true;
      });
      const reply = script(view);
      if (reply.httpError) {
        res.writeHead(reply.httpError.status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: reply.httpError.message, type: 'invalid_request_error' },
          }),
        );
        return;
      }
      const pause = () => new Promise((r) => setTimeout(r, reply.delayMs ?? 0));
      const send = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl_${view.index}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ role: 'assistant', content: '' });
      for (const piece of reply.reasoning ?? []) {
        if (record.aborted) return;
        send({ reasoning_content: piece });
        if (reply.delayMs) await pause();
      }
      for (const piece of reply.text ?? []) {
        if (record.aborted) return;
        send({ content: piece });
        if (reply.delayMs) await pause();
      }
      if (record.aborted) return;
      const calls = reply.toolCalls ?? [];
      calls.forEach((call, index) => {
        // Chat 只有函数工具：自定义工具与命名空间由网关在请求里摊平成函数，这里按摊平后的名字回。
        const name = call.namespace === undefined ? call.name : `${call.namespace}__${call.name}`;
        const args = call.kind === 'custom' ? { input: call.input ?? '' } : (call.args ?? {});
        const json = JSON.stringify(args);
        // 参数分两片发，验证网关按 index 拼接。
        send({
          tool_calls: [
            {
              index,
              id: nextCallId('chatcall'),
              type: 'function',
              function: { name, arguments: json.slice(0, 5) },
            },
          ],
        });
        send({ tool_calls: [{ index, function: { arguments: json.slice(5) } }] });
      });
      send({}, calls.length > 0 ? 'tool_calls' : 'stop');
      if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl_${view.index}`,
            object: 'chat.completion.chunk',
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 64 },
              completion_tokens_details: { reasoning_tokens: reply.reasoning?.length ?? 0 },
            },
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
