// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts（`resultUserFacingError`、`terminalResultError`、`isOverloadedResult`、`terminalStatusFromResult`、`providerFailureFromResult`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：输出 Wevir 的 `turn.settled` / `turn.failed`（错误归成 missing_credentials / provider / unknown），去掉 T3 的失败对象与网关限流的特判。
//
// 回合结果（SDK 的 `result` 消息）→ 回合的终结事件（claude-event-mapping.md §5.6）。SDK 把 API 层的失败（401、429、529…）也
// 报成 `subtype: "success"` 加 `is_error`，`terminal_reason` 比外层的成功标记更可信。

import type { TurnFailedEvent, TurnRetryingEvent } from '@wevir/runtime-adapter';
import type { SDKAPIRetryMessage, SDKRateLimitInfo, SDKResultMessage } from './sdk.js';

/** 给人看的第一条错误（T3：`[ede_diagnostic]` 是 CLI 内部的遥测，不当错误显示）。 */
export function resultUserFacingError(result: SDKResultMessage): string | undefined {
  if (result.subtype === 'success' && !result.is_error) return undefined;
  const errors = 'errors' in result && Array.isArray(result.errors) ? result.errors : [];
  return errors.find(
    (error): error is string => typeof error === 'string' && !error.startsWith('[ede_diagnostic]'),
  );
}

/** `terminal_reason` 的说明（T3 的 `terminalResultError`）；不是失败的原因返回 undefined。 */
export function terminalReasonError(
  reason: SDKResultMessage['terminal_reason'],
  hint?: string,
): string | undefined {
  switch (reason) {
    case 'api_error':
      return hint ?? 'Claude gave up after repeated API errors.';
    case 'malformed_tool_use_exhausted':
      return 'Claude gave up after repeated malformed tool calls.';
    case 'budget_exhausted':
      return "Claude stopped: the turn's token budget was exhausted.";
    case 'structured_output_retry_exhausted':
      return 'Claude could not produce the requested structured output.';
    case 'tool_deferred_unavailable':
      return 'Claude could not resume a deferred tool call: the tool is no longer available.';
    case 'turn_setup_failed':
      return 'Claude could not start the turn.';
    case 'blocking_limit':
      return 'Claude stopped: a usage limit blocked the request.';
    case 'rapid_refill_breaker':
      return 'Claude stopped: the context refilled too quickly after compaction.';
    case 'prompt_too_long':
      return "Claude stopped: the prompt exceeds the model's context window.";
    case 'image_error':
      return 'Claude stopped: an image in the conversation could not be processed.';
    case 'model_error':
      return 'Claude stopped: the model returned an error.';
    default:
      return undefined;
  }
}

/** 结果是不是一次中断（T3：CLI 会把中断标成 success、`is_error: false`，以 `terminal_reason` 为准）。 */
export function isAbortedResult(result: SDKResultMessage): boolean {
  if (
    result.terminal_reason === 'aborted_tools' ||
    result.terminal_reason === 'aborted_streaming'
  ) {
    return true;
  }
  if (result.subtype === 'success') return false;
  const text = result.errors.join('\n').toLowerCase();
  return text.includes('interrupt') || text.includes('cancel');
}

/** 用量窗口的长度（分钟）：5 小时与按周的几种（总量、Opus、Sonnet）；按量的 `overage` 没有固定长度。 */
const LIMIT_WINDOW_MINUTES: Partial<
  Record<NonNullable<SDKRateLimitInfo['rateLimitType']>, number>
> = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
  seven_day_opus: 7 * 24 * 60,
  seven_day_sonnet: 7 * 24 * 60,
  seven_day_overage_included: 7 * 24 * 60,
};

/**
 * 被拒的 `rate_limit_event`（0.119.0）→ 回合失败时的 `usageLimit`：账号的套餐用量到了上限，`resetsAt` 是秒级时间戳。没被拒
 * （`allowed` / `allowed_warning`）时 undefined。
 */
export function rejectedUsageLimit(
  info: SDKRateLimitInfo,
): NonNullable<TurnFailedEvent['usageLimit']> | undefined {
  if (info.status !== 'rejected') return undefined;
  const minutes =
    info.rateLimitType === undefined ? undefined : LIMIT_WINDOW_MINUTES[info.rateLimitType];
  const resetsAt =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
      ? new Date(info.resetsAt * 1000).toISOString()
      : undefined;
  return {
    ...(resetsAt !== undefined && { resetsAt }),
    ...(minutes !== undefined && { windowMinutes: minutes }),
  };
}

/**
 * `api_retry`（0.119.0）→ `turn.retrying`：第几次、最多几次，原因是错误种类与 HTTP 状态码（SDK 不给原文）。没收到响应头时
 * `max_retries` 是这种原因单独的上限。
 */
export function retryingOf(
  message: Pick<SDKAPIRetryMessage, 'attempt' | 'max_retries' | 'error' | 'error_status'>,
): Omit<TurnRetryingEvent, 'engineSessionId'> {
  const valid = (value: number) => Number.isInteger(value) && value >= 1;
  return {
    type: 'turn.retrying',
    ...(valid(message.attempt) && { attempt: message.attempt }),
    ...(valid(message.max_retries) && { maxAttempts: message.max_retries }),
    reason:
      message.error_status === null
        ? message.error
        : `${message.error} (HTTP ${message.error_status})`,
  };
}

/**
 * 失败的回合 → `turn.failed` 的字段；正常完成时 undefined。`authFailed`：回合里的助手消息报过 `authentication_failed`
 * （没登录或登录过期），归为 `missing_credentials`。`usageLimit`：回合里被拒的 `rate_limit_event`（0.119.0）；结果的
 * `terminal_reason` 是 `blocking_limit` 时也算用量上限。
 */
export function resultFailure(
  result: SDKResultMessage,
  authFailed: boolean,
  usageLimit?: NonNullable<TurnFailedEvent['usageLimit']>,
): Pick<TurnFailedEvent, 'category' | 'message' | 'code' | 'usageLimit'> | undefined {
  const status = result.subtype === 'success' ? result.api_error_status : undefined;
  const listed = resultUserFacingError(result);
  if (result.subtype !== 'success') {
    return {
      category: authFailed ? 'missing_credentials' : 'unknown',
      message: listed ?? (result.errors.join('\n') || result.subtype),
    };
  }
  const structured =
    status === 529
      ? 'Claude API is overloaded (529). Try again shortly.'
      : status === 429
        ? 'Claude API rate limit reached. Try again later.'
        : terminalReasonError(result.terminal_reason);
  if (!result.is_error && structured === undefined) return undefined;
  const category =
    authFailed || status === 401
      ? 'missing_credentials'
      : status !== undefined && status !== null
        ? 'provider'
        : result.terminal_reason === 'api_error' || result.terminal_reason === 'blocking_limit'
          ? 'provider'
          : 'unknown';
  const limited = usageLimit ?? (result.terminal_reason === 'blocking_limit' ? {} : undefined);
  return {
    category,
    message: listed ?? structured ?? (result.result || 'Claude reported an error.'),
    ...(typeof status === 'number' && { code: status }),
    ...(limited !== undefined && category !== 'missing_credentials' && { usageLimit: limited }),
  };
}
