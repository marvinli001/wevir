// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/status.ts（`checkOpenCodeProviderStatus`、`formatOpenCodeProbeError`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `AccountState`（`EngineAccounts`）；“已登录”与套餐显示接上了哪些上游；
// 不读 skills、slash 命令与 agent 列表；不支持外部服务器的网址与密码（只用本机起的服务器）。另移植了 usageLimits.ts（见 usage.ts）。
//
// OpenCode 的账号（opencode-event-mapping.md §2）：`opencode` 找用户自己装的，没有就由 Wevir 从 npm 下载一份
// （install.ts，`account.install`）；上游（Anthropic、OpenAI、OpenCode Zen、GitHub Copilot…）在设置里接（`account.upstreams` /
// `account.login` / `account.logout` 带 `upstream`，经本机服务器的 `provider.auth`、`provider.oauth`、`auth.set`），也可以在终端里
// `opencode auth login`；凭据在 opencode 自己的数据目录里（Wevir 只读 OpenCode Go 的 Key 查用量）。照 T3：先找 `opencode` 跑 `--version`，
// 再起本机服务器读 `provider.list`——`connected` 里有上游就算已登录，套餐写接上了哪些。接上了 OpenCode Go 时顺带读它的用量
// （usage.ts：读 auth.json 里 Go 的 Key，只读；读不到时留着上一次的）。结果缓存 5 分钟，`read` 带 `refresh` 时重新检测。

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  type AccountKind,
  type AccountLoginMethod,
  type AccountLoginOptions,
  type AccountModels,
  type AccountState,
  type AccountUpstream,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { NpmInstallCancelled } from '@wevir/runtime-adapter/npm-package';
import {
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_LOGIN_COMMAND,
  openCodeLoginCommand,
} from './executable.js';
import { accountModels, contextWindowOf, planLabel, variantsOf } from './models.js';
import type { OpenCodeRuntime, ServerLease } from './runtime.js';
import {
  authErrorMessage,
  errorMessage,
  type OpenCodeClient,
  type ProviderAuthMethod,
  type ProviderListResponse,
} from './sdk.js';
import {
  defaultInputs,
  deviceCode,
  type OpenCodeUpstream,
  type UpstreamMethod,
  upstreamCatalog,
} from './upstreams.js';
import { OPENCODE_GO_PROVIDER, readOpenCodeGoUsage } from './usage.js';

/** 检测结果的有效期（同 adapter-claude 的 PROBE_TTL_MS）。 */
export const PROBE_TTL_MS = 5 * 60_000;
/** 一次 OAuth 登录最长等多久（用户在浏览器里同意、或输入设备码前；设备码 15 分钟失效）。 */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** 进行中的一次应用内登录（OAuth）：服务器上的 `provider.oauth.callback` 挂着，借着的服务器不放。 */
interface ActiveLogin {
  info: NonNullable<AccountState['login']>;
  upstream: string;
  abort: AbortController;
  timedOut: boolean;
  release: () => void;
}

export interface OpenCodeAccountsOptions {
  runtime: OpenCodeRuntime;
  /** Host 的环境变量（找 opencode 的 auth.json、`OPENCODE_API_KEY`）；省略时用 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 读 OpenCode Go 用量的 fetch（测试换成假的）；省略时用全局的。 */
  fetch?: typeof fetch;
  /** 读 auth.json（测试换成假的）。 */
  readFile?: (file: string) => Promise<string>;
  now?: () => number;
}

