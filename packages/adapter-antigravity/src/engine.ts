// Antigravity 的引擎描述（ADR-0005 补记 14，docs/architecture/antigravity-event-mapping.md）：通用 ACP 适配器
// （`@wevir/adapter-acp`）按它驱动 Google 的 Antigravity ACP 运行体。可执行文件、profile 与环境在启动器里（process.ts）。

import type {
  AcpEngine,
  AcpRouteCodec,
  ClassifiedResumeError,
  ClassifiedTurnError,
} from '@wevir/adapter-acp';
import { antigravityToolDisplay, normalizeAntigravityUpdate } from './protocol.js';
import { ANTIGRAVITY_RELEASE_VERSION } from './release.js';

/** ACP 的“需要登录”（Antigravity 没有登录、登录过期时 `session/new`、`session/prompt` 报这个码）。 */
export const AUTH_REQUIRED_CODE = -32000;
const INVALID_PARAMS = -32602;

/**
 * Antigravity 的会话路由：模型就是 ACP config option `model` 的值（Google 账号能用的原生模型 ID）。运行体 1.4 起同一模型的
 * 思考档位合成一项（`gemini-3.8-flash`），档位另有 `thinking_level` 选项，选项随模型变，由适配器在选定模型之后设
 * （antigravity-adapter.ts 的 #applyThinking），不经路由；1.3 存下的带档位的 ID（`gemini-3.8-flash-high`）运行体照样认。
 * Provider 只有一个（`antigravity`），不编码进值里。
 */
export const ANTIGRAVITY_ROUTE: AcpRouteCodec = Object.freeze<AcpRouteCodec>({
  modelOption: 'model',
  encode: (_providerId, modelId) => modelId,
  decodeModel: (value) => (value.trim() === '' ? undefined : value),
});

function describe(error: unknown): { message: string; code?: number } {
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const data = (error as { data?: unknown } | null)?.data;
  const details =
    typeof data === 'string'
      ? data
      : typeof (data as { details?: unknown } | null)?.details === 'string'
        ? (data as { details: string }).details
        : undefined;
  const full =
    details !== undefined && !message.includes(details) ? `${message}: ${details}` : message;
  return typeof code === 'number' ? { message: full, code } : { message: full };
}

/** 回合失败的归类：要登录 → missing_credentials；订阅、额度、限流 → provider；其余 unknown。原文保留。 */
export function classifyAntigravityTurnError(error: unknown): ClassifiedTurnError {
  const { message, code } = describe(error);
  const base = code === undefined ? { message } : { message, code };
  if (
    code === AUTH_REQUIRED_CODE ||
    /auth(?:entication)? required|sign in|log ?in required/iu.test(message)
  ) {
    return { category: 'missing_credentials', ...base };
  }
  if (
    /SUBSCRIPTION_REQUIRED|RESOURCE_EXHAUSTED|quota|rate limit|usage limit|\b429\b|PERMISSION_DENIED/iu.test(
      message,
    )
  ) {
    return { category: 'provider', ...base };
  }
  return { category: 'unknown', ...base };
}

/**
 * `session/resume` 失败的归类。Antigravity 的措辞没有在真实运行体上录过（待维护者验证）：找不到会话的按 not_found
 * 处理（Host 标为只读），其余一律 unknown（报 engine_unavailable，可以再试）。
 */
export function classifyAntigravityResumeError(error: unknown): ClassifiedResumeError {
  const { message, code } = describe(error);
  const base = code === undefined ? { message } : { message, code };
  if (
    (code === INVALID_PARAMS || code === -32603 || code === undefined) &&
    /session[^.]*(?:not found|does not exist|unknown)|unknown session|no such session|not resumable/iu.test(
      message,
    )
  ) {
    return { failure: { kind: 'lost', reason: 'not_found' }, ...base };
  }
  if (/already (?:active|loaded)/iu.test(message)) {
    return { failure: { kind: 'already_active' }, ...base };
  }
  return { failure: { kind: 'unknown' }, ...base };
}

export const ANTIGRAVITY_ENGINE: AcpEngine = Object.freeze<AcpEngine>({
  name: 'antigravity',
  version: ANTIGRAVITY_RELEASE_VERSION,
  // 工具调用与审批走 ACP；恢复用 session/resume（T3：session/load 会回放全部工具调用，官方客户端也用 resume）；一个进程
  // 承载多个会话（T3 每个会话一个进程，Wevir 共用一个，见 antigravity-event-mapping.md §3.4）。
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  tools: {
    display: (toolName, rawInput, update) => antigravityToolDisplay(toolName, rawInput, update),
  },
  route: ANTIGRAVITY_ROUTE,
  classifyTurnError: classifyAntigravityTurnError,
  classifyResumeError: classifyAntigravityResumeError,
  // `agent_message_chunk` 是逐字增量，没有 messageId（T3 的测试样本）。
  messageChunks: 'streamed',
  normalizeUpdate: normalizeAntigravityUpdate,
  // 图片（0.28.0）：initialize 报 `promptCapabilities.image: true`（T3 的 AntigravityAcpSupport 也发图片内容块）。
  images: true,
});
