// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/AntigravityAuth.ts（makeAntigravityAuth）、Drivers/AntigravityDriver.ts（不启动
// 运行体的健康检查、refreshModels、一次性的登录进程）与 AntigravityProvider.ts（登录状态与模型）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成普通 TS 的 EngineAccounts。只有个人 Google 账号；回调落在 Host 这台机器的 127.0.0.1，浏览器要在
// 本机，不做 T3 的远程粘贴回调网址（协议里没有这个方法）；登录状态不启动运行体，只看 profile 里登录文件在不在（不读内容），
// 会话或刷新报要登录时改为未登录；不做 T3 读令牌查用量（Wevir 不读令牌）；安装经 account.install，进度与失败进状态。
//
// Antigravity 的账号（订阅来源 `antigravity`，domain-model §3.6，docs/architecture/antigravity-event-mapping.md §2、§6）。

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { AcpProcess } from '@wevir/adapter-acp';
import { methods } from '@wevir/adapter-acp/sdk';
import {
  type AccountKind,
  type AccountLoginMethod,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import {
  type AntigravityExecutable,
  AntigravityInstallationError,
  AntigravityInstallCancelled,
  type InstallProgress,
} from './installation.js';
import { antigravityModelsFromSetup, clearModels, loadModels, saveModels } from './models.js';
import {
  type AntigravityLauncher,
  type AntigravityRuntimeContext,
  createAntigravityProcess,
} from './process.js';
import {
  ANTIGRAVITY_AUTH_METHOD,
  type AntigravityAuthorizationUrl,
  antigravityTokenPath,
} from './profile.js';
import { removeAntigravitySessionFiles } from './session-files.js';

/** 一次登录最长等多久（T3 的 AUTH_TIMEOUT_MS）。 */
export const LOGIN_TIMEOUT_MS = 300_000;
/** `login` 最多等登录网址多久再返回（客户端请求的默认时限是 60 s）；之后网址经 onChange 送达。 */
export const LOGIN_URL_WAIT_MS = 40_000;
/** 登出与刷新的时限（T3：90 s）。 */
export const LOGOUT_TIMEOUT_MS = 90_000;
export const REFRESH_TIMEOUT_MS = 90_000;

const KIND = 'antigravity' as const;
const BASE: AccountState = {
  kind: KIND,
  status: 'signed_out',
  signIn: 'in_app',
  loginMethods: ['browser'],
};
const SIGN_IN_EXPIRED = 'Google sign-in expired or was revoked. Sign in again.';

interface LoginFlow {
  readonly loginId: string;
  readonly startedAt: string;
  readonly process: AcpProcess;
  readonly launcher: AntigravityLauncher;
  readonly cwd: string;
  authUrl?: string;
  sessionId?: string;
  timer?: ReturnType<typeof setTimeout>;
  gotUrl: () => void;
}

export interface AntigravityAccountsOptions {
  context: AntigravityRuntimeContext;
  /** 登出：先停掉用着旧凭据的会话进程（antigravity-adapter.ts）。 */
  onSignedOut?: () => Promise<void>;
  loginTimeoutMs?: number;
  loginUrlWaitMs?: number;
}

export class AntigravityAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = [KIND];
  readonly #options: AntigravityAccountsOptions;
  readonly #context: AntigravityRuntimeContext;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #state: AccountState = BASE;
  #flow: LoginFlow | undefined;
  #stopping = false;
  #installing: InstallProgress | undefined;
  /** 最近一次登录、安装失败或登录失效的原因（AccountState.lastError）。 */
  #lastError: string | undefined;
  /** 会话或刷新报了要登录：登录文件还在也算未登录，直到重新登录或刷新成功。 */
  #authRejected = false;
  #customPath: string | null = null;
  #models: AccountModels | undefined;
  #disposed = false;
  /**
   * 状态的先后：每次取快照或直接设置状态前取一个号，只采用号比已采用的大的。快照要读磁盘、是异步的，先开始的可能后完成，
   * 不这样的话旧快照（例如下载失败前开始的、还带着 installing 的）会盖掉已经发布的新状态。
   */
  #stateSeq = 0;
  #appliedSeq = 0;

  constructor(options: AntigravityAccountsOptions) {
    this.#options = options;
    this.#context = options.context;
  }

  /** account.setPath 指定的可执行文件（会话进程的启动器读它）。 */
  get customPath(): string | null {
    return this.#customPath;
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    if (this.#flow !== undefined) return this.#state;
    const seq = ++this.#stateSeq;
    const state = await this.#snapshot();
    if (options?.refresh === true && state.installed === true && state.status === 'signed_in') {
      await this.#refresh();
      return this.#update();
    }
    return this.#set(state, seq);
  }

  async login(kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    this.#check(kind);
    if (method !== 'browser') {
      throw new AdapterError('invalid_input', 'Antigravity signs in through the browser only.');
    }
    if (this.#stopping) {
      throw new AdapterError('invalid_input', 'Antigravity sign-out is in progress. Try again.');
    }
    const executable = await this.#resolve();
    if (executable === undefined) {
      throw new AdapterError('invalid_input', 'Antigravity is not installed. Download it first.');
    }
    // 已有进行中的登录时替换它（EngineAccounts.login 的约定）。
    await this.#endFlow();
    await fsp.mkdir(this.#context.paths.root, { recursive: true });
    const cwd = await fsp.mkdtemp(path.join(this.#context.paths.root, '.setup-'));
    let gotUrl: () => void = () => {};
    const urlArrived = new Promise<void>((resolve) => {
      gotUrl = resolve;
    });
    let flow: LoginFlow | undefined;
    const { process, launcher } = createAntigravityProcess({
      context: this.#context,
      authenticate: 'none',
      onAuthorizationUrl: (url) => {
        if (flow !== undefined) this.#onUrl(flow, url);
      },
    });
    flow = {
      loginId: randomUUID(),
      startedAt: new Date().toISOString(),
      process,
      launcher,
      cwd,
      gotUrl,
    };
    const current = flow;
    this.#flow = current;
    this.#lastError = undefined;
    current.timer = setTimeout(
      () =>
        void this.#fail(
          current,
          new Error('timeout'),
          'Google sign-in expired. Start sign-in again.',
        ),
      this.#options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
    );
    current.timer.unref?.();
    this.#set(this.#signingIn(current, (await this.#installFields()).fields));
    const run = (async () => {
      await process.start();
      const connection = process.connection;
      // 没登录时运行体经 BROWSER 钩子给出登录网址，等用户在浏览器里完成（回调落在本机 127.0.0.1）。
      await connection.agent.request(methods.agent.authenticate, {
        methodId: ANTIGRAVITY_AUTH_METHOD,
      });
      if (this.#flow !== current) return undefined;
      // 照 T3 的 verifying：开一个一次性会话确认账号能用，顺便读模型列表。
      const created = await connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      current.sessionId = created.sessionId;
      return antigravityModelsFromSetup(created);
    })();
    run.then(
      (models) => void this.#finish(current, models),
      (error: unknown) => void this.#fail(current, error),
    );
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      urlArrived,
      run.catch(() => {}),
      new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, this.#options.loginUrlWaitMs ?? LOGIN_URL_WAIT_MS);
      }),
    ]);
    clearTimeout(waitTimer);
    return this.#state;
  }

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    this.#check(kind);
    const flow = this.#flow;
    if (flow === undefined || (loginId !== undefined && flow.loginId !== loginId)) {
      return this.#state;
    }
    await this.#endFlow();
    return this.#update();
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    this.#stopping = true;
    try {
      await this.#endFlow();
      // 先停掉用着旧凭据的会话进程，再让运行体清掉登录（T3：stopSessions 之后再 logout）。
      await this.#options.onSignedOut?.();
      const tokenPath = antigravityTokenPath(this.#context.paths.profile);
      if (await exists(tokenPath)) {
        try {
          await this.#nativeLogout();
        } catch (error) {
          // 运行体登出失败（没装、起不来）：删掉 Wevir 数据目录里这份登录，保证登出生效。
          this.#context.logger.warn('Antigravity 原生登出失败，直接删除 profile 里的登录', {
            error: error instanceof Error ? error.message : String(error),
          });
          await fsp.rm(tokenPath, { force: true });
        }
      }
      this.#models = undefined;
      await clearModels(this.#context.paths.models);
      this.#authRejected = false;
      this.#lastError = undefined;
    } finally {
      this.#stopping = false;
    }
    return this.#update();
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    this.#models ??= await loadModels(this.#context.paths.models);
    return this.#models ?? { models: [] };
  }

  async setExecutablePath(kind: AccountKind, executablePath: string | null): Promise<AccountState> {
    this.#check(kind);
    this.#customPath = executablePath?.trim() || null;
    return this.read(kind);
  }

  async install(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    const { installation } = this.#context;
    if (this.#installing !== undefined || installation.installing) return this.#state;
    const asset = installation.releaseAsset;
    if (asset === null) {
      throw new AdapterError(
        'invalid_input',
        `Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}. Set a custom executable path.`,
      );
    }
    this.#installing = { phase: 'downloading', completedBytes: 0, totalBytes: asset.archiveBytes };
    this.#lastError = undefined;
    // 先发布“开始安装”再开始下载：下载很快就失败或完成时，那个状态排在它后面（#stateSeq）。
    const started = await this.#update();
    installation
      .install((progress) => {
        if (this.#installing === undefined) return;
        this.#installing = progress;
        void this.#publish();
      })
      .then(
        () => {
          this.#installing = undefined;
          return this.#publish();
        },
        (error: unknown) => {
          this.#installing = undefined;
          if (!(error instanceof AntigravityInstallCancelled)) {
            this.#lastError =
              error instanceof AntigravityInstallationError
                ? error.message
                : 'Could not install Antigravity.';
            this.#context.logger.warn('Antigravity 安装失败', {
              error: error instanceof Error ? error.message : String(error),
              cause: describeCause(error),
            });
          }
          return this.#publish();
        },
      )
      .catch(() => {});
    return started;
  }

  /** 取消进行中的下载安装（协议里没有这个方法；dispose 时用，也给测试）。没下完的部分留着，下次接着下。 */
  cancelInstall(): void {
    this.#context.installation.cancel();
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 会话报了要登录（登录过期、被撤销）：改为未登录，直到重新登录。 */
  markSignInRequired(): void {
    if (this.#authRejected) return;
    this.#authRejected = true;
    this.#lastError = SIGN_IN_EXPIRED;
    void this.#publish();
  }

  /** 会话的 `configOptions` 带来的模型列表（建会话、恢复时）：有变化就存下。 */
  noteSessionModels(configOptions: unknown): void {
    const models = antigravityModelsFromSetup({ configOptions });
    if (models === undefined || models.models.length === 0) return;
    if (JSON.stringify(models) === JSON.stringify(this.#models)) return;
    this.#models = models;
    void saveModels(this.#context.paths.models, models).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.cancelInstall();
    await this.#endFlow();
    this.#listeners.clear();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────────────────

  /** 不启动运行体的状态：运行体在不在（安装字段）、登录文件在不在、进行中的安装。 */
  async #snapshot(): Promise<AccountState> {
    const { fields, error } = await this.#installFields();
    if (this.#flow !== undefined) return this.#signingIn(this.#flow, fields);
    const signedIn =
      fields.installed === true &&
      !this.#authRejected &&
      (await exists(antigravityTokenPath(this.#context.paths.profile)));
    const lastError = this.#lastError ?? (fields.installing === undefined ? error : undefined);
    return {
      ...BASE,
      ...fields,
      ...(signedIn ? { status: 'signed_in' as const } : {}),
      ...(!signedIn && lastError !== undefined && { lastError }),
    };
  }

  /** 安装字段；找不到运行体且不只是“没装”（指定的路径不对、记录坏了、本平台没有发布）时另给原因。 */
  async #installFields(): Promise<{ fields: Partial<AccountState>; error?: string }> {
    const { installation } = this.#context;
    const asset = installation.releaseAsset;
    const installing =
      this.#installing === undefined
        ? {}
        : {
            installing: {
              completedBytes: this.#installing.completedBytes,
              totalBytes: this.#installing.totalBytes,
            },
          };
    const custom = this.#customPath === null ? {} : { customPath: this.#customPath };
    let executable: AntigravityExecutable;
    try {
      executable = await installation.resolve(this.#customPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const fields: Partial<AccountState> = {
        installed: false,
        ...(asset !== null && { canInstall: true }),
        ...custom,
        ...installing,
      };
      return this.#customPath !== null || asset === null || !/not installed/u.test(detail)
        ? { fields, error: detail }
        : { fields };
    }
    return {
      fields: {
        installed: true,
        ...(executable.version !== null && { version: executable.version }),
        executablePath: executable.executablePath,
        ...custom,
        ...installing,
      },
    };
  }

  async #resolve(): Promise<AntigravityExecutable | undefined> {
    try {
      return await this.#context.installation.resolve(this.#customPath);
    } catch {
      return undefined;
    }
  }

  #signingIn(flow: LoginFlow, fields: Partial<AccountState>): AccountState {
    return {
      ...BASE,
      ...fields,
      status: 'signing_in',
      login: {
        loginId: flow.loginId,
        method: 'browser',
        ...(flow.authUrl !== undefined && { authUrl: flow.authUrl }),
        startedAt: flow.startedAt,
      },
    };
  }

  #onUrl(flow: LoginFlow, url: AntigravityAuthorizationUrl): void {
    if (this.#flow !== flow) return;
    if (flow.authUrl !== undefined) {
      if (flow.authUrl !== url.authorizationUrl) {
        void this.#fail(
          flow,
          new Error('Antigravity started more than one Google sign-in request.'),
        );
      }
      return;
    }
    flow.authUrl = url.authorizationUrl;
    flow.gotUrl();
    this.#set({
      ...this.#state,
      ...(this.#state.login !== undefined && {
        login: { ...this.#state.login, authUrl: url.authorizationUrl },
      }),
    });
  }

  async #finish(flow: LoginFlow, models: AccountModels | undefined): Promise<void> {
    if (this.#flow !== flow) return;
    await this.#endFlow();
    if (models !== undefined && models.models.length > 0) {
      this.#models = models;
      await saveModels(this.#context.paths.models, models).catch(() => {});
    }
    this.#authRejected = false;
    this.#lastError = undefined;
    await this.#publish();
  }

  async #fail(flow: LoginFlow, error: unknown, message?: string): Promise<void> {
    if (this.#flow !== flow) return;
    await this.#endFlow();
    this.#lastError = message ?? loginFailure(error);
    this.#context.logger.warn('Antigravity 登录失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    await this.#publish();
  }

  /** 结束进行中的登录：停掉登录进程，删掉它的临时目录与一次性会话的文件。 */
  async #endFlow(): Promise<void> {
    const flow = this.#flow;
    if (flow === undefined) return;
    this.#flow = undefined;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    flow.gotUrl();
    await flow.process.dispose();
    await flow.launcher.cleanup();
    await removeAntigravitySessionFiles({
      profileDirectory: this.#context.paths.profile,
      sessionId: flow.sessionId,
      cwd: flow.cwd,
    });
    await fsp.rm(flow.cwd, { recursive: true, force: true }).catch(() => {});
  }

  /** 显式刷新（account.get 的 refresh，T3 的 refreshModels）：启动运行体确认登录还有效，并读模型列表。 */
  async #refresh(): Promise<void> {
    const cwd = await fsp.mkdtemp(path.join(this.#context.paths.root, '.setup-'));
    let signInRequired = false;
    const { process, launcher } = createAntigravityProcess({
      context: this.#context,
      authenticate: 'none',
      onAuthorizationUrl: () => {
        signInRequired = true;
        void process.dispose();
      },
    });
    let sessionId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        await process.start();
        await process.connection.agent.request(methods.agent.authenticate, {
          methodId: ANTIGRAVITY_AUTH_METHOD,
        });
        const created = await process.connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        sessionId = created.sessionId;
        return antigravityModelsFromSetup(created);
      })();
      const models = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Antigravity refresh timed out.')),
            REFRESH_TIMEOUT_MS,
          );
        }),
      ]);
      if (models !== undefined && models.models.length > 0) {
        this.#models = models;
        await saveModels(this.#context.paths.models, models).catch(() => {});
      }
      this.#authRejected = false;
      this.#lastError = undefined;
    } catch (error) {
      if (signInRequired || (error as { code?: unknown } | null)?.code === -32000) {
        this.#authRejected = true;
        this.#lastError = SIGN_IN_EXPIRED;
        return;
      }
      throw new AdapterError(
        'engine_unavailable',
        `Could not refresh Antigravity: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      await process.dispose();
      await launcher.cleanup();
      await removeAntigravitySessionFiles({
        profileDirectory: this.#context.paths.profile,
        sessionId,
        cwd,
      });
      await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 让运行体清掉它的登录（ACP `logout`，要 `agentCapabilities.auth.logout`）。 */
  async #nativeLogout(): Promise<void> {
    const { process, launcher } = createAntigravityProcess({
      context: this.#context,
      authenticate: 'none',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const initialized = await process.start();
          const auth = (
            initialized.agentCapabilities as { auth?: { logout?: unknown } } | undefined
          )?.auth;
          if (!auth?.logout) {
            throw new Error('This Antigravity version does not support sign-out.');
          }
          await process.connection.agent.request(methods.agent.logout, {});
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Antigravity sign-out timed out.')),
            LOGOUT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await process.dispose();
      await launcher.cleanup();
    }
  }

  async #publish(): Promise<void> {
    if (this.#disposed) return;
    await this.#update();
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'Antigravity accounts are disposed');
    if (kind !== KIND) {
      throw new AdapterError('invalid_input', `Antigravity does not handle ${kind} accounts`);
    }
  }

  /** 取快照并发布（按开始的先后，见 #stateSeq）。 */
  async #update(): Promise<AccountState> {
    const seq = ++this.#stateSeq;
    const state = await this.#snapshot();
    return this.#set(state, seq);
  }

  /** `seq` 是这个状态开始计算时取的号；直接给出的状态取新号。比已采用的旧时不发布，返回现有状态。 */
  #set(state: AccountState, seq: number = ++this.#stateSeq): AccountState {
    if (seq < this.#appliedSeq) return this.#state;
    this.#appliedSeq = seq;
    const changed = JSON.stringify(state) !== JSON.stringify(this.#state);
    this.#state = state;
    if (changed && !this.#disposed) {
      for (const listener of [...this.#listeners]) {
        try {
          listener(state);
        } catch {
          // 监听器里的错误不影响别的监听器。
        }
      }
    }
    return state;
  }
}

/** 登录失败给人看的说法（照 T3 的 safeAuthFailure，不带引擎原文；原文进日志）。 */
function loginFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (message.includes('SUBSCRIPTION_REQUIRED')) {
    return 'Google requires an eligible Antigravity subscription for this account.';
  }
  if (/access_denied|denied access|cancelled/iu.test(message)) {
    return 'Google sign-in was not approved. Start sign-in again.';
  }
  if (code === -32603 && /session\/new/u.test(message)) {
    return 'Antigravity authenticated, but could not initialize a session or load models.';
  }
  if (/more than one Google sign-in/u.test(message)) return message;
  if (/启动失败|spawn|ENOENT|EACCES/u.test(message)) {
    return `Antigravity could not start: ${message}`;
  }
  return 'Google sign-in failed. Start sign-in again.';
}

function describeCause(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
}

async function exists(filePath: string): Promise<boolean> {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}
