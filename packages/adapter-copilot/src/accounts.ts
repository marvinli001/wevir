import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { COPILOT_ENGINE, isCopilotAuthRequired } from './engine.js';
import {
  CopilotInstallCancelled,
  CopilotInstaller,
  copilotArchive,
  type ManagedCopilot,
} from './install.js';
import {
  COPILOT_BIN_ENV,
  type CopilotAccountDirs,
  type CopilotExecutable,
  CopilotLauncher,
  copilotAcpArgs,
  copilotEnv,
  copilotInstallCommand,
  copilotLoginCommand,
  copilotTokenEnv,
  findCopilot,
  managedCopilotEnv,
  parseCopilotVersion,
  runCopilot,
} from './launch.js';
import { type CopilotLoginFlow, startCopilotLogin } from './login.js';
import { COPILOT_DEFAULT_MODELS, copilotModels, record } from './models.js';

export const PROBE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 30_000;
/** 设置里的“登录”按钮可用时给的指引。 */
export const COPILOT_SIGN_IN_HINT = 'Sign in to GitHub Copilot in Settings > Model services';

export interface CopilotAccountsOptions {
  workDir: string;
  /** Wevir 下载的 `copilot` 放在哪里，默认 `<workDir>/runtime`（添加的账号与首个账号共用一份：设置里的下载装在首个账号那里）。 */
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 添加的账号（0.63.0）：它自己的 `COPILOT_HOME` 与空的 GitHub CLI 配置目录；首个账号省略，用用户本机的登录。 */
  account?: CopilotAccountDirs;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `copilot`）。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string;
  /** 测试用：替换读登录状态与模型列表的 ACP 探测。 */
  probeSession?: (
    executable: CopilotExecutable,
    signal: AbortSignal,
    workDir: string,
  ) => Promise<CopilotProbe>;
  /** 替用户下载安装 `copilot`；省略时按本平台建，`null` 表示不能装（测试）。 */
  installer?: CopilotInstaller | null;
  /** 测试用：替换启动应用内登录。 */
  startLogin?: typeof startCopilotLogin;
  /** 测试用：替换 Copilot 的配置目录（默认 `COPILOT_HOME` 或 `~/.copilot`）。 */
  home?: string;
  now?: () => number;
}

/** ACP 探测的结果：没登录时 `session/new` 回“Authentication required”。 */
export type CopilotProbe = { signedIn: false } | { signedIn: true; models?: AccountModels };

interface Detection {
  state: AccountState;
  executable?: CopilotExecutable;
  models?: AccountModels;
}

/** 进行中的一次应用内登录。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  flow: CopilotLoginFlow;
}

/** Copilot 在配置目录的 config.json 里记下的上次登录的账号（`lastLoggedInUser`，1.0.103）。 */
export interface CopilotUser {
  host: string;
  login: string;
}

