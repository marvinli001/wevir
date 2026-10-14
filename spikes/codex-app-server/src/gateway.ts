// 最小模型协议网关：对 Codex 暴露 POST /v1/responses，向上游转成 Chat Completions。
// 设想放在 Host 里（ADR-0005 草案）：Codex 的 env_key 拿到的只是一次性令牌，上游 Key 只在网关进程里。
//
// 映射要点（详见 docs/research/codex-notes.md §5）：
// - 请求：developer → system；reasoning 项 → 下一条 assistant 的 reasoning_content；function_call / custom_tool_call
//   → assistant.tool_calls；*_output → tool 消息；custom 工具（apply_patch）→ 只有一个字符串参数 input 的函数，
//   语法写进描述；namespace 工具 → 摊平成 `<ns>__<name>` 的函数。
// - 响应：reasoning_content → reasoning 项（reasoning_text 增量），并把全文放进 encrypted_content，
//   保证下一次请求能原样带回；content → message 项；tool_calls 按 index 拼接，结束时按原工具类型还原。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatMessage, ChatRequest } from './mock-chat.ts';
import type { ResponsesRequest } from './mock-responses.ts';

export interface GatewayOptions {
  /** 上游协议：chat 走转换；responses 原样透传（只剥掉 Codex 附带的元数据）。 */
  upstreamProtocol?: 'chat' | 'responses';
  /** 上游 base URL（到 /v1 为止，网关追加 /chat/completions 或 /responses）。 */
  upstreamBaseURL: string;
  /** 上游 Key：只在网关里，不进 Codex 的环境与配置。 */
  upstreamKey?: string;
  /** 发给上游的模型名；不给则用 Codex 请求里的 model。 */
  upstreamModel?: string;
  /** Codex 侧的一次性令牌（Codex 的 env_key 值）。 */
  sessionToken: string;
  /** 上游额外请求体字段（各家的思考开关等）。 */
  extraBody?: Record<string, unknown>;
  log?: (line: string) => void;
}

export interface Gateway {
  baseURL: string;
  /** 每次转换后的 Chat 请求体（spike 断言用）。 */
  translated: ChatRequest[];
  /** 透传模式下实际发给上游的请求头名（spike 断言用）。 */
  forwardedHeaders: string[][];
  /** 丢弃的、不认识的输入项类型。 */
  dropped: string[];
  close(): Promise<void>;
}

const ENCRYPTED_PREFIX = 'wevir-gw:v1:';
const SEP = '__';

type Tool = Record<string, unknown> & { type: string; name?: string };

interface ToolMap {
  chatTools: NonNullable<ChatRequest['tools']>;
  /** 摊平后的函数名 → 原工具的类型与名字。 */
  byChatName: Map<string, { kind: 'function' | 'custom'; name: string; namespace?: string }>;
}

