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
import { DEVIN_ENGINE } from './engine.js';
import {
  DevinInstallCancelled,
  DevinInstaller,
  devinArchive,
  type ManagedDevin,
} from './install.js';
import {
  DEVIN_BIN_ENV,
  type DevinExecutable,
  DevinLauncher,
  devinEnv,
  devinInstallCommand,
  devinLoginCommand,
  findDevin,
  parseDevinVersion,
  runDevin,
} from './launch.js';
import { type DevinLoginFlow, loginDirectory, startDevinLogin } from './login.js';
import { DEVIN_DEFAULT_MODELS, devinModels } from './models.js';

export const PROBE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 15_000;
/** `devin auth status` 等子命令的时限（它可能要联网读账号信息）。 */
export const COMMAND_TIMEOUT_MS = 20_000;
/** 设置里的“登录”按钮可用时给的指引。 */
export const DEVIN_SIGN_IN_HINT = 'Sign in to Devin in Settings > Model services';
/** `devin acp` 也认这个环境变量里的 API Key（官方文档），设了就不看存下的登录。 */
export const DEVIN_API_KEY_ENV = 'WINDSURF_API_KEY';

export interface DevinAccountsOptions {
  workDir: string;
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `devin`）。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string;
  /** 测试用：替换读模型列表的 ACP 探测。 */
  probeSession?: (
    executable: DevinExecutable,
    signal: AbortSignal,
    workDir: string,
  ) => Promise<unknown>;
  /** 替用户下载安装 `devin`；省略时按本平台建，`null` 表示不能装（测试）。 */
  installer?: DevinInstaller | null;
  /** 测试用：替换启动应用内登录。 */
  startLogin?: typeof startDevinLogin;
  now?: () => number;
}

interface Detection {
  state: AccountState;
  executable?: DevinExecutable;
  models?: AccountModels;
}

/** 进行中的一次应用内登录。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  flow: DevinLoginFlow;
}

/** `devin auth status` 的结果。 */
export interface DevinAuthStatus {
  signedIn: boolean;
  email?: string;
  planLabel?: string;
}

/**
 * 解析 `devin auth status`（3000.11.92）：没登录是 “Not logged in.”，登录了是 “Logged in as …” 加 `Email:`、`Plan:` 等行。都不像
 * 时 undefined（交给调用方报错）。
 */
export function parseDevinAuthStatus(output: string): DevinAuthStatus | undefined {
  if (/\bnot logged in\b/i.test(output)) return { signedIn: false };
  if (!/\blogged in\b/i.test(output)) return undefined;
  const field = (name: string) =>
    new RegExp(`^\\s*${name}:[ \\t]*(\\S.*?)\\s*$`, 'imu').exec(output)?.[1];
  const email = field('Email');
  const plan = field('Plan');
  return {
    signedIn: true,
    ...(email !== undefined && /@/.test(email) && { email }),
    ...(plan !== undefined && { planLabel: plan }),
  };
}

/**
 * 找官方 CLI（用户自己装的优先，没有就用 Wevir 下载的），用 `devin auth status` 检测登录，登录了再起一次 `devin acp` 读模型列表；
 * 检测不认证、不读取凭据文件。登录由设置里的按钮起一次性的 `devin acp` 完成（login.ts），登出用 `devin auth logout`。
 */
