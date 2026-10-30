import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountKind,
  type AccountLoginMethod,
  type AccountLoginOptions,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { KiroInstallCancelled, KiroInstaller, kiroArchive, type ManagedKiro } from './install.js';
import {
  findKiro,
  KIRO_API_KEY_ENV,
  KIRO_BIN_ENV,
  type KiroExecutable,
  kiroApiKeyEnv,
  kiroEnv,
  kiroInstallCommand,
  kiroLoginCommand,
  managedKiroEnv,
  parseKiroVersion,
  runKiro,
} from './launch.js';
import {
  isKiroLoginOption,
  KIRO_LOGIN_OPTIONS,
  type KiroLoginFlow,
  startKiroLogin,
} from './login.js';
import { KIRO_DEFAULT_MODELS, kiroModels, record } from './models.js';

export const PROBE_TTL_MS = 5 * 60_000;
export const COMMAND_TIMEOUT_MS = 30_000;
/** 设置里的“登录”按钮可用时给的指引。 */
export const KIRO_SIGN_IN_HINT = 'Sign in to Kiro in Settings > Model services';

export interface KiroAccountsOptions {
  workDir: string;
  /** Wevir 下载的 `kiro-cli` 放在哪里，默认 `<workDir>/runtime`。 */
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试用：替换可执行文件的查找（第二个参数是 Wevir 自己装的 `kiro-cli`）。 */
  findExecutable?: (customPath: string | null, managedPath?: string) => string;
  /** 替用户下载安装 `kiro-cli`；省略时按本平台建，`null` 表示不能装（测试、Windows）。 */
  installer?: KiroInstaller | null;
  /** 测试用：替换启动应用内登录。 */
  startLogin?: typeof startKiroLogin;
  now?: () => number;
}

/** `kiro-cli whoami --format json` 的结果：没登录时 `{"account":null}`（2.36.0）。 */
export interface KiroWhoami {
  signedIn: boolean;
  /** 界面上的账号名（邮箱或用户名）；读不到时省略。 */
  label?: string;
}

/**
 * 读 `whoami --format json` 的输出。登录后的 `account` 里有哪些字段没有账号核对过：有 `email` 用它，否则用任何像邮箱的字符串，
 * 再否则是 `username` / `userId`；读不懂时 undefined。
 */
export function parseKiroWhoami(output: string): KiroWhoami | undefined {
  let json: unknown;
  try {
    json = JSON.parse(output.trim());
  } catch {
    return undefined;
  }
  const fields = record(json);
  if (fields === undefined || !('account' in fields)) return undefined;
  const account = fields.account;
  if (account === null || account === undefined || account === false) return { signedIn: false };
  const label = accountLabel(account);
  return { signedIn: true, ...(label !== undefined && { label }) };
}

