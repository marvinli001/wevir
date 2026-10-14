import type { AccountKind, AccountLoginMethod, AccountState } from '@wevir/protocol';
import type { AccountModels, EngineAccounts } from '@wevir/runtime-adapter';
import type { ProviderProfileRecord, Storage } from '@wevir/storage';
import { HostError } from './errors.js';

/** ChatGPT 登录成功后 Host 自己建的 Provider（protocol `provider.upsert` 的 `chatgpt` 一支，ID 固定）。 */
export const CHATGPT_PROVIDER_ID = 'chatgpt';
export const CHATGPT_DISPLAY_NAME = 'ChatGPT';

/** 读账号时刷新 `chatgpt` Provider 的模型列表的最短间隔。 */
export const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;

export interface HostAccountsOptions {
  accounts: EngineAccounts;
  storage: Storage;
  /** Provider 写操作的串行锁（与 `provider.upsert` / `provider.remove` 共用）。 */
  providerLock: <T>(op: () => Promise<T>) => Promise<T>;
  /** 写库后把全部 Provider 交给引擎（`syncProviders`）。 */
  applyProviders: () => Promise<void>;
  onWarning: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * Host 侧的账号（R6，host-api.md §3.1 `account.*`，domain-model §3.6）：方法交给引擎（`EngineAccounts`），引擎报的状态
 * 变化转给调用过 `account.*` 的连接（`watch`），并维护 `chatgpt` Provider——登录成功时建它，之后读到已登录时刷新模型列表。
 * 账号状态与凭据都在引擎那边，Host 不存。
 */
export class HostAccounts {
  readonly #options: HostAccountsOptions;
  readonly #watchers = new Set<(state: AccountState) => void>();
  readonly #unsubscribe: () => void;
  #lastStatus: AccountState['status'] | undefined;
  #modelsRefreshedAt: number | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(options: HostAccountsOptions) {
    this.#options = options;
    this.#unsubscribe = options.accounts.onChange((state) => this.#onChange(state));
  }

  get kinds(): readonly AccountKind[] {
    return this.#options.accounts.kinds;
  }

  /** 连接调过 `account.*` 之后收 `account.updated`。返回退订函数。 */
  watch(listener: (state: AccountState) => void): () => void {
    this.#watchers.add(listener);
    return () => this.#watchers.delete(listener);
  }

  async read(kind: AccountKind): Promise<AccountState> {
    const state = await this.#call(() => this.#options.accounts.read(kind));
    this.#lastStatus = state.status;
    if (state.status === 'signed_in' && this.#modelsStale()) this.#refreshInBackground();
    return state;
  }

  login(kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    return this.#call(() => this.#options.accounts.login(kind, method));
  }

  cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    return this.#call(() => this.#options.accounts.cancelLogin(kind, loginId));
  }

  logout(kind: AccountKind): Promise<AccountState> {
    return this.#call(() => this.#options.accounts.logout(kind));
  }

  /** `chatgpt` Provider 可选的模型（`provider.upsert` 用）。 */
  models(kind: AccountKind): Promise<AccountModels> {
    return this.#call(() => this.#options.accounts.models(kind));
  }

  /**
   * 按引擎的模型列表建或更新 `chatgpt` Provider：没有就建（显示名 `ChatGPT`，默认模型取引擎标的默认），有就换模型列表，
   * 默认模型不在新列表里时换成新的默认。模型列表为空时不动。
   */
  async refreshProvider(): Promise<void> {
    this.#refreshing ??= this.#refreshProvider().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#watchers.clear();
  }

  async #refreshProvider(): Promise<void> {
    const { models, defaultModelId } = await this.models('chatgpt');
    if (models.length === 0 || defaultModelId === undefined) return;
    this.#modelsRefreshedAt = this.#now();
    await this.#options.providerLock(async () => {
      const { storage } = this.#options;
      const existing = storage.providers.get(CHATGPT_PROVIDER_ID);
      if (existing !== undefined && existing.kind !== 'chatgpt') {
        this.#options.onWarning('provider id chatgpt is taken by another kind; not creating it', {
          kind: existing.kind,
        });
        return;
      }
      const keep =
        existing !== undefined && models.some((model) => model.id === existing.defaultModelId);
      const now = new Date(this.#now()).toISOString();
      const record: ProviderProfileRecord = {
        id: CHATGPT_PROVIDER_ID,
        kind: 'chatgpt',
        displayName: existing?.displayName ?? CHATGPT_DISPLAY_NAME,
        models,
        defaultModelId: keep ? existing.defaultModelId : defaultModelId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (
        existing !== undefined &&
        JSON.stringify(existing.models) === JSON.stringify(record.models) &&
        existing.defaultModelId === record.defaultModelId
      ) {
        return;
      }
      if (existing !== undefined) storage.providers.update(record);
      else storage.providers.insert(record);
      await this.#options.applyProviders();
    });
  }

  #onChange(state: AccountState): void {
    const previous = this.#lastStatus;
    this.#lastStatus = state.status;
    // 刚登录成功：建或刷新 chatgpt Provider（模型列表随账号的套餐变化）。
    if (state.status === 'signed_in' && previous !== 'signed_in') {
      this.#modelsRefreshedAt = undefined;
      this.#refreshInBackground();
    }
    for (const watcher of [...this.#watchers]) {
      try {
        watcher(state);
      } catch (error) {
        this.#options.onWarning('account watcher failed', { error });
      }
    }
  }

  #modelsStale(): boolean {
    const at = this.#modelsRefreshedAt;
    return at === undefined || this.#now() - at >= MODEL_REFRESH_INTERVAL_MS;
  }

  #refreshInBackground(): void {
    this.refreshProvider().catch((error: unknown) =>
      this.#options.onWarning('failed to refresh the ChatGPT provider', { error }),
    );
  }

  /** 引擎的失败一律 `ENGINE_ERROR`（host-api.md §3.1）。 */
  async #call<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (error instanceof HostError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
