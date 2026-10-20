// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/ClaudeProvider.ts（`checkClaudeProviderStatus`、`probeClaudeCapabilities`、`buildClaudeCapabilitiesProbeQueryOptions`、`claudeSubscriptionLabel`、`claudeAuthStatus`、`claudeAuthMetadata`）、apps/server/src/provider/claudeUsageLimits.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `AccountState`（`EngineAccounts`）；用量只留 5 小时与 7 天两个窗口，另认 `rate_limit_event` 的 `unifiedWindows`；去掉 slash 命令、skills 与重置额度。
//
// Claude Agent 的账号（claude-event-mapping.md §2）：Wevir 自己不碰令牌。`claude` 找用户自己装的，没有就由 Wevir 从 npm 下载
// 一份（install.ts 的 `NpmPackageInstaller`，`account.install`）；登录在 macOS 与 Linux 上由设置里的按钮替用户启动
// `claude auth login`（login.ts），其余平台给命令，用户在终端里登录后重新检测。检测照 T3：
// 先找 `claude` 并跑 `--version`，再开一个 SDK 的探测会话读初始化结果里的 `account`——探测的 prompt 永远不产出，`claude`
// 只做本地的初始化，不向 Anthropic 发请求——顺带读一次套餐用量（SDK 的实验接口，失败不影响登录状态）。结果缓存 5 分钟
// （T3 的 `CAPABILITIES_PROBE_TTL`），`read` 带 `refresh` 时重新检测；回合里的 `rate_limit_event` 更新用量。

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type AccountKind,
  type AccountModels,
  type AccountRateLimitWindow,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { NpmInstallCancelled, NpmPackageInstaller } from '@wevir/runtime-adapter/npm-package';
import { type ClaudeEnvOptions, claudeEnv } from './env.js';
import {
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_LOGIN_COMMAND,
  claudeLoginCommand,
  claudeNpmPackage,
  findClaude,
  findGitBash,
  GIT_BASH_MISSING_MESSAGE,
  GIT_FOR_WINDOWS_URL,
  isGitBashError,
  probeClaudeVersion,
  VERSION_TIMEOUT_MS,
} from './executable.js';
import {
  type ClaudeLoginFlow,
  inAppLoginSupported,
  runClaudeCommand,
  startClaudeLogin,
} from './login.js';
import { claudeModels } from './model-catalog.js';
import type {
  ClaudeSdk,
  Options,
  SDKControlGetUsageResponse,
  SDKRateLimitInfo,
  SDKUserMessage,
} from './sdk.js';

/** 探测结果的有效期（T3 的 `CAPABILITIES_PROBE_TTL`）。 */
export const PROBE_TTL_MS = 5 * 60_000;
/** 探测会话等初始化结果的时限（T3 的 `CAPABILITIES_PROBE_TIMEOUT_MS`：Bedrock 初始化慢）。 */
export const PROBE_TIMEOUT_MS = 25_000;
/** 读用量的时限，单独计（T3：慢的可选请求不能拖掉初始化结果）。 */
export const USAGE_TIMEOUT_MS = 10_000;
/** `claude auth logout` 的时限。 */
export const LOGOUT_TIMEOUT_MS = 20_000;

const FIVE_HOURS = 5 * 60;
const ONE_WEEK = 7 * 24 * 60;

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part !== '')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

/** SDK 的 `subscriptionType` → 套餐的显示名（T3 的 `claudeSubscriptionLabel`）。 */
export function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === undefined || normalized === '') return undefined;
  switch (normalized) {
    case 'claudemaxsubscription':
    case 'max':
    case 'maxplan':
      return 'Max';
    case 'claudemax5xsubscription':
    case 'max5':
      return 'Max 5x';
    case 'claudemax20xsubscription':
    case 'max20':
      return 'Max 20x';
    case 'claudeenterprisesubscription':
    case 'enterprise':
      return 'Enterprise';
    case 'claudeteamsubscription':
    case 'team':
      return 'Team';
    case 'claudeprosubscription':
    case 'pro':
      return 'Pro';
    case 'claudefreesubscription':
    case 'free':
      return 'Free';
    default:
      return titleCase(subscriptionType as string);
  }
}

