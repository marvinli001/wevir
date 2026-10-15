// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/sdk.ts（另参照同目录 CursorSdkCatalog.ts、CursorAgentSdk.ts 用到的 SDK 入口）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：不再用 createRequire 加载 CJS 产物（T3 为了 Node SEA），改为第一次用到时动态 import；Effect 的 Context 服务换成窄接口 CursorSdk，
// 测试换成假的。
//
// Cursor 的官方 SDK（`@cursor/sdk`，只有本包能声明与 import，AGENTS.md 规则 2）。适配器只经这里的窄接口用它，测试换成假的
// （cursor-adapter.test.ts 的 FakeCursorSdk）。SDK 在本进程里跑 agent（`local`），不需要 Cursor CLI。

import type {
  AgentOptions,
  InteractionUpdate,
  ListResult,
  RunResult,
  SDKModel,
  SDKUser,
  SDKUserMessage,
  SdkCredentialStore,
  SdkLoginOptions,
  SdkLoginResult,
  SendOptions,
} from '@cursor/sdk';

/** 锁定的 SDK 版本（package.json 钉的确切版本），写进 `EngineSession.engineVersion`。 */
export const CURSOR_SDK_VERSION = '1.0.35';

/** 一次 `send` 开出的 run。 */
export interface CursorRun {
  readonly id: string;
  readonly agentId: string;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
}

/** 挂在本进程里的一个本地 agent（`Agent.create` / `Agent.resume` 的结果）。 */
export interface CursorAgentHandle {
  readonly agentId: string;
  send(message: string | SDKUserMessage, options?: SendOptions): Promise<CursorRun>;
  close(): void;
}

/** 本地 run 的定位参数（`Agent.listRuns` / `Agent.cancelRun` 的 `runtime: 'local'`）。 */
export interface CursorLocalRunOptions {
  cwd?: string;
  apiKey?: string;
  limit?: number;
}

/** 适配器用到的 SDK 入口。 */
export interface CursorSdk {
  createAgent(options: AgentOptions): Promise<CursorAgentHandle>;
  resumeAgent(agentId: string, options: AgentOptions): Promise<CursorAgentHandle>;
  /** 最近的 run（T3：恢复后第一条消息撞上“already has active run”时用它找出遗留的 run 取消掉）。 */
  listRuns(
    agentId: string,
    options: CursorLocalRunOptions,
  ): Promise<ListResult<{ id: string; status: string }>>;
  cancelRun(runId: string, options: CursorLocalRunOptions): Promise<void>;
  me(apiKey: string): Promise<SDKUser>;
  listModels(apiKey: string): Promise<SDKModel[]>;
  /** 浏览器登录并铸一把 API Key（`Cursor.auth.login`）。 */
  login(options: SdkLoginOptions): Promise<SdkLoginResult>;
}

export type { InteractionUpdate, SdkCredentialStore };

let loading: Promise<CursorSdk> | undefined;

/**
 * 这个 Host 能不能用 `@cursor/sdk`：安装包不带它（ADR-0007 补记 3：许可证是“All rights reserved”，维护者定不随应用再分发），
 * 没装时 Host 不挂 Cursor 引擎（host 的 engines.ts）。只解析、不加载。
 */
export function cursorSdkInstalled(): boolean {
  try {
    import.meta.resolve('@cursor/sdk');
    return true;
  } catch {
    return false;
  }
}

/** 第一次调用时加载 `@cursor/sdk`，之后复用。 */
export function loadCursorSdk(): Promise<CursorSdk> {
  loading ??= import('@cursor/sdk').then(
    (sdk): CursorSdk => ({
      createAgent: (options) => sdk.Agent.create(options),
      resumeAgent: (agentId, options) => sdk.Agent.resume(agentId, options),
      listRuns: (agentId, options) => sdk.Agent.listRuns(agentId, { runtime: 'local', ...options }),
      cancelRun: (runId, options) => sdk.Agent.cancelRun(runId, { runtime: 'local', ...options }),
      me: (apiKey) => sdk.Cursor.me({ apiKey }),
      listModels: (apiKey) => sdk.Cursor.models.list({ apiKey }),
      login: (options) => sdk.Cursor.auth.login(options),
    }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}
