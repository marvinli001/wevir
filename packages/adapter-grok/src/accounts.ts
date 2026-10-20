// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/status.ts（`checkGrokProviderStatus`、`discoverGrokMetadataViaAcpInitialize`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `AccountState`（`EngineAccounts`）；ACP 的探测经 `@wevir/adapter-acp`
// 的 `AcpProcess`；邮箱与用量照 T3 读 ~/.grok 的 auth.json（只读，见 usage.ts），没有套餐；不做 skills 与斜杠命令；结果缓存
// 5 分钟，`read` 带 `refresh` 时重新检测。
//
// Grok 的账号（grok-event-mapping.md §2）：Wevir 自己不碰令牌。`grok` 找用户自己装的，没有就由 Wevir 从 npm 下载一份
// （install.ts 的 `NpmPackageInstaller`，`account.install`）；登录由设置里的按钮替用户启动 `grok login --device-auth`
// （login.ts），登出跑 `grok logout`；用户环境里的 `XAI_API_KEY` 也算已登录。检测照 T3：找 `grok` 并跑 `--version`；跑
// `grok models`（不起 agent，输出里说有没有登录，并列出模型）；再起一次
// `grok agent stdio` 只做 ACP `initialize` 读 `_meta.modelState`（带上下文窗口与推理档位）。探测不调 `authenticate`、不建
// 会话，所以不会打开浏览器登录，也不会启动工作区的 MCP 服务器。同时读 `grok login` 的账号的邮箱与本周期的额度（usage.ts），
// 读不到额度时留着上一次的。

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AcpProcess } from '@wevir/adapter-acp';
import {
  type AccountKind,
  type AccountModels,
  type AccountState,
  AdapterError,
  accountRateLimits,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { NpmInstallCancelled, NpmPackageInstaller } from '@wevir/runtime-adapter/npm-package';
import { GROK_ENGINE } from './engine.js';
import { grokNpmPackage, pinnedGrokFetch } from './install.js';
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
import { type GrokLoginFlow, type GrokLoginResult, startGrokLogin } from './login.js';
import {
  GROK_DEFAULT_MODELS,
  type GrokModelsCliOutput,
  modelsFromInitialize,
  parseGrokModelsOutput,
} from './models.js';
import { readGrokUsage } from './usage.js';

/** 检测结果的有效期（同 Claude Agent 的 `PROBE_TTL_MS`）。 */
export const PROBE_TTL_MS = 5 * 60_000;
/** `grok --version` 的时限（T3 是 4 s；冷启动的 Node 启动脚本要更久，与 Claude Agent 一样给 10 s）。 */
export const VERSION_TIMEOUT_MS = 10_000;
/** `grok models` 的时限（T3 的 `AUTH_PROBE_TIMEOUT_MS`）。 */
export const MODELS_TIMEOUT_MS = 10_000;
/** 只做 `initialize` 的探测的时限（T3 的 `GROK_ACP_INITIALIZE_TIMEOUT_MS`）。 */
export const INITIALIZE_PROBE_TIMEOUT_MS = 8_000;
/** `grok logout` 的时限。 */
export const LOGOUT_TIMEOUT_MS = 20_000;
/** 交给 Wevir 装的 `grok` 的环境变量：更新只经设置里的下载，不让它自己下载新版换掉（文档：Process 级开关）。 */
export const GROK_DISABLE_AUTOUPDATER_ENV = 'GROK_DISABLE_AUTOUPDATER';

export interface GrokAccountsOptions {
  /** 探测进程的工作目录（数据目录下的 engines/grok）。 */
  workDir: string;
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `grok`）。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string;
  /** 替用户下载安装 `grok`；省略时按本平台建，`null` 表示不能装（测试）。 */
  installer?: NpmPackageInstaller | null;
  /** 测试用：替换启动 `grok login --device-auth`。 */
  startLogin?: typeof startGrokLogin;
  /** 测试用：替换跑 `grok` 的一次性命令（`logout`）。 */
  runCommand?: typeof runGrok;
  /** 测试用：替换 `initialize` 探测（返回 `initialize` 的结果）。 */
  probeInitialize?: (
    executable: GrokExecutable,
    signal: AbortSignal,
    workDir: string,
  ) => Promise<unknown>;
  /** 读用量的 fetch（测试换成假的）；省略时用全局的。 */
  fetch?: typeof fetch;
  /** 读 ~/.grok 下的文件（测试换成假的）。 */
  readFile?: (file: string) => Promise<string>;
  now?: () => number;
}

/** 进行中的一次应用内登录。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  flow: GrokLoginFlow;
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
  readonly #installer: NpmPackageInstaller | undefined;
  #installing: { completedBytes: number; totalBytes?: number } | undefined;
  #installError: string | undefined;
  #login: ActiveLogin | undefined;
  /** 进行中的检测（dispose 时中止，不留下 `grok` 进程）。 */
  readonly #abort = new AbortController();
  #disposed = false;

  constructor(options: GrokAccountsOptions) {
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
   * 登录：启动 `grok login --device-auth`，拿到登录地址与码就返回 `signing_in`（带 `login`）。grok 自己会打开浏览器；它说打不
   * 开时才在 `login.authUrl` 里给地址，由桌面端替它打开。用户在浏览器里确认后 grok 退出，再检测一次账号并通知。
   */
  async login(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const state = await this.read(kind);
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? 'grok is not installed: install it first, then sign in',
      );
    }
    this.#login?.flow.cancel();
    this.#login = undefined;
    let flow: GrokLoginFlow;
    try {
      flow = await (this.#options.startLogin ?? startGrokLogin)({
        executablePath: executable.path,
        env: executable.env,
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the Grok sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const login: ActiveLogin = {
      flow,
      info: {
        loginId: randomUUID(),
        method: 'device_code',
        verificationUrl: flow.verificationUrl,
        ...(flow.userCode !== undefined && { userCode: flow.userCode }),
        ...(!flow.browserOpened && { authUrl: flow.verificationUrl }),
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

  /** 登出：跑 `grok logout`（清掉 `grok login` 存的登录）再检测；环境里的 `XAI_API_KEY` 不归它管。 */
  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    await this.read(kind);
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError('engine_unavailable', 'grok is not installed');
    }
    const result = await (this.#options.runCommand ?? runGrok)(
      executable.path,
      ['logout'],
      executable.env,
      LOGOUT_TIMEOUT_MS,
      this.#abort.signal,
    );
    if (!result.ok) throw new AdapterError('engine_unavailable', result.message);
    if (result.code !== 0) {
      throw new AdapterError(
        'engine_unavailable',
        `\`grok logout\` failed: ${`${result.stdout}\n${result.stderr}`.trim().slice(-500) || `exit code ${result.code}`}`,
      );
    }
    return this.read(kind, { refresh: true });
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

  /**
   * 替用户下载安装 `grok`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因在
   * `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no grok build for ${process.platform}-${process.arch}: install it yourself with \`${GROK_INSTALL_COMMAND}\` or set a custom executable path`,
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
            this.#installError = error instanceof Error ? error.message : 'Could not install grok.';
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
        `Grok is not signed in: sign in from Settings, or run \`${GROK_LOGIN_COMMAND}\` in a terminal and check again`,
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
    const { planLabel: _label, email: _email, rateLimits: _limits, ...rest } = state;
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
    if (this.#disposed) throw new AdapterError('disposed', 'the Grok engine has been disposed');
    if (kind !== 'grok')
      throw new AdapterError('invalid_input', `not a Grok account kind: ${kind}`);
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

  #defaultInstaller(): NpmPackageInstaller | undefined {
    const spec = grokNpmPackage();
    if (spec === undefined) return undefined;
    return new NpmPackageInstaller({
      directory: path.join(this.#options.workDir, 'runtime'),
      spec,
      fetch: pinnedGrokFetch(spec.packageName),
      // 下载来的程序要能跑：`grok --version` 正常退出。
      validate: async (file, _version, signal) => {
        const run = await runGrok(
          file,
          ['--version'],
          this.#managedEnv(file),
          VERSION_TIMEOUT_MS,
          signal,
        );
        if (!run.ok) throw new Error(run.message);
        if (run.code !== 0) throw new Error(`\`grok --version\` exited with code ${run.code}`);
      },
    });
  }

  /** Wevir 装的 `grok` 的环境：继承 Host 的，加上关掉它自己的自动更新。 */
  #managedEnv(executablePath: string): NodeJS.ProcessEnv {
    return {
      ...grokEnv(this.#options.env ?? process.env, executablePath),
      [GROK_DISABLE_AUTOUPDATER_ENV]: '1',
    };
  }

  /** `grok login` 退出了：成功就重新检测账号，失败带上它的输出；被取消或被新的登录替换的不管。 */
  async #loginEnded(login: ActiveLogin, result: GrokLoginResult): Promise<void> {
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
    const canInstall = this.#installer !== undefined;
    const base: AccountState = {
      kind: 'grok',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
      ...(this.#customPath !== null && { customPath: this.#customPath }),
    };
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(this.#customPath, managed?.path) ??
        findGrok({ customPath: this.#customPath, env: parentEnv, managedPath: managed?.path }).path;
    } catch (error) {
      this.#executable = undefined;
      return {
        ...base,
        installed: false,
        installCommand: GROK_INSTALL_COMMAND,
        ...(canInstall && { canInstall }),
        ...(this.#customPath !== null && {
          lastError: `${this.#customPath} does not exist or is not executable`,
        }),
        // `WEVIR_GROK_BIN` 指错了（开发时）：原文说明是哪个路径。
        ...(this.#customPath === null &&
          error instanceof Error &&
          parentEnv[GROK_BIN_ENV] !== undefined && { lastError: error.message }),
      };
    }
    const isManaged = managed !== undefined && executablePath === managed.path;
    const env = isManaged ? this.#managedEnv(executablePath) : grokEnv(parentEnv, executablePath);
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
        // Wevir 装的这份跑不起来：当作没装，设置里重新下载。
        installed: !(!versionRun.ok && versionRun.reason === 'missing') && !isManaged,
        executablePath,
        installCommand: GROK_INSTALL_COMMAND,
        ...(isManaged && canInstall && { canInstall }),
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

    // 邮箱与用量和下面的探测同时读（不抛错）。
    const usage = readGrokUsage({
      env: parentEnv,
      ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
      ...(this.#options.readFile !== undefined && { readFile: this.#options.readFile }),
    });

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
    const account = await usage;
    // 读失败时留着上一次的，只要还是同一个账号。
    const previous = this.#state?.status === 'signed_in' ? this.#state : undefined;
    const rateLimits =
      account === undefined
        ? undefined
        : account.usage.ok
          ? account.usage.rateLimits && accountRateLimits(account.usage.rateLimits)
          : previous?.email === account.email
            ? previous?.rateLimits
            : undefined;
    return {
      ...installed,
      status: 'signed_in',
      ...(account?.email !== undefined && { email: account.email }),
      ...(rateLimits !== undefined && { rateLimits }),
      // 看不出来有没有登录（输出的措辞变了、`grok models` 失败）：照样当作已登录，回合里 Grok 要认证时再标回去。
      ...(cli.authenticated === null && {
        lastError: modelsRun.ok
          ? 'Could not confirm the Grok login from `grok models`'
          : `Could not confirm the Grok login: ${modelsRun.message}`,
      }),
    };
  }

  /**
   * 只重读用量（Host 定时刷新）：读 `grok login` 的 auth.json 与本周期的额度，不起 CLI；还是同一个账号、读到了而且变了才发布。
   * 用 xAI API Key 时没有额度。
   */
  async refreshUsage(kind: AccountKind): Promise<void> {
    this.#check(kind);
    const state = this.#state;
    if (state?.status !== 'signed_in' || state.plan === 'apiKey' || this.#probing !== undefined) {
      return;
    }
    const account = await readGrokUsage({
      env: this.#options.env ?? process.env,
      ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
      ...(this.#options.readFile !== undefined && { readFile: this.#options.readFile }),
    });
    if (this.#state !== state || account === undefined || !account.usage.ok) return;
    if (account.email !== state.email) return;
    const rateLimits = account.usage.rateLimits && accountRateLimits(account.usage.rateLimits);
    if (rateLimits === undefined) return;
    if (JSON.stringify(rateLimits) === JSON.stringify(state.rateLimits)) return;
    this.#publish({ ...state, rateLimits });
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
