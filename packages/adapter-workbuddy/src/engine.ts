import type { AcpEngine, ClassifiedResumeError, ClassifiedTurnError } from '@wevir/adapter-acp';
import { record, WORKBUDDY_DEFAULT_MODEL } from './models.js';
import { workBuddyToolDisplay } from './tool-display.js';

export const WORKBUDDY_TESTED_VERSION = '2.168.2';
export const WORKBUDDY_QUESTION = '_codebuddy.ai/question';
export const WORKBUDDY_AUTH_URL = '_codebuddy.ai/authUrl';
export const WORKBUDDY_RESOLVE_INTERRUPTION = '_codebuddy.ai/resolveInterruption';

function errorInfo(error: unknown) {
  const fields = record(error);
  const data = record(fields?.data);
  const detail = data?.details ?? data?.message;
  const message =
    typeof detail === 'string'
      ? detail
      : typeof fields?.message === 'string'
        ? fields.message
        : String(error);
  return { message, ...(typeof fields?.code === 'number' && { code: fields.code }) };
}

export function isWorkBuddyAuthRequired(error: unknown): boolean {
  const { code, message } = errorInfo(error);
  return (
    (code === -32000 && /auth/i.test(message)) ||
    /authentication required|not (?:logged in|authenticated)|login required/i.test(message)
  );
}

export function classifyWorkBuddyTurnError(error: unknown): ClassifiedTurnError {
  const info = errorInfo(error);
  if (isWorkBuddyAuthRequired(error)) return { category: 'missing_credentials', ...info };
  if (
    /rate.?limit|quota|credits?|insufficient|RESOURCE_EXHAUSTED|\b(?:429|5\d\d)\b|API error/i.test(
      info.message,
    )
  ) {
    return { category: 'provider', ...info };
  }
  return { category: 'unknown', ...info };
}

export function classifyWorkBuddyResumeError(error: unknown): ClassifiedResumeError {
  const info = errorInfo(error);
  if (
    /session.*(?:not found|does not exist|unknown)|(?:no such|unknown) session/i.test(info.message)
  ) {
    return { failure: { kind: 'lost', reason: 'not_found' }, ...info };
  }
  if (/already (?:active|loaded|open)/i.test(info.message)) {
    return { failure: { kind: 'already_active' }, ...info };
  }
  return { failure: { kind: 'unknown' }, ...info };
}

export const WORKBUDDY_ENGINE: AcpEngine = {
  name: 'workbuddy',
  version: 'unknown',
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  route: {
    modelOption: 'model',
    reasoningEffortOption: 'thought_level',
    encode: (_providerId, modelId) => (modelId === WORKBUDDY_DEFAULT_MODEL ? undefined : modelId),
    decodeModel: (value) => value || undefined,
  },
  tools: {
    display: workBuddyToolDisplay,
    isPlanTool: (name) => /^todo_?write$/i.test(name),
  },
  messageChunks: 'streamed',
  images: true,
  classifyTurnError: classifyWorkBuddyTurnError,
  classifyResumeError: classifyWorkBuddyResumeError,
  extensions: {
    requests: [WORKBUDDY_QUESTION, WORKBUDDY_AUTH_URL],
    notifications: [
      WORKBUDDY_AUTH_URL,
      '_codebuddy.ai/checkpoint',
      '_codebuddy.ai/artifact',
      '_codebuddy.ai/artifactBatch',
      '_codebuddy.ai/command',
      '_codebuddy.ai/file_history_snapshot',
    ],
  },
  normalizeUpdate: (notification) => {
    // 成员流不能冒充主助手的回答；保留为 engine.raw，不把它当作新的 Wevir 子会话。
    if (record(notification.update._meta)?.['codebuddy.ai/memberEvent'] !== undefined) {
      return {
        ...notification,
        update: { ...notification.update, sessionUpdate: 'workbuddy_member_update' },
      };
    }
    return notification;
  },
};
