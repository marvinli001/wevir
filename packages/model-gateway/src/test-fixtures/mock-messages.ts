// 脚本化的 Anthropic Messages 流式服务（POST …/v1/messages），代表只有 Messages 接口的上游。事件格式照 Anthropic 的
// 流式文档（message_start → content_block_* → message_delta → message_stop）。请求先按 Anthropic 的结构规则检查，
// 不合规则时像 Anthropic 一样回 400（invalid_request_error），让集成测试能发现网关拼错的请求：
// - max_tokens 必填；思考开关为 enabled 时 budget_tokens ≥ 1024 且小于 max_tokens；
// - 第一条是 user、最后一条是 user、角色交替（网关会合并相邻的同角色消息）、文本块非空；
// - 思考块必须带签名，而且签名对得上原文（网关原样带回才对得上）；
// - 每个 tool_use 的结果必须在紧接着的 user 消息里、排在最前面；历史里有工具调用就必须定义工具；
// - 工具名与 tool_use id 符合 Anthropic 的字符规则。
// 签名是思考原文的哈希：`signature()`。

import { createHash } from 'node:crypto';
import { flatToolName } from '../tools.js';
import type { MessagesRequest } from '../types.js';
import { disconnect, type MockServer, startMockServer } from './mock-server.js';
import { type ModelView, nextCallId, pause, type Script } from './model-script.js';

/** mock 给思考块的签名：原文的哈希，带回时据此判断有没有被改过。 */
export function signature(thinking: string): string {
  return `sig_${createHash('sha256').update(thinking).digest('hex').slice(0, 24)}`;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]+$/;