/** SDK 初始化结果里的账号（`AccountInfo`）。 */
export interface ClaudeAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

/**
 * 有没有登录（T3 的 `claudeAuthStatus`）：探测会话对没登录的 `claude` 也能完成，所以只有 `tokenSource: "none"` 而且没有
 * API Key、邮箱与套餐时才算没登录；第三方后端（Bedrock 等）的认证在 AWS / gcloud，一律算已登录。什么都不报（太旧的
 * `claude`、用 profile 登录的）不算没登录。
 */
export function claudeSignedIn(account: ClaudeAccountInfo | undefined): boolean {
  if (account === undefined) return true;
  if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') return true;
  if (account.tokenSource !== 'none') return true;
  const hasApiKey = account.apiKeySource !== undefined && account.apiKeySource !== 'none';
  return hasApiKey || account.email !== undefined || account.subscriptionType !== undefined;
}

/** 套餐的显示（T3 的 `claudeAuthMetadata` / `apiProviderAuthMetadata`）：API Key、Bedrock 或订阅。 */
export function claudePlan(
  account: ClaudeAccountInfo | undefined,
): { plan: string; planLabel: string } | undefined {
  const normalized = account?.tokenSource?.toLowerCase().replace(/[\s_-]+/g, '');
  if (
    normalized === 'apikey' ||
    normalized === 'anthropicapikey' ||
    normalized === 'anthropicauthtoken'
  ) {
    return { plan: 'apiKey', planLabel: 'API Key' };
  }
  if (account?.subscriptionType !== undefined) {
    const label = claudeSubscriptionLabel(account.subscriptionType);
    if (label !== undefined) return { plan: account.subscriptionType, planLabel: label };
  }
  if (account?.apiProvider === 'bedrock') return { plan: 'bedrock', planLabel: 'Amazon Bedrock' };
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoOrUndefined(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * `get_usage` 的结果 → 账号的用量（T3 的 `claudeUsageResponseToLimits`）：5 小时窗口是 primary，7 天窗口是 secondary，百分比
 * 已是 0–100。没有套餐用量（API Key、Bedrock）时 undefined。按模型的周窗口 Wevir 的账号状态放不下，不报。
 */
export function usageRateLimits(
  response: Pick<SDKControlGetUsageResponse, 'rate_limits_available' | 'rate_limits'>,
): AccountState['rateLimits'] {
  if (!response.rate_limits_available || response.rate_limits === null) return undefined;
  const window = (
    entry: { utilization: number | null; resets_at: string | null } | null | undefined,
    minutes: number,
  ): AccountRateLimitWindow | undefined => {
    if (entry === null || entry === undefined || typeof entry.utilization !== 'number') {
      return undefined;
    }
    const resetsAt = isoOrUndefined(entry.resets_at);
    return {
      usedPercent: clampPercent(entry.utilization),
      windowMinutes: minutes,
      ...(resetsAt !== undefined && { resetsAt }),
    };
  };
  const primary = window(response.rate_limits.five_hour, FIVE_HOURS);
  const secondary = window(response.rate_limits.seven_day, ONE_WEEK);
  if (primary === undefined && secondary === undefined) return undefined;
  return {
    ...(primary !== undefined && { primary }),
    ...(secondary !== undefined && { secondary }),
  };
}

/**
 * 回合里的 `rate_limit_event` → 更新后的用量（T3 的 `claudeRateLimitEventToUpdate`）：一次只报一个窗口，用量是 0–1 的
 * 小数，重置时间是秒级时间戳。不认识的窗口返回 undefined。
 */
export function applyRateLimitEvent(
  current: AccountState['rateLimits'],
  info: SDKRateLimitInfo,
): AccountState['rateLimits'] | undefined {
  // 新版 `claude` 另带两个窗口的全貌（`unifiedWindows`，SDK 的类型里还没有），有它就两个一起更新。
  const unified = (
    info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> }
  ).unifiedWindows;
  if (unified !== undefined && typeof unified === 'object') {
    const window = (
      entry: { utilization?: unknown; resetsAt?: unknown } | undefined,
      minutes: number,
    ): AccountRateLimitWindow | undefined => {
      if (entry === undefined || typeof entry.utilization !== 'number') return undefined;
      const resetsAt = isoOrUndefined(
        typeof entry.resetsAt === 'number' ? entry.resetsAt : undefined,
      );
      return {
        usedPercent: clampPercent(entry.utilization * 100),
        windowMinutes: minutes,
        ...(resetsAt !== undefined && { resetsAt }),
      };
    };
    const primary = window(unified.five_hour, FIVE_HOURS);
    const secondary = window(unified.seven_day, ONE_WEEK);
    if (primary !== undefined || secondary !== undefined) {
      return {
        ...current,
        ...(primary !== undefined && { primary }),
        ...(secondary !== undefined && { secondary }),
      };
    }
  }
  if (typeof info.utilization !== 'number') return undefined;
  const slot =
    info.rateLimitType === 'five_hour'
      ? 'primary'
      : info.rateLimitType === 'seven_day'
        ? 'secondary'
        : undefined;
  if (slot === undefined) return undefined;
  const resetsAt = isoOrUndefined(info.resetsAt);
  return {
    ...current,
    [slot]: {
      usedPercent: clampPercent(info.utilization * 100),
      windowMinutes: slot === 'primary' ? FIVE_HOURS : ONE_WEEK,
      ...(resetsAt !== undefined && { resetsAt }),
    },
  };
}

/** 探测会话的 SDK 选项（T3 的 `buildClaudeCapabilitiesProbeQueryOptions`）。 */
export function probeQueryOptions(input: {
  executablePath: string;
  abortController: AbortController;
  env: Record<string, string | undefined>;
  cwd: string;
}): Options {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: ['user', 'project', 'local'],
    // 不跑用户的 hooks：每次检测都会触发 SessionStart。
    settings: { disableAllHooks: true },
    allowedTools: [],
    // 不连任何 MCP 服务器（含 claude.ai 上连接的）：只要初始化结果。
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.env,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    },
    cwd: input.cwd,
    stderr: () => {},
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

export interface ClaudeProbe {
  account: ClaudeAccountInfo | undefined;
  usage?: Pick<SDKControlGetUsageResponse, 'rate_limits_available' | 'rate_limits'>;
}

/**
 * 开一个探测会话读初始化结果（T3 的 `probeClaudeCapabilities`）：prompt 是永远不产出的异步迭代，`claude` 完成本地的初始化
 * （账号、命令）却不发请求；读完就中止。失败时抛错。
 */
export async function probeClaudeAccount(
  sdk: ClaudeSdk,
  input: { executablePath: string; env: Record<string, string | undefined>; cwd: string },
  signal?: AbortSignal,
): Promise<ClaudeProbe> {
  const abortController = new AbortController();
  // 外面中止（dispose）时连同 `claude` 进程一起停掉。
  const onAbort = () => abortController.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted === true) throw new Error('the Claude probe was aborted');
    const q = sdk.query({
      // biome-ignore lint/correctness/useYield: 探测的 prompt 永远不产出，不让 claude 向 Anthropic 发请求（T3 同）。
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbort(abortController.signal);
      })(),
      options: probeQueryOptions({ ...input, abortController }),
    });
    const init = await withTimeout(q.initializationResult(), PROBE_TIMEOUT_MS, 'Claude probe');
    let usage: ClaudeProbe['usage'];
    try {
      const response = await withTimeout(
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        USAGE_TIMEOUT_MS,
        'Claude usage',
      );
      usage = {
        rate_limits_available: response.rate_limits_available,
        rate_limits: response.rate_limits,
      };
    } catch {
      usage = undefined;
    }
    const account = init.account as ClaudeAccountInfo | undefined;
    return { account, ...(usage !== undefined && { usage }) };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    abortController.abort();
  }
}

