// 脚本化的 OpenAI Responses 流式服务（POST …/responses，SSE），仿 adapter-dsh 的 startMockModel：
// 只看请求体决定回复，不需要 Key。事件格式照 upstream/codex/codex-rs/core/tests/common/responses.rs:753+ 的 ev_* 帮手。

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ModelView, nextCallId, type Reply, type Script } from './model-script.ts';

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface RecordedRequest<B = ResponsesRequest> {
  path: string;
  /** 请求头：authorization 之类只记方案与长度。 */
  headers: Record<string, string>;
  body: B;
  view: ModelView;
  aborted: boolean;
}

export interface MockServer<B = ResponsesRequest> {
  baseURL: string;
  requests: RecordedRequest<B>[];
  close(): Promise<void>;
}

export function redactHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const v = Array.isArray(value) ? value.join(', ') : (value ?? '');
    out[name] = /authorization|api-key|cookie/i.test(name)
      ? `<${v.split(' ')[0] ?? ''} …${v.length} chars>`
      : v;
  }
  return out;
}

const textOfContent = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : '';

export function viewOfResponses(body: ResponsesRequest, index: number): ModelView {
  let lastUser = -1;
  let lastUserText = '';
  body.input.forEach((item, i) => {
    if (item.type === 'message' && item.role === 'user') {
      const text = textOfContent(item.content);
      if (!text.trimStart().startsWith('<')) {
        lastUser = i;
        lastUserText = text;
      }
    }
  });
  const toolOutputs = body.input
    .slice(lastUser + 1)
    .filter((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output')
    .map((i) => (typeof i.output === 'string' ? i.output : JSON.stringify(i.output)));
  return { index, lastUserText, toolOutputs, allText: JSON.stringify(body.input) };
}

/** 把一次 Reply 渲染成 Responses 的 SSE 事件序列（null 表示停顿）。 */
function* renderReply(reply: Reply, responseId: string): Generator<Record<string, unknown> | null> {
  yield { type: 'response.created', response: { id: responseId } };
  let outputIndex = 0;
  const pause = reply.delayMs ? null : undefined;
  if (reply.reasoning?.length) {
    const id = `rs_${responseId}`;
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'reasoning', id, summary: [] },
    };
    for (const piece of reply.reasoning) {
      yield {
        type: 'response.reasoning_text.delta',
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        delta: piece,
      };
      if (pause === null) yield null;
    }
    yield {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'reasoning',
        id,
        summary: [],
        content: [{ type: 'reasoning_text', text: reply.reasoning.join('') }],
        ...(reply.encryptedReasoning === undefined
          ? {}
          : { encrypted_content: reply.encryptedReasoning }),
      },
    };
    outputIndex += 1;
  }
  if (reply.text?.length) {
    const id = `msg_${responseId}`;
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', role: 'assistant', id, content: [] },
    };
    for (const piece of reply.text) {
      yield {
        type: 'response.output_text.delta',
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        delta: piece,
      };
      if (pause === null) yield null;
    }
    yield {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'message',
        role: 'assistant',
        id,
        content: [{ type: 'output_text', text: reply.text.join('') }],
      },
    };
    outputIndex += 1;
  }
  for (const call of reply.toolCalls ?? []) {
    const callId = nextCallId('call');
    const item =
      call.kind === 'custom'
        ? { type: 'custom_tool_call', call_id: callId, name: call.name, input: call.input ?? '' }
        : {
            type: 'function_call',
            call_id: callId,
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          };
    if (call.namespace !== undefined) Object.assign(item, { namespace: call.namespace });
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  yield {
    type: 'response.completed',
    response: {
      id: responseId,
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

export async function startMockResponses(script: Script): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock: 不支持 ${req.method} ${req.url}` } }));
        return;
      }
      const body = JSON.parse(raw) as ResponsesRequest;
      const view = viewOfResponses(body, requests.length);
      const record: RecordedRequest = {
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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (reply.failed) {
        const id = `resp_${view.index}`;
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`,
        );
        res.end(
          `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id, error: reply.failed } })}\n\n`,
        );
        return;
      }
      for (const event of renderReply(reply, `resp_${view.index}`)) {
        if (record.aborted) return;
        if (event === null) {
          await new Promise((r) => setTimeout(r, reply.delayMs));
          continue;
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
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
