// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/sdk.ts（另参照同目录 CursorSdkCatalog.ts、CursorAgentSdk.ts 用到的 SDK 入口）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8；SDK 1.2.0 跟进 c8a601c0dfa5c7626e51e06d727076f6b840a005；检查点与 run 记录照
// c165587702dae88d8e1d2236114f52e44cf2f205、0b308312d53f0e434e4ff58b32bc6de0221454ff（CursorAgentSdk.ts 的 readContextUsage、runCheckpointed）
// Copyright (c) 2026 T3 Tools Inc.
// 修改：不再用 createRequire 加载 CJS 产物（T3 为了 Node SEA），改为第一次用到时动态 import（安装包里从数据目录下载装好的那份加载）；Effect 的 Context 服务换成窄接口 CursorSdk，
// 测试换成假的。
//
// Cursor 的官方 SDK（`@cursor/sdk`，只有本包能声明与 import，AGENTS.md 规则 2）。适配器只经这里的窄接口用它，测试换成假的
// （cursor-adapter.test.ts 的 FakeCursorSdk）。SDK 在本进程里跑 agent（`local`），不需要 Cursor CLI。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AgentOptions,
  InteractionUpdate,
  ListResult,
  RunRecord,
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
export const CURSOR_SDK_VERSION = '1.2.0';

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
  summarize(): Promise<CursorRun>;
  close(): void;
}

/** 本地 run 的定位参数（`Agent.listRuns` / `Agent.cancelRun` 的 `runtime: 'local'`）。 */
export interface CursorLocalRunOptions {
  cwd?: string;
  apiKey?: string;
  limit?: number;
  /** 下一页（上一页的 `nextCursor`）。 */
  cursor?: string;
}

/** 适配器用到的 SDK 入口。 */
export interface CursorSdk {
  createAgent(options: AgentOptions): Promise<CursorAgentHandle>;
  resumeAgent(agentId: string, options: AgentOptions): Promise<CursorAgentHandle>;
  /**
   * agent 的 run，分页（T3：恢复后第一条消息撞上“already has active run”时用它找出遗留的 run 取消掉）。本地存储按从旧到新列出。
   */
  listRuns(
    agentId: string,
    options: CursorLocalRunOptions,
  ): Promise<ListResult<{ id: string; status: string }>>;
  cancelRun(runId: string, options: CursorLocalRunOptions): Promise<void>;
  /**
   * agent 最近的检查点（本地存储的 `checkpointStore.loadLatest`；SDK 的类型是 unknown，实际是 ConversationStateStructure，带
   * `tokenDetails`）；还没有检查点时是 null。`cwd` 是 agent 的工作目录，本地存储按它定位。
   */
  loadCheckpoint(agentId: string, cwd: string): Promise<unknown>;
  /** 本地存储里的一个 run（`store.getRun`），看它开始时与最近的检查点；没有这个 run 时是 null。 */
  getRun(
    agentId: string,
    runId: string,
    cwd: string,
  ): Promise<Pick<RunRecord, 'startCheckpointRef' | 'latestCheckpointRef'> | null>;
  me(apiKey: string): Promise<SDKUser>;
  listModels(apiKey: string): Promise<SDKModel[]>;
  /** 浏览器登录并铸一把 API Key（`Cursor.auth.login`）。 */
  login(options: SdkLoginOptions): Promise<SdkLoginResult>;
}

export type { InteractionUpdate, SdkCredentialStore };

/** 已加载的 SDK：键是 SDK 所在的目录，空串是随 Host 解析到的那份（开发环境经 pnpm 装的）。 */
const loading = new Map<string, Promise<CursorSdk>>();

/**
 * 这个 Host 自己解析得到 `@cursor/sdk` 吗（开发环境经 pnpm 装上）。安装包不带它（许可证是“All rights reserved”，Wevir 不再分发），
 * 那时由用户选用时下载到数据目录（sdk-install.ts）。只解析、不加载。
 */
