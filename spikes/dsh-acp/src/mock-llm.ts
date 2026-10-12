// 本地脚本化的 OpenAI Chat Completions 兼容服务（含最小 Anthropic Messages 文本回复）。
// 用途：不调用真实模型也能把 ACP / SDK 全流程跑通，而且行为确定，可复现、可录制。
// 它像真实 Provider 一样只看请求里的 messages 决定下一步，因此也能验证 resume 后 dsh 是否
// 把历史完整发给了模型。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_MODEL = 'wevir-mock';
/** 喂给 dsh 的假 Key：不是密钥，只用来证明 apiKeyEnv → 请求头 的注入链路。 */
export const MOCK_KEY = 'wevir-mock-key-not-a-secret';

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ type: string; function: { name: string; parameters?: unknown } }>;
  stream?: boolean;
  [k: string]: unknown;
}

export interface ToolCallPlan {
  name: string;
  arguments: Record<string, unknown>;
}

/** 一次回复：可选的思考、文本（按片段流式发出）、工具调用。 */
export interface Reply {
  reasoning?: string;
  text?: string;
  toolCalls?: ToolCallPlan[];
  /** 文本切成多少片发；每片之间的间隔 */
  chunks?: number;
  chunkDelayMs?: number;
}

export type Script = (req: ChatRequest, ctx: { auth: string | undefined }) => Reply;

export interface RecordedRequest {
  t: number;
  path: string;
  auth: string | undefined;
  body: ChatRequest;
  aborted: boolean;
}

export interface MockLlm {
  baseURL: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
      )
      .join('');
  }
  return '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function split(text: string, n: number): string[] {
  const chars = [...text];
  if (chars.length === 0) return [];
  const size = Math.max(1, Math.ceil(chars.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

async function streamOpenAi(
  res: ServerResponse,
  reply: Reply,
  model: string,
  closed: () => boolean,
) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta: unknown, finish: string | null = null, extra: object = {}) => {
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    );
  };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send({ role: 'assistant', content: '' });
  const delay = reply.chunkDelayMs ?? 5;
  for (const piece of split(reply.reasoning ?? '', 3)) {
    if (closed()) return;
    send({ reasoning_content: piece });
    await sleep(delay);
  }
  for (const piece of split(reply.text ?? '', reply.chunks ?? 4)) {
    if (closed()) return;
    send({ content: piece });
    await sleep(delay);
  }
  (reply.toolCalls ?? []).forEach((call, index) => {
    send({
      tool_calls: [
        {
          index,
          id: `call_${Date.now().toString(36)}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        },
      ],
    });
  });
  const finish = (reply.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop';
  send({}, finish);
  res.write(
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 最小 Anthropic Messages 流：只回一段文本，用于验证 deepseek-official 适配器的端点与 Key 注入。 */
function streamAnthropic(res: ServerResponse, text: string, model: string) {
  const ev = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  ev('message_start', {
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  ev('message_stop', {});
  res.end();
}

export async function startMockLlm(script: Script): Promise<MockLlm> {
  const requests: RecordedRequest[] = [];
  const t0 = Date.now();
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? '';
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }));
      return;
    }
    const raw = await readBody(req);
    let body: ChatRequest;
    try {
      body = JSON.parse(raw) as ChatRequest;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const auth = (req.headers.authorization ?? req.headers['x-api-key']) as string | undefined;
    const entry: RecordedRequest = { t: Date.now() - t0, path, auth, body, aborted: false };
    requests.push(entry);
    let closed = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        closed = true;
        entry.aborted = true;
      }
    });
    if (path.endsWith('/messages')) {
      streamAnthropic(res, 'OK', body.model);
      return;
    }
    const reply = script(body, { auth });
    await streamOpenAi(res, reply, body.model, () => closed);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let active: MockLlm | undefined;

/** run-all 在 mock 模式下启动的实例；真实模式下为 undefined。 */
export function activeMock(): MockLlm | undefined {
  return active;
}

export function setActiveMock(mock: MockLlm | undefined): void {
  active = mock;
}
