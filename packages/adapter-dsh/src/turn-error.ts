import type { ClassifiedTurnError, TurnErrorCategory } from '@wevir/adapter-acp';

// 回合失败的归类（T3.2，ADR-0001 §5 第 9 条）。dsh 的轮次失败让 `session/prompt` 以 JSON-RPC `-32603`
// 结束，消息是自由文本，没有结构化错误码（T0.3 §3.4）：ACP SDK 的 `RequestError.internalError` 加前缀
// `Internal error: `，dsh-acp 再加 `turn failed: `（上游 `packages/acp/acp/src/session.ts`），后面是 dsh
// 内部失败的原文。这里只看去掉这两层之后的开头，归不了类就是 unknown；原文始终保留。
//
// 规则表与 docs/architecture/acp-event-mapping.md 的「错误归类」一致（acp-event-mapping.test.ts 检查）。
// `classifyTurnError` 是 dsh 引擎描述的回合失败归类（engine.ts）。

export interface TurnErrorRule {
  category: Exclude<TurnErrorCategory, 'unknown'>;
  /** 匹配去掉包装之后的文本开头。 */
  pattern: RegExp;
}

export const TURN_ERROR_RULES: readonly TurnErrorRule[] = Object.freeze([
  // llm-deepseek：no API key for provider route "…"；llm-pi-ai：no credential for provider route "…"。
  { category: 'missing_credentials', pattern: /^llm-[a-z0-9-]+: no (?:API key|credential) for / },
  // llm-pi-ai 的 HTTP 错误：`401: {"message":…}`；OpenAI SDK 自己的写法是 `401 …`。
  { category: 'provider', pattern: /^[1-5]\d\d:? / },
  // OpenAI SDK（llm-pi-ai 经它访问 OpenAI 兼容服务）：连不上、连接中途断开、超时。
  { category: 'provider', pattern: /^Connection error\./ },
  { category: 'provider', pattern: /^Request timed out\./ },
  // llm-deepseek：响应体里没有 error.message 时的兜底文本。
  {
    category: 'provider',
    pattern: /^DeepSeek Messages (?:request failed|returned no response body)/,
  },
]);

/** JSON-RPC 内部错误码；dsh 的轮次失败只用它。 */
export const INTERNAL_ERROR_CODE = -32603;

const WRAPPER = /^Internal error: turn failed: /;

/** 把 `session/prompt` 的失败归类。只有 `-32603` 且带 `turn failed: ` 包装的才按规则表归类。 */
export function classifyTurnError(error: unknown): ClassifiedTurnError {
  const { message, code } = describeError(error);
  const base = code === undefined ? { message } : { message, code };
  if (code !== INTERNAL_ERROR_CODE || !WRAPPER.test(message)) {
    return { category: 'unknown', ...base };
  }
  const detail = message.replace(WRAPPER, '');
  const rule = TURN_ERROR_RULES.find((candidate) => candidate.pattern.test(detail));
  return { category: rule?.category ?? 'unknown', ...base };
}

/** ACP SDK 的 `RequestError` 带数字 `code`；其余错误只取消息。 */
function describeError(error: unknown): { message: string; code?: number } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? { message: error.message, code } : { message: error.message };
  }
  if (typeof error === 'object' && error !== null) {
    const { message, code } = error as { message?: unknown; code?: unknown };
    if (typeof message === 'string') {
      return typeof code === 'number' ? { message, code } : { message };
    }
  }
  return { message: String(error) };
}
