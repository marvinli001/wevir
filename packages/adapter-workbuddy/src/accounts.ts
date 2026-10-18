import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AcpProcess } from '@wevir/adapter-acp';
import {
  type AccountKind,
  type AccountLoginMethod,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { isWorkBuddyAuthRequired, WORKBUDDY_ENGINE } from './engine.js';
import {
  type ManagedWorkBuddy,
  WorkBuddyInstallCancelled,
  WorkBuddyInstaller,
  workbuddyArchive,
} from './install.js';
import {
  findWorkBuddy,
  managedWorkBuddyEnv,
  parseWorkBuddyVersion,
  runWorkBuddy,
  WORKBUDDY_BIN_ENV,
  WORKBUDDY_INSTALL_COMMAND,
  type WorkBuddyExecutable,
  WorkBuddyLauncher,
  workbuddyEnv,
  workbuddyLoginCommand,
} from './launch.js';
import {
  startWorkBuddyLogin,
  type WorkBuddyLoginFlow,
  type WorkBuddyLoginOption,
  workbuddyAuthMethod,
  workbuddyLoginOptions,
} from './login.js';
import { WORKBUDDY_DEFAULT_MODELS, workBuddyModels } from './models.js';

export const PROBE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 15_000;
/** 终端里登录（iOA、企业域名等应用内登录不支持的环境）。 */
export const WORKBUDDY_SIGN_IN_HINT =
  'Run codebuddy in a terminal and sign in; use the same China/international environment, then check again';
/** 设置里的“登录”按钮可用时。 */
export const WORKBUDDY_SIGN_IN_APP_HINT = 'Sign in to WorkBuddy in Settings > Model services';

export interface WorkBuddyAccountsOptions {
  workDir: string;
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `codebuddy`）。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string;
  probeSession?: (
    executable: WorkBuddyExecutable,
    signal: AbortSignal,
    workDir: string,
  ) => Promise<unknown>;
  /** 替用户下载安装 `codebuddy`；省略时按本平台建，`null` 表示不能装（测试）。 */
  installer?: WorkBuddyInstaller | null;
  /** 测试用：替换启动应用内登录。 */
  startLogin?: typeof startWorkBuddyLogin;
  now?: () => number;
}

interface Detection {
  state: AccountState;
  executable?: WorkBuddyExecutable;
  models?: AccountModels;
}

/** 进行中的一次应用内登录。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  flow: WorkBuddyLoginFlow;
}

/**
 * 找官方 CLI（用户自己装的优先，没有就用 Wevir 下载的）并检测登录；检测不认证、不读取凭据、不请求 HTTP 接口。登录由
 * 设置里的按钮起一次性的 `codebuddy --acp` 完成（login.ts），iOA、企业域名等环境仍给命令。
 */
export class WorkBuddyAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['workbuddy'];
  readonly #options: WorkBuddyAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  readonly #installer: WorkBuddyInstaller | undefined;
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #models: AccountModels = WORKBUDDY_DEFAULT_MODELS;
  #executable: WorkBuddyExecutable | undefined;
  #checkedAt = 0;
  #probing: Promise<AccountState> | undefined;
  readonly #probes = new Set<Promise<AccountState>>();
  #abort: AbortController | undefined;
  #revision = 0;
  #installing: { completedBytes: number; totalBytes?: number } | undefined;
  #installError: string | undefined;
  #login: ActiveLogin | undefined;
  #loginError: string | undefined;
  #disposed = false;

  constructor(options: WorkBuddyAccountsOptions) {
    this.#options = options;
    this.#installer =
      options.installer === undefined ? this.#defaultInstaller() : (options.installer ?? undefined);
  }

  read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    if (options?.refresh === true) {
      this.#installError = undefined;
      this.#loginError = undefined;
    }
    if (options?.refresh !== true && this.#probing !== undefined) {
      return this.#probing.then((state) => this.#view(state));
    }
    if (
      options?.refresh !== true &&
      this.#state !== undefined &&
      this.#now() - this.#checkedAt < PROBE_TTL_MS
    ) {
      return Promise.resolve(this.#view(this.#state));
    }
    return this.#probe(options?.refresh === true).then((state) => this.#view(state));
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    if (this.#state === undefined) await this.read(kind);
    return this.#models;
  }

  /**
   * 登录：起一次性的 `codebuddy --acp`，`authenticate` 后拿到浏览器要打开的授权地址就返回 `signing_in`（带 `login.authUrl`），
   * 用户在浏览器里同意后再检测一次账号并通知。`options.option` 是 `AccountState.loginOptions` 里的一项（国内微信还是国际
   * Google / GitHub），省略取缺省（login.ts）；iOA、企业域名等给命令（`signIn: command`）。已登录时不调（`authenticate` 会先把人
   * 登出）。
   */
  async login(
    kind: AccountKind,
    method: AccountLoginMethod,
    options?: { option?: string },
  ): Promise<AccountState> {
    this.#check(kind);
    if (method !== 'browser') {
      throw new AdapterError('invalid_input', 'CodeBuddy signs in through the browser only');
    }
    if (workbuddyLoginOptions(this.#parentEnv()) === undefined) {
      throw new AdapterError('invalid_input', WORKBUDDY_SIGN_IN_HINT);
    }
    const authMethod = workbuddyAuthMethod(this.#parentEnv(), options?.option);
    if (authMethod === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Unknown CodeBuddy sign-in option: ${options?.option ?? ''}`,
      );
    }
    const state = await this.read(kind);
    if (state.status === 'signed_in') {
      throw new AdapterError('invalid_input', 'CodeBuddy is already signed in');
    }
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? 'CodeBuddy is not installed: download it first, then sign in',
      );
    }
    // 已有进行中的登录时替换它（EngineAccounts.login 的约定）。
    this.#login?.flow.cancel();
    this.#login = undefined;
    this.#loginError = undefined;
    let flow: WorkBuddyLoginFlow;
    try {
      flow = await (this.#options.startLogin ?? startWorkBuddyLogin)({
        executable,
        method: authMethod,
        directory: join(this.#options.workDir, 'login'),
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the CodeBuddy sign-in: ${error instanceof Error ? error.message : String(error)}. You can also run ${state.loginCommand ?? 'codebuddy'} in a terminal.`,
      );
    }
    if (flow.authUrl === undefined) {
      // 不需要浏览器就登录完成了（已有可用的凭据）。
      await flow.done;
      return this.read(kind, { refresh: true });
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
    // CodeBuddy 没有非交互的登出：ACP 没有这个方法，命令行也没有子命令。
    throw new AdapterError('invalid_input', 'Sign out with /logout inside the codebuddy CLI');
  }

  setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    this.#customPath = path?.trim() || null;
    return this.#probe(true).then((state) => this.#view(state));
  }

  /**
   * 替用户下载安装 `codebuddy`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因
   * 在 `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no CodeBuddy build for ${process.platform}-${process.arch}: install it yourself with \`${WORKBUDDY_INSTALL_COMMAND}\` or set a custom executable path`,
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
          if (!(error instanceof WorkBuddyInstallCancelled)) {
            this.#installError =
              error instanceof Error ? error.message : 'Could not install CodeBuddy.';
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

  get version(): string | undefined {
    return this.#state?.version;
  }

  /** 没登录时给用户的指引：应用内能登录的指向设置，其余是终端里的命令。 */
  signInHint(): string {
    return workbuddyAuthMethod(this.#parentEnv()) === undefined
      ? WORKBUDDY_SIGN_IN_HINT
      : WORKBUDDY_SIGN_IN_APP_HINT;
  }

  async executable(): Promise<WorkBuddyExecutable> {
    const state = await this.read('workbuddy');
    if (this.#executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          (this.#installer === undefined
            ? `Install CodeBuddy: ${WORKBUDDY_INSTALL_COMMAND}`
            : `Download CodeBuddy in Settings > Model services, or install it: ${WORKBUDDY_INSTALL_COMMAND}`),
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? this.signInHint());
    }
    return this.#executable;
  }

  markSignedOut(): void {
    if (this.#state === undefined || this.#disposed) return;
    this.#models = WORKBUDDY_DEFAULT_MODELS;
    this.#checkedAt = this.#now();
    const { lastError: _stale, ...rest } = this.#state;
    this.#publish({
      ...rest,
      status: 'signed_out',
      ...(workbuddyAuthMethod(this.#parentEnv()) === undefined && {
        lastError: WORKBUDDY_SIGN_IN_HINT,
      }),
    });
  }

  /** 仅当前模型的 thought_level 已知；保留此前同一目录里实际见过的其他模型档位。 */
  noteSessionModels(configOptions: unknown): void {
    const next = workBuddyModels(configOptions);
    if (next === undefined || this.#disposed) return;
    this.#models = {
      ...next,
      models: next.models.map((model) => {
        const previous = this.#models.models.find((old) => old.id === model.id);
        return model.reasoningEfforts === undefined && previous?.reasoningEfforts !== undefined
          ? { ...model, reasoningEfforts: previous.reasoningEfforts }
          : model;
      }),
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#revision += 1;
    this.#installer?.cancel();
    this.#login?.flow.cancel();
    this.#login = undefined;
    this.#abort?.abort();
    this.#listeners.clear();
    await Promise.all([...this.#probes].map((run) => run.catch(() => {})));
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'WorkBuddy adapter disposed');
    if (kind !== 'workbuddy')
      throw new AdapterError('invalid_input', `Not a WorkBuddy account: ${kind}`);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #parentEnv(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  /** 状态里加上不属于检测结果的部分：正在安装的进度、安装与登录失败的原因、进行中的登录。 */
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
    // 登录方式只在未登录时有意义。
    if (view.status !== 'signed_out' && view.loginOptions !== undefined) {
      const { loginOptions: _options, ...rest } = view;
      view = rest;
    }
    if (
      this.#login === undefined &&
      this.#loginError !== undefined &&
      view.status === 'signed_out'
    ) {
      view = { ...view, lastError: this.#loginError };
    }
    return view;
  }

  #defaultInstaller(): WorkBuddyInstaller | undefined {
    const archive = workbuddyArchive();
    if (archive === undefined) return undefined;
    return new WorkBuddyInstaller({
      directory: join(this.#options.workDir, 'runtime'),
      archive,
      // 下载来的程序要能跑：`codebuddy --version` 有答复。
      validate: async (file, _version, signal) => {
        const run = await runWorkBuddy(
          file,
          ['--version'],
          managedWorkBuddyEnv(workbuddyEnv(this.#parentEnv(), file)),
          10_000,
          signal,
        );
        if (!run.ok) throw new Error(run.message);
        if (run.code !== 0 || parseWorkBuddyVersion(`${run.stdout}\n${run.stderr}`) === undefined) {
          throw new Error(`\`--version\` exited with code ${run.code}`);
        }
      },
    });
  }

  /** 登录的 `codebuddy` 退出了：成功就重新检测账号，失败带上它的说明；被取消或被新的登录替换的不管。 */
  async #loginEnded(
    login: ActiveLogin,
    result: Awaited<WorkBuddyLoginFlow['done']>,
  ): Promise<void> {
    if (this.#login !== login) return;
    this.#login = undefined;
    if (this.#disposed) return;
    if (!result.ok && !result.cancelled) this.#loginError = result.message;
    if (result.ok) {
      this.#loginError = undefined;
      await this.#probe(true).catch(() => this.#emit());
      if (this.#state?.status !== 'signed_in') {
        this.#loginError = 'Sign-in finished, but CodeBuddy still reports you as signed out.';
        this.#emit();
      }
      return;
    }
    this.#emit();
  }

  #probe(force: boolean): Promise<AccountState> {
    if (this.#probing !== undefined && !force) return this.#probing;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const revision = ++this.#revision;
    const run = this.#detect(this.#customPath, abort.signal)
      .then((detected) => {
        if (revision === this.#revision && !this.#disposed) {
          this.#checkedAt = this.#now();
          this.#executable = detected.executable;
          this.#models = detected.models ?? WORKBUDDY_DEFAULT_MODELS;
          this.#publish(detected.state);
        }
        return detected.state;
      })
      .finally(() => {
        this.#probes.delete(run);
        if (this.#probing === run) this.#probing = undefined;
      });
    this.#probing = run;
    this.#probes.add(run);
    return run;
  }

  async #detect(customPath: string | null, signal: AbortSignal): Promise<Detection> {
    const parent = this.#parentEnv();
    const managed: ManagedWorkBuddy | undefined = await this.#installer?.active();
    const canInstall = this.#installer !== undefined;
    const loginOptions = workbuddyLoginOptions(parent);
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(customPath, managed?.path) ??
        findWorkBuddy({ customPath, env: parent, managedPath: managed?.path }).path;
    } catch {
      return {
        state: {
          ...this.#base(customPath, loginOptions, undefined, false),
          installed: false,
          installCommand: WORKBUDDY_INSTALL_COMMAND,
          ...(canInstall && { canInstall }),
          ...((customPath !== null || parent[WORKBUDDY_BIN_ENV] !== undefined) && {
            lastError: 'CodeBuddy executable path is unavailable',
          }),
        },
      };
    }
    const isManaged = managed !== undefined && executablePath === managed.path;
    const base = this.#base(customPath, loginOptions, executablePath, isManaged);
    const env = workbuddyEnv(parent, executablePath);
    const executable = { path: executablePath, env: isManaged ? managedWorkBuddyEnv(env) : env };
    const versionRun = await runWorkBuddy(
      executablePath,
      ['--version'],
      executable.env,
      10_000,
      signal,
    );
    const installed = { ...base, installed: true, executablePath };
    if (!versionRun.ok || versionRun.code !== 0) {
      if (isManaged) {
        // Wevir 装的这份跑不起来：当作没装，设置里重新下载。
        return {
          state: {
            ...base,
            installed: false,
            executablePath,
            installCommand: WORKBUDDY_INSTALL_COMMAND,
            canInstall: true,
            lastError: 'The downloaded CodeBuddy did not start. Download it again.',
          },
        };
      }
      return {
        state: {
          ...installed,
          lastError: 'CodeBuddy version check failed; Node 18.20.8+ required',
        },
      };
    }
    const version = parseWorkBuddyVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
    const versioned = { ...installed, ...(version !== undefined && { version }) };
    try {
      const setup = await (this.#options.probeSession ?? probeWorkBuddySession)(
        executable,
        signal,
        this.#options.workDir,
      );
      return {
        executable,
        models: workBuddyModels(setup) ?? WORKBUDDY_DEFAULT_MODELS,
        state: {
          ...versioned,
          status: 'signed_in',
          ...(version === undefined && {
            lastError: 'Unrecognized CodeBuddy CLI version; ACP detection succeeded',
          }),
        },
      };
    } catch (error) {
      const authRequired = isWorkBuddyAuthRequired(error);
      return {
        executable,
        state: {
          ...versioned,
          // 应用内能登录时，未登录只是未登录：设置里有“登录”，不必再给一条终端命令的提示。
          ...(authRequired
            ? loginOptions === undefined && { lastError: WORKBUDDY_SIGN_IN_HINT }
            : {
                lastError:
                  'CodeBuddy ACP detection failed; update the CLI, check the account environment and refresh',
              }),
        },
      };
    }
  }

  /** 登录方式：应用内能登录的给 `in_app`，其余给终端命令。 */
  #base(
    customPath: string | null,
    loginOptions: WorkBuddyLoginOption[] | undefined,
    executablePath: string | undefined,
    managed: boolean,
  ): AccountState {
    return {
      kind: 'workbuddy',
      status: 'signed_out',
      ...(loginOptions !== undefined
        ? {
            signIn: 'in_app' as const,
            loginMethods: ['browser' as const],
            loginOptions: loginOptions.map((option) => ({ ...option })),
          }
        : {
            signIn: 'command' as const,
            loginCommand: workbuddyLoginCommand(executablePath, managed),
          }),
      ...(customPath !== null && { customPath }),
    };
  }

  /** 把当前的原始检测结果（加上安装与登录的进展）通知监听器。 */
  #emit(): void {
    if (this.#state !== undefined && !this.#disposed) this.#notify(this.#view(this.#state));
  }

  #publish(state: AccountState): void {
    this.#state = state;
    this.#notify(this.#view(state));
  }

  #notify(state: AccountState): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        /* 一个监听器不影响其他监听器。 */
      }
    }
  }
}

/** 空目录建会话只读取 configOptions；绝不 authenticate / prompt / getUserInfo。 */
export async function probeWorkBuddySession(
  executable: WorkBuddyExecutable,
  signal: AbortSignal,
  workDir: string,
): Promise<unknown> {
  const cwd = join(workDir, 'probe');
  mkdirSync(cwd, { recursive: true });
  const probe = new AcpProcess({
    engine: WORKBUDDY_ENGINE,
    launcher: new WorkBuddyLauncher(workDir, async () => executable),
    clientInfo: { name: 'wevir-workbuddy-probe', version: '0.0.0' },
    restart: { maxRestarts: 0 },
    onExtRequest: async () => ({ outcome: 'cancelled' }),
  });
  const onAbort = () => {
    void probe.dispose();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) throw new AdapterError('disposed', 'WorkBuddy probe aborted');
    return await Promise.race([
      (async () => {
        await probe.start();
        const result = await probe.connection.agent.request<{ configOptions?: unknown }>(
          'session/new',
          { cwd, mcpServers: [] },
        );
        return result.configOptions;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ACP probe timeout')), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await probe.dispose();
  }
}
