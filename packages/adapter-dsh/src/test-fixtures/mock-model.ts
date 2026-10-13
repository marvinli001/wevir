// 集成测试用的本地脚本化模型：最小的 OpenAI Chat Completions 流式服务（照 T0.3 spike 的 mock-llm 重写）。
// 像真实 Provider 一样只看请求里的 messages 决定回复，不需要 Key。配套的 overlay 把 dsh 的 acp 路由指过来。

import { writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export const MOCK_MODEL = 'wevir-mock';
/** overlay 里 `apiKeyEnv` 的变量名；值经 `DshProcessOptions.env` 注入。 */
export const MOCK_KEY_ENV = 'WEVIR_PROVIDER_WEVIR_TEST_KEY';
/** 不是密钥，只用来走通 apiKeyEnv → 请求头的链路。 */
export const MOCK_KEY = 'wevir-mock-key-not-a-secret';

export interface MockRequest {
  messages: Array<{ role: string; content?: unknown }>;
}

/** 消息内容的文本：字符串，或 `[{type: 'text', text}]` 各段相连。 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? (part.text as string) : ''))
    .join('');
}

/**
 * 本回合：最后一条含 `marker` 的用户消息（dsh 会在提示之后另加一条运行时上下文的用户消息，所以不能取最后一条），
 * 以及它之后的工具结果（按顺序）。
 */
export function turnOf(
  request: MockRequest,
  marker: string,
): { prompt: string; toolResults: string[] } {
  const index = request.messages.findLastIndex(
    (m) => m.role === 'user' && textOf(m.content).includes(marker),
  );
  return {
    prompt: index < 0 ? '' : textOf(request.messages[index]?.content),
    toolResults: request.messages
      .slice(index + 1)
      .filter((m) => m.role === 'tool')
      .map((m) => textOf(m.content)),
  };
}

/** 一次回复：先逐片发思考，再逐片发文本，最后可选一个工具调用。每片之间等 `delayMs`。 */
export interface MockReply {
  reasoning?: readonly string[];
  text?: readonly string[];
  toolCall?: { name: string; arguments: Record<string, unknown> };
  delayMs?: number;
}

/** 请求的路径与头（T3.4 用来确认 Key 经哪个请求头到达、请求发到了哪个 Provider）。 */
export interface MockRequestMeta {
  url: string;
  headers: IncomingHttpHeaders;
}

export interface MockModel {
  baseURL: string;
  close(): Promise<void>;
}

export async function startMockModel(
  script: (request: MockRequest, meta: MockRequestMeta) => MockReply,
): Promise<MockModel> {
  // dsh 用 Provider 给的 id 作 ACP 的 toolCallId，一个会话里的工具调用 id 不能重复。
  let toolCalls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', async () => {
      const reply = script(JSON.parse(body) as MockRequest, {
        url: req.url ?? '',
        headers: req.headers,
      });
      let closed = false;
      res.on('close', () => {
        closed = !res.writableFinished;
      });
      const send = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-wevir',
            object: 'chat.completion.chunk',
            created: 0,
            model: MOCK_MODEL,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      const pause = () => new Promise((resolve) => setTimeout(resolve, reply.delayMs ?? 0));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ role: 'assistant', content: '' });
      for (const piece of reply.reasoning ?? []) {
        if (closed) return;
        send({ reasoning_content: piece });
        await pause();
      }
      for (const piece of reply.text ?? []) {
        if (closed) return;
        send({ content: piece });
        await pause();
      }
      if (closed) return;
      if (reply.toolCall !== undefined) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `call_wevir_mock_${++toolCalls}`,
              type: 'function',
              function: {
                name: reply.toolCall.name,
                arguments: JSON.stringify(reply.toolCall.arguments),
              },
            },
          ],
        });
      }
      send({}, reply.toolCall === undefined ? 'stop' : 'tool_calls');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 指向本地 mock 的 Provider overlay（格式见 T0.3 §6.2），只写 Key 的环境变量名。 */
export function writeMockOverlay(dir: string, baseURL: string): string {
  const file = join(dir, 'provider.yml');
  writeFileSync(
    file,
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      wevir-test:',
      '        displayName: Wevir Test',
      `        apiKeyEnv: ${MOCK_KEY_ENV}`,
      '        api: openai-completions',
      `        baseURL: ${baseURL}`,
      '        compat:',
      '          supportsDeveloperRole: false',
      '          maxTokensField: max_tokens',
      '        models:',
      `          - id: ${MOCK_MODEL}`,
      '- id: acp',
      '  config:',
      '    provider: wevir-test',
      `    model: ${MOCK_MODEL}`,
      '',
    ].join('\n'),
  );
  return file;
}