export interface ClaudeAccountsOptions {
  sdk: ClaudeSdk;
  /** 探测会话的工作目录（Wevir 数据目录下的 engines/claude）。 */
  workDir: string;
  /** Wevir 下载的 `claude` 放在哪里，默认 `<workDir>/runtime`（0.63.0：添加的账号与首个账号共用一份）。 */
  runtimeDir?: string;
  /** 0.63.0：添加的账号的 `CLAUDE_CONFIG_DIR`；在终端里登录的命令要带上它。 */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换版本探测。 */
  probeVersion?: typeof probeClaudeVersion;
  /** 测试用：覆盖“能不能在应用内登录”（默认只有 macOS 与 Linux）。 */
  inAppLogin?: boolean;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `claude`）。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string | undefined;
  /** 替用户下载安装 `claude`；省略时按本平台建，`null` 表示不能装（测试）。 */
  installer?: NpmPackageInstaller | null;
  /** 测试用：替换启动 `claude auth login`。 */
  startLogin?: typeof startClaudeLogin;
  /** 测试用：替换跑 `claude` 的一次性命令（`auth logout`）。 */
  runCommand?: typeof runClaudeCommand;
  /** 测试用：换掉平台与文件系统，在别的平台上走 Windows 的分支（Git Bash 的查找与交给 `claude` 的环境）。 */
  system?: ClaudeEnvOptions;
  now?: () => number;
}