/** 读 `<配置目录>/config.json`（带 `//` 注释的 JSON）里的 `lastLoggedInUser`；没有或读不懂时 undefined。不读令牌。 */
export function readCopilotUser(configDir: string): CopilotUser | undefined {
  let text: string;
  try {
    text = readFileSync(join(configDir, 'config.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const json = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, ''));
    const user = record(record(json)?.lastLoggedInUser);
    if (typeof user?.login !== 'string' || user.login === '') return undefined;
    return { host: typeof user.host === 'string' ? user.host : 'github.com', login: user.login };
  } catch {
    return undefined;
  }
}

/** 界面上的账号名：github.com 的写登录名，别的主机（GitHub Enterprise）写 `登录名@主机`。 */
export function copilotUserLabel(user: CopilotUser): string {
  const host = user.host.replace(/^https?:\/\//u, '').replace(/\/+$/u, '');
  return host === '' || host === 'github.com' ? user.login : `${user.login}@${host}`;
}

/**
 * 找官方 CLI（用户自己装的优先，没有就用 Wevir 下载的），起一次 `copilot --acp` 建个会话看登录状态并读模型列表（没登录时
 * `session/new` 报“Authentication required”），账号名读配置目录的 config.json；检测不认证、不读令牌。登录由设置里的按钮起
 * `copilot login --device-code` 完成（login.ts），登出用 ACP 的 `logout`。额度来自会话里的 `assistant.usage` 事件
 * （usage.ts，`setRateLimits`）。
 */
export class CopilotAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['copilot'];
  readonly #options: CopilotAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  readonly #installer: CopilotInstaller | undefined;
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #models: AccountModels = COPILOT_DEFAULT_MODELS;
  #rateLimits: AccountState['rateLimits'];
  #executable: CopilotExecutable | undefined;
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

  constructor(options: CopilotAccountsOptions) {
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
   * 登录：起 `copilot login --device-code`，等它给出设备码就返回 `signing_in`（带网址与码；CLI 自己也复制码、打开浏览器）。用户
   * 授权后 CLI 退出，再检测一次账号并通知。已登录时不调。
   */
  async login(kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    this.#check(kind);
    if (method !== 'device_code') {
      throw new AdapterError('invalid_input', 'GitHub Copilot signs in with a device code only');
    }
    const state = await this.read(kind);
    if (state.status === 'signed_in') {
      throw new AdapterError('invalid_input', 'GitHub Copilot is already signed in');
    }
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? 'GitHub Copilot CLI is not installed: download it first, then sign in',
      );
    }
    // 已有进行中的登录时替换它（EngineAccounts.login 的约定）。
    this.#login?.flow.cancel();
    this.#login = undefined;
    this.#loginError = undefined;
    const directory = join(this.#options.workDir, 'login');
    mkdirSync(directory, { recursive: true });
    let flow: CopilotLoginFlow;
    try {
      flow = await (this.#options.startLogin ?? startCopilotLogin)({ executable, directory });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the GitHub Copilot sign-in: ${error instanceof Error ? error.message : String(error)}. You can also run ${state.loginCommand ?? 'copilot login'} in a terminal.`,
      );
    }
    const login = {
      flow,
      info: {
        loginId: randomUUID(),
        method: 'device_code' as const,
        verificationUrl: flow.verificationUrl,
        userCode: flow.userCode,
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

  /**
   * 登出：起一次 `copilot --acp` 调 ACP 的 `logout`（删掉本机存的令牌，不在 GitHub 上吊销），然后重新检测。环境变量里的令牌
   * 与 GitHub CLI 的登录不归 Wevir 管，Copilot 也会拒绝。
   */
  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    await this.read(kind);
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError('engine_unavailable', 'GitHub Copilot CLI is not installed');
    }
    const token =
      this.#options.account === undefined ? copilotTokenEnv(this.#parentEnv()) : undefined;
    if (token !== undefined) {
      throw new AdapterError(
        'invalid_input',
        `GitHub Copilot uses the ${token} environment variable; remove it to sign out`,
      );
    }
    const acp = new AcpProcess({
      engine: COPILOT_ENGINE,
      launcher: new CopilotLauncher(this.#options.workDir, async () => executable),
      clientInfo: { name: 'wevir-copilot-logout', version: '0.0.0' },
      restart: { maxRestarts: 0 },
    });
    try {
      await acp.start();
      await acp.connection.agent.request('logout', {});
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `GitHub Copilot could not sign out: ${messageOf(error)}`,
      );
    } finally {
      await acp.dispose().catch(() => {});
    }
    this.#rateLimits = undefined;
    return this.read(kind, { refresh: true });
  }

  setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    this.#customPath = path?.trim() || null;
    return this.#probe(true).then((state) => this.#view(state));
  }

  /**
   * 替用户下载安装 `copilot`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因在
   * `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no GitHub Copilot CLI build for ${process.platform}-${process.arch}: install it yourself with \`${copilotInstallCommand()}\` or set a custom executable path`,
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
          if (!(error instanceof CopilotInstallCancelled)) {
            this.#installError =
              error instanceof Error ? error.message : 'Could not install GitHub Copilot CLI.';
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

  async executable(): Promise<CopilotExecutable> {
    const state = await this.read('copilot');
    if (this.#executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          (this.#installer === undefined
            ? `Install GitHub Copilot CLI: ${copilotInstallCommand()}`
            : `Download GitHub Copilot CLI in Settings > Model services, or install it: ${copilotInstallCommand()}`),
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? COPILOT_SIGN_IN_HINT);
    }
    return this.#executable;
  }

  markSignedOut(): void {
    if (this.#state === undefined || this.#disposed) return;
    this.#models = COPILOT_DEFAULT_MODELS;
    this.#rateLimits = undefined;
    this.#checkedAt = this.#now();
    const { lastError: _stale, email: _email, rateLimits: _limits, ...rest } = this.#state;
    this.#publish({ ...rest, status: 'signed_out' });
  }

  /** 会话里见到的模型列表（`config_option_update`）比检测时的新，换上它。 */
  noteSessionModels(configOptions: unknown): void {
    const next = copilotModels(configOptions);
    if (next === undefined || this.#disposed) return;
    this.#models = next;
  }

  /** 会话里的 `assistant.usage` 带来的额度（usage.ts）：记下并通知。 */
  setRateLimits(rateLimits: NonNullable<AccountState['rateLimits']>): void {
    if (this.#disposed) return;
    this.#rateLimits = rateLimits;
    this.#emit();
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
    if (this.#disposed) throw new AdapterError('disposed', 'GitHub Copilot adapter disposed');
    if (kind !== 'copilot') {
      throw new AdapterError('invalid_input', `Not a GitHub Copilot account: ${kind}`);
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #parentEnv(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  /** Copilot 的配置目录：添加的账号是它自己的，首个账号是 `COPILOT_HOME` 或 `~/.copilot`。 */
  #configDir(): string {
    return (
      this.#options.home ??
      this.#options.account?.copilotHome ??
      (this.#parentEnv().COPILOT_HOME?.trim() || join(homedir(), '.copilot'))
    );
  }

  /** 状态里加上不属于检测结果的部分：正在安装的进度、安装与登录失败的原因、进行中的登录、额度。 */
  #view(state: AccountState): AccountState {
    let view = state;
    if (this.#rateLimits !== undefined && view.status === 'signed_in') {
      view = { ...view, rateLimits: this.#rateLimits };
    }
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

  #defaultInstaller(): CopilotInstaller | undefined {
    const archive = copilotArchive();
    if (archive === undefined) return undefined;
    return new CopilotInstaller({
      directory: this.#options.runtimeDir ?? join(this.#options.workDir, 'runtime'),
      archive,
      // 下载来的程序要能跑：`copilot --version` 有答复。
      validate: async (file, _version, signal) => {
        const run = await runCopilot(
          file,
          ['--version'],
          managedCopilotEnv(copilotEnv(this.#parentEnv(), file, this.#options.account)),
          30_000,
          signal,
        );
        if (!run.ok) throw new Error(run.message);
        if (run.code !== 0 || parseCopilotVersion(`${run.stdout}\n${run.stderr}`) === undefined) {
          throw new Error(`\`--version\` exited with code ${run.code}`);
        }
      },
    });
  }

  /** 登录的 `copilot login` 结束了：成功就重新检测账号，失败带上它的说明；被取消或被新的登录替换的不管。 */
  async #loginEnded(login: ActiveLogin, result: Awaited<CopilotLoginFlow['done']>): Promise<void> {
    if (this.#login !== login) return;
    this.#login = undefined;
    if (this.#disposed) return;
    if (!result.ok && !result.cancelled) this.#loginError = result.message;
    if (result.ok) {
      this.#loginError = undefined;
      await this.#probe(true).catch(() => this.#emit());
      if (this.#state?.status !== 'signed_in') {
        this.#loginError = 'Sign-in finished, but GitHub Copilot still reports you as signed out.';
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
          this.#models = detected.models ?? COPILOT_DEFAULT_MODELS;
          if (detected.state.status !== 'signed_in') this.#rateLimits = undefined;
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
    const managed: ManagedCopilot | undefined = await this.#installer?.active();
    const canInstall = this.#installer !== undefined;
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(customPath, managed?.path) ??
        findCopilot({ customPath, env: parent, managedPath: managed?.path }).path;
    } catch {
      return {
        state: {
          ...this.#base(customPath, undefined, false),
          installed: false,
          installCommand: copilotInstallCommand(),
          ...(canInstall && { canInstall }),
          ...((customPath !== null || parent[COPILOT_BIN_ENV] !== undefined) && {
            lastError: 'GitHub Copilot CLI executable path is unavailable',
          }),
        },
      };
    }
    const isManaged = managed !== undefined && executablePath === managed.path;
    const base = this.#base(customPath, executablePath, isManaged);
    const executable: CopilotExecutable = {
      path: executablePath,
      env: isManaged
        ? managedCopilotEnv(copilotEnv(parent, executablePath, this.#options.account))
        : copilotEnv(parent, executablePath, this.#options.account),
      args: copilotAcpArgs(isManaged),
    };
    const versionRun = await runCopilot(
      executablePath,
      ['--version'],
      executable.env,
      30_000,
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
            installCommand: copilotInstallCommand(),
            canInstall: true,
            lastError: 'The downloaded GitHub Copilot CLI did not start. Download it again.',
          },
        };
      }
      return { state: { ...installed, lastError: 'GitHub Copilot CLI version check failed' } };
    }
    const version = parseCopilotVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
    const versioned = { ...installed, ...(version !== undefined && { version }) };

    let probe: CopilotProbe;
    try {
      probe = await (this.#options.probeSession ?? probeCopilotSession)(
        executable,
        signal,
        this.#options.workDir,
      );
    } catch (error) {
      return { executable, state: { ...versioned, lastError: messageOf(error) } };
    }
    if (!probe.signedIn) return { executable, state: versioned };
    const user = readCopilotUser(this.#configDir());
    const signedIn: AccountState = {
      ...versioned,
      status: 'signed_in',
      ...(user !== undefined && { email: copilotUserLabel(user) }),
    };
    return {
      executable,
      state: signedIn,
      ...(probe.models !== undefined && { models: probe.models }),
    };
  }

  /** 应用内登录（设备码）；终端里登录的命令也给。 */
  #base(
    customPath: string | null,
    executablePath: string | undefined,
    managed: boolean,
  ): AccountState {
    return {
      kind: 'copilot',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
      loginCommand: copilotLoginCommand(
        executablePath,
        managed,
        this.#options.account?.copilotHome,
      ),
      ...(customPath !== null && { customPath }),
    };
  }

  /** 把当前的原始检测结果（加上安装、登录与额度）通知监听器。 */
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

function messageOf(error: unknown): string {
  const fields = record(error);
  const data = fields?.data;
  if (typeof data === 'string' && data !== '') return data;
  if (typeof fields?.message === 'string' && fields.message !== '') return fields.message;
  return String(error);
}

/**
 * 看登录状态、读模型列表：在空目录里建一个会话，只读它的 `configOptions`，再关掉它。没登录时 `session/new` 回“Authentication
 * required”。不起内置的 GitHub MCP 服务器；绝不 authenticate / prompt。
 */
export async function probeCopilotSession(
  executable: CopilotExecutable,
  signal: AbortSignal,
  workDir: string,
): Promise<CopilotProbe> {
  const cwd = join(workDir, 'probe');
  mkdirSync(cwd, { recursive: true });
  const probe = new AcpProcess({
    engine: COPILOT_ENGINE,
    launcher: new CopilotLauncher(workDir, async () => ({
      ...executable,
      args: [...(executable.args ?? copilotAcpArgs(false)), '--disable-builtin-mcps'],
    })),
    clientInfo: { name: 'wevir-copilot-probe', version: '0.0.0' },
    restart: { maxRestarts: 0 },
  });
  const onAbort = () => {
    void probe.dispose();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) throw new AdapterError('disposed', 'GitHub Copilot probe aborted');
    return await Promise.race([
      (async (): Promise<CopilotProbe> => {
        await probe.start();
        let result: { sessionId: string; configOptions?: unknown; models?: unknown };
        try {
          result = await probe.connection.agent.request('session/new', { cwd, mcpServers: [] });
        } catch (error) {
          if (isCopilotAuthRequired(error)) return { signedIn: false };
          throw error;
        }
        await probe.connection.agent
          .request('session/close', { sessionId: result.sessionId })
          .catch(() => {});
        const models = copilotModels(result.configOptions, result.models);
        return { signedIn: true, ...(models !== undefined && { models }) };
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
