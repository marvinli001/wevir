import type { TurnFailedEvent } from '@wevir/runtime-adapter';
import type { TurnError } from './protocol.js';

// 回合失败的归类（R3，docs/architecture/codex-event-mapping.md §6.7）。`turn/completed` 的 `turn.error` 带
// `codexErrorInfo`（v2/CodexErrorInfo.ts：字符串或带 `httpStatusCode` 的对象）与原文。所有 Provider 都经网关
// （ADR-0005 决策 2.2），网关把上游的状态码原样转给 Codex，自己拒绝的请求（缺 Key、连不上上游）带
// `wevir gateway:` 前缀的原文。规则自上而下第一条匹配的生效；`message` 始终是完整原文。样本在
// test-fixtures/app-server/errors/turn-*.json（真实 codex-app-server + 网关 + mock 上游录制）。

/** 网关在 Provider 没有 Key 时的拒绝（model-gateway 的 gateway.ts，401）。 */
const MISSING_KEY = /wevir gateway: Provider .+ 没有(?: API Key|服务账号 JSON)/;

/**
 * 上游以 `response.incomplete` 结束且原因不是 `content_filter`（输出达到上限：Chat 转换的 `finish_reason: length`
 * 也报成 `max_output_tokens`）。rust-v0.163.0 起 Codex 不再当作流断开重试，直接以 `other` 和这句原文结束回合。
 */
const INCOMPLETE_RESPONSE = /^Incomplete response returned, reason: /;

/** 带上游状态码的变体：连接或流的失败、重试用完。 */
const HTTP_VARIANTS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
] as const;

/** 上游（模型服务）报的错误：鉴权、限流与额度、服务端出错、请求不合规、上下文超长、内容策略。 */
const PROVIDER_ERRORS = new Set([
  'unauthorized',
  'badRequest',
  'internalServerError',
  'serverOverloaded',
  'rateLimitExceeded',
  'usageLimitExceeded',
  'contextWindowExceeded',
  'flexUnavailable',
  'cyberPolicy',
  'misalignmentPolicyViolation',
]);

export interface ClassifiedTurnError {
  category: TurnFailedEvent['category'];
  /** 上游的 HTTP 状态码（`codexErrorInfo` 带的 `httpStatusCode`），没有时省略。 */
  httpStatus?: number;
}

/**
 * - `missing_credentials`：网关说这个 Provider 没有 Key（401，`wevir gateway: Provider … 没有 API Key`）；
 * - `provider`：`codexErrorInfo` 带上游状态码（网关连不上上游时是 502），或是上游报的那几类，或是 `other` 而原文
 *   是上游的 JSON 错误体（Codex 对 400 等直接给出响应体）或不完整响应的说明；
 * - `unknown`：其余（沙箱错误、回滚失败、`other` 的其他原因等）。
 * 401 是 Key 无效，归 `provider`，与 dsh 相同（acp-event-mapping.md §3）。
 */
export function classifyTurnError(error: TurnError | null | undefined): ClassifiedTurnError {
  if (error === null || error === undefined) return { category: 'unknown' };
  const info = error.codexErrorInfo;
  const httpStatus = httpStatusOf(info);
  const withStatus = httpStatus === undefined ? {} : { httpStatus };
  if (MISSING_KEY.test(error.message)) return { category: 'missing_credentials', ...withStatus };
  if (httpStatus !== undefined) return { category: 'provider', httpStatus };
  if (typeof info === 'string') {
    if (PROVIDER_ERRORS.has(info)) return { category: 'provider' };
    if (info === 'other' && isUpstreamErrorBody(error.message)) return { category: 'provider' };
    if (info === 'other' && INCOMPLETE_RESPONSE.test(error.message))
      return { category: 'provider' };
  } else if (isRecord(info) && HTTP_VARIANTS.some((key) => key in info)) {
    return { category: 'provider' };
  }
  return { category: 'unknown' };
}

/**
 * 回合是不是因订阅账号的额度失败（0.119.0 的 `usageLimit`）：`usageLimitExceeded` 总是；ChatGPT 登录的进程（`subscription`）
 * 还有 `rateLimitExceeded` 与对 429 重试用完的 `responseTooManyFailedAttempts`——上游只用最后一次的状态码说明原因，
 * 订阅账号的 429 就是额度到了。经网关的 Provider 的 429 是限流，不算。
 */
export function isUsageLimit(error: TurnError | null | undefined, subscription: boolean): boolean {
  const info = error?.codexErrorInfo;
  if (info === 'usageLimitExceeded') return true;
  if (!subscription) return false;
  if (info === 'rateLimitExceeded') return true;
  const exhausted = isRecord(info) ? info.responseTooManyFailedAttempts : undefined;
  return isRecord(exhausted) && exhausted.httpStatusCode === 429;
}

function httpStatusOf(info: unknown): number | undefined {
  if (!isRecord(info)) return undefined;
  for (const key of HTTP_VARIANTS) {
    const variant = info[key];
    if (isRecord(variant) && typeof variant.httpStatusCode === 'number') {
      return variant.httpStatusCode;
    }
  }
  return undefined;
}

/** `{"error": {...}}` 或 `{"error": "..."}`：上游（或网关整理过的）错误体。 */
function isUpstreamErrorBody(message: string): boolean {
  const text = message.trim();
  if (!text.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && (isRecord(parsed.error) || typeof parsed.error === 'string');
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
