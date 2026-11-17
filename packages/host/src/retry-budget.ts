import type { AgentEvent } from '@wevir/runtime-adapter';

// 重试的时限（照 T3 Code 362ac8d、66a40c7、00766e2，#33130、#29208、#33152）：引擎报 `turn.retrying` 之后可能再也不恢复——Codex
// 等网络时不计次数一直等，Claude 一次挂住的请求就能等好几分钟——回合一直停在“正在重新连接”。Host 替所有引擎管一个时限：从回合
// 里第一条 `turn.retrying` 算起，之后的重试都算在同一个时限里，模型重新有输出时清掉；到时停下回合、记为失败。会话这边（计时、
// 停下、结算）在 session-manager.ts。

/** 回合停在重试里最多多久（T3 的 `PROVIDER_RETRY_BUDGET_MS`）。恢复了的重试一般在 75 秒内重新有输出。 */
export const RETRY_BUDGET_MS = 10 * 60_000;

/**
 * 说明模型又在出东西、重试已经恢复的引擎事件：文字与思考的增量和提交、工具调用开始、计划。T3 按各引擎的“模型重新开始回答”
 * 判定（Claude 的 `message_start`、Codex 的 `item/started`、Pi 的 `message_update`），这几种是它们在 Wevir 的事件里的样子。用量
 * （Codex 每次报 token 用量都重发缓存的额度，迟到的网关用量还可能属于上一个回合）、工具的进展与结束（重试之前开始的工具）、被丢弃
 * 的增量流（`assistant.stream_ended`）都不算。
 */
export const RETRY_RECOVERY_EVENTS: ReadonlySet<AgentEvent['type']> = new Set([
  'assistant.delta',
  'assistant.message',
  'assistant.thought',
  'tool.started',
  'plan.delta',
  'plan.proposed',
]);

/**
 * 重试的原因是不是请求太多（HTTP 429）：Claude 的原因写成 `rate_limit (HTTP 429)`，Codex 的是服务端的原文（`unexpected status
 * 429 Too Many Requests: …`）。`turn.retrying` 不带状态码，只能看原文。
 */
export function retryRateLimited(reason: string | undefined): boolean {
  return (
    reason !== undefined &&
    /\b(?:HTTP|status|code)\s*429\b|\b429 Too Many Requests\b|\btoo many requests\b|\brate[_ ]limit/i.test(
      reason,
    )
  );
}

/** 停下回合时 `engine.error` 的说明，带最后一次重试的原因。 */
export function retryExpiredMessage(budgetMs: number, reason: string | undefined): string {
  const minutes = Math.max(1, Math.round(budgetMs / 60_000));
  const last = reason === undefined || reason === '' ? '' : ` The last error was: ${reason}`;
  return (
    `Stopped the turn: the model service was still being retried after ${minutes} ` +
    `minute${minutes === 1 ? '' : 's'}.${last}`
  );
}