export function mapTools(tools: Tool[] | undefined): ToolMap {
  const chatTools: ToolMap['chatTools'] = [];
  const byChatName: ToolMap['byChatName'] = new Map();
  const addFunction = (tool: Tool, namespace?: string) => {
    const name = tool.name ?? '';
    const chatName = namespace === undefined ? name : `${namespace}${SEP}${name}`;
    chatTools.push({
      type: 'function',
      function: {
        name: chatName,
        description: tool.description as string | undefined,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    });
    byChatName.set(chatName, { kind: 'function', name, namespace });
  };
  for (const tool of tools ?? []) {
    if (tool.type === 'function') addFunction(tool);
    else if (tool.type === 'namespace') {
      for (const inner of (tool.tools as Tool[]) ?? []) {
        if (inner.type === 'function') addFunction(inner, tool.name);
      }
    } else if (tool.type === 'custom') {
      const name = tool.name ?? '';
      const format = tool.format as
        | { type?: string; syntax?: string; definition?: string }
        | undefined;
      const grammar =
        format?.type === 'grammar'
          ? `\n\nPut the raw tool input in the \`input\` string. It must match this ${format.syntax} grammar:\n${format.definition}`
          : '\n\nPut the raw tool input in the `input` string.';
      chatTools.push({
        type: 'function',
        function: {
          name,
          description: `${(tool.description as string | undefined) ?? ''}${grammar}`,
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw freeform input.' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
      });
      byChatName.set(name, { kind: 'custom', name });
    }
    // web_search、image_generation 等托管工具：Chat 上游没有，丢掉。
  }
  return { chatTools, byChatName };
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((c: { type?: string; text?: string }) => (typeof c?.text === 'string' ? c.text : ''))
          .join('')
      : '';

function userContent(content: unknown): ChatMessage['content'] {
  if (!Array.isArray(content)) return textOf(content);
  const parts = content.map((c: { type?: string; text?: string; image_url?: string }) =>
    c.type === 'input_image'
      ? { type: 'image_url', image_url: { url: c.image_url } }
      : { type: 'text', text: c.text ?? '' },
  );
  return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts;
}

export function decodeReasoning(item: Record<string, unknown>): string {
  const content = item.content as Array<{ text?: string }> | undefined;
  if (Array.isArray(content) && content.length > 0)
    return content.map((c) => c.text ?? '').join('');
  const encrypted = item.encrypted_content;
  if (typeof encrypted === 'string' && encrypted.startsWith(ENCRYPTED_PREFIX)) {
    return Buffer.from(encrypted.slice(ENCRYPTED_PREFIX.length), 'base64').toString('utf8');
  }
  return '';
}

export function mapInput(body: ResponsesRequest, dropped: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  let pendingReasoning = '';
  // 当前可以继续追加内容 / 工具调用的 assistant 消息（直到出现工具输出或用户消息为止）。
  let open: ChatMessage | undefined;
  const assistant = (): ChatMessage => {
    if (open === undefined) {
      open = { role: 'assistant', content: null };
      messages.push(open);
    }
    if (pendingReasoning) {
      open.reasoning_content = (open.reasoning_content ?? '') + pendingReasoning;
      pendingReasoning = '';
    }
    return open;
  };
  for (const item of body.input) {
    switch (item.type) {
      case 'message': {
        const role = item.role as string;
        if (role === 'assistant') {
          const msg = assistant();
          msg.content = ((msg.content as string | null) ?? '') + textOf(item.content);
        } else {
          open = undefined;
          messages.push({
            role: role === 'developer' ? 'system' : role,
            content: role === 'user' ? userContent(item.content) : textOf(item.content),
          });
        }
        break;
      }
      case 'reasoning':
        pendingReasoning += decodeReasoning(item);
        break;
      case 'function_call':
      case 'custom_tool_call': {
        const msg = assistant();
        const name =
          item.namespace === undefined
            ? (item.name as string)
            : `${item.namespace as string}${SEP}${item.name as string}`;
        const args =
          item.type === 'custom_tool_call'
            ? JSON.stringify({ input: item.input })
            : (item.arguments as string);
        msg.tool_calls = [
          ...(msg.tool_calls ?? []),
          { id: item.call_id as string, type: 'function', function: { name, arguments: args } },
        ];
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        // 工具输出之后不能再往同一条 assistant 消息上加 tool_calls。
        open = undefined;
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id as string,
          content: typeof item.output === 'string' ? item.output : textOf(item.output),
        });
        break;
      default:
        dropped.push(String(item.type));
    }
  }
  return messages;
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const translated: ChatRequest[] = [];
  const forwardedHeaders: string[][] = [];
  const dropped: string[] = [];
  const log = options.log ?? (() => {});
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: Error) => {
      // Codex 读到 response.completed 就断开连接（codex-api/src/sse/responses.rs:655-660），取消时也断开；
      // 网关随之中断上游，这是正常结束，不算错误。
      if (error.name === 'AbortError') return;
      log(`gateway error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `wevir gateway: ${error.message}` } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${options.sessionToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'wevir gateway: 令牌不对' } }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: `wevir gateway: 不支持 ${req.method} ${req.url}` } }),
      );
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as ResponsesRequest;
    if (options.upstreamProtocol === 'responses') return passthrough(body, res);
    const tools = mapTools(body.tools as Tool[] | undefined);
    const chat: ChatRequest = {
      model: options.upstreamModel ?? body.model,
      messages: mapInput(body, dropped),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.chatTools.length > 0 ? { tools: tools.chatTools, tool_choice: 'auto' } : {}),
      ...options.extraBody,
    };
    translated.push(chat);

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const upstream = await fetch(`${options.upstreamBaseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(options.upstreamKey ? { authorization: `Bearer ${options.upstreamKey}` } : {}),
      },
      body: JSON.stringify(chat),
      signal: abort.signal,
    });
    if (!upstream.ok || upstream.body === null) {
      // 状态码原样转给 Codex：429 / 5xx 由 Codex 自己的重试策略处理。
      const text = await upstream.text();
      log(`upstream ${upstream.status}: ${text.slice(0, 300)}`);
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(text || JSON.stringify({ error: { message: `upstream ${upstream.status}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event: Record<string, unknown>) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const responseId = `resp_gw_${Date.now().toString(36)}`;
    emit({ type: 'response.created', response: { id: responseId } });

    let outputIndex = 0;
    let reasoning: { id: string; text: string } | undefined;
    let message: { id: string; text: string } | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Record<string, unknown> | undefined;

    const closeReasoning = () => {
      if (!reasoning) return;
      emit({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          type: 'reasoning',
          id: reasoning.id,
          summary: [],
          content: [{ type: 'reasoning_text', text: reasoning.text }],
          encrypted_content: ENCRYPTED_PREFIX + Buffer.from(reasoning.text).toString('base64'),
        },
      });
      outputIndex += 1;
      reasoning = undefined;
    };
    const closeMessage = () => {
      if (!message) return;
      emit({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          type: 'message',
          role: 'assistant',
          id: message.id,
          content: [{ type: 'output_text', text: message.text }],
        },
      });
      outputIndex += 1;
      message = undefined;
    };

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: Record<string, unknown>;
        };
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          if (!reasoning) {
            closeMessage();
            reasoning = { id: `rs_${responseId}_${outputIndex}`, text: '' };
            emit({
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: { type: 'reasoning', id: reasoning.id, summary: [] },
            });
          }
          reasoning.text += delta.reasoning_content;
          emit({
            type: 'response.reasoning_text.delta',
            item_id: reasoning.id,
            output_index: outputIndex,
            content_index: 0,
            delta: delta.reasoning_content,
          });
        }
        if (delta.content) {
          closeReasoning();
          if (!message) {
            message = { id: `msg_${responseId}_${outputIndex}`, text: '' };
            emit({
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: { type: 'message', role: 'assistant', id: message.id, content: [] },
            });
          }
          message.text += delta.content;
          emit({
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: outputIndex,
            content_index: 0,
            delta: delta.content,
          });
        }
        for (const part of delta.tool_calls ?? []) {
          closeReasoning();
          closeMessage();
          const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
          calls.set(part.index, call);
        }
      }
    }
    closeReasoning();
    closeMessage();
    for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
      const original = tools.byChatName.get(call.name);
      let item: Record<string, unknown>;
      if (original?.kind === 'custom') {
        let input = call.args;
        try {
          input = (JSON.parse(call.args) as { input: string }).input;
        } catch {
          // 模型没按 {input} 回：原样当自由文本交给 Codex，由工具自己报错。
        }
        item = { type: 'custom_tool_call', call_id: call.id, name: original.name, input };
      } else {
        item = {
          type: 'function_call',
          call_id: call.id,
          name: original?.name ?? call.name,
          arguments: call.args,
          ...(original?.namespace === undefined ? {} : { namespace: original.namespace }),
        };
      }
      emit({ type: 'response.output_item.done', output_index: outputIndex, item });
      outputIndex += 1;
    }
    const details = (usage?.prompt_tokens_details ?? {}) as { cached_tokens?: number };
    const completion = (usage?.completion_tokens_details ?? {}) as { reasoning_tokens?: number };
    emit({
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: (usage?.prompt_tokens as number) ?? 0,
          input_tokens_details: {
            cached_tokens: details.cached_tokens ?? (usage?.prompt_cache_hit_tokens as number) ?? 0,
          },
          output_tokens: (usage?.completion_tokens as number) ?? 0,
          output_tokens_details: { reasoning_tokens: completion.reasoning_tokens ?? 0 },
          total_tokens: (usage?.total_tokens as number) ?? 0,
        },
      },
    });
    res.end();
  }

  /**
   * Responses 透传：请求体只去掉 client_metadata（含 installation_id、turn 元数据），请求头只带网关自己的；
   * 响应流原样转回。x-codex-* / session-id / thread-id / originator 一律不转发。
   */
  async function passthrough(body: ResponsesRequest, res: ServerResponse): Promise<void> {
    const { client_metadata: _drop, ...rest } = body;
    const forwarded = {
      ...rest,
      ...(options.upstreamModel ? { model: options.upstreamModel } : {}),
    };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'wevir-gateway/0.0.0',
      ...(options.upstreamKey ? { authorization: `Bearer ${options.upstreamKey}` } : {}),
    };
    forwardedHeaders.push(Object.keys(headers));
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const upstream = await fetch(`${options.upstreamBaseURL.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(forwarded),
      signal: abort.signal,
    });
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
    });
    if (upstream.body === null) {
      res.end();
      return;
    }
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    translated,
    forwardedHeaders,
    dropped,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
