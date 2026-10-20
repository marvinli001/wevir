// 脚本化的 OpenAI Chat Completions 流式服务（POST …/chat/completions），代表只有 Chat 接口的上游。推理按 DeepSeek 的方式放在 delta.reasoning_content；
// 用法块按 stream_options.include_usage 最后单独发。另有 finish_reason、流中的错误、提前断开、原样的 chunk。

import { flatToolName } from '../tools.js';
import type { ChatRequest } from '../types.js';
import { disconnect, type MockServer, sendHttpError, startMockServer } from './mock-server.js';
import { type ModelView, nextCallId, pause, type Script } from './model-script.js';

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : '';

export function viewOfChat(body: ChatRequest, index: number): ModelView {
  let lastUserText = '';
  for (const m of body.messages) {
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (!text.trimStart().startsWith('<') && !text.startsWith('[')) lastUserText = text;
    }
  }
  return { index, lastUserText };
}

export function startMockChat(script: Script): Promise<MockServer<ChatRequest>> {
  let count = 0;
  return startMockServer<ChatRequest>('/chat/completions', async (body, record, res) => {
    const index = count++;
    const reply = script(viewOfChat(body, index));
    if (reply.httpError) return sendHttpError(res, reply.httpError);
    const raw = (data: unknown) =>
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    const send = (delta: unknown, finish: string | null = null) =>
      raw({
        id: `chatcmpl_${index}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (reply.rawChunks) {
      for (const chunk of reply.rawChunks) {
        if (record.aborted) return;
        raw(chunk);
        if (reply.delayMs) await pause(reply.delayMs);
      }
      if (reply.disconnect) await disconnect(res);
      else res.end();
      return;
    }
    send({ role: 'assistant', content: '' });
    for (const piece of reply.reasoning ?? []) {
      if (record.aborted) return;
      send({ reasoning_content: piece });
      if (reply.delayMs) await pause(reply.delayMs);
    }
    for (const piece of reply.text ?? []) {
      if (record.aborted) return;
      send({ content: piece });
      if (reply.delayMs) await pause(reply.delayMs);
    }
    if (record.aborted) return;
    if (reply.disconnect) {
      await disconnect(res);
      return;
    }
    if (reply.failed) {
      raw({ error: { message: reply.failed.message, code: reply.failed.code } });
      res.end();
      return;
    }
    const calls = reply.toolCalls ?? [];
    calls.forEach((call, i) => {
      // Chat 只有函数工具：按网关摊平的规则得出函数名。参数分两片发，验证网关按 index 拼接。
      const name = flatToolName(call.name, call.namespace);
      const json = JSON.stringify(
        call.kind === 'custom' ? { input: call.input ?? '' } : (call.args ?? {}),
      );
      send({
        tool_calls: [
          {
            index: i,
            id: nextCallId('chatcall'),
            type: 'function',
            function: { name, arguments: json.slice(0, 5) },
          },
        ],
      });
      send({ tool_calls: [{ index: i, function: { arguments: json.slice(5) } }] });
    });
    send({}, reply.finishReason ?? (calls.length > 0 ? 'tool_calls' : 'stop'));
    if (body.stream_options?.include_usage) {
      raw({
        id: `chatcmpl_${index}`,
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: reply.reasoning?.length ?? 0 },
        },
      });
    }
    res.end('data: [DONE]\n\n');
  });
}
