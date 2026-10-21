import type { AcpEngine, ClassifiedResumeError, ClassifiedTurnError } from '@wevir/adapter-acp';
import { DEVIN_DEFAULT_MODEL, record } from './models.js';
import { devinToolDisplay } from './tool-display.js';

export const DEVIN_TESTED_VERSION = '3000.11.92';

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

/** 3000.11.92：没登录时 `session/prompt` 回 -32000 “Please log in to use Devin…”，同时发 `agent_stopped`（`auth_required`）。 */
export function isDevinAuthRequired(error: unknown): boolean {
  const { message } = errorInfo(error);
  return /please (?:log ?in|authenticate)|not (?:logged in|authenticated)|auth(?:entication)? required|run `\/login`/i.test(
    message,
  );
}

export function classifyDevinTurnError(error: unknown): ClassifiedTurnError {
  const info = errorInfo(error);
  if (isDevinAuthRequired(error)) return { category: 'missing_credentials', ...info };
  if (
    /rate.?limit|quota|credits?|ACUs?\b|insufficient|billing|usage limit|overloaded|\b(?:429|5\d\d)\b/i.test(
      info.message,
    )
  ) {
    return { category: 'provider', ...info };
  }
  return { category: 'unknown', ...info };
}

/** `session/load` 找不到会话：-32016 “Session not found”，`data['cognition.ai/errorKind']` 是 `session_not_found`。 */
export function classifyDevinResumeError(error: unknown): ClassifiedResumeError {
  const info = errorInfo(error);
  const kind = record(record(error)?.data)?.['cognition.ai/errorKind'];
  if (kind === 'session_not_found' || /session.*not found|unknown session/i.test(info.message)) {
    return { failure: { kind: 'lost', reason: 'not_found' }, ...info };
  }
  if (/already (?:active|loaded|open)|locked/i.test(info.message)) {
    return { failure: { kind: 'already_active' }, ...info };
  }
  return { failure: { kind: 'unknown' }, ...info };
}

export const DEVIN_ENGINE: AcpEngine = {
  name: 'devin',
  version: 'unknown',
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  route: {
    modelOption: 'model',
    encode: (_providerId, modelId) => (modelId === DEVIN_DEFAULT_MODEL ? undefined : modelId),
    decodeModel: (value) => value || undefined,
  },
  tools: {
    display: devinToolDisplay,
    isPlanTool: (name) => /^todo_?write$/i.test(name),
  },
  messageChunks: 'streamed',
  images: true,
  // Devin 没有 session/resume，只有回放历史的 session/load（适配器在恢复期间丢掉回放）。
  resumeMethod: 'load',
  classifyTurnError: classifyDevinTurnError,
  classifyResumeError: classifyDevinResumeError,
};
