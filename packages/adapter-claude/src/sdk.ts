// Claude Agent SDK 的入口（AGENTS.md 规则 2：`@anthropic-ai/claude-agent-sdk` 只在本包）。适配器与账号只经这里拿 SDK 的
// 函数与类型；测试换成假的 `ClaudeSdk`（录好的消息回放）。

import {
  type CanUseTool,
  forkSession,
  getSessionInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  type PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

export type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAssistantMessage,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
  SdkPermissionMode,
};

/** 适配器用到的 SDK 函数。 */
export interface ClaudeSdk {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
  forkSession(
    sessionId: string,
    options?: { dir?: string; upToMessageId?: string; title?: string },
  ): Promise<{ sessionId: string }>;
  /** 会话在不在（`resumeSession` 判断 `session_lost`）。 */
  sessionExists(sessionId: string, dir: string): Promise<boolean>;
}

export const realClaudeSdk: ClaudeSdk = {
  query: (params) => query(params),
  forkSession: (sessionId, options) => forkSession(sessionId, options),
  sessionExists: async (sessionId, dir) => (await getSessionInfo(sessionId, { dir })) !== undefined,
};