/** 按 Anthropic 的结构规则检查请求，返回第一个问题（undefined 表示合规）。 */
export function messagesProblem(body: MessagesRequest): string | undefined {
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)
    return 'max_tokens: Field required';
  const thinking = body.thinking;
  if (thinking?.type === 'enabled') {
    const budget = thinking.budget_tokens;
    if (typeof budget !== 'number' || budget < 1024 || budget >= body.max_tokens)
      return 'thinking.budget_tokens: must be ≥ 1024 and less than max_tokens';
  }
  if (body.system !== undefined && !body.system.every((b) => b.type === 'text' && b.text !== ''))
    return 'system: text blocks only';
  for (const tool of body.tools ?? []) {
    if (!TOOL_NAME.test(tool.name)) return `tools: invalid name ${tool.name}`;
  }
  const messages = body.messages;
  if (messages[0]?.role !== 'user') return 'messages: first message must use the "user" role';
  if (messages.at(-1)?.role !== 'user') return 'messages: final message must use the "user" role';
  let pending: Set<string> | undefined;
  let usesTools = false;
  for (const [i, message] of messages.entries()) {
    if (i > 0 && messages[i - 1]?.role === message.role)
      return `messages.${i}: roles must alternate`;
    if (message.content.length === 0) return `messages.${i}: content must be non-empty`;
    for (const block of message.content) {
      if (block.type === 'text' && block.text === '')
        return `messages.${i}: text content blocks must be non-empty`;
      if (block.type === 'thinking') {
        if (message.role !== 'assistant') return `messages.${i}: thinking only in assistant`;
        if (typeof block.signature !== 'string' || block.signature === '')
          return `messages.${i}.content: thinking.signature: Field required`;
        if (block.signature !== signature(String(block.thinking)))
          return `messages.${i}.content: Invalid \`signature\` in \`thinking\` block`;
      }
      if (block.type === 'tool_use' || block.type === 'tool_result') usesTools = true;
      if (block.type === 'tool_use' && !TOOL_USE_ID.test(String(block.id)))
        return `messages.${i}: tool_use.id: String should match pattern`;
    }
    if (message.role === 'user') {
      const results = message.content.filter((b) => b.type === 'tool_result');
      const firstOther = message.content.findIndex((b) => b.type !== 'tool_result');
      if (
        firstOther >= 0 &&
        message.content.slice(firstOther).some((b) => b.type === 'tool_result')
      )
        return `messages.${i}: tool_result blocks must come first`;
      for (const result of results) {
        if (!pending?.delete(String(result.tool_use_id)))
          return `messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(result.tool_use_id)}`;
      }
      if (pending !== undefined && pending.size > 0)
        return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${[...pending].join(', ')}`;
      pending = undefined;
    } else {
      const ids = message.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
      pending = new Set(ids);
    }
  }
  if (usesTools && (body.tools ?? []).length === 0)
    return 'Requests which include `tool_use` or `tool_result` blocks must define tools.';
  return undefined;
}

export function viewOfMessages(body: MessagesRequest, index: number): ModelView {
  let lastUserText = '';
  for (const m of body.messages) {
    if (m.role !== 'user') continue;
    for (const block of m.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      if (!block.text.trimStart().startsWith('<') && !block.text.startsWith('['))
        lastUserText = block.text;
    }
  }
  return { index, lastUserText };
}

export function startMockMessages(script: Script): Promise<MockServer<MessagesRequest>> {
  let count = 0;
  return startMockServer<MessagesRequest>('/messages', async (body, record, res) => {
    const index = count++;
    const problem = messagesProblem(body);
    const reply = problem === undefined ? script(viewOfMessages(body, index)) : {};
    const error = (status: number, type: string, message: string, raw?: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw ?? JSON.stringify({ type: 'error', error: { type, message } }));
    };
    if (problem !== undefined) return error(400, 'invalid_request_error', problem);
    if (reply.httpError) {
      const e = reply.httpError;
      return error(e.status, e.code ?? 'invalid_request_error', e.message ?? 'mock error', e.body);
    }
    const send = (event: Record<string, unknown> | string) =>
      res.write(
        typeof event === 'string'
          ? `data: ${event}\n\n`
          : `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (reply.rawChunks) {
      for (const chunk of reply.rawChunks) {
        if (record.aborted) return;
        send(chunk as Record<string, unknown> | string);
        if (reply.delayMs) await pause(reply.delayMs);
      }
      if (reply.disconnect) await disconnect(res);
      else res.end();
      return;
    }
    send({
      type: 'message_start',
      message: {
        id: `msg_mock_${index}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 30,
          cache_creation_input_tokens: 6,
          cache_read_input_tokens: 64,
          output_tokens: 1,
        },
      },
    });
    let block = 0;
    const delta = (d: Record<string, unknown>) =>
      send({ type: 'content_block_delta', index: block, delta: d });
    if (reply.reasoning?.length) {
      send({
        type: 'content_block_start',
        index: block,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      for (const piece of reply.reasoning) {
        if (record.aborted) return;
        delta({ type: 'thinking_delta', thinking: piece });
        if (reply.delayMs) await pause(reply.delayMs);
      }
      if (!reply.noSignature)
        delta({ type: 'signature_delta', signature: signature(reply.reasoning.join('')) });
      send({ type: 'content_block_stop', index: block });
      block += 1;
    }
    for (const data of reply.redacted ?? []) {
      send({
        type: 'content_block_start',
        index: block,
        content_block: { type: 'redacted_thinking', data },
      });
      send({ type: 'content_block_stop', index: block });
      block += 1;
    }
    if (reply.text?.length) {
      send({
        type: 'content_block_start',
        index: block,
        content_block: { type: 'text', text: '' },
      });
      send({ type: 'ping' });
      for (const piece of reply.text) {
        if (record.aborted) return;
        delta({ type: 'text_delta', text: piece });
        if (reply.delayMs) await pause(reply.delayMs);
      }
      send({ type: 'content_block_stop', index: block });
      block += 1;
    }
    if (record.aborted) return;
    if (reply.disconnect) {
      await disconnect(res);
      return;
    }
    if (reply.failed) {
      send({ type: 'error', error: { type: reply.failed.code, message: reply.failed.message } });
      res.end();
      return;
    }
    const calls = reply.toolCalls ?? [];
    for (const call of calls) {
      // Messages 只有普通工具：按网关摊平的规则得出名字。参数分两片发，验证网关拼接。
      const json = JSON.stringify(
        call.kind === 'custom' ? { input: call.input ?? '' } : (call.args ?? {}),
      );
      send({
        type: 'content_block_start',
        index: block,
        content_block: {
          type: 'tool_use',
          id: nextCallId('toolu'),
          name: flatToolName(call.name, call.namespace),
          input: {},
        },
      });
      delta({ type: 'input_json_delta', partial_json: '' });
      delta({ type: 'input_json_delta', partial_json: json.slice(0, 5) });
      delta({ type: 'input_json_delta', partial_json: json.slice(5) });
      send({ type: 'content_block_stop', index: block });
      block += 1;
    }
    send({
      type: 'message_delta',
      delta: {
        stop_reason: reply.finishReason ?? (calls.length > 0 ? 'tool_use' : 'end_turn'),
        stop_sequence: null,
      },
      usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } },
    });
    send({ type: 'message_stop' });
    res.end();
  });
}
