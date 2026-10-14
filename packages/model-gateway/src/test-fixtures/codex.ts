// 测试里扮演 Codex：读录制的请求样本（codex-requests/）、按 Codex 的请求头发请求、按 Codex 解析流的规则检查网关
// 发回的事件（upstream/codex/codex-rs/codex-api/src/sse/responses.rs）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SseParser } from '../sse.js';
import type { ResponsesEvent, ResponsesRequest } from '../types.js';

export const CODEX_SAMPLES = [
  '1-first-turn',
  '2-tool-results',
  '3-next-turn',
  '4-compact',
] as const;
export type CodexSample = (typeof CODEX_SAMPLES)[number];

export interface RecordedCodexRequest {
  description: string;
  /** Codex 发出的请求头名（值没有录）。 */
  headers: string[];
  body: ResponsesRequest;
}

export function codexRequest(name: CodexSample): RecordedCodexRequest {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, 'codex-requests', `${name}.json`), 'utf8'),
  ) as RecordedCodexRequest;
}

/** Codex 每个请求都带的元数据头（codex-notes §3.1），值是假的。网关一个都不该转发。 */
export const CODEX_METADATA_HEADERS: Record<string, string> = {
  originator: 'wevir',
  'user-agent': 'wevir/0.0.0 (Mac OS 26.0; arm64) codex',
  'session-id': '00000000-0000-0000-0000-000000000001',
  'thread-id': '00000000-0000-0000-0000-000000000001',
  'x-client-request-id': '00000000-0000-0000-0000-000000000002',
  'x-codex-window-id': '00000000-0000-0000-0000-000000000001:0',
  'x-codex-turn-metadata': '{"installation_id":"00000000-0000-0000-0000-000000000003"}',
  'x-codex-beta-features': 'remote_compaction_v2',
  'x-openai-subagent': 'collab_spawn',
  'x-codex-parent-thread-id': '00000000-0000-0000-0000-000000000004',
};

export function postResponses(
  baseURL: string,
  token: string,
  body: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${baseURL}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
      ...CODEX_METADATA_HEADERS,
      ...init.headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: init.signal,
  });
}

/** 读完 SSE，返回 data 里的 JSON 事件（非 JSON 的 data 跳过，与 Codex 相同）。 */
export async function readEvents(response: Response): Promise<ResponsesEvent[]> {
  return parseEvents(await response.text());
}

export function parseEvents(text: string): ResponsesEvent[] {
  const parser = new SseParser();
  const out: ResponsesEvent[] = [];
  for (const message of [...parser.push(text), ...parser.end()]) {
    try {
      out.push(JSON.parse(message.data) as ResponsesEvent);
    } catch {
      // Codex 也跳过非 JSON（如 [DONE]）。
    }
  }
  return out;
}

/**
 * 按 Codex 的规则检查事件序列，返回问题列表（空表示 Codex 能照常处理）：
 * - 只有一个终结事件（completed / incomplete / failed），且在最后；
 * - response.completed 的 response.id 是字符串，usage 有就要有三个 token 数；
 * - 增量之前要有同一 item_id 的 output_item.added；
 * - output_item.done 的项能按 Codex 的 ResponseItem 解析（必填字段与类型）。
 */
export function codexProblems(events: readonly ResponsesEvent[]): string[] {
  const problems: string[] = [];
  const added = new Set<string>();
  const terminal = events.filter((e) =>
    ['response.completed', 'response.incomplete', 'response.failed'].includes(e.type),
  );
  if (terminal.length !== 1) problems.push(`终结事件有 ${terminal.length} 个`);
  else if (events.at(-1) !== terminal[0]) problems.push('终结事件不在最后');
  for (const event of events) {
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === 'response.output_item.added' && typeof item?.id === 'string')
      added.add(item.id);
    if (
      (event.type === 'response.output_text.delta' ||
        event.type === 'response.reasoning_text.delta') &&
      !added.has(String(event.item_id))
    ) {
      problems.push(`${event.type} 之前没有 ${String(event.item_id)} 的 output_item.added`);
    }
    if (event.type === 'response.output_item.done') {
      const problem = itemProblem(item);
      if (problem !== undefined) problems.push(problem);
    }
    if (event.type === 'response.completed') {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id !== 'string') problems.push('response.completed 没有字符串 id');
      const usage = response?.usage as Record<string, unknown> | undefined;
      if (
        usage !== undefined &&
        !['input_tokens', 'output_tokens', 'total_tokens'].every(
          (k) => typeof usage[k] === 'number',
        )
      ) {
        problems.push('usage 缺 token 数');
      }
    }
  }
  return problems;
}

function itemProblem(item: Record<string, unknown> | undefined): string | undefined {
  if (item === undefined) return 'output_item.done 没有 item';
  const str = (k: string) => typeof item[k] === 'string';
  switch (item.type) {
    case 'message':
      return str('role') && Array.isArray(item.content) ? undefined : 'message 缺 role 或 content';
    case 'reasoning':
      return Array.isArray(item.summary) ? undefined : 'reasoning 缺 summary';
    case 'function_call':
      return str('name') && str('arguments') && str('call_id') ? undefined : 'function_call 缺字段';
    case 'custom_tool_call':
      return str('name') && str('input') && str('call_id') ? undefined : 'custom_tool_call 缺字段';
    default:
      return `Codex 不认识的输出项 ${String(item.type)}`;
  }
}

/** 已提交的输出项（output_item.done）。 */
export function doneItems(events: readonly ResponsesEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.type === 'response.output_item.done')
    .map((e) => e.item as Record<string, unknown>);
}
