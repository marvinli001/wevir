import type { AcpEngine, ClassifiedResumeError, ClassifiedTurnError } from '@wevir/adapter-acp';
import { KIRO_DEFAULT_MODEL, record, withModelOption } from './models.js';
import { kiroToolDisplay } from './tool-display.js';

export const KIRO_TESTED_VERSION = '2.36.0';

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

/**
 * 2.36.0：没登录时 `kiro-cli acp` 根本起不来，在 stderr 打印 “Not logged in. Set the KIRO_API_KEY environment variable or run
 * `kiro-cli login` first.” 并以 1 退出；登录过期时回合里的错误原文没有核对过，按常见说法认。
 */
export function isKiroAuthRequired(error: unknown): boolean {
  const { message } = errorInfo(error);
  return /not logged in|authentication required|(?:token|session|credentials?) (?:has )?expired|please (?:log ?in|sign ?in|authenticate)|run `?kiro-cli login/i.test(
    message,
  );
}

export function classifyKiroTurnError(error: unknown): ClassifiedTurnError {
  const info = errorInfo(error);
  if (isKiroAuthRequired(error)) return { category: 'missing_credentials', ...info };
  if (
    /rate.?limit|throttl|quota|credits?|overage|insufficient|billing|usage limit|monthly request|daily request|overloaded|capacity|\b(?:402|429|5\d\d)\b/i.test(
      info.message,
    )
  ) {
    return { category: 'provider', ...info };
  }
  return { category: 'unknown', ...info };
}

/** `session/load` 找不到会话（Kiro 没公开错误码，按原文认）。 */
export function classifyKiroResumeError(error: unknown): ClassifiedResumeError {
  const info = errorInfo(error);
  if (/session.*not found|unknown session|no such session|resource not found/i.test(info.message)) {
    return { failure: { kind: 'lost', reason: 'not_found' }, ...info };
  }
  if (/already (?:active|loaded|open)|locked/i.test(info.message)) {
    return { failure: { kind: 'already_active' }, ...info };
  }
  return { failure: { kind: 'unknown' }, ...info };
}

/** Kiro 压缩上下文的进度（kiro.dev/docs/cli/acp 只列了名字，字段没有公开）。 */
export const KIRO_COMPACTION_STATUS = '_kiro.dev/compaction/status';
/** Kiro 每个回合与压缩之后重算的上下文用量（`contextUsagePercentage` 等）。 */
export const KIRO_METADATA = '_kiro.dev/metadata';

export const KIRO_ENGINE: AcpEngine = {
  name: 'kiro',
  version: 'unknown',
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  route: {
    // v2 引擎（`kiro-cli acp` 的默认，Wevir 固定用它）换模型用 ACP 的 `session/set_model`（kiro.dev/docs/cli/acp）。
    modelMethod: 'set_model',
    modelOption: 'model',
    modelCategory: 'model',
    encode: (_providerId, modelId) => (modelId === KIRO_DEFAULT_MODEL ? undefined : modelId),
    decodeModel: (value) => value || undefined,
  },
  tools: {
    display: kiroToolDisplay,
    isPlanTool: (name) => /^todo_?list$/i.test(name),
  },
  messageChunks: 'streamed',
  // 2.x 的 `initialize` 声明 `promptCapabilities.image: true`（官方文档）。
  images: true,
  // 声明 `loadSession: true`，没有 session/resume：用 session/load，适配器在恢复期间丢掉它回放的历史。
  resumeMethod: 'load',
  sessionModels: withModelOption,
  // 压缩上下文（2.36.0 不发 ACP 的 `compaction_update`）：Kiro 自己的进度通知，与压缩后重算上下文用量的 `metadata`（kiro-adapter.ts）。
  extensions: { notifications: [KIRO_COMPACTION_STATUS, KIRO_METADATA] },
  classifyTurnError: classifyKiroTurnError,
  classifyResumeError: classifyKiroResumeError,
};
