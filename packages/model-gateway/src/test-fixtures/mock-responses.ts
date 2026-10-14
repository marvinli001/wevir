// 改写自 spikes/codex-app-server/src/mock-responses.ts：脚本化的 OpenAI Responses 流式服务（POST …/responses）。
// 事件格式照 upstream/codex/codex-rs/core/tests/common/responses.rs 的 ev_* 帮手。custom 工具调用按请求里的
// 工具定义渲染：请求里有同名的 custom 工具就回 custom_tool_call，否则回参数是 `{"input"}` 的 function_call
// （模拟网关把 custom 工具摊平之后的上游）。

import type { ResponsesItem, ResponsesRequest, ResponsesTool } from '../types.js';
import { disconnect, type MockServer, sendHttpError, startMockServer } from './mock-server.js';
import { type ModelView, nextCallId, pause, type Reply, type Script } from './model-script.js';

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : '';

export function viewOfResponses(body: ResponsesRequest, index: number): ModelView {
  let lastUserText = '';
  const input = typeof body.input === 'string' ? [] : body.input;
  for (const item of input) {
    if (item.type === 'message' && item.role === 'user') {
      const text = textOf(item.content);
      if (!text.trimStart().startsWith('<')) lastUserText = text;
    }
  }
  if (typeof body.input === 'string') lastUserText = body.input;
  return { index, lastUserText };
}

function hasCustomTool(tools: readonly ResponsesTool[] | undefined, name: string): boolean {
  return (tools ?? []).some(
    (t) =>
      (t.type === 'custom' && t.name === name) ||
      (t.type === 'namespace' && hasCustomTool(t.tools as ResponsesTool[] | undefined, name)),
  );
}

/** 一次 Reply 的 Responses 事件序列（null 表示停顿）。 */
function* renderReply(
  reply: Reply,
  responseId: string,
  body: ResponsesRequest,
): Generator<Record<string, unknown> | null> {
  yield { type: 'response.created', response: { id: responseId } };
  let outputIndex = 0;
  const output: ResponsesItem[] = [];
  if (reply.reasoning?.length) {
    const id = `rs_${responseId}`;
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'reasoning', id, summary: [] },
    };
    for (const delta of reply.reasoning) {
      yield {
        type: 'response.reasoning_text.delta',
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      };
      if (reply.delayMs) yield null;
    }
    const item = {
      type: 'reasoning',
      id,
      summary: [],
      content: [{ type: 'reasoning_text', text: reply.reasoning.join('') }],
    };
    output.push(item);
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  if (reply.text?.length) {
    const id = `msg_${responseId}`;
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', role: 'assistant', id, content: [] },
    };
    for (const delta of reply.text) {
      yield {
        type: 'response.output_text.delta',
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      };
      if (reply.delayMs) yield null;
    }
    const item = {
      type: 'message',
      role: 'assistant',
      id,
      content: [{ type: 'output_text', text: reply.text.join('') }],
    };
    output.push(item);
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  if (reply.disconnect) return;
  for (const call of reply.toolCalls ?? []) {
    const callId = nextCallId('call');
    const namespace = call.namespace === undefined ? {} : { namespace: call.namespace };
    const item: ResponsesItem =
      call.kind === 'custom' && hasCustomTool(body.tools, call.name)
        ? {
            type: 'custom_tool_call',
            call_id: callId,
            name: call.name,
            input: call.input ?? '',
            ...namespace,
          }
        : {
            type: 'function_call',
            call_id: callId,
            name: call.name,
            arguments: JSON.stringify(
              call.kind === 'custom' ? { input: call.input ?? '' } : (call.args ?? {}),
            ),
            ...namespace,
          };
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, input: '' },
    };
    output.push(item);
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  yield {
    type: 'response.completed',
    response: {
      id: responseId,
      output,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: reply.reasoning?.length ?? 0 },
        total_tokens: 120,
      },
    },
  };
}

export function startMockResponses(script: Script): Promise<MockServer<ResponsesRequest>> {
  let count = 0;
  return startMockServer<ResponsesRequest>('/responses', async (body, record, res) => {
    const index = count++;
    const reply = script(viewOfResponses(body, index));
    if (reply.httpError) return sendHttpError(res, reply.httpError);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `resp_${index}`;
    const write = (event: Record<string, unknown>) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (reply.failed) {
      write({ type: 'response.created', response: { id } });
      write({ type: 'response.failed', response: { id, error: reply.failed } });
      res.end();
      return;
    }
    for (const event of renderReply(reply, id, body)) {
      if (record.aborted) return;
      if (event === null) await pause(reply.delayMs ?? 0);
      else write(event);
    }
    if (reply.disconnect) await disconnect(res);
    else res.end();
  });
}