/** OpenCode 的 `EngineAccounts`：只有一种 `opencode`。 */
export class OpenCodeAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = Object.freeze(['opencode' as const]);
  readonly #options: OpenCodeAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #state: AccountState | undefined;
  #providers: ProviderListResponse | undefined;
  #checkedAt = 0;
  #probing: Promise<AccountState> | undefined;
  #installing: { completedBytes: number; totalBytes?: number } | undefined;
  #installError: string | undefined;
  #login: ActiveLogin | undefined;
  #disposed = false;

  constructor(options: OpenCodeAccountsOptions) {
    this.#options = options;
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

  /** 带 `upstream`：接上这一家（见 `connect`）；不带：OpenCode 没有“整体登录”，告诉用户终端命令。 */
  async login(
    kind: AccountKind,
    _method?: AccountLoginMethod,
    options?: AccountLoginOptions,
  ): Promise<AccountState> {
    this.#check(kind);
    if (options?.upstream !== undefined) {
      return this.connect({
        upstream: options.upstream,
        ...(options.option !== undefined && { option: options.option }),
        ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
      });
    }
    const state = await this.read(kind);
    throw new AdapterError(
      'invalid_input',
      `OpenCode uses your own opencode login: run \`${state.loginCommand ?? OPENCODE_LOGIN_COMMAND}\` in a terminal, then check again`,
    );
  }

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    this.#check(kind);
    const login = this.#login;
    if (login !== undefined && (loginId === undefined || loginId === login.info.loginId)) {
      this.#endLogin(login);
      this.#emit();
    }
    return this.read(kind);
  }

  /** 全部能在应用内接的上游，和各自的登录方式（常用的在前）。 */
  async upstreams(kind: AccountKind = 'opencode'): Promise<AccountUpstream[]> {
    this.#check(kind);
    const lease = await this.#lease();
    try {
      const { list, auth } = await this.#catalogData(lease);
      this.#providers = list;
      return upstreamCatalog(list, auth).map((upstream) => ({
        ...upstream,
        methods: upstream.methods.map(({ type, label, option }) => ({ type, label, option })),
      }));
    } finally {
      lease.release();
    }
  }

  /**
   * 接上一个上游（opencode-event-mapping.md §2.4）。API Key：Key 经 `auth.set` 交给 opencode，立即返回重新检测后的状态；
   * OAuth：向服务器要授权网址，返回 `signing_in`（浏览器授权带 `login.authUrl`，设备码带 `login.verificationUrl` 与
   * `login.userCode`），用户在浏览器里同意后服务器的回调返回，再检测一次并通知；同一时刻只有一次登录，新的替换旧的。
   * Wevir 不读也不存令牌，Key 不进日志与状态。
   */
  async connect(input: {
    upstream: string;
    /** `upstreams()` 里这个上游某种方式的 `option`；上游只有一种方式时可省略。 */
    option?: string;
    apiKey?: string;
  }): Promise<AccountState> {
    this.#check('opencode');
    const lease = await this.#lease();
    let keepLease = false;
    try {
      const { list, auth } = await this.#catalogData(lease);
      const upstream = upstreamCatalog(list, auth).find((entry) => entry.id === input.upstream);
      if (upstream === undefined) {
        throw new AdapterError(
          'invalid_input',
          `OpenCode has no upstream "${input.upstream}" that can be connected here; use \`${OPENCODE_LOGIN_COMMAND}\` in a terminal`,
        );
      }
      const method = pickMethod(upstream, input.option);
      const client = lease.client(this.#options.runtime.engineDir);
      if (method.type === 'api_key') {
        const key = input.apiKey?.trim() ?? '';
        if (key === '' || /\s/u.test(key)) {
          throw new AdapterError(
            'invalid_input',
            key === ''
              ? `An API key is required for ${upstream.name}`
              : 'The API key must not contain spaces or line breaks',
          );
        }
        try {
          await client.setApiKey(upstream.id, key);
        } catch (error) {
          throw new AdapterError(
            'engine_unavailable',
            `OpenCode could not save the ${upstream.name} key: ${authErrorMessage(error)}`,
            { cause: error },
          );
        }
      } else {
        const index = method.index;
        if (index === undefined)
          throw new AdapterError('invalid_input', `${upstream.name}: not an OAuth method`);
        await this.#startOAuth(client, lease, upstream, index, auth[upstream.id]?.[index]);
        keepLease = true;
      }
    } finally {
      if (!keepLease) lease.release();
    }
    if (this.#login !== undefined && keepLease) return this.#view(this.#state as AccountState);
    return this.#view(await this.#probe(true));
  }

  /** 去掉 opencode 里存的这个上游的登录。环境变量或 OpenCode Zen 的免登录模型接着的，这里去不掉。 */
  async disconnect(upstream: string): Promise<AccountState> {
    this.#check('opencode');
    const lease = await this.#lease();
    try {
      await lease.client(this.#options.runtime.engineDir).removeAuth(upstream);
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `OpenCode could not remove the ${upstream} login: ${authErrorMessage(error)}`,
        { cause: error },
      );
    } finally {
      lease.release();
    }
    const state = await this.#probe(true);
    if (this.#providers?.connected.includes(upstream) === true) {
      throw new AdapterError(
        'invalid_input',
        `${upstream} is still connected through an environment variable or OpenCode's free access, which Wevir cannot remove`,
      );
    }
    return this.#view(state);
  }

  /** 带 `upstream`：去掉这一家的登录（见 `disconnect`）；不带：告诉用户终端命令。 */
  async logout(kind: AccountKind, options?: { upstream?: string }): Promise<AccountState> {
    this.#check(kind);
    if (options?.upstream !== undefined) return this.disconnect(options.upstream);
    const state = await this.read(kind);
    const command = (state.loginCommand ?? OPENCODE_LOGIN_COMMAND).replace(/ login$/u, ' logout');
    throw new AdapterError(
      'invalid_input',
      `OpenCode uses your own opencode login: run \`${command}\` in a terminal`,
    );
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    if (this.#providers === undefined) await this.read(kind);
    return this.#providers === undefined ? { models: [] } : accountModels(this.#providers);
  }

  async setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    const trimmed = path?.trim();
    await this.#options.runtime.setCustomPath(
      trimmed === undefined || trimmed === '' ? null : trimmed,
    );
    return this.#view(await this.#probe(true));
  }

  /**
   * 替用户下载安装 `opencode`（`account.install`）：立即返回带 `installing` 的状态，进度、完成（再检测一次账号）与失败（原因在
   * `lastError`）经 `onChange` 报告；已在安装时返回当前状态。
   */
  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const installer = this.#options.runtime.installer;
    if (installer === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Wevir has no opencode build for ${process.platform}-${process.arch}: install it yourself with \`${OPENCODE_INSTALL_COMMAND}\` or set a custom executable path`,
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
              error instanceof Error ? error.message : 'Could not install opencode.';
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
   * 会话要用之前：最近一次检测的结果，没检测过或已过期时先检测。没装或版本不能用时报 `engine_unavailable`，没接上游时报
   * `missing_credentials`（同 ChatGPT 会话，ADR-0005 补记 10）。
   */
  async requireReady(): Promise<void> {
    const state = await this.read('opencode');
    if (this.#options.runtime.installation === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          `opencode was not found; ${
            state.canInstall === true
              ? 'download it in Settings'
              : `install it with \`${OPENCODE_INSTALL_COMMAND}\``
          }`,
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError(
        'missing_credentials',
        `OpenCode has no connected provider: run \`${state.loginCommand ?? OPENCODE_LOGIN_COMMAND}\` in a terminal, then check again`,
      );
    }
  }

  /** 模型的上下文窗口（来自最近一次的 `provider.list`）。 */
  contextWindow(modelId: string): number | undefined {
    return contextWindowOf(this.#providers, modelId);
  }

  /** 模型的变体（来自最近一次的 `provider.list`）。 */
  variants(modelId: string): string[] {
    return variantsOf(this.#providers, modelId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#options.runtime.installer?.cancel();
    if (this.#login !== undefined) this.#endLogin(this.#login);
    this.#listeners.clear();
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the OpenCode engine has been disposed');
    if (kind !== 'opencode') {
      throw new AdapterError('invalid_input', `not an OpenCode account kind: ${kind}`);
    }
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

  /** 状态里加上不属于检测结果的部分：正在安装的进度、安装失败的原因。 */
  #view(state: AccountState): AccountState {
    let view = state;
    if (this.#installing !== undefined) {
      view = { ...view, installing: this.#installing };
    } else if (this.#installError !== undefined && view.installed === false) {
      view = { ...view, lastError: this.#installError };
    }
    if (this.#login !== undefined) {
      const { lastError: _stale, ...rest } = view;
      view = { ...rest, status: 'signing_in', login: this.#login.info };
    }
    return view;
  }

  /** 借服务器做登录与上游的事：先检测，没装或版本不能用时报错。借到的用完要 `release`。 */
  async #lease(): Promise<ServerLease> {
    const state = await this.read('opencode');
    const runtime = this.#options.runtime;
    if (runtime.installation === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          `opencode is not installed: ${
            state.canInstall === true
              ? 'download it first'
              : `install it with \`${OPENCODE_INSTALL_COMMAND}\``
          }`,
      );
    }
    try {
      mkdirSync(runtime.engineDir, { recursive: true });
      return await runtime.acquire();
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the OpenCode server: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async #catalogData(
    lease: ServerLease,
  ): Promise<{ list: ProviderListResponse; auth: Record<string, ProviderAuthMethod[]> }> {
    const runtime = this.#options.runtime;
    const client = lease.client(runtime.engineDir);
    try {
      const [list, auth] = await Promise.all([
        client.providers(runtime.signal),
        client.providerAuth(runtime.signal),
      ]);
      return { list, auth };
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Failed to load the OpenCode upstreams: ${authErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** 开始一次 OAuth 登录：要授权网址，挂上等回调的请求，登录进行中借着的服务器不放（`login.release`）。 */
  async #startOAuth(
    client: OpenCodeClient,
    lease: ServerLease,
    upstream: OpenCodeUpstream,
    method: number,
    raw: ProviderAuthMethod | undefined,
  ): Promise<void> {
    const runtime = this.#options.runtime;
    const inputs = defaultInputs(raw?.prompts) ?? {};
    let authorization: Awaited<ReturnType<OpenCodeClient['oauthAuthorize']>>;
    try {
      authorization = await client.oauthAuthorize(
        {
          providerID: upstream.id,
          method,
          ...(Object.keys(inputs).length > 0 && { inputs }),
        },
        runtime.signal,
      );
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Could not start the ${upstream.name} sign-in: ${authErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (authorization.method !== 'auto') {
      throw new AdapterError(
        'invalid_input',
        `The ${upstream.name} sign-in needs a code pasted back, which Wevir cannot do yet: run \`${OPENCODE_LOGIN_COMMAND}\` in a terminal`,
      );
    }
    if (!/^https?:\/\//iu.test(authorization.url)) {
      throw new AdapterError(
        'engine_unavailable',
        `OpenCode returned an unusable ${upstream.name} sign-in address`,
      );
    }
    const code = deviceCode(authorization.instructions);
    const startedAt = new Date(this.#now()).toISOString();
    const info: ActiveLogin['info'] =
      code === undefined
        ? { loginId: randomUUID(), method: 'browser', authUrl: authorization.url, startedAt }
        : {
            loginId: randomUUID(),
            method: 'device_code',
            verificationUrl: authorization.url,
            userCode: code,
            startedAt,
          };
    this.#replaceLogin();
    const abort = new AbortController();
    let released = false;
    const timer = setTimeout(() => {
      login.timedOut = true;
      abort.abort();
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const login: ActiveLogin = {
      info,
      upstream: upstream.id,
      abort,
      timedOut: false,
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        lease.release();
      },
    };
    this.#login = login;
    this.#emit();
    void client
      .oauthCallback(
        { providerID: upstream.id, method },
        AbortSignal.any([abort.signal, runtime.signal]),
      )
      .then(
        (completed) =>
          this.#loginEnded(
            login,
            completed ? undefined : `The ${upstream.name} sign-in was not completed.`,
          ),
        (error: unknown) =>
          this.#loginEnded(
            login,
            login.timedOut
              ? 'Sign-in timed out.'
              : `The ${upstream.name} sign-in failed: ${authErrorMessage(error)}`,
          ),
      );
  }

  /** 登录的请求回来了：成功就重新检测；失败带原因；被取消或被新的登录替换的不管。 */
  async #loginEnded(login: ActiveLogin, failure: string | undefined): Promise<void> {
    if (this.#login !== login) return;
    this.#endLogin(login);
    if (this.#disposed) return;
    if (failure === undefined) {
      await this.#probe(true).catch(() => this.#emit());
      return;
    }
    if (this.#state !== undefined) this.#state = { ...this.#state, lastError: failure };
    this.#emit();
  }

  /** 结束一次登录：中止挂着的请求、放掉借着的服务器。 */
  #endLogin(login: ActiveLogin): void {
    if (this.#login === login) this.#login = undefined;
    login.abort.abort();
    login.release();
  }

  #replaceLogin(): void {
    if (this.#login !== undefined) this.#endLogin(this.#login);
  }

  async #detect(): Promise<AccountState> {
    const runtime = this.#options.runtime;
    const detection = await runtime.detect();
    const executablePath = detection.ok
      ? detection.installation.executablePath
      : detection.executablePath;
    const base: AccountState = {
      kind: 'opencode',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['browser', 'device_code'],
      loginCommand: openCodeLoginCommand(executablePath, detection.managed === true),
      ...(runtime.customPath !== null && { customPath: runtime.customPath }),
    };
    if (!detection.ok) {
      this.#providers = undefined;
      const canInstall = runtime.installer !== undefined;
      return {
        ...base,
        // Wevir 装的这份跑不起来：当作没装，设置里重新下载。
        installed: detection.reason !== 'missing' && detection.managed !== true,
        installCommand: OPENCODE_INSTALL_COMMAND,
        ...((detection.reason === 'missing' || detection.managed === true) &&
          canInstall && { canInstall }),
        ...(detection.executablePath !== undefined && {
          executablePath: detection.executablePath,
        }),
        ...(detection.version !== undefined && { version: detection.version }),
        ...(detection.message !== undefined && { lastError: detection.message }),
      };
    }
    const { installation } = detection;
    const installed: AccountState = {
      ...base,
      installed: true,
      executablePath: installation.executablePath,
      ...(installation.version !== undefined && { version: installation.version }),
    };
    let providers: ProviderListResponse;
    try {
      mkdirSync(runtime.engineDir, { recursive: true });
      const lease = await runtime.acquire();
      try {
        providers = await lease.client(runtime.engineDir).providers(runtime.signal);
      } finally {
        lease.release();
      }
    } catch (error) {
      this.#providers = undefined;
      return {
        ...installed,
        lastError: `Failed to load the OpenCode provider list: ${errorMessage(error)}`,
      };
    }
    this.#providers = providers;
    const label = planLabel(providers);
    if (label === undefined) return installed;
    const rateLimits = providers.connected.includes(OPENCODE_GO_PROVIDER)
      ? await this.#readUsage()
      : undefined;
    return {
      ...installed,
      status: 'signed_in',
      plan: providers.connected.join(','),
      planLabel: label,
      ...(rateLimits !== undefined && { rateLimits }),
    };
  }

  /** OpenCode Go 的用量；读不到时是上一次的（usage.ts）。 */
  async #readUsage(): Promise<AccountState['rateLimits']> {
    try {
      return await readOpenCodeGoUsage({
        env: this.#options.env ?? process.env,
        ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
        ...(this.#options.readFile !== undefined && { readFile: this.#options.readFile }),
      });
    } catch {
      return this.#state?.status === 'signed_in' ? this.#state.rateLimits : undefined;
    }
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

/** 挑方式：给了 `option` 就找它，没给时上游只有一种方式才能省略。 */
function pickMethod(upstream: OpenCodeUpstream, option: string | undefined): UpstreamMethod {
  if (option === undefined) {
    const only = upstream.methods.length === 1 ? upstream.methods[0] : undefined;
    if (only === undefined) {
      throw new AdapterError(
        'invalid_input',
        `${upstream.name} has several sign-in methods: choose one (${upstream.methods
          .map((method) => `${method.option}: ${method.label}`)
          .join(', ')})`,
      );
    }
    return only;
  }
  const found = upstream.methods.find((method) => method.option === option);
  if (found === undefined) {
    throw new AdapterError('invalid_input', `${upstream.name} has no sign-in method ${option}`);
  }
  return found;
}