/** 检测到的 `claude`：会话也用它。 */
export interface ClaudeInstallation {
  executablePath: string;
  version: string | undefined;
}

/** 进行中的一次应用内登录。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  flow: ClaudeLoginFlow;
}

/** Claude Agent 的 `EngineAccounts`：只有一种 `claude`。 */
export class ClaudeAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = Object.freeze(['claude' as const]);
  readonly #options: ClaudeAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #installation: ClaudeInstallation | undefined;
  #checkedAt = 0;
  #probing: Promise<AccountState> | undefined;
  readonly #installer: NpmPackageInstaller | undefined;
  #installing: { completedBytes: number; totalBytes?: number } | undefined;
  #installError: string | undefined;
  #login: ActiveLogin | undefined;
  /** 进行中的检测（dispose 时中止，不留下 `claude` 进程）。 */
  readonly #abort = new AbortController();
  #disposed = false;

  constructor(options: ClaudeAccountsOptions) {
    this.#options = options;
    this.#installer =
      options.installer === undefined ? this.#defaultInstaller() : (options.installer ?? undefined);
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    const fresh =
      this.#state !== undefined &&
      this.#now() - this.#checkedAt < PROBE_TTL_MS &&
      this.#probing === undefined;
    if (fresh && options?.refresh !== true) return this.#view(this.#state as AccountState);
    if (options?.refresh === true) this.#installError = undefined;
    return this.#view(await this.#probe(options?.refresh === true));
  }

  /**
   * 登录。macOS 与 Linux 上启动 `claude auth login`，拿到浏览器要打开的授权地址就返回 `signing_in`（带 `login.authUrl`），用户在
   * 浏览器里同意后 claude 退出，再检测一次账号并通知；其余平台给命令（`signIn: command`）。
   */
  async login(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const state = await this.read(kind);
    if (!this.#inAppLogin()) {
      throw new AdapterError(
        'invalid_input',
        `Claude uses your own claude login: run \`${state.loginCommand ?? CLAUDE_LOGIN_COMMAND}\` in a terminal, then check again`,
      );
    }
    const executablePath = this.#installation?.executablePath;
    if (executablePath === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? 'claude is not installed: install it first, then sign in',
      );
    }
    const system = this.#options.system ?? {};
    const env = claudeEnv(this.#options.env ?? process.env, executablePath, system);
    this.#login?.flow.cancel();
    this.#login = undefined;
    let flow: ClaudeLoginFlow;
    try {
      flow = await (this.#options.startLogin ?? startClaudeLogin)({
        executablePath,
        env,
        directory: path.join(this.#options.workDir, 'login'),
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the Claude sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const login = {
      flow,
      info: {
        loginId: randomUUID(),
        method: 'browser' as const,
        authUrl: flow.authUrl,
        startedAt: new Date(this.#now()).toISOString(),
      },
    };
    this.#login = login;
    void flow.done.then((result) => this.#loginEnded(login, result));
    this.#emit();
    return this.#view(this.#state as AccountState);
  }

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    this.#check(kind);
    const login = this.#login;
    if (login !== undefined && (loginId === undefined || loginId === login.info.loginId)) {
      this.#login = undefined;
      login.flow.cancel();
      this.#emit();
    }
    return this.read(kind);
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    if (!this.#inAppLogin()) {
      throw new AdapterError(
        'invalid_input',
        'Claude uses your own claude login: run `claude auth logout` in a terminal',
      );
    }
    await this.read(kind);
    const executablePath = this.#installation?.executablePath;
    if (executablePath === undefined) {
      throw new AdapterError('engine_unavailable', 'claude is not installed');
    }
    const env = claudeEnv(this.#options.env ?? process.env, executablePath, this.#options.system);
    const result = await (this.#options.runCommand ?? runClaudeCommand)(
      executablePath,
      ['auth', 'logout'],
      env,
      LOGOUT_TIMEOUT_MS,
      this.#abort.signal,
    );
    if (!result.ok) throw new AdapterError('engine_unavailable', result.message);
    return this.read(kind, { refresh: true });
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    if (this.#state === undefined) await this.read(kind);
    return claudeModels(this.#installation?.version);
  }

  async setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    const trimmed = path?.trim();
    this.#customPath = trimmed === undefined || trimmed === '' ? null : trimmed;
    return this.#probe(true);
  }

  /**
   * 替用户下载安装 `claude`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因在
   * `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no claude build for ${process.platform}-${process.arch}: install it yourself with \`${CLAUDE_INSTALL_COMMAND}\` or set a custom executable path`,
      );
    }
    const state = await this.read(kind);
    if (installer.installing) return state;
    this.#installing = { completedBytes: 0 };
    this.#installError = undefined;
    this.#emit();
    installer
      .install((progress) => {
        if (this.#installing === undefined) return;
        this.#installing = {
          completedBytes: progress.completedBytes,
          ...(progress.totalBytes !== undefined && { totalBytes: progress.totalBytes }),
        };
        this.#emit();
      })
      .then(
        async () => {
          this.#installing = undefined;
          await this.#probe(true).catch((error: unknown) => {
            this.#installError = error instanceof Error ? error.message : String(error);
            this.#emit();
          });
        },
        (error: unknown) => {
          this.#installing = undefined;
          if (!(error instanceof NpmInstallCancelled)) {
            this.#installError =
              error instanceof Error ? error.message : 'Could not install claude.';
          }
          this.#emit();
        },
      )
      .catch(() => {});
    return this.#view(this.#state as AccountState);
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 会话要用的 `claude`：最近一次检测的结果；还没检测过或已过期时先检测。没装时报 `engine_unavailable`，没登录时报
   * `missing_credentials`（同 ChatGPT 会话，补记 10）。
   */
  async installation(): Promise<ClaudeInstallation> {
    const state = await this.read('claude');
    if (this.#installation === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? `claude was not found; install it with \`${CLAUDE_INSTALL_COMMAND}\``,
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError(
        'missing_credentials',
        `Claude is not signed in: run \`${state.loginCommand ?? CLAUDE_LOGIN_COMMAND}\` in a terminal, then check again`,
      );
    }
    return this.#installation;
  }

  /** 回合里的 `rate_limit_event`：更新用量并通知。 */
  applyRateLimit(info: SDKRateLimitInfo): void {
    const state = this.#state;
    if (state === undefined || state.status !== 'signed_in') return;
    const rateLimits = applyRateLimitEvent(state.rateLimits, info);
    if (rateLimits === undefined) return;
    this.#publish({ ...state, rateLimits });
  }

  /** 回合报认证失败（`authentication_failed`）：标成没登录，下次读时重新检测。 */
  markSignedOut(message: string): void {
    const state = this.#state;
    if (state === undefined || state.status !== 'signed_in') return;
    const { email: _email, plan: _plan, planLabel: _label, rateLimits: _limits, ...rest } = state;
    this.#checkedAt = 0;
    this.#publish({ ...rest, status: 'signed_out', lastError: message });
  }

  dispose(): void {
    this.#disposed = true;
    this.#installer?.cancel();
    this.#login?.flow.cancel();
    this.#login = undefined;
    this.#abort.abort();
    this.#listeners.clear();
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the Claude engine has been disposed');
    if (kind !== 'claude')
      throw new AdapterError('invalid_input', `not a Claude account kind: ${kind}`);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** 状态里加上不属于检测结果的部分：正在安装的进度、安装失败的原因、进行中的登录。 */
  #view(state: AccountState): AccountState {
    let view = state;
    if (this.#installing !== undefined) {
      view = { ...view, installing: this.#installing };
    } else if (this.#installError !== undefined && view.installed === false) {
      view = { ...view, lastError: this.#installError };
    }
    if (this.#login !== undefined && view.status !== 'signed_in') {
      const { lastError: _stale, ...rest } = view;
      view = { ...rest, status: 'signing_in', login: this.#login.info };
    }
    return view;
  }

  #inAppLogin(): boolean {
    return (
      this.#options.inAppLogin ??
      inAppLoginSupported(this.#options.system?.platform ?? process.platform)
    );
  }

  #defaultInstaller(): NpmPackageInstaller | undefined {
    const system = this.#options.system ?? {};
    const spec = claudeNpmPackage(system.platform ?? process.platform);
    if (spec === undefined) return undefined;
    return new NpmPackageInstaller({
      directory: this.#options.runtimeDir ?? path.join(this.#options.workDir, 'runtime'),
      spec,
      // 下载来的程序要能跑：`claude --version` 有答复。
      validate: async (file, _version, signal) => {
        const probe = await (this.#options.probeVersion ?? probeClaudeVersion)(
          file,
          claudeEnv(this.#options.env ?? process.env, file, system),
          VERSION_TIMEOUT_MS,
          signal,
        );
        if (!probe.ok) throw new Error(probe.message);
      },
    });
  }

  /** `claude auth login` 退出了：成功就重新检测账号，失败带上它的输出；被取消或被新的登录替换的不管。 */
  async #loginEnded(login: ActiveLogin, result: Awaited<ClaudeLoginFlow['done']>): Promise<void> {
    if (this.#login !== login) return;
    this.#login = undefined;
    if (this.#disposed) return;
    if (result.ok) {
      await this.#probe(true).catch(() => this.#emit());
      return;
    }
    if (!result.cancelled && this.#state !== undefined) {
      this.#state = { ...this.#state, lastError: result.message };
    }
    this.#emit();
  }

  #probe(force: boolean): Promise<AccountState> {
    if (this.#probing !== undefined && !force) return this.#probing;
    const run = this.#detect().then(
      (state) => {
        if (this.#probing === run) this.#probing = undefined;
        this.#checkedAt = this.#now();
        this.#publish(state);
        return state;
      },
      (error: unknown) => {
        if (this.#probing === run) this.#probing = undefined;
        throw error;
      },
    );
    this.#probing = run;
    return run;
  }

  async #detect(): Promise<AccountState> {
    const parentEnv = this.#options.env ?? process.env;
    const managed = await this.#installer?.active();
    const find =
      this.#options.findExecutable ??
      ((customPath, managedPath) => findClaude({ customPath, env: parentEnv, managedPath }));
    const executablePath = find(this.#customPath, managed?.path);
    const isManaged = managed !== undefined && executablePath === managed.path;
    const canInstall = this.#installer !== undefined;
    const inApp = this.#inAppLogin();
    const base: AccountState = {
      kind: 'claude',
      status: 'signed_out',
      ...(inApp
        ? { signIn: 'in_app' as const, loginMethods: ['browser' as const] }
        : {
            signIn: 'command' as const,
            loginCommand: withConfigDir(
              claudeLoginCommand(executablePath, isManaged),
              this.#options.configDir,
              this.#options.system?.platform ?? process.platform,
            ),
          }),
      ...(this.#customPath !== null && { customPath: this.#customPath }),
    };
    if (executablePath === undefined) {
      this.#installation = undefined;
      return {
        ...base,
        installed: false,
        installCommand: CLAUDE_INSTALL_COMMAND,
        ...(canInstall && { canInstall }),
        ...(this.#customPath !== null && { lastError: `${this.#customPath} does not exist` }),
      };
    }
    const system = this.#options.system ?? {};
    const env = claudeEnv(parentEnv, executablePath, system);
    // Windows 上 `claude` 要 Git Bash：找不到、`claude` 又因此报错时，说成要装 Git for Windows，不把原始报错给用户。
    const platform = system.platform ?? process.platform;
    const gitBash =
      platform === 'win32'
        ? findGitBash({
            env: parentEnv,
            platform,
            ...(system.home !== undefined && { home: system.home }),
            ...(system.exists !== undefined && { exists: system.exists }),
          })
        : undefined;
    const needsGit = (message: string) =>
      platform === 'win32' && gitBash === undefined && isGitBashError(message);
    const gitMissing = (): AccountState => {
      this.#installation = undefined;
      return {
        ...base,
        installed: false,
        executablePath,
        installUrl: GIT_FOR_WINDOWS_URL,
        lastError: GIT_BASH_MISSING_MESSAGE,
      };
    };
    const version = await (this.#options.probeVersion ?? probeClaudeVersion)(
      executablePath,
      env,
      undefined,
      this.#abort.signal,
    );
    if (!version.ok) {
      if (version.reason === 'failed' && needsGit(version.message)) return gitMissing();
      this.#installation = undefined;
      return {
        ...base,
        // Wevir 装的这份跑不起来：当作没装，设置里重新下载。
        installed: version.reason !== 'missing' && !isManaged,
        executablePath,
        installCommand: CLAUDE_INSTALL_COMMAND,
        ...(isManaged && canInstall && { canInstall }),
        lastError: version.message,
      };
    }
    this.#installation = { executablePath, version: version.version };
    const installed: AccountState = {
      ...base,
      installed: true,
      executablePath,
      ...(version.version !== undefined && { version: version.version }),
    };
    let probe: ClaudeProbe;
    try {
      mkdirSync(this.#options.workDir, { recursive: true });
      probe = await probeClaudeAccount(
        this.#options.sdk,
        { executablePath, env, cwd: this.#options.workDir },
        this.#abort.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (needsGit(message)) return gitMissing();
      return {
        ...installed,
        lastError: `Could not verify Claude authentication: ${message}`,
      };
    }
    if (!claudeSignedIn(probe.account)) return installed;
    const plan = claudePlan(probe.account);
    const rateLimits = probe.usage === undefined ? undefined : usageRateLimits(probe.usage);
    return {
      ...installed,
      status: 'signed_in',
      ...(probe.account?.email !== undefined && { email: probe.account.email }),
      ...(plan !== undefined && plan),
      ...(rateLimits !== undefined && { rateLimits }),
    };
  }

  #publish(state: AccountState): void {
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    if (this.#state === undefined) return;
    const state = this.#view(this.#state);
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // 监听器里抛错不影响别的监听器（EngineAccounts.onChange 的约定）。
      }
    }
  }
}

/**
 * 添加的账号（0.63.0）在终端里登录的命令：先把 `CLAUDE_CONFIG_DIR` 设成它的配置目录。Windows 写 PowerShell 的写法（默认的终端），
 * 其余是 POSIX shell。
 */
export function withConfigDir(
  command: string,
  configDir: string | undefined,
  platform: NodeJS.Platform,
): string {
  if (configDir === undefined) return command;
  if (platform === 'win32')
    return `$env:CLAUDE_CONFIG_DIR='${configDir.replaceAll("'", "''")}'; ${command}`;
  return `CLAUDE_CONFIG_DIR='${configDir.replaceAll("'", "'\\''")}' ${command}`;
}
