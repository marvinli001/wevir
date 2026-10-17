// Claude Agent SDK 的入口（AGENTS.md 规则 2：`@anthropic-ai/claude-agent-sdk` 只在本包）。适配器与账号只经这里拿 SDK 的
// 函数与类型；测试换成假的 `ClaudeSdk`（录好的消息回放）。

import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAssistantMessage,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
  PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

/**
 * 动态 import：没装 SDK 时 Host 照常启动，只是不挂 Claude 引擎（`claudeSdkInstalled`，host 的 engines.ts）。2026-10-16 起安装包
 * 不带 SDK（ADR-0007 补记 3），2026-10-17 起又随安装包带上（补记 6）；留着这条路给只装了部分依赖的 Host。只把“找不到这个模块”
 * 当成没装，别的加载错误照样抛出。
 */
const sdkModule: SdkModule | undefined = await import('@anthropic-ai/claude-agent-sdk').catch(
  (error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  },
);

/** 这个 Host 能不能用 Claude Agent SDK（开发环境经 pnpm 装上，安装包里随 Host 带上）。 */
export function claudeSdkInstalled(): boolean {
  return sdkModule !== undefined;
}

function loadedSdk(): SdkModule {
  if (sdkModule === undefined) throw new Error('Claude Agent SDK is not installed in this build');
  return sdkModule;
}

export type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAssistantMessage,
  SDKControlGetContextUsageResponse,
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
  query: (params) => loadedSdk().query(params),
  forkSession: (sessionId, options) => loadedSdk().forkSession(sessionId, options),
  sessionExists: async (sessionId, dir) =>
    (await loadedSdk().getSessionInfo(sessionId, { dir })) !== undefined,
};
