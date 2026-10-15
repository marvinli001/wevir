// Grok Build 的引擎描述（ADR-0005 决策 1.3 与补记 14，docs/architecture/grok-event-mapping.md）：通用 ACP 适配器
// （`@wevir/adapter-acp`）按它驱动用户自己装的 `grok agent stdio`。可执行文件、参数与环境随权限模式和用户指定的路径变化，
// 在启动器里（launch.ts）。

import type {
  AcpEngine,
  AcpRouteCodec,
  ClassifiedResumeError,
  ClassifiedTurnError,
} from '@wevir/adapter-acp';
import { GROK_DEFAULT_MODEL } from './models.js';
import { grokToolDisplay, isGrokTodoTool } from './tool-display.js';
import {
  GROK_INITIALIZE_META,
  grokApprovalOptions,
  XAI_ASK_USER_QUESTION_METHODS,
  XAI_EXIT_PLAN_MODE_METHODS,
  XAI_PROMPT_COMPLETE_METHODS,
  XAI_RATE_LIMITED_CODE,
  XAI_SESSION_NOTIFICATION_METHODS,
} from './xai.js';

/**
 * Grok 的会话路由：`configOptions` 里有 `model`（值就是模型 ID）与 `reasoning_effort`，换模型用 ACP 的 `session/set_model`，
 * 推理强度放在它的 `_meta.reasoningEffort` 里（T3 的 `applyGrokAcpModelSelection`；Grok 的 `initialize` 回协议版本 1，
 * T3 对它不用 `set_config_option`）。Provider 只有一个（`grok`），不进路由。
 */
export const GROK_ROUTE: AcpRouteCodec = Object.freeze<AcpRouteCodec>({
  modelMethod: 'set_model',
  modelOption: 'model',
  reasoningEffortOption: 'reasoning_effort',
  // `grok-build` 是 CLI 的产品名（检测不到模型时唯一的模型），选它就用会话当前的模型，不发 set_model（T3）。
  encode: (_providerId, modelId) => (modelId === GROK_DEFAULT_MODEL ? undefined : modelId),
  decodeModel: (value) => (value === '' ? undefined : value),
});

/** JSON-RPC 错误的原文：Grok 把真正的原因放在 `data.message`（`-32603 Internal error` 只是外壳）。 */
function describeError(error: unknown): { message: string; code?: number; httpStatus?: number } {
  if (typeof error !== 'object' || error === null) return { message: String(error) };
  const { message, code, data } = error as { message?: unknown; code?: unknown; data?: unknown };
  const detail = (data as { message?: unknown } | null | undefined)?.message;
  const status = (data as { http_status?: unknown } | null | undefined)?.http_status;
  const text =
    typeof detail === 'string' && detail !== ''
      ? detail
      : typeof message === 'string'
        ? message
        : String(error);
  return {
    message: text,
    ...(typeof code === 'number' && { code }),
    ...(typeof status === 'number' && { httpStatus: status }),
  };
}

/** Grok 要先认证（没有登录、令牌过期）：`-32000 Authentication required`（codex-notes §9）。 */
export function isAuthRequired(error: unknown): boolean {
  const { message, code } = describeError(error);
  return code === -32000 && /auth/i.test(message);
}

/**
 * 回合失败的归类（grok-event-mapping.md §2.3）：要认证的是 `missing_credentials`；用量上限（`-32003` 或 `rate_limit`）、
 * 带 HTTP 状态码的上游错误（`API error (status 400 …)`）是 `provider`；其余 unknown。原文是 `data.message`。
 */
export function classifyTurnError(error: unknown): ClassifiedTurnError {
  const { message, code, httpStatus } = describeError(error);
  const base = code === undefined ? { message } : { message, code };
  if (isAuthRequired(error) || /not (?:logged in|authenticated)/i.test(message)) {
    return { category: 'missing_credentials', ...base };
  }
  if (
    code === XAI_RATE_LIMITED_CODE ||
    httpStatus !== undefined ||
    /^API error \(status \d{3}/.test(message)
  ) {
    return { category: 'provider', ...base };
  }
  return { category: 'unknown', ...base };
}

/**
 * `session/resume` 失败的归类。Grok 的措辞还没有录到（grok-event-mapping.md §6，待维护者验证）：只把明确说会话不存在的
 * 归为 `lost`，其余 unknown（不标只读，下次还能重试）。
 */
export function classifyResumeError(error: unknown): ClassifiedResumeError {
  const { message, code } = describeError(error);
  const base = code === undefined ? { message } : { message, code };
  if (/session.*(?:not found|does not exist|unknown)|(?:no such|unknown) session/i.test(message)) {
    return { failure: { kind: 'lost', reason: 'not_found' }, ...base };
  }
  if (/already (?:active|loaded|open)/i.test(message)) {
    return { failure: { kind: 'already_active' }, ...base };
  }
  return { failure: { kind: 'unknown' }, ...base };
}

/** `initialize` 之后的 `_meta.agentVersion`（Grok 自报的版本），会话的 `engineVersion` 用它。 */
export function agentVersionOf(initialize: unknown): string | undefined {
  const meta = (initialize as { _meta?: { agentVersion?: unknown } } | undefined)?._meta;
  return typeof meta?.agentVersion === 'string' && meta.agentVersion !== ''
    ? meta.agentVersion
    : undefined;
}

/**
 * Grok 的引擎描述。`version` 是占位：Grok 由用户自己装，版本以 `initialize` 自报的为准（`agentVersionOf`），适配器建会话时
 * 换上。
 */
export const GROK_ENGINE: AcpEngine = Object.freeze<AcpEngine>({
  name: 'grok',
  version: 'unknown',
  // 工具调用、审批、close 之后 resume（`sessionCapabilities.resume`）、一个进程多个会话（`_x.ai/sessions/changed`）。
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  tools: {
    display: grokToolDisplay,
    // `todo_write` 可以只给改动的几项（`merge: true`），合并后的完整列表随后以 ACP `plan` 发出。
    isPlanTool: isGrokTodoTool,
  },
  route: GROK_ROUTE,
  classifyTurnError,
  classifyResumeError,
  // `agent_message_chunk` / `agent_thought_chunk` 是逐字增量，没有 `messageId`（codex-notes §9）。
  messageChunks: 'streamed',
  initializeMeta: GROK_INITIALIZE_META,
  extensions: {
    requests: [...XAI_ASK_USER_QUESTION_METHODS, ...XAI_EXIT_PLAN_MODE_METHODS],
    notifications: [...XAI_PROMPT_COMPLETE_METHODS, ...XAI_SESSION_NOTIFICATION_METHODS],
  },
  approvalOptions: grokApprovalOptions,
});
