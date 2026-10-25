import type { AcpEngine, ClassifiedResumeError, ClassifiedTurnError } from '@wevir/adapter-acp';
import { COPILOT_DEFAULT_MODEL, record } from './models.js';
import { copilotToolDisplay } from './tool-display.js';

export const COPILOT_TESTED_VERSION = '1.0.103';

/**
 * Copilot 的原始会话事件（`initialize` 的 `clientCapabilities._meta`，T3 Code 的 copilotAcp.ts 同样订阅）：只要回合里每次调模型
 * 后的 `assistant.usage`，它的 `quotaSnapshots` 是账号的额度。事件经扩展通知 `github.com/copilot/sessionEvent` 送来。
 */
export const COPILOT_META_KEY = 'github.com/copilot';
export const COPILOT_SESSION_EVENT = 'github.com/copilot/sessionEvent';

function errorInfo(error: unknown) {
  const fields = record(error);
  const data = fields?.data;
  const detail = typeof data === 'string' ? data : (record(data)?.details ?? record(data)?.message);
  const message =
    typeof detail === 'string'
      ? detail
      : typeof fields?.message === 'string'
        ? fields.message
        : String(error);
  return { message, ...(typeof fields?.code === 'number' && { code: fields.code }) };
}

/** 1.0.103：没登录时 `session/new` 回 -32000 “Authentication required”。 */
export function isCopilotAuthRequired(error: unknown): boolean {
  const { message } = errorInfo(error);
  return /authentication required|not (?:logged|signed) in|please (?:log ?in|sign ?in|authenticate)|run `?copilot login/i.test(
    message,
  );
}

export function classifyCopilotTurnError(error: unknown): ClassifiedTurnError {
  const info = errorInfo(error);
  if (isCopilotAuthRequired(error)) return { category: 'missing_credentials', ...info };
  if (
    /rate.?limit|quota|premium requests?|AI credits?|insufficient|billing|usage limit|overloaded|\b(?:402|429|5\d\d)\b/i.test(
      info.message,
    )
  ) {
    return { category: 'provider', ...info };
  }
  return { category: 'unknown', ...info };
}

/** `session/load` 找不到会话（Copilot 没公开错误码，按原文认）。 */
export function classifyCopilotResumeError(error: unknown): ClassifiedResumeError {
  const info = errorInfo(error);
  if (/session.*not found|unknown session|no such session|resource not found/i.test(info.message)) {
    return { failure: { kind: 'lost', reason: 'not_found' }, ...info };
  }
  if (/already (?:active|loaded|open)|locked/i.test(info.message)) {
    return { failure: { kind: 'already_active' }, ...info };
  }
  return { failure: { kind: 'unknown' }, ...info };
}

export const COPILOT_ENGINE: AcpEngine = {
  name: 'copilot',
  version: 'unknown',
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  route: {
    modelOption: 'model',
    // 选项 ID 没有公开文档：按 ACP 的类别找模型选项。
    modelCategory: 'model',
    encode: (_providerId, modelId) => (modelId === COPILOT_DEFAULT_MODEL ? undefined : modelId),
    decodeModel: (value) => value || undefined,
  },
  tools: {
    display: copilotToolDisplay,
    isPlanTool: (name) => /^(?:update_)?todos?(?:_?write)?$/i.test(name),
  },
  messageChunks: 'streamed',
  images: true,
  // 1.0.103 的 initialize 只声明 loadSession，没有 session/resume：用 session/load，适配器在恢复期间丢掉它回放的历史。
  resumeMethod: 'load',
  clientCapabilitiesMeta: { [COPILOT_META_KEY]: { events: ['assistant.usage'] } },
  // 方法名带不带 ACP 扩展的 `_` 前缀没有核对过，两种都收。
  extensions: { notifications: [COPILOT_SESSION_EVENT, `_${COPILOT_SESSION_EVENT}`] },
  classifyTurnError: classifyCopilotTurnError,
  classifyResumeError: classifyCopilotResumeError,
};
