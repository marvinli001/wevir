// Claude Agent SDK 的入口（AGENTS.md 规则 2：`@anthropic-ai/claude-agent-sdk` 只在本包）。适配器与账号只经这里拿 SDK 的
// 函数与类型；测试换成假的 `ClaudeSdk`（录好的消息回放）。

import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAPIRetryMessage,
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

let sdkModule: SdkModule | undefined;
let loading: Promise<void> | undefined;

/**
 * 这个 Host 能不能用 Claude Agent SDK（开发环境经 pnpm 装上，安装包里随 Host 带上）。只解析、不加载：没装 SDK 时 Host 照常启动，只是
 * 不挂 Claude 引擎（`claudeSdkInstalled`，host 的 engines.ts）。2026-10-16 起安装包不带 SDK（ADR-0007 补记 3），2026-10-17 起又随
 * 安装包带上（补记 6）；留着这条路给只装了部分依赖的 Host。
 */
export function claudeSdkInstalled(): boolean {
  try {
    import.meta.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * 第一次用到时才加载 SDK（它要几十毫秒、几十 MB 内存，不用 Claude 的 Host 不必付出）。已加载时返回 `undefined`，调用方不必让出事件循环；
 * 加载失败时下次再试。
 */
export function loadClaudeSdk(): Promise<void> | undefined {
  if (sdkModule !== undefined) return undefined;
  loading ??= import('@anthropic-ai/claude-agent-sdk').then(
    (sdk) => {
      sdkModule = sdk;
    },
    (error: unknown) => {
      loading = undefined;
      if ((error as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('Claude Agent SDK is not installed in this build', { cause: error });
      }
      throw error;
    },
  );
  return loading;
}

function loadedSdk(): SdkModule {
  if (sdkModule === undefined) {
    throw new Error(
      claudeSdkInstalled()
        ? 'Claude Agent SDK is not loaded yet (call load() first)'
        : 'Claude Agent SDK is not installed in this build',
    );
  }
  return sdkModule;
}

export type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAPIRetryMessage,
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
  /** 用 `query` 之前加载 SDK（`loadClaudeSdk`）；已加载或不需要加载时返回 `undefined`。 */
  load?(): Promise<void> | undefined;
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
  /** `configDir`（0.63.0）：会话在这个 `CLAUDE_CONFIG_DIR` 里（添加的账号）；省略时是 Host 自己的环境里的。 */
  forkSession(
    sessionId: string,
    options?: { dir?: string; upToMessageId?: string; title?: string },
    configDir?: string,
  ): Promise<{ sessionId: string }>;
  /** 会话在不在（`resumeSession` 判断 `session_lost`）。`configDir` 同 `forkSession`。 */
  sessionExists(sessionId: string, dir: string, configDir?: string): Promise<boolean>;
}

export const realClaudeSdk: ClaudeSdk = {
  load: loadClaudeSdk,
  query: (params) => loadedSdk().query(params),
  forkSession: (sessionId, options, configDir) =>
    inConfigDir(configDir, async () => {
      await loadClaudeSdk();
      return loadedSdk().forkSession(sessionId, options);
    }),
  sessionExists: (sessionId, dir, configDir) =>
    inConfigDir(configDir, async () => {
      await loadClaudeSdk();
      return (await loadedSdk().getSessionInfo(sessionId, { dir })) !== undefined;
    }),
};

let configDirQueue: Promise<unknown> = Promise.resolve();

/**
 * 在 Host 进程里跑的 SDK 函数（读会话、分支）按 `process.env.CLAUDE_CONFIG_DIR` 找会话（`uc()`），不收环境参数；添加的账号
 * （0.63.0）各有自己的配置目录，调用时临时换上。这类调用一次一个（换着环境时别的调用会找错目录），省略 `configDir` 的照样排队、
 * 不换环境。
 */
export function inConfigDir<T>(configDir: string | undefined, op: () => Promise<T>): Promise<T> {
  const run = configDirQueue.then(async () => {
    if (configDir === undefined) return op();
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      return await op();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
  configDirQueue = run.catch(() => {});
  return run;
}
