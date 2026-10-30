import {
  type AccountLoginMethod,
  type AccountModels,
  type AccountRateLimitWindow,
  type AccountState,
  AdapterError,
  isAdapterError,
  type ProviderModelConfig,
} from '@wevir/runtime-adapter';
import { fromCodexEffort } from './config.js';
import type {
  AccountLoginCompletedNotification,
  AccountRateLimitsUpdatedNotification,
  AccountUpdatedNotification,
  CancelLoginAccountParams,
  CancelLoginAccountResponse,
  CodexModel,
  GetAccountParams,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  LoginAccountParams,
  LoginAccountResponse,
  ModelListParams,
  ModelListResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from './protocol.js';

// ChatGPT 账号（R6，ADR-0005 决策 4 第 ① 行，docs/architecture/codex-event-mapping.md §8）：ChatGPT 进程的
// `account/*` 与 `model/list` → Wevir 的 `AccountState`。凭据由 Codex 自己存在 ChatGPT 进程的 CODEX_HOME
// （`cli_auth_credentials_store = "file"`，`auth.json`），这里只经 app-server 读状态，不碰文件、不拿令牌。

/** 发请求的那一端（CodexProcess；测试用假的）。 */
export interface AccountRpc {
  request<T>(method: string, params: unknown): Promise<T>;
}

export interface ChatgptAccountOptions {
  /** 拿到能发请求的进程（ChatGPT 进程没起来时先启动它）。 */
  rpc: () => Promise<AccountRpc>;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  /** 测试用。 */
  now?: () => Date;
}

/** Wevir 的推理档位（protocol `ProviderReasoningLevel`）；Codex 多出来的（如 `ultra`）不列。 */
const WEVIR_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 主额度的 `limitId`；其余的是某些模型单独的额度（Codex 的 `additional_rate_limits`）。 */
const MAIN_LIMIT = 'codex';

/** 一份额度：主窗口与次窗口，模型单独的额度带名字。 */
export interface CodexRateLimit {
  name?: string;
  primary?: AccountRateLimitWindow;
  secondary?: AccountRateLimitWindow;
}

/** 账号本身（不含进行中的登录）。 */
interface Base {
  signedIn: boolean;
  email?: string;
  plan?: string;
  /** 按 `limitId` 记的额度；主额度是 `codex`。 */
  limits?: Record<string, CodexRateLimit>;
  lastError?: string;
}

/**
 * 一个 ChatGPT 进程的账号状态：缓存最近读到的账号与进行中的登录，按 app-server 的通知更新，有变化时通知监听器。
 *
 * - 登录（`account/login/start`）：浏览器方式给 `authUrl`（回调在本机 `127.0.0.1:1455`，由 app-server 监听），设备码
 *   方式给 `verificationUrl` 与 `userCode`。新的登录替换旧的；被替换、被取消的登录随后的失败通知不算错误。
 * - 完成（`account/login/completed`）：成功就重读账号（邮箱、套餐、用量），失败把原文记进 `lastError`。
 * - `account/updated`：登出（`authMode: null`）或账号变了，重读。`account/rateLimits/updated` 是稀疏的用量更新。
 * - 进程退出时进行中的登录随之结束（app-server 的登录任务在进程里）。
 */
export class ChatgptAccount {
  readonly #options: ChatgptAccountOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #base: Base | undefined;
  #login: AccountState['login'];
  /** 被替换或取消的登录：它们的失败通知不记错误。 */
  readonly #abandoned = new Set<string>();
  /**
   * 每个额度上一条 `account/rateLimits/updated` 带的窗口。Codex 每次报 token 用量都重发会话里缓存的额度，可能早于随后
   * 重读到的用量（额度已经重置）；与上一条相同的窗口不是新消息，不覆盖。
   */
  readonly #notified = new Map<string, Pick<CodexRateLimit, 'primary' | 'secondary'>>();
  #published = '';

  constructor(options: ChatgptAccountOptions) {
    this.#options = options;
  }

  /** 当前状态（没读过账号时按未登录）。 */
  get state(): AccountState {
    const base = this.#base ?? { signedIn: false };
    const state: AccountState = {
      kind: 'chatgpt',
      status: this.#login !== undefined ? 'signing_in' : base.signedIn ? 'signed_in' : 'signed_out',
    };
    if (base.signedIn) {
      if (base.email !== undefined) state.email = base.email;
      if (base.plan !== undefined) state.plan = base.plan;
      const rateLimits = base.limits && codexRateLimits(base.limits);
      if (rateLimits !== undefined && this.#login === undefined) state.rateLimits = rateLimits;
    }
    if (this.#login !== undefined) state.login = { ...this.#login };
    else if (base.lastError !== undefined) state.lastError = base.lastError;
    return state;
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** `account/read`，已登录时再读用量（读不到就不带）。 */
  async read(): Promise<AccountState> {
    const rpc = await this.#options.rpc();
    let response: GetAccountResponse;
    try {
      response = await rpc.request<GetAccountResponse>('account/read', {
        refreshToken: false,
      } satisfies GetAccountParams);
    } catch (error) {
      // 已登录时 app-server 读账号要联网（工作区路由），连不上时用缓存的状态。
      if (this.#base !== undefined) {
        this.#options.warn('读 ChatGPT 账号失败，用上次的状态', { error: errorText(error) });
        return this.state;
      }
      throw rpcError(error, 'account/read');
    }
    const account = response.account;
    if (account?.type === 'chatgpt') {
      const base: Base = { signedIn: true };
      const email = nonEmpty((account as { email?: unknown }).email);
      const plan = nonEmpty((account as { planType?: unknown }).planType);
      if (email !== undefined) base.email = email;
      if (plan !== undefined) base.plan = plan;
      const limits = await this.#readRateLimits(rpc);
      if (limits !== undefined) base.limits = limits;
      this.#base = base;
    } else {
      this.#base = {
        signedIn: false,
        ...(this.#base?.lastError !== undefined && { lastError: this.#base.lastError }),
      };
    }
    return this.#publish();
  }

  /** 没读过就读一次；不是已登录时抛 `missing_credentials`（会话用这个账号之前检查，ChatGPT 会话不发未登录的请求）。 */
  async assertSignedIn(): Promise<void> {
    if (this.#base === undefined) await this.read();
    if (this.#base?.signedIn !== true) {
      throw new AdapterError(
        'missing_credentials',
        '没有登录 ChatGPT：先在设置里登录 ChatGPT 账号，或用 wevir provider login',
      );
    }
  }

  async login(method: AccountLoginMethod): Promise<AccountState> {
    const rpc = await this.#options.rpc();
    // 新的登录替换旧的：旧的随后以失败结束，不记错误。
    if (this.#login !== undefined) this.#abandoned.add(this.#login.loginId);
    const params: LoginAccountParams =
      method === 'browser' ? { type: 'chatgpt' } : { type: 'chatgptDeviceCode' };
    let response: LoginAccountResponse;
    try {
      response = await rpc.request<LoginAccountResponse>('account/login/start', params);
    } catch (error) {
      throw rpcError(error, 'account/login/start');
    }
    const fields = response as Record<string, unknown>;
    const loginId = nonEmpty(fields.loginId);
    if (loginId === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        `account/login/start 的结果不认识：${response.type}`,
      );
    }
    const login: NonNullable<AccountState['login']> = {
      loginId,
      method,
      startedAt: (this.#options.now?.() ?? new Date()).toISOString(),
    };
    const authUrl = nonEmpty(fields.authUrl);
    const verificationUrl = nonEmpty(fields.verificationUrl);
    const userCode = nonEmpty(fields.userCode);
    if (authUrl !== undefined) login.authUrl = authUrl;
    if (verificationUrl !== undefined) login.verificationUrl = verificationUrl;
    if (userCode !== undefined) login.userCode = userCode;
    this.#login = login;
    if (this.#base !== undefined) delete this.#base.lastError;
    return this.#publish();
  }

  async cancelLogin(loginId?: string): Promise<AccountState> {
    const current = this.#login;
    if (current === undefined || (loginId !== undefined && loginId !== current.loginId)) {
      return this.state;
    }
    this.#abandoned.add(current.loginId);
    this.#login = undefined;
    const state = this.#publish();
    try {
      const rpc = await this.#options.rpc();
      await rpc.request<CancelLoginAccountResponse>('account/login/cancel', {
        loginId: current.loginId,
      } satisfies CancelLoginAccountParams);
    } catch (error) {
      // 进程没了的话登录也没了；其余情况登录会在 app-server 里超时结束。
      this.#options.warn('取消 ChatGPT 登录失败', { error: errorText(error) });
    }
    return state;
  }

  async logout(): Promise<AccountState> {
    const rpc = await this.#options.rpc();
    if (this.#login !== undefined) this.#abandoned.add(this.#login.loginId);
    try {
      await rpc.request('account/logout', undefined);
    } catch (error) {
      throw rpcError(error, 'account/logout');
    }
    this.#login = undefined;
    this.#base = { signedIn: false };
    this.#notified.clear();
    return this.#publish();
  }

  /** `model/list`（按 `nextCursor` 翻完）→ Wevir 的模型列表。 */
  async models(): Promise<AccountModels> {
    const rpc = await this.#options.rpc();
    const data: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      let response: ModelListResponse;
      try {
        response = await rpc.request<ModelListResponse>('model/list', {
          ...(cursor !== null && { cursor }),
        } satisfies ModelListParams);
      } catch (error) {
        throw rpcError(error, 'model/list');
      }
      data.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
      if (cursor === null) break;
    }
    return accountModels(data);
  }

  // ── 通知 ───────────────────────────────────────────────────────────────────────────

  /** 不属于 thread 的通知里账号相关的几种；处理了返回 true。 */
  onNotification(method: string, params: unknown): boolean {
    switch (method) {
      case 'account/login/completed':
        this.#onLoginCompleted(params as AccountLoginCompletedNotification);
        return true;
      case 'account/updated':
        this.#onAccountUpdated(params as AccountUpdatedNotification);
        return true;
      case 'account/rateLimits/updated':
        this.#onRateLimits(params as AccountRateLimitsUpdatedNotification);
        return true;
      default:
        return false;
    }
  }

  /** 进程退出：进行中的登录随之结束；账号状态等下次读。 */
  onExit(): void {
    // 新进程的缓存从它自己的第一条通知算起。
    this.#notified.clear();
    if (this.#login === undefined) return;
    this.#abandoned.add(this.#login.loginId);
    this.#login = undefined;
    this.#base = {
      ...(this.#base ?? { signedIn: false }),
      lastError: 'codex-app-server 退出了，登录没有完成',
    };
    this.#publish();
  }

  #onLoginCompleted(params: AccountLoginCompletedNotification): void {
    const loginId = typeof params?.loginId === 'string' ? params.loginId : undefined;
    const abandoned = loginId !== undefined && this.#abandoned.delete(loginId);
    if (abandoned && params.success !== true) return;
    if (loginId === undefined || this.#login?.loginId === loginId) this.#login = undefined;
    if (params.success === true) {
      this.#base = { ...this.#base, signedIn: true };
      delete this.#base.lastError;
      this.#publish();
      this.#reread();
      return;
    }
    this.#base = {
      ...(this.#base ?? { signedIn: false }),
      lastError: nonEmpty(params.error) ?? '登录没有成功',
    };
    this.#publish();
  }

  #onAccountUpdated(params: AccountUpdatedNotification): void {
    if (params?.authMode === null || params?.authMode === undefined) {
      if (this.#base?.signedIn !== true) return;
      this.#base = { signedIn: false };
      this.#notified.clear();
      this.#publish();
      return;
    }
    const plan = nonEmpty(params.planType);
    this.#base = { ...this.#base, signedIn: true, ...(plan !== undefined && { plan }) };
    this.#publish();
    this.#reread();
  }

  /** 稀疏更新：只换带来的窗口，记到它的 `limitId` 下（没有时是主额度），别的额度不动。 */
  #onRateLimits(params: AccountRateLimitsUpdatedNotification): void {
    if (this.#base?.signedIn !== true) return;
    const update = params?.rateLimits;
    if (update === undefined || update === null) return;
    const id = nonEmpty(update.limitId) ?? MAIN_LIMIT;
    const limit: CodexRateLimit = { ...this.#base.limits?.[id] };
    const name = nonEmpty(update.limitName);
    const primary = rateLimitWindow(update.primary);
    const secondary = rateLimitWindow(update.secondary);
    const previous = this.#notified.get(id);
    this.#notified.set(id, {
      ...(primary !== undefined && { primary }),
      ...(secondary !== undefined && { secondary }),
    });
    const fresh = (window: AccountRateLimitWindow | undefined, last?: AccountRateLimitWindow) =>
      window !== undefined && !sameWindow(window, last);
    const changed = fresh(primary, previous?.primary) || fresh(secondary, previous?.secondary);
    if (name !== undefined) limit.name = name;
    if (fresh(primary, previous?.primary)) limit.primary = primary;
    if (fresh(secondary, previous?.secondary)) limit.secondary = secondary;
    if (!changed || (limit.primary === undefined && limit.secondary === undefined)) return;
    this.#base.limits = { ...this.#base.limits, [id]: limit };
    this.#publish();
  }

  /** 只重读用量（Host 定时刷新）；没登录、正在登录或读不到时什么都不做。 */
  async refreshUsage(): Promise<void> {
    if (this.#base?.signedIn !== true || this.#login !== undefined) return;
    const rpc = await this.#options.rpc().catch(() => undefined);
    if (rpc === undefined) return;
    const limits = await this.#readRateLimits(rpc);
    if (limits === undefined || this.#base?.signedIn !== true) return;
    this.#base = { ...this.#base, limits };
    this.#publish();
  }

  #reread(): void {
    this.read().catch((error: unknown) =>
      this.#options.warn('登录后读 ChatGPT 账号失败', { error: errorText(error) }),
    );
  }

  /** 全部额度（`rateLimitsByLimitId`，旧版本只有 `rateLimits`）；读不到时是上一次的。 */
  async #readRateLimits(rpc: AccountRpc): Promise<Base['limits']> {
    try {
      const response = await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read', {
        excludeResetCreditDetails: true,
      });
      const snapshots: [string, RateLimitSnapshot | null | undefined][] = Object.entries(
        response.rateLimitsByLimitId ?? {},
      );
      if (!snapshots.some(([id]) => id === MAIN_LIMIT)) {
        snapshots.unshift([
          nonEmpty(response.rateLimits?.limitId) ?? MAIN_LIMIT,
          response.rateLimits,
        ]);
      }
      const limits: Record<string, CodexRateLimit> = {};
      for (const [id, snapshot] of snapshots) {
        const primary = rateLimitWindow(snapshot?.primary);
        const secondary = rateLimitWindow(snapshot?.secondary);
        if (primary === undefined && secondary === undefined) continue;
        const name = nonEmpty(snapshot?.limitName);
        limits[id] = {
          ...(name !== undefined && { name }),
          ...(primary !== undefined && { primary }),
          ...(secondary !== undefined && { secondary }),
        };
      }
      return Object.keys(limits).length === 0 ? undefined : limits;
    } catch {
      // 用量只是附带的，读不到不影响账号状态。
      return this.#base?.limits;
    }
  }

  /** 状态有变化时通知监听器；返回当前状态。 */
  #publish(): AccountState {
    const state = this.state;
    const text = JSON.stringify(state);
    if (text !== this.#published) {
      this.#published = text;
      for (const listener of [...this.#listeners]) {
        try {
          listener(this.state);
        } catch (error) {
          this.#options.warn('账号状态的监听器出错', { error: errorText(error) });
        }
      }
    }
    return state;
  }
}

/** `model/list` 的结果 → Wevir 的模型（只留 Wevir 认得的推理档位），默认模型取 `isDefault` 的那个。 */
export function accountModels(data: readonly CodexModel[]): AccountModels {
  const models: ProviderModelConfig[] = [];
  let defaultModelId: string | undefined;
  const seen = new Set<string>();
  for (const model of data) {
    const id = nonEmpty(model?.model) ?? nonEmpty(model?.id);
    if (id === undefined || model.hidden === true || seen.has(id)) continue;
    seen.add(id);
    const entry: ProviderModelConfig = { id };
    const displayName = nonEmpty(model.displayName);
    if (displayName !== undefined) entry.displayName = displayName;
    if (Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) {
      entry.supportsImages = true;
    }
    if (Array.isArray(model.supportedReasoningEfforts)) {
      entry.reasoningEfforts = model.supportedReasoningEfforts
        .map((option) => fromCodexEffort(String(option?.reasoningEffort)))
        .filter((effort) => WEVIR_EFFORTS.has(effort));
    }
    models.push(entry);
    if (model.isDefault === true && defaultModelId === undefined) defaultModelId = id;
  }
  defaultModelId ??= models[0]?.id;
  return { models, ...(defaultModelId !== undefined && { defaultModelId }) };
}

/**
 * 额度 → 账号的 `rateLimits`：主额度的两个窗口是 `primary` / `secondary`；有模型单独的额度时 `windows` 先列主额度的，再列它们的
 * （`scope` 是额度名，如“GPT-5.3-Codex-Spark · 5 小时用量”）。只有主额度时不带 `windows`（与 0.45.0 之前一样）。
 */
export function codexRateLimits(
  limits: Record<string, CodexRateLimit>,
): AccountState['rateLimits'] {
  const main = limits[MAIN_LIMIT];
  const extra = Object.entries(limits)
    .filter(([id]) => id !== MAIN_LIMIT)
    .sort(([a], [b]) => a.localeCompare(b));
  const windows: AccountRateLimitWindow[] = [];
  if (main?.primary !== undefined) windows.push(main.primary);
  if (main?.secondary !== undefined) windows.push(main.secondary);
  for (const [id, limit] of extra) {
    const scope = limit.name ?? id;
    if (limit.primary !== undefined) windows.push({ ...limit.primary, scope });
    if (limit.secondary !== undefined) windows.push({ ...limit.secondary, scope });
  }
  if (windows.length === 0) return undefined;
  const primary = main?.primary ?? windows[0];
  const secondary = main === undefined ? windows[1] : main.secondary;
  return {
    ...(primary !== undefined && { primary }),
    ...(secondary !== undefined && { secondary }),
    ...(extra.length > 0 && { windows }),
  };
}

function rateLimitWindow(
  window: RateLimitWindow | null | undefined,
): AccountRateLimitWindow | undefined {
  if (window === null || window === undefined || typeof window.usedPercent !== 'number') {
    return undefined;
  }
  const result: AccountRateLimitWindow = { usedPercent: Math.max(0, window.usedPercent) };
  if (typeof window.windowDurationMins === 'number' && window.windowDurationMins >= 1) {
    result.windowMinutes = Math.round(window.windowDurationMins);
  }
  if (typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)) {
    result.resetsAt = new Date(window.resetsAt * 1000).toISOString();
  }
  return result;
}

function sameWindow(a: AccountRateLimitWindow, b: AccountRateLimitWindow | undefined): boolean {
  return (
    b !== undefined &&
    a.usedPercent === b.usedPercent &&
    a.windowMinutes === b.windowMinutes &&
    a.resetsAt === b.resetsAt
  );
}

function rpcError(error: unknown, method: string): AdapterError {
  if (isAdapterError(error)) return error;
  return new AdapterError('engine_unavailable', `${method} 失败：${errorText(error)}`, {
    cause: error,
  });
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