function accountLabel(account: unknown): string | undefined {
  const fields = record(account);
  if (fields === undefined) return undefined;
  if (typeof fields.email === 'string' && fields.email.trim()) return fields.email.trim();
  const strings: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (typeof value === 'string') strings.push(value);
    else if (depth < 3 && typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(fields, 0);
  const email = strings.find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
  if (email !== undefined) return email;
  for (const key of ['username', 'userName', 'name', 'userId']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

interface Detection {
  state: AccountState;
  executable?: KiroExecutable;
}

/** 进行中的一次应用内登录。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  flow: KiroLoginFlow;
}

/**
 * 找官方 CLI（用户自己装的优先，没有就用 Wevir 下载的），`kiro-cli whoami --format json` 看登录状态与账号名；检测不认证、不读
 * 令牌。登录由设置里的按钮起 `kiro-cli login --use-device-flow` 完成（login.ts），登出是 `kiro-cli logout`。模型列表要等会话建
 * 起来才知道（没登录时 ACP 进程起不来，也没有不登录就能读的列表），之前是“默认”。
 *
 * 只有首个账号：Kiro 把登录存在用户目录下固定的 data.sqlite3 里（macOS `~/Library/Application Support/kiro-cli`），2.36.0 的
 * `KIRO_HOME` 与 `KIRO_DATA_DIR` 都不搬它。
 */
export class KiroAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['kiro'];
  readonly #options: KiroAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  readonly #installer: KiroInstaller | undefined;
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #models: AccountModels = KIRO_DEFAULT_MODELS;
  #executable: KiroExecutable | undefined;
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

  constructor(options: KiroAccountsOptions) {
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
   * 登录：起 `kiro-cli login --use-device-flow`（`option` 选 Builder ID、Google 或 GitHub，缺省 Builder ID），等它给出设备码就
   * 返回 `signing_in`（带网址与码）。用户授权后 CLI 退出，再检测一次账号并通知。已登录时不调。
   */
  async login(
    kind: AccountKind,
    method: AccountLoginMethod,
    options?: AccountLoginOptions,
  ): Promise<AccountState> {
    this.#check(kind);
    const option = options?.option;
    if (method !== 'device_code') {
      throw new AdapterError('invalid_input', 'Kiro signs in with a device code only');
    }
    if (option !== undefined && !isKiroLoginOption(option)) {
      throw new AdapterError('invalid_input', `Unknown Kiro sign-in option: ${option}`);
    }
    const state = await this.read(kind);
    if (state.status === 'signed_in') {
      throw new AdapterError('invalid_input', 'Kiro is already signed in');
    }
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? 'Kiro CLI is not installed: download it first, then sign in',
      );
    }
    // 已有进行中的登录时替换它（EngineAccounts.login 的约定）。
    this.#login?.flow.cancel();
    this.#login = undefined;
    this.#loginError = undefined;
    const directory = join(this.#options.workDir, 'login');
    mkdirSync(directory, { recursive: true });
    let flow: KiroLoginFlow;
    try {
      flow = await (this.#options.startLogin ?? startKiroLogin)({
        executable,
        directory,
        ...(option !== undefined && { option }),
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the Kiro sign-in: ${error instanceof Error ? error.message : String(error)}. You can also run ${state.loginCommand ?? 'kiro-cli login'} in a terminal.`,
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
   * 登出：`kiro-cli logout`（删掉本机存的令牌），然后重新检测。环境变量里的 API Key 不归 Wevir 管，Kiro 也会拒绝。
   */
  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    await this.read(kind);
    const executable = this.#executable;
    if (executable === undefined) {
      throw new AdapterError('engine_unavailable', 'Kiro CLI is not installed');
    }
    if (kiroApiKeyEnv(this.#parentEnv())) {
      throw new AdapterError(
        'invalid_input',
        `Kiro uses the ${KIRO_API_KEY_ENV} environment variable; remove it to sign out`,
      );
    }
    const run = await runKiro(executable.path, ['logout'], executable.env, COMMAND_TIMEOUT_MS);
    if (!run.ok || run.code !== 0) {
      throw new AdapterError(
        'engine_unavailable',
        `Kiro could not sign out: ${run.ok ? lastLine(`${run.stdout}\n${run.stderr}`) || `exit code ${run.code}` : run.message}`,
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
   * 替用户下载安装 `kiro-cli`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因在
   * `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no Kiro CLI build for ${process.platform}-${process.arch}: install it yourself with \`${kiroInstallCommand()}\` or set a custom executable path`,
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
          if (!(error instanceof KiroInstallCancelled)) {
            this.#installError =
              error instanceof Error ? error.message : 'Could not install Kiro CLI.';
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

  async executable(): Promise<KiroExecutable> {
    const state = await this.read('kiro');
    if (this.#executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          (this.#installer === undefined
            ? `Install Kiro CLI: ${kiroInstallCommand()}`
            : `Download Kiro CLI in Settings > Model services, or install it: ${kiroInstallCommand()}`),
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? KIRO_SIGN_IN_HINT);
    }
    return this.#executable;
  }

  markSignedOut(): void {
    if (this.#state === undefined || this.#disposed) return;
    this.#checkedAt = this.#now();
    const { lastError: _stale, email: _email, ...rest } = this.#state;
    this.#publish({ ...rest, status: 'signed_out' });
  }

  /** 会话建起来时见到的模型列表（`session/new` 的 `models` 或 `configOptions`）：换上它。 */
  noteSessionModels(configOptions: unknown, models?: unknown): void {
    const next = kiroModels(configOptions, models);
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
    if (this.#disposed) throw new AdapterError('disposed', 'Kiro adapter disposed');
    if (kind !== 'kiro') {
      throw new AdapterError('invalid_input', `Not a Kiro account: ${kind}`);
    }
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
    // 登录方式只在未登录时有意义。
    if (view.status !== 'signed_out' && view.loginOptions !== undefined) {
      const { loginOptions: _options, ...rest } = view;
      view = rest;
    }
    if (this.#installing !== undefined) {
      view = { ...view, installing: this.#installing };
    } else if (this.#installError !== undefined && view.installed === false) {
      view = { ...view, lastError: this.#installError };
    }
    if (this.#login !== undefined && view.status !== 'signed_in') {
      const { lastError: _stale, loginOptions: _options, ...rest } = view;
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

  #defaultInstaller(): KiroInstaller | undefined {
    const archive = kiroArchive();
    if (archive === undefined) return undefined;
    return new KiroInstaller({
      directory: this.#options.runtimeDir ?? join(this.#options.workDir, 'runtime'),
      archive,
      // 下载来的程序要能跑：`kiro-cli --version` 有答复。
      validate: async (file, _version, signal) => {
        const run = await runKiro(
          file,
          ['--version'],
          managedKiroEnv(kiroEnv(this.#parentEnv(), file)),
          30_000,
          signal,
        );
        if (!run.ok) throw new Error(run.message);
        if (run.code !== 0 || parseKiroVersion(`${run.stdout}\n${run.stderr}`) === undefined) {
          throw new Error(`\`--version\` exited with code ${run.code}`);
        }
      },
    });
  }

  /** 登录的 `kiro-cli login` 结束了：成功就重新检测账号，失败带上它的说明；被取消或被新的登录替换的不管。 */
  async #loginEnded(login: ActiveLogin, result: Awaited<KiroLoginFlow['done']>): Promise<void> {
    if (this.#login !== login) return;
    this.#login = undefined;
    if (this.#disposed) return;
    if (!result.ok && !result.cancelled) this.#loginError = result.message;
    if (result.ok) {
      this.#loginError = undefined;
      await this.#probe(true).catch(() => this.#emit());
      if (this.#state?.status !== 'signed_in') {
        this.#loginError = 'Sign-in finished, but Kiro still reports you as signed out.';
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
          if (detected.state.status !== 'signed_in') this.#models = KIRO_DEFAULT_MODELS;
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
    const managed: ManagedKiro | undefined = await this.#installer?.active();
    const canInstall = this.#installer !== undefined;
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(customPath, managed?.path) ??
        findKiro({ customPath, env: parent, managedPath: managed?.path }).path;
    } catch {
      return {
        state: {
          ...this.#base(customPath, undefined, false),
          installed: false,
          installCommand: kiroInstallCommand(),
          ...(canInstall && { canInstall }),
          ...((customPath !== null || parent[KIRO_BIN_ENV] !== undefined) && {
            lastError: 'Kiro CLI executable path is unavailable',
          }),
        },
      };
    }
    const isManaged = managed !== undefined && executablePath === managed.path;
    const base = this.#base(customPath, executablePath, isManaged);
    const env = kiroEnv(parent, executablePath);
    const executable: KiroExecutable = {
      path: executablePath,
      env: isManaged ? managedKiroEnv(env) : env,
    };
    const versionRun = await runKiro(
      executablePath,
      ['--version'],
      executable.env,
      COMMAND_TIMEOUT_MS,
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
            installCommand: kiroInstallCommand(),
            canInstall: true,
            lastError: 'The downloaded Kiro CLI did not start. Download it again.',
          },
        };
      }
      return { state: { ...installed, lastError: 'Kiro CLI version check failed' } };
    }
    const version = parseKiroVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
    const versioned = { ...installed, ...(version !== undefined && { version }) };

    const whoamiRun = await runKiro(
      executablePath,
      ['whoami', '--format', 'json'],
      executable.env,
      COMMAND_TIMEOUT_MS,
      signal,
    );
    const whoami = whoamiRun.ok ? parseKiroWhoami(whoamiRun.stdout) : undefined;
    if (whoami === undefined) {
      return {
        executable,
        state: {
          ...versioned,
          lastError: whoamiRun.ok
            ? `\`kiro-cli whoami\` failed: ${lastLine(`${whoamiRun.stdout}\n${whoamiRun.stderr}`) || `exit code ${whoamiRun.code}`}`
            : whoamiRun.message,
        },
      };
    }
    if (!whoami.signedIn) return { executable, state: versioned };
    return {
      executable,
      state: {
        ...versioned,
        status: 'signed_in',
        ...(whoami.label !== undefined && { email: whoami.label }),
      },
    };
  }

  /** 应用内登录（设备码，可选 Builder ID、Google 或 GitHub）；终端里登录的命令也给。 */
  #base(
    customPath: string | null,
    executablePath: string | undefined,
    managed: boolean,
  ): AccountState {
    return {
      kind: 'kiro',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
      loginOptions: KIRO_LOGIN_OPTIONS.map(({ id, label }) => ({ id, label })),
      loginCommand: kiroLoginCommand(executablePath, managed),
      ...(customPath !== null && { customPath }),
    };
  }

  /** 把当前的原始检测结果（加上安装与登录）通知监听器。 */
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

/** 输出里最后一行有内容的。 */
function lastLine(output: string): string {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1)
      ?.slice(0, 300) ?? ''
  );
}
