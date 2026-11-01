import type { EngineErrorInfo, UsageLimit } from './entities.js';

/** 只有无需修改配置或输入就能继续的模型错误提供恢复操作。 */
export function modelErrorRecovery(
  error: EngineErrorInfo & { code?: number; fatal?: boolean; usageLimit?: UsageLimit },
): 'retry' | 'continue' | undefined {
  if (error.category !== 'provider' || error.fatal || error.usageLimit !== undefined) return;
  const { message } = error;
  if (/^Incomplete response returned, reason: max_output_tokens\b/.test(message)) {
    return 'continue';
  }
  if (
    /insufficient[_\s-]*(?:quota|credits?|balance|funds)|quota[_\s-]*(?:exceeded|exhausted)|billing|credit balance|余额不足|额度不足|欠费|invalid[_\s-]*(?:api[_\s-]*)?key|model[_\s-]*not[_\s-]*found|model\b.{0,80}\b(?:does not exist|not found)|unauthori[sz]ed|context[_\s-]*(?:window|length)|content[_\s-]*filter|content policy/i.test(
      message,
    )
  ) {
    return;
  }
  const status =
    error.code !== undefined && error.code >= 400 && error.code < 600
      ? error.code
      : Number(/\b([45]\d\d)\b/.exec(message)?.[1]);
  if (status !== undefined && status >= 400 && status < 600) {
    return [408, 409, 425, 429].includes(status) || status >= 500 ? 'retry' : undefined;
  }
  if (
    /stream.{0,40}(?:disconnect|closed|reset)|connection.{0,40}(?:failed|closed|reset|refused)|network|fetch failed|failed to fetch|error sending request|timed? out|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|rate[_\s-]*limit|overload|capacity.{0,20}unavailable|temporarily unavailable|server[_\s-]*error/i.test(
      message,
    )
  ) {
    return 'retry';
  }
}