export function cursorSdkInstalled(): boolean {
  try {
    import.meta.resolve('@cursor/sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * 第一次调用时加载 `@cursor/sdk`，之后复用。`root` 是下载装好的 SDK（`CursorSdkInstallation.root`，其下 `node_modules/@cursor/sdk`），
 * 省略时用 Host 自己解析得到的那份。
 */
export function loadCursorSdk(root?: string): Promise<CursorSdk> {
  const key = root ?? '';
  let promise = loading.get(key);
  if (promise === undefined) {
    promise = importSdk(root).then(wrap, (error: unknown) => {
      loading.delete(key);
      throw error;
    });
    loading.set(key, promise);
  }
  return promise;
}

async function importSdk(root: string | undefined): Promise<typeof import('@cursor/sdk')> {
  if (root === undefined) {
    useSandboxHelper(fileURLToPath(import.meta.resolve('@cursor/sdk')));
    return import('@cursor/sdk');
  }
  const packageDir = join(root, 'node_modules', '@cursor', 'sdk');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: { '.'?: { import?: unknown; default?: unknown } };
  };
  const entry = manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default;
  if (typeof entry !== 'string') throw new Error('the installed @cursor/sdk has no ESM entry');
  useInstalledPlatformPackage(root);
  useSandboxHelper(join(packageDir, entry));
  return import(pathToFileURL(join(packageDir, entry)).href) as Promise<
    typeof import('@cursor/sdk')
  >;
}

/**
 * SDK 找 `cursorsandbox` 只从 `process.argv[1]` 与可执行文件往上找 `node_modules/@cursor/sdk-<平台>/bin`，没有对应的环境变量；
 * 找不到时开沙箱的权限模式（请求批准、自动审核）每条消息都失败，而且这个结果在进程里一直缓存。Host 只在启动时读命令行，
 * 所以把 `argv[1]` 指到 SDK 自己的入口文件：从它往上就是装 SDK 的 `node_modules`，平台包与 SDK 并列（数据目录里的下载与
 * pnpm 的布局都是）。
 */
function useSandboxHelper(entryFile: string): void {
  process.argv[1] = entryFile;
}

/**
 * SDK 找平台包里的 `rg` 与 tree-sitter 是从 Host 的入口文件与可执行文件往上找 `node_modules`，找不到下载在数据目录里的这份，
 * 所以经它认的两个环境变量指过去（用户自己设了的不动）。`cursorsandbox` 没有对应的变量，见 `useSandboxHelper`。
 */
function useInstalledPlatformPackage(root: string): void {
  const platformDir = join(
    root,
    'node_modules',
    '@cursor',
    `sdk-${process.platform}-${process.arch}`,
  );
  const rg = join(platformDir, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  const vendor = join(platformDir, 'vendor');
  if (!process.env.CURSOR_RIPGREP_PATH && existsSync(rg)) process.env.CURSOR_RIPGREP_PATH = rg;
  if (!process.env.CURSOR_TREE_SITTER_VENDOR_DIR && existsSync(join(vendor, 'tree-sitter'))) {
    process.env.CURSOR_TREE_SITTER_VENDOR_DIR = vendor;
  }
}

function wrap(sdk: typeof import('@cursor/sdk')): CursorSdk {
  let sandboxPrimed: Promise<void> | undefined;
  async function prepareFullAccess(options: AgentOptions): Promise<void> {
    if (process.platform === 'win32' || options.local?.sandboxOptions?.enabled !== false) return;
    const { cwd } = options.local;
    // The SDK caches the first sandbox capability check, even when the helper was disabled.
    sandboxPrimed ??= (async () => {
      const workspace = await sdk.createAgentPlatform(
        cwd === undefined ? {} : { workspaceRef: cwd },
      );
      const release = await workspace.prewarmLocalWorkspace({
        ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
        local: {
          ...(cwd !== undefined && { cwd }),
          settingSources: [],
          sandboxOptions: { enabled: true },
        },
      });
      await release();
    })().catch(() => {
      // Full access remains usable on hosts where the sandbox helper cannot start.
    });
    await sandboxPrimed;
  }
  return {
    createAgent: async (options) => {
      await prepareFullAccess(options);
      return sdk.Agent.create(options);
    },
    resumeAgent: async (agentId, options) => {
      await prepareFullAccess(options);
      return sdk.Agent.resume(agentId, options);
    },
    listRuns: (agentId, options) => sdk.Agent.listRuns(agentId, { runtime: 'local', ...options }),
    cancelRun: (runId, options) => sdk.Agent.cancelRun(runId, { runtime: 'local', ...options }),
    // 与 Agent.create 的本地 agent 同一个存储：SDK 按工作目录缓存平台（createAgentPlatform 的 workspaceRef 就是 local.cwd）。
    loadCheckpoint: async (agentId, cwd) =>
      (await sdk.createAgentPlatform({ workspaceRef: cwd })).checkpointStore.loadLatest(agentId),
    getRun: async (agentId, runId, cwd) =>
      (await sdk.createAgentPlatform({ workspaceRef: cwd })).store.getRun(agentId, runId),
    me: (apiKey) => sdk.Cursor.me({ apiKey }),
    listModels: (apiKey) => sdk.Cursor.models.list({ apiKey }),
    login: (options) => sdk.Cursor.auth.login(options),
  };
}
