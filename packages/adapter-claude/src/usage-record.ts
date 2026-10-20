// 一次 API 请求的用量 → `usage.recorded`（0.62.0，用量统计）。Anthropic 的 usage 本来就是事件要的口径：`input_tokens` 不含
// 缓存的读写，思考的 token（`output_tokens_details.thinking_tokens`）含在 `output_tokens` 里。

import type { UsageRecordedEvent } from '@wevir/runtime-adapter';

/**
 * 还没报的一次请求。顶层会话从流式事件拼：`message_start` 带模型、输入与缓存（`output_tokens` 只是开头的一两个），
 * `message_delta` 带最终的累计用量；子 agent 没有流式事件，只有快照（见 claude-adapter.ts 的 `#childRequest`）。
 */
export interface ClaudeRequest {
  /** API 消息的 `id`（同一请求的各个快照与流式事件共用）。 */
  id: string;
  model?: string;
  usage: Record<string, unknown>;
  /** 收到 `message_start` 的时刻与它带的 `ttft_ms`（`claude` 从发出请求到 `message_start` 的毫秒数）；只有顶层有。 */
  startedAt?: number;
  ttftMs?: number;
  /** 收到 `message_delta` 的时刻：有它时用量是最终的，最后一个 token 也到了。 */
  endedAt?: number;
}

/** 后到的用量盖掉先到的（`message_delta` 里没变的字段可能是 null）。 */
export function mergeClaudeUsage(request: ClaudeRequest, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return;
  for (const [key, value] of Object.entries(usage)) {
    if (value !== null && value !== undefined) request.usage[key] = value;
  }
}

export function claudeUsageRecord(
  engineSessionId: string,
  request: ClaudeRequest,
): UsageRecordedEvent {
  const usage = request.usage;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const details = usage.output_tokens_details;
  const thinking =
    typeof details === 'object' && details !== null
      ? count((details as Record<string, unknown>).thinking_tokens)
      : 0;
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const ttft =
    request.ttftMs !== undefined && Number.isFinite(request.ttftMs) && request.ttftMs >= 0
      ? Math.round(request.ttftMs)
      : undefined;
  // 发出请求的时刻 ≈ 收到 `message_start` 减去 `ttft_ms`；中途断掉（没等到 `message_delta`）的不报时长。
  const duration =
    ttft !== undefined && request.startedAt !== undefined && request.endedAt !== undefined
      ? ttft + Math.max(0, request.endedAt - request.startedAt)
      : undefined;
  return {
    type: 'usage.recorded',
    engineSessionId,
    requestId: request.id,
    ...(request.model !== undefined && request.model !== '' && { model: request.model }),
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
    ...(thinking > 0 && { reasoningTokens: thinking }),
    ...(duration !== undefined && { durationMs: duration }),
    ...(ttft !== undefined && { firstTokenMs: ttft }),
  };
}
