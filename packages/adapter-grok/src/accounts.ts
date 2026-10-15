// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/status.ts（`checkGrokProviderStatus`、`discoverGrokMetadataViaAcpInitialize`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `AccountState`（`EngineAccounts`）；ACP 的探测经 `@wevir/adapter-acp`
// 的 `AcpProcess`；不读 Grok 存的凭据（T3 读 ~/.grok 的 auth.json 取邮箱与用量，Wevir 不读，所以没有邮箱、套餐与用量）；
// 不做 skills 与斜杠命令；结果缓存 5 分钟，`read` 带 `refresh` 时重新检测。
//
// Grok 的账号（grok-event-mapping.md §2）：Wevir 自己不登录，只检测用户在终端里 `grok login` 的结果，或用户环境里的
// `XAI_API_KEY`。照 T3：找 `grok` 并跑 `--version`；跑 `grok models`（不起 agent，输出里说有没有登录，并列出模型）；再起一次
// `grok agent stdio` 只做 ACP `initialize` 读 `_meta.modelState`（带上下文窗口与推理档位）。探测不调 `authenticate`、不建
// 会话，所以不会打开浏览器登录，也不会启动工作区的 MCP 服务器。

import { mkdirSync } from 'node:fs';
import { AcpProcess } from '@wevir/adapter-acp';
import {
  type AccountKind,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { GROK_ENGINE } from './engine.js';
import {
  findGrok,
  GROK_BIN_ENV,
  GROK_INSTALL_COMMAND,
  GROK_LOGIN_COMMAND,
  type GrokExecutable,
  GrokLauncher,
  grokEnv,
  parseGrokVersion,
  runGrok,
  XAI_API_KEY_ENV,
} from './launch.js';
import {
  GROK_DEFAULT_MODELS,
  type GrokModelsCliOutput,
  modelsFromInitialize,
  parseGrokModelsOutput,
} from './models.js';

/** 检测结果的有效期（同 Claude Agent 的 `PROBE_TTL_MS`）。 */
export const PROBE_TTL_MS = 5 * 60_000;
/** `grok --version` 的时限（T3 是 4 s；冷启动的 Node 启动脚本要更久，与 Claude Agent 一样给 10 s）。 */
export const VERSION_TIMEOUT_MS = 10_000;
/** `grok models` 的时限（T3 的 `AUTH_PROBE_TIMEOUT_MS`）。 */
export const MODELS_TIMEOUT_MS = 10_000;
/** 只做 `initialize` 的探测的时限（T3 的 `GROK_ACP_INITIALIZE_TIMEOUT_MS`）。 */
export const INITIALIZE_PROBE_TIMEOUT_MS = 8_000;

export interface GrokAccountsOptions {
  /** 探测进程的工作目录（数据目录下的 engines/grok）。 */
  workDir: string;
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换可执行文件的查找。 */
  findExecutable?: (customPath: string | null) => string;
  /** 测试用：替换 `initialize` 探测（返回 `initialize` 的结果）。 */
  probeInitialize?: (
    executable: GrokExecutable,
    signal: AbortSignal,
    workDir: string,
  ) => Promise<unknown>;
  now?: () => number;
}

/** Grok Build 的 `EngineAccounts`：只有一种 `grok`。 */
export class GrokAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = Object.freeze(['grok' as const]);
  readonly #options: GrokAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #executable: GrokExecutable | undefined;
  #models: AccountModels = GROK_DEFAULT_MODELS;
  #checkedAt = 0;
  #probing: Promise<AccountState> | undefined;
  /** 进行中的检测（dispose 时中止，不留下 `grok` 进程）。 */
  readonly #abort = new AbortController();
  #disposed = false;

  constructor(options: GrokAccountsOptions) {
    this.#options = options;
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    const fresh =
      this.#state !== undefined &&
      this.#now() - this.#checkedAt < PROBE_TTL_MS &&
      this.#probing === undefined;
    if (fresh && options?.refresh !== true) return this.#state as AccountState;
    return this.#probe(options?.refresh === true);
  }

  async login(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    throw new AdapterError(
      'invalid_input',
      `Grok Build uses your own grok login: run \`${GROK_LOGIN_COMMAND}\` in a terminal, then check again`,
    );
  }

  async cancelLogin(kind: AccountKind): Promise<AccountState> {
    return this.read(kind);
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    throw new AdapterError(
      'invalid_input',
      'Grok Build uses your own grok login: sign out with the grok CLI in a terminal',
    );
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    if (this.#state === undefined) await this.read(kind);
    return this.#models;
  }

  async setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    const trimmed = path?.trim();
    this.#customPath = trimmed === undefined || trimmed === '' ? null : trimmed;
    return this.#probe(true);
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 会话要用的 `grok` 与它的环境：最近一次检测的结果；还没检测过或已过期时先检测。没装时报 `engine_unavailable`，检测到没
   * 登录时报 `missing_credentials`（同 Claude Agent）。登录状态看不出来时照常启动，由 Grok 自己决定。
   */
  async executable(): Promise<GrokExecutable> {
    const state = await this.read('grok');
    if (this.#executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? `grok was not found; install it with \`${GROK_INSTALL_COMMAND}\``,
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError(
        'missing_credentials',
        `Grok is not signed in: run \`${GROK_LOGIN_COMMAND}\` in a terminal, then check again`,
      );
    }
    return this.#executable;
  }

  /** 最近一次检测到的版本。 */
  get version(): string | undefined {
    return this.#state?.version;
  }

  /** 回合报要认证（令牌过期等）：标成没登录，下次读时重新检测。 */
  markSignedOut(message: string): void {
    const state = this.#state;
    if (state === undefined || state.status !== 'signed_in') return;
    const { planLabel: _label, ...rest } = state;
    this.#checkedAt = 0;
    this.#publish({ ...rest, status: 'signed_out', lastError: message });
  }

  dispose(): void {
    this.#disposed = true;
    this.#abort.abort();
    this.#listeners.clear();
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the Grok engine has been disposed');
    if (kind !== 'grok')
      throw new AdapterError('invalid_input', `not a Grok account kind: ${kind}`);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
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
    const base: AccountState = {
      kind: 'grok',
      status: 'signed_out',
      signIn: 'command',
      loginCommand: GROK_LOGIN_COMMAND,
      ...(this.#customPath !== null && { customPath: this.#customPath }),
    };
    const parentEnv = this.#options.env ?? process.env;
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(this.#customPath) ??
        findGrok({ customPath: this.#customPath, env: parentEnv }).path;
    } catch (error) {
      this.#executable = undefined;
      return {
        ...base,
        installed: false,
        installCommand: GROK_INSTALL_COMMAND,
        ...(this.#customPath !== null && {
          lastError: `${this.#customPath} does not exist or is not executable`,
        }),
        // `WEVIR_GROK_BIN` 指错了（开发时）：原文说明是哪个路径。
        ...(this.#customPath === null &&
          error instanceof Error &&
          parentEnv[GROK_BIN_ENV] !== undefined && { lastError: error.message }),
      };
    }
    const env = grokEnv(parentEnv, executablePath);
    const signal = this.#abort.signal;
    const versionRun = await runGrok(
      executablePath,
      ['--version'],
      env,
      VERSION_TIMEOUT_MS,
      signal,
    );
    if (!versionRun.ok || versionRun.code !== 0) {
      this.#executable = undefined;
      return {
        ...base,
        installed: !(!versionRun.ok && versionRun.reason === 'missing'),
        executablePath,
        installCommand: GROK_INSTALL_COMMAND,
        lastError: versionRun.ok
          ? `\`grok --version\` exited with code ${versionRun.code}`
          : versionRun.message,
      };
    }
    const version = parseGrokVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
    const executable: GrokExecutable = { path: executablePath, env };
    this.#executable = executable;
    const installed: AccountState = {
      ...base,
      installed: true,
      executablePath,
      ...(version !== undefined && { version }),
    };

    // `grok models`：只解析干净退出的输出（失败时打印的是帮助或错误，不能当模型或登录结论，T3）。
    const modelsRun = await runGrok(executablePath, ['models'], env, MODELS_TIMEOUT_MS, signal);
    const cli: GrokModelsCliOutput =
      modelsRun.ok && modelsRun.code === 0
        ? parseGrokModelsOutput(`${modelsRun.stdout}\n${modelsRun.stderr}`)
        : { authenticated: null, models: { models: [] } };

    // `initialize` 的 `_meta.modelState`：带上下文窗口与推理档位，有就用它（T3）。失败只让模型信息少一些。
    let initialize: unknown;
    try {
      initialize = await (this.#options.probeInitialize ?? probeInitialize)(
        executable,
        signal,
        this.#options.workDir,
      );
    } catch {
      initialize = undefined;
    }
    const acpModels = modelsFromInitialize(initialize);
    this.#models = acpModels ?? (cli.models.models.length > 0 ? cli.models : GROK_DEFAULT_MODELS);

    const apiKey = parentEnv[XAI_API_KEY_ENV]?.trim();
    if (apiKey !== undefined && apiKey !== '') {
      return { ...installed, status: 'signed_in', plan: 'apiKey', planLabel: 'xAI API Key' };
    }
    if (cli.authenticated === false) return installed;
    return {
      ...installed,
      status: 'signed_in',
      // 看不出来有没有登录（输出的措辞变了、`grok models` 失败）：照样当作已登录，回合里 Grok 要认证时再标回去。
      ...(cli.authenticated === null && {
        lastError: modelsRun.ok
          ? 'Could not confirm the Grok login from `grok models`'
          : `Could not confirm the Grok login: ${modelsRun.message}`,
      }),
    };
  }

  #publish(state: AccountState): void {
    this.#state = state;
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
 * 起一次 `grok agent stdio`（请求批准模式，只读 `initialize`），读完就回收（T3 的 `discoverGrokMetadataViaAcpInitialize`）。
 * 不 `authenticate`、不建会话。
 */
export async function probeInitialize(
  executable: GrokExecutable,
  signal: AbortSignal,
  workDir: string,
): Promise<unknown> {
  const dir = workDir;
  mkdirSync(dir, { recursive: true });
  const probe = new AcpProcess({
    engine: GROK_ENGINE,
    launcher: new GrokLauncher('on_request', dir, async () => executable),
    clientInfo: { name: 'wevir-grok-probe', version: '0.0.0' },
    initializeTimeoutMs: INITIALIZE_PROBE_TIMEOUT_MS,
    restart: { maxRestarts: 0 },
  });
  const onAbort = () => void probe.dispose();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await probe.start();
  } finally {
    signal.removeEventListener('abort', onAbort);
    await probe.dispose();
  }
}
