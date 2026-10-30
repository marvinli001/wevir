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
  normalizeUpdate: memberUpdate,
};

type Notification = Parameters<NonNullable<AcpEngine['normalizeUpdate']>>[0];

function memberUpdate(notification: Notification): Notification {
  // 成员流不能冒充主助手的回答；保留为 engine.raw，不把它当作新的 Wevir 子会话。
  if (record(notification.update._meta)?.['codebuddy.ai/memberEvent'] !== undefined) {
    return {
      ...notification,
      update: { ...notification.update, sessionUpdate: 'workbuddy_member_update' },
    };
  }
  return notification;
}

const COMPACT_INTERNAL = 'codebuddy.ai/isCompactInternal';
const SUMMARY_OPENING = '<conversation_history_summary><summary>';

/**
 * 每个适配器一份的 `normalizeUpdate`：CodeBuddy 不发 ACP `compaction_update`，压缩只以带 `codebuddy.ai/isCompactInternal` 的回答块
 * 出现（手动 `/compact` 先发只有摘要开头标签的开始块，再发带摘要的完成块；紧急压缩只发完成块；发送前的自动压缩什么都不发）。改写成
 * `compaction_update`，摘要不混进回答。
 */
export function workBuddyNormalizeUpdate(): (notification: Notification) => Notification {
  const open = new Map<string, string>();
  let seq = 0;
  return (notification) => {
    const { sessionId, update } = notification;
    if (
      update.sessionUpdate !== 'agent_message_chunk' ||
      record(update._meta)?.[COMPACT_INTERNAL] !== true
    ) {
      return memberUpdate(notification);
    }
    const content = record(update.content);
    const started = typeof content?.text === 'string' && content.text.trim() === SUMMARY_OPENING;
    const compactionId = (!started && open.get(sessionId)) || `workbuddy-${++seq}`;
    if (started) open.set(sessionId, compactionId);
    else open.delete(sessionId);
    return {
      ...notification,
      update: {
        sessionUpdate: 'compaction_update',
        compactionId,
        status: started ? 'in_progress' : 'completed',
      },
    };
  };
}