export class DevinAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['devin'];
  readonly #options: DevinAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  readonly #installer: DevinInstaller | undefined;
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #models: AccountModels = DEVIN_DEFAULT_MODELS;
  #executable: DevinExecutable | undefined;
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

  constructor(options: DevinAccountsOptions) {
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
   * 登录：起一次性的 `devin acp` 调 `authenticate`，Devin 自己打开系统浏览器；立即返回 `signing_in`（没有 `authUrl`），用户在
   * 浏览器里登录后再检测一次账号并通知。已登录时不调。
   */
  async login(kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    this.#check(kind);
    if (method !== 'browser') {
      throw new AdapterError('invalid_input', 'Devin signs in through the browser only');
    }
    const state = await this.read(kind);
    if (state.status === 'signed_in') {
      throw new AdapterError('invalid_input', 'Devin is already signed in');
    }
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? 'Devin CLI is not installed: download it first, then sign in',
      );
    }
    // 已有进行中的登录时替换它（EngineAccounts.login 的约定）。
    this.#login?.flow.cancel();
    this.#login = undefined;
    this.#loginError = undefined;
    let flow: DevinLoginFlow;
    try {
      flow = await (this.#options.startLogin ?? startDevinLogin)({
        executable,
        directory: loginDirectory(this.#options.workDir),
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the Devin sign-in: ${error instanceof Error ? error.message : String(error)}. You can also run ${state.loginCommand ?? 'devin auth login'} in a terminal.`,
      );
    }
    const login = {
      flow,
      info: {
        loginId: randomUUID(),
        method: 'browser' as const,
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

  /** `devin auth logout` 删掉 Devin 存下的凭据，然后重新检测。环境变量里的 Key 不归 Wevir 管。 */
  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    await this.read(kind);
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError('engine_unavailable', 'Devin CLI is not installed');
    }
    if (this.#parentEnv()[DEVIN_API_KEY_ENV]?.trim()) {
      throw new AdapterError(
        'invalid_input',
        `Devin uses the ${DEVIN_API_KEY_ENV} environment variable; remove it to sign out`,
      );
    }
    const run = await runDevin(
      executable.path,
      ['auth', 'logout'],
      executable.env,
      COMMAND_TIMEOUT_MS,
    );
    if (!run.ok || run.code !== 0) {
      throw new AdapterError(
        'engine_unavailable',
        `\`devin auth logout\` failed: ${run.ok ? lastLine(`${run.stderr}\n${run.stdout}`) : run.message}`,
      );
    }
    return this.read(kind, { refresh: true });
  }

  setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    this.#customPath = path?.trim() || null;
    return this.#probe(true).then((state) => this.#view(state));
  }

  /**
   * 替用户下载安装 `devin`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因在
   * `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no Devin CLI build for ${process.platform}-${process.arch}: install it yourself with \`${devinInstallCommand()}\` or set a custom executable path`,
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
          if (!(error instanceof DevinInstallCancelled)) {
            this.#installError =
              error instanceof Error ? error.message : 'Could not install Devin CLI.';
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

  async executable(): Promise<DevinExecutable> {
    const state = await this.read('devin');
    if (this.#executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          (this.#installer === undefined
            ? `Install Devin CLI: ${devinInstallCommand()}`
            : `Download Devin CLI in Settings > Model services, or install it: ${devinInstallCommand()}`),
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? DEVIN_SIGN_IN_HINT);
    }
    return this.#executable;
  }

  markSignedOut(): void {
    if (this.#state === undefined || this.#disposed) return;
    this.#models = DEVIN_DEFAULT_MODELS;
    this.#checkedAt = this.#now();
    const { lastError: _stale, email: _email, planLabel: _plan, ...rest } = this.#state;
    this.#publish({ ...rest, status: 'signed_out' });
  }

  /** 会话里见到的模型列表（`config_option_update`）比检测时的新，换上它。 */
  noteSessionModels(configOptions: unknown): void {
    const next = devinModels(configOptions);
    if (next === undefined || this.#disposed) return;
    this.#models = next;
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
    if (this.#disposed) throw new AdapterError('disposed', 'Devin adapter disposed');
    if (kind !== 'devin') throw new AdapterError('invalid_input', `Not a Devin account: ${kind}`);
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
    if (
      this.#login === undefined &&
      this.#loginError !== undefined &&
      view.status === 'signed_out'
    ) {
      view = { ...view, lastError: this.#loginError };
    }
    return view;
  }

  #defaultInstaller(): DevinInstaller | undefined {
    const archive = devinArchive();
    if (archive === undefined) return undefined;
    return new DevinInstaller({
      directory: join(this.#options.workDir, 'runtime'),
      archive,
      // 下载来的程序要能跑：`devin --version` 有答复。
      validate: async (file, _version, signal) => {
        const run = await runDevin(
          file,
          ['--version'],
          devinEnv(this.#parentEnv(), file),
          10_000,
          signal,
        );
        if (!run.ok) throw new Error(run.message);
        if (run.code !== 0 || parseDevinVersion(`${run.stdout}\n${run.stderr}`) === undefined) {
          throw new Error(`\`--version\` exited with code ${run.code}`);
        }
      },
    });
  }

  /** 登录的 `devin acp` 结束了：成功就重新检测账号，失败带上它的说明；被取消或被新的登录替换的不管。 */
  async #loginEnded(login: ActiveLogin, result: Awaited<DevinLoginFlow['done']>): Promise<void> {
    if (this.#login !== login) return;
    this.#login = undefined;
    if (this.#disposed) return;
    if (!result.ok && !result.cancelled) this.#loginError = result.message;
    if (result.ok) {
      this.#loginError = undefined;
      await this.#probe(true).catch(() => this.#emit());
      if (this.#state?.status !== 'signed_in') {
        this.#loginError = 'Sign-in finished, but Devin still reports you as signed out.';
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
          this.#models = detected.models ?? DEVIN_DEFAULT_MODELS;
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
    const managed: ManagedDevin | undefined = await this.#installer?.active();
    const canInstall = this.#installer !== undefined;
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(customPath, managed?.path) ??
        findDevin({ customPath, env: parent, managedPath: managed?.path }).path;
    } catch {
      return {
        state: {
          ...this.#base(customPath, undefined, false),
          installed: false,
          installCommand: devinInstallCommand(),
          ...(canInstall && { canInstall }),
          ...((customPath !== null || parent[DEVIN_BIN_ENV] !== undefined) && {
            lastError: 'Devin CLI executable path is unavailable',
          }),
        },
      };
    }
    const isManaged = managed !== undefined && executablePath === managed.path;
    const base = this.#base(customPath, executablePath, isManaged);
    const executable = { path: executablePath, env: devinEnv(parent, executablePath) };
    const versionRun = await runDevin(
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
            installCommand: devinInstallCommand(),
            canInstall: true,
            lastError: 'The downloaded Devin CLI did not start. Download it again.',
          },
        };
      }
      return { state: { ...installed, lastError: 'Devin CLI version check failed' } };
    }
    const version = parseDevinVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
    const versioned = { ...installed, ...(version !== undefined && { version }) };

    let auth: DevinAuthStatus | undefined;
    if (parent[DEVIN_API_KEY_ENV]?.trim()) {
      auth = { signedIn: true };
    } else {
      const statusRun = await runDevin(
        executablePath,
        ['auth', 'status'],
        executable.env,
        COMMAND_TIMEOUT_MS,
        signal,
      );
      auth = statusRun.ok
        ? parseDevinAuthStatus(`${statusRun.stdout}\n${statusRun.stderr}`)
        : undefined;
      if (auth === undefined) {
        return {
          executable,
          state: {
            ...versioned,
            lastError: statusRun.ok
              ? `\`devin auth status\` gave an unrecognized answer: ${lastLine(`${statusRun.stderr}\n${statusRun.stdout}`)}`
              : statusRun.message,
          },
        };
      }
    }
    if (!auth.signedIn) return { executable, state: versioned };
    const signedIn: AccountState = {
      ...versioned,
      status: 'signed_in',
      ...(auth.email !== undefined && { email: auth.email }),
      ...(auth.planLabel !== undefined && { planLabel: auth.planLabel }),
    };
    try {
      const setup = await (this.#options.probeSession ?? probeDevinSession)(
        executable,
        signal,
        this.#options.workDir,
      );
      return { executable, models: devinModels(setup) ?? DEVIN_DEFAULT_MODELS, state: signedIn };
    } catch {
      // 读不到模型列表不影响登录状态：用“默认”，会话里见到真实列表再换。
      return { executable, state: signedIn };
    }
  }

  /** 应用内登录（浏览器）；终端里登录的命令也给。 */
  #base(
    customPath: string | null,
    executablePath: string | undefined,
    managed: boolean,
  ): AccountState {
    return {
      kind: 'devin',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['browser'],
      loginCommand: devinLoginCommand(executablePath, managed),
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

function lastLine(output: string): string {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1) ?? 'no output'
  ).slice(0, 300);
}

/**
 * 读模型列表：在空目录里建一个会话，只读它的 `configOptions`，再删掉它（Devin 一建就存进自己的会话库，不删会出现在 `devin list`
 * 里）。绝不 authenticate / prompt。
 */
export async function probeDevinSession(
  executable: DevinExecutable,
  signal: AbortSignal,
  workDir: string,
): Promise<unknown> {
  const cwd = join(workDir, 'probe');
  mkdirSync(cwd, { recursive: true });
  const probe = new AcpProcess({
    engine: DEVIN_ENGINE,
    launcher: new DevinLauncher(workDir, async () => executable),
    clientInfo: { name: 'wevir-devin-probe', version: '0.0.0' },
    restart: { maxRestarts: 0 },
    onExtRequest: async () => ({ outcome: 'cancelled' }),
  });
  const onAbort = () => {
    void probe.dispose();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) throw new AdapterError('disposed', 'Devin probe aborted');
    return await Promise.race([
      (async () => {
        await probe.start();
        const result = await probe.connection.agent.request<{
          sessionId: string;
          configOptions?: unknown;
        }>('session/new', { cwd, mcpServers: [] });
        await probe.connection.agent
          .request('session/delete', { sessionId: result.sessionId })
          .catch(() => {});
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
