// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/auth.ts（makeCursorAuth）、CursorSdkCatalog.ts、status.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成普通 TS 的 EngineAccounts：登录先写内存、确认后才落盘，5 分钟超时，取消，替换进行中的登录，登出清掉凭据并停掉用着它的会话，
// 模型列表缓存 30 分钟，15 s 超时；状态报成 Wevir 的 AccountState。用量不读 Cursor CLI 的登录，用这把 API Key 读（usage.ts）。
//
// Cursor 的账号（订阅来源 `cursor`，domain-model §3.6，docs/architecture/cursor-event-mapping.md §2）：在应用里登录。
// `Cursor.auth.login` 给出浏览器网址，用户在浏览器里登录后 SDK 铸一把有期限的 API Key（90 天，Cursor 后台的 API Keys 里看得到、
// 能吊销），存进 Wevir 的数据目录（credentials.ts）。环境变量 `CURSOR_API_KEY` 优先，这时不能在应用里登录或登出。账号的
// 邮箱与模型来自 `Cursor.me` 与 `Cursor.models.list`，本计费周期的用量来自 `DashboardService/GetCurrentPeriodUsage`（与读账号
// 同时读、同样缓存 5 分钟；读不到时留着上一次的）。

import { randomUUID } from 'node:crypto';
import type { SDKModel, SDKUser } from '@cursor/sdk';
import {
  type AccountKind,
  type AccountLoginMethod,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { CursorCredentialFile, MemoryCredentials } from './credentials.js';
import { errorMessage, isAuthenticationFailure } from './errors.js';
import { accountModels } from './models.js';
import type { CursorSdk } from './sdk.js';
import { DEFAULT_CURSOR_BACKEND_URL, readCursorUsage } from './usage.js';

/** 一次登录最长等多久（T3 的 AUTH_TIMEOUT_MS）。 */
export const LOGIN_TIMEOUT_MS = 300_000;
/** 读账号与模型列表的时限（T3 的 CURSOR_SDK_CATALOG_TIMEOUT_MS）。 */
export const CATALOG_TIMEOUT_MS = 15_000;
/** 模型列表的缓存（T3：非空列表 30 分钟）。 */
export const MODELS_TTL_MS = 30 * 60_000;
/** 不带 refresh 的 `read` 复用上一次读到的账号多久。 */
export const ACCOUNT_TTL_MS = 5 * 60_000;
/** 等 SDK 给出登录网址的时限。 */
const LOGIN_URL_TIMEOUT_MS = 15_000;
/** 铸出的 API Key 在 Cursor 后台显示的名字。 */
export const API_KEY_NAME = 'Wevir';

const KIND = 'cursor' as const;
const BASE: AccountState = {
  kind: KIND,
  status: 'signed_out',
  signIn: 'in_app',
  loginMethods: ['browser'],
};

export interface CursorAccountsOptions {
  /** 加载 SDK（测试换成假的）。 */
  sdk: () => Promise<CursorSdk>;
  /** 存铸出的 API Key 的文件。 */
  credentialsPath: string;
  /** `CURSOR_API_KEY` 等环境变量；省略时当作空。 */
  env?: NodeJS.ProcessEnv;
  /** 读到的 API Key 交给 Host 日志的抹除表（`Logger.addSecret`）。 */
  addSecret?: (value: string) => void;
  /** 登出或凭据被拒：用着旧 Key 的会话要停下（cursor-adapter.ts）。 */
  onSignedOut?: () => void;
  /** 读用量的 fetch（测试换成假的）；省略时用全局的。 */
  fetch?: typeof fetch;
  now?: () => number;
  loginTimeoutMs?: number;
}

interface LoginFlow {
  readonly loginId: string;
  readonly controller: AbortController;
  readonly startedAt: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface Catalog {
  readonly apiKey: string;
  readonly user: SDKUser;
  readonly at: number;
}

export class CursorAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = [KIND];
  readonly #options: CursorAccountsOptions;
  readonly #store: CursorCredentialFile;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #state: AccountState = BASE;
  #flow: LoginFlow | undefined;
  /** 登出进行中：这期间不能登录、不能开会话（T3 的 operation === 'stopping'）。 */
  #stopping = false;
  #catalog: Catalog | undefined;
  #models: { apiKey: string; models: SDKModel[]; at: number } | undefined;
  #disposed = false;

  constructor(options: CursorAccountsOptions) {
    this.#options = options;
    this.#store = new CursorCredentialFile(options.credentialsPath);
  }

  /** `CURSOR_API_KEY` 设了：它优先，应用里不能登录、登出（T3 的 usesApiKey）。 */
  get usesEnvironmentKey(): boolean {
    return this.#envKey() !== undefined;
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    if (this.#flow !== undefined) return this.#state;
    const credential = await this.#credential();
    if (credential === undefined) {
      this.#catalog = undefined;
      return this.#set({ ...BASE, ...lastError(this.#state) });
    }
    const { apiKey } = credential;
    const cached = this.#catalog;
    if (
      options?.refresh !== true &&
      cached?.apiKey === apiKey &&
      this.#now() - cached.at < ACCOUNT_TTL_MS &&
      this.#state.status === 'signed_in'
    ) {
      return this.#state;
    }
    // 用量与账号同时读；读不到用量不影响登录状态。
    const usage = this.#readUsage(credential);
    let user: SDKUser;
    try {
      const sdk = await this.#options.sdk();
      user = await withTimeout(sdk.me(apiKey), CATALOG_TIMEOUT_MS, 'Cursor account request');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        this.#catalog = undefined;
        return this.#set({
          ...BASE,
          lastError: this.usesEnvironmentKey
            ? 'Cursor rejected CURSOR_API_KEY. Check the key.'
            : 'Cursor sign-in expired or was rejected. Sign in again.',
        });
      }
      // 网络等其他失败：有上一次的结果就沿用，没有就报错（Host 的 account.list 把它显示成未登录带原因）。
      if (cached?.apiKey === apiKey && this.#state.status === 'signed_in') return this.#state;
      throw new AdapterError(
        'engine_unavailable',
        `Cursor account request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const previous =
      cached?.apiKey === apiKey && this.#state.status === 'signed_in'
        ? this.#state.rateLimits
        : undefined;
    this.#catalog = { apiKey, user, at: this.#now() };
    const email = user.userEmail?.trim();
    const read = await usage;
    const rateLimits = read.ok ? read.rateLimits : previous;
    return this.#set({
      ...BASE,
      status: 'signed_in',
      ...(email && { email }),
      ...(rateLimits !== undefined && { rateLimits }),
    });
  }

  async login(kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    this.#check(kind);
    if (method !== 'browser') {
      throw new AdapterError('invalid_input', 'Cursor signs in through the browser only');
    }
    if (this.usesEnvironmentKey) {
      throw new AdapterError(
        'invalid_input',
        'Remove CURSOR_API_KEY from the environment before signing in with Cursor in the app.',
      );
    }
    if (this.#stopping) {
      throw new AdapterError('invalid_input', 'Cursor sign-out is in progress. Try again.');
    }
    // 已有进行中的登录时替换它（EngineAccounts.login 的约定）。
    this.#endFlow();
    const sdk = await this.#loadSdk();
    const flow: LoginFlow = {
      loginId: randomUUID(),
      controller: new AbortController(),
      startedAt: new Date(this.#now()).toISOString(),
    };
    this.#flow = flow;
    // SDK 先写进内存；取消或被替换的登录不会落盘（T3：interrupting a store Promise cannot stop a late write）。
    const pending = new MemoryCredentials();
    let gotUrl: (url: string) => void = () => {};
    const url = new Promise<string>((resolve) => {
      gotUrl = resolve;
    });
    const done = sdk.login({
      openBrowser: false,
      store: pending,
      signal: flow.controller.signal,
      apiKeyName: API_KEY_NAME,
      onLoginUrl: (authUrl) => {
        if (this.#flow === flow) gotUrl(authUrl);
      },
    });
    let authUrl: string;
    try {
      authUrl = await withTimeout(
        Promise.race([
          url,
          done.then(() => {
            throw new Error('Cursor sign-in finished without a sign-in page');
          }),
        ]),
        LOGIN_URL_TIMEOUT_MS,
        'Cursor sign-in',
      );
    } catch (error) {
      done.catch(() => {});
      if (this.#flow === flow) this.#endFlow();
      throw new AdapterError(
        'engine_unavailable',
        `Cursor sign-in failed: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    if (this.#flow !== flow) {
      // 等网址的时候被取消或替换了。
      done.catch(() => {});
      return this.#state;
    }
    flow.timer = setTimeout(() => {
      if (this.#flow !== flow) return;
      this.#endFlow();
      this.#set({ ...BASE, lastError: 'Cursor sign-in expired. Start sign-in again.' });
    }, this.#options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
    flow.timer.unref?.();
    done.then(
      () => this.#finishLogin(flow, pending),
      (error: unknown) => {
        if (this.#flow !== flow) return;
        this.#endFlow();
        this.#set({ ...BASE, lastError: `Cursor sign-in failed: ${errorMessage(error)}` });
      },
    );
    return this.#set({
      ...withoutLogin(this.#state),
      status: 'signing_in',
      login: { loginId: flow.loginId, method: 'browser', authUrl, startedAt: flow.startedAt },
    });
  }

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    this.#check(kind);
    const flow = this.#flow;
    if (flow === undefined || (loginId !== undefined && flow.loginId !== loginId)) {
      return this.#state;
    }
    this.#endFlow();
    return this.#set({ ...BASE });
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    if (this.usesEnvironmentKey) {
      throw new AdapterError(
        'invalid_input',
        'Remove CURSOR_API_KEY from the environment to disconnect Cursor.',
      );
    }
    this.#stopping = true;
    try {
      this.#endFlow();
      // 先停掉用着这把 Key 的会话，再删凭据（T3：closing admission before draining sessions）。
      this.#options.onSignedOut?.();
      await this.#store.clear();
      this.#catalog = undefined;
      this.#models = undefined;
    } finally {
      this.#stopping = false;
    }
    return this.#set({ ...BASE });
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    const apiKey = await this.readApiKey();
    if (apiKey === undefined) return { models: [] };
    return accountModels(await this.catalogModels(apiKey));
  }

  /** SDK 的模型列表（非空时缓存 30 分钟），会话把推理档位换成 SDK 参数时也用它。 */
  async catalogModels(apiKey: string): Promise<SDKModel[]> {
    const cached = this.#models;
    if (cached?.apiKey === apiKey && this.#now() - cached.at < MODELS_TTL_MS) return cached.models;
    const sdk = await this.#loadSdk();
    let models: SDKModel[];
    try {
      models = await withTimeout(sdk.listModels(apiKey), CATALOG_TIMEOUT_MS, 'Cursor model list');
    } catch (error) {
      throw new AdapterError(
        isAuthenticationFailure(error) ? 'missing_credentials' : 'engine_unavailable',
        `Cursor model list failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (models.length > 0) this.#models = { apiKey, models, at: this.#now() };
    return models;
  }

  /** 上一次读到的模型列表（不联网）；没有时 undefined。 */
  cachedModels(apiKey: string): SDKModel[] | undefined {
    return this.#models?.apiKey === apiKey ? this.#models.models : undefined;
  }

  /** 现在能用的 API Key：`CURSOR_API_KEY`，否则是登录存下的、没过期的那把。 */
  async readApiKey(): Promise<string | undefined> {
    return (await this.#credential())?.apiKey;
  }

  /**
   * API Key 与它所在的后端：`CURSOR_API_KEY` 用 `CURSOR_BACKEND_URL` 或默认后端（同 SDK），登录存下的用铸它的那个后端。
   */
  async #credential(): Promise<{ apiKey: string; backendUrl: string } | undefined> {
    const envKey = this.#envKey();
    if (envKey !== undefined) {
      this.#options.addSecret?.(envKey);
      return {
        apiKey: envKey,
        backendUrl: this.#options.env?.CURSOR_BACKEND_URL?.trim() || DEFAULT_CURSOR_BACKEND_URL,
      };
    }
    const credentials = await this.#store.load();
    if (credentials === undefined) return undefined;
    if (
      credentials.apiKeyExpiresAtMs !== undefined &&
      credentials.apiKeyExpiresAtMs <= this.#now()
    ) {
      return undefined;
    }
    this.#options.addSecret?.(credentials.apiKey);
    return { apiKey: credentials.apiKey, backendUrl: credentials.backendUrl };
  }

  /** 开会话要的 API Key；没有时报 `missing_credentials`（T3 的 requireApiKey）。 */
  async requireApiKey(): Promise<string> {
    if (this.#flow !== undefined || this.#stopping) {
      throw new AdapterError(
        'missing_credentials',
        'Cursor sign-in or sign-out is in progress. Try again after it finishes.',
      );
    }
    const apiKey = await this.readApiKey();
    if (apiKey === undefined) {
      throw new AdapterError(
        'missing_credentials',
        'Sign in to Cursor in Settings, or set CURSOR_API_KEY.',
      );
    }
    return apiKey;
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#endFlow();
    this.#listeners.clear();
  }

  /** 登录完成：确认还是当前这次登录，存进文件，再用新 Key 读一次账号确认它能用（T3 的 verifying）。 */
  async #finishLogin(flow: LoginFlow, pending: MemoryCredentials): Promise<void> {
    if (this.#flow !== flow) return;
    try {
      const credentials = await pending.load();
      if (credentials === undefined) throw new Error('Cursor sign-in returned no credentials');
      if (this.#flow !== flow) return;
      this.#options.addSecret?.(credentials.apiKey);
      await this.#store.save(credentials);
    } catch (error) {
      if (this.#flow !== flow) return;
      this.#endFlow();
      this.#set({
        ...BASE,
        lastError: `Could not save the Cursor sign-in: ${errorMessage(error)}`,
      });
      return;
    }
    if (this.#flow !== flow) return;
    this.#endFlow();
    this.#catalog = undefined;
    this.#models = undefined;
    try {
      const state = await this.read(KIND, { refresh: true });
      if (state.status !== 'signed_in') await this.#store.clear();
    } catch {
      // 新 Key 已存下，只是这次读账号失败（网络）：报已登录，邮箱等下次读再补。
      this.#set({ ...BASE, status: 'signed_in' });
    }
  }

  #endFlow(): void {
    const flow = this.#flow;
    if (flow === undefined) return;
    this.#flow = undefined;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    flow.controller.abort();
  }

  #set(state: AccountState): AccountState {
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

  async #loadSdk(): Promise<CursorSdk> {
    try {
      return await this.#options.sdk();
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Cursor SDK failed to load: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  /** 读本周期的用量（usage.ts）；不抛错，失败时 `ok: false`。 */
  async #readUsage(credential: {
    apiKey: string;
    backendUrl: string;
  }): Promise<{ ok: true; rateLimits: AccountState['rateLimits'] } | { ok: false }> {
    try {
      const rateLimits = await readCursorUsage({
        ...credential,
        ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
      });
      return { ok: true, rateLimits };
    } catch {
      return { ok: false };
    }
  }

  #envKey(): string | undefined {
    const value = this.#options.env?.CURSOR_API_KEY?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  #check(kind: AccountKind): void {
    if (kind !== KIND)
      throw new AdapterError('invalid_input', `no ${kind} account in the Cursor engine`);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

function withoutLogin(state: AccountState): AccountState {
  const { login: _login, lastError: _error, ...rest } = state;
  return rest;
}

/** 上一个状态里的登录失败原因：读账号时还留着，直到下一次登录或登录成功。 */
function lastError(state: AccountState): Pick<AccountState, 'lastError'> {
  return state.status === 'signed_out' && state.lastError !== undefined
    ? { lastError: state.lastError }
    : {};
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
