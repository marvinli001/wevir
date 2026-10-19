import type {
  AccountKind,
  AccountLoginMethod,
  AccountState,
  AccountUpstream,
} from '@wevir/protocol';
import type { AccountLoginOptions, AccountModels, EngineAccounts } from '@wevir/runtime-adapter';
import type { ProviderProfileRecord, Storage } from '@wevir/storage';
import type { EnginePathStore } from './engine-paths.js';
import { HostError } from './errors.js';
import { UsageRefresher } from './usage-refresh.js';

/** ChatGPT 登录成功后 Host 自己建的 Provider（protocol `provider.upsert` 的 `chatgpt` 一支，ID 固定）。 */
export const CHATGPT_PROVIDER_ID = 'chatgpt';
export const CHATGPT_DISPLAY_NAME = 'ChatGPT';

/**
 * 账号登录后 Host 自己建的 Provider 的显示名（0.19.0，domain-model §3.6）：ID 与种类相同。Claude 2026-10-17 起叫 “Claude”
 * （维护者定，原来是 “Claude Agent”），不叫 “Claude Code”（ADR-0005 补记 14）。
 */
export const ACCOUNT_PROVIDER_NAMES: Readonly<Record<AccountKind, string>> = {
  chatgpt: CHATGPT_DISPLAY_NAME,
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  antigravity: 'Antigravity',
  workbuddy: 'WorkBuddy',
};

/** 以前的默认显示名：Provider 还叫它时刷新时换成 `ACCOUNT_PROVIDER_NAMES` 里现在的。 */
const LEGACY_PROVIDER_NAMES: Readonly<Partial<Record<AccountKind, string>>> = {
  claude: 'Claude Agent',
};

/** 读账号时刷新账号 Provider 的模型列表的最短间隔。 */
export const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;

export interface HostAccountsOptions {
  accounts: EngineAccounts;
  storage: Storage;
  /** Provider 写操作的串行锁（与 `provider.upsert` / `provider.remove` 共用）。 */
  providerLock: <T>(op: () => Promise<T>) => Promise<T>;
  /** 写库后把全部 Provider 交给引擎（`syncProviders`）。 */
  applyProviders: () => Promise<void>;
  onWarning: (message: string, fields?: Record<string, unknown>) => void;
  /** 用户指定的可执行文件（`account.setPath`）；省略时不能指定（测试）。 */
  paths?: EnginePathStore;
  now?: () => number;
}

/**
 * Host 侧的账号（R6，host-api.md §3.1 `account.*`，domain-model §3.6）：方法交给引擎（`EngineAccounts`，多个引擎时是路由合并的），
 * 引擎报的状态变化转给调用过 `account.*` 的连接（`watch`），并维护每种账号的 Provider（ID 与种类相同）——第一次读到已登录时
 * 建它，之后读到已登录时刷新模型列表。账号状态与凭据都在引擎那边，Host 不存；用户指定的可执行文件记在 `engines.json`。
 */
export class HostAccounts {
  readonly #options: HostAccountsOptions;
  readonly #watchers = new Set<(state: AccountState) => void>();
  /** Host 自己的监听（用量的自动刷新），不算“有客户端看着”。 */
  readonly #observers = new Set<(state: AccountState) => void>();
  readonly #unsubscribe: () => void;
  readonly #lastStatus = new Map<AccountKind, AccountState['status']>();
  readonly #modelsRefreshedAt = new Map<AccountKind, number>();
  readonly #refreshing = new Map<AccountKind, Promise<void>>();
  /** 用量的自动刷新（usage-refresh.ts）；`startUsageRefresh` 之后才定时读。 */
  readonly usage: UsageRefresher;

  constructor(options: HostAccountsOptions) {
    this.#options = options;
    this.#unsubscribe = options.accounts.onChange((state) => this.#onChange(state));
    this.usage = new UsageRefresher({
      target: this,
      onWarning: options.onWarning,
      ...(options.now !== undefined && { now: options.now }),
    });
  }

  get kinds(): readonly AccountKind[] {
    return this.#options.accounts.kinds;
  }

  /** 引擎能不能指定可执行文件、能不能下载安装（Host 据此声明 `subscription_sources`）。 */
  get hasSubscriptions(): boolean {
    return this.kinds.some((kind) => kind !== 'chatgpt');
  }

  /** 有没有引擎的账号后面接着好几家上游（Host 据此声明 `subscription_upstreams`）。 */
  get hasUpstreams(): boolean {
    return this.#options.accounts.upstreams !== undefined;
  }

  /** 把 `engines.json` 里记下的路径交给引擎。Host 启动时调用一次；失败只告警。 */
  async applySavedPaths(): Promise<void> {
    const store = this.#options.paths;
    const setPath = this.#options.accounts.setExecutablePath;
    if (store === undefined || setPath === undefined) return;
    for (const [kind, path] of await store.load()) {
      if (!this.kinds.includes(kind)) continue;
      await setPath
        .call(this.#options.accounts, kind, path)
        .catch((error: unknown) =>
          this.#options.onWarning('failed to apply a saved engine path', { kind, error }),
        );
    }
  }

  /** 连接调过 `account.*` 之后收 `account.updated`。返回退订函数。 */
  watch(listener: (state: AccountState) => void): () => void {
    this.#watchers.add(listener);
    return () => this.#watchers.delete(listener);
  }

  /** 有没有连接在收 `account.updated`（用量的自动刷新据此决定读不读）。 */
  get watching(): boolean {
    return this.#watchers.size > 0;
  }

  /** Host 内部看账号状态：读到的结果与引擎报的变化都给。返回退订函数。 */
  observe(listener: (state: AccountState) => void): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    const state = await this.#call(() => this.#options.accounts.read(kind, options));
    this.#lastStatus.set(kind, state.status);
    this.#notifyObservers(state);
    if (state.status === 'signed_in' && this.#modelsStale(kind)) this.#refreshInBackground(kind);
    return state;
  }

  /**
   * 只重读用量（usage-refresh.ts 定时调）：引擎实现了 `refreshUsage` 用它，否则用不带 `refresh` 的 `read`（引擎的缓存过期才
   * 真的去读）。变化经 `account.updated` 推给客户端。
   */
  async refreshUsage(kind: AccountKind): Promise<void> {
    const { accounts } = this.#options;
    if (accounts.refreshUsage !== undefined) await accounts.refreshUsage(kind);
    else await this.read(kind);
  }

  /** 全部种类的状态（`account.list`）；读不到的种类是 `signed_out` 带 `lastError`，不让一个引擎拖垮整张表。 */
  list(): Promise<AccountState[]> {
    return Promise.all(
      this.kinds.map((kind) =>
        this.read(kind).catch(
          (error: unknown): AccountState => ({
            kind,
            status: 'signed_out',
            lastError: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    );
  }

  login(
    kind: AccountKind,
    method: AccountLoginMethod,
    options?: AccountLoginOptions,
  ): Promise<AccountState> {
    return this.#call(() => this.#options.accounts.login(kind, method, options));
  }

  /** 订阅来源后面能在应用内接的上游（`account.upstreams`）。 */
  upstreams(kind: AccountKind): Promise<AccountUpstream[]> {
    return this.#call(async () => {
      const { accounts } = this.#options;
      if (accounts.upstreams === undefined) throw new Error(`the ${kind} account has no upstreams`);
      return accounts.upstreams(kind);
    });
  }

  cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    return this.#call(() => this.#options.accounts.cancelLogin(kind, loginId));
  }

  logout(kind: AccountKind, options?: { upstream?: string }): Promise<AccountState> {
    return this.#call(() => this.#options.accounts.logout(kind, options));
  }

  /** 指定可执行文件（`account.setPath`）：先交给引擎（它重新检测），再记进 `engines.json`。 */
  setPath(kind: AccountKind, path: string | null): Promise<AccountState> {
    return this.#call(async () => {
      const { accounts, paths } = this.#options;
      if (accounts.setExecutablePath === undefined || paths === undefined) {
        throw new Error(`the ${kind} engine has no executable path setting`);
      }
      const state = await accounts.setExecutablePath(kind, path);
      await paths.set(kind, path);
      this.#lastStatus.set(kind, state.status);
      return state;
    });
  }

  install(kind: AccountKind): Promise<AccountState> {
    return this.#call(async () => {
      const { accounts } = this.#options;
      if (accounts.install === undefined) throw new Error(`the ${kind} engine cannot be installed`);
      return accounts.install(kind);
    });
  }

  /** 账号 Provider 可选的模型（`provider.upsert` 用）。 */
  models(kind: AccountKind): Promise<AccountModels> {
    return this.#call(() => this.#options.accounts.models(kind));
  }

  /**
   * 按引擎的模型列表建或更新这种账号的 Provider：没有就建（显示名见 `ACCOUNT_PROVIDER_NAMES`，默认模型取引擎标的默认），有就换
   * 模型列表，默认模型不在新列表里时换成新的默认。模型列表为空时不动。
   */
  async refreshProvider(kind: AccountKind = 'chatgpt'): Promise<void> {
    let running = this.#refreshing.get(kind);
    if (running === undefined) {
      running = this.#refreshProvider(kind).finally(() => this.#refreshing.delete(kind));
      this.#refreshing.set(kind, running);
    }
    return running;
  }

  dispose(): void {
    this.usage.dispose();
    this.#unsubscribe();
    this.#watchers.clear();
    this.#observers.clear();
  }

  async #refreshProvider(kind: AccountKind): Promise<void> {
    const { models, defaultModelId } = await this.models(kind);
    if (models.length === 0 || defaultModelId === undefined) return;
    this.#modelsRefreshedAt.set(kind, this.#now());
    const id = kind;
    await this.#options.providerLock(async () => {
      const { storage } = this.#options;
      const existing = storage.providers.get(id);
      if (existing !== undefined && existing.kind !== kind) {
        this.#options.onWarning(`provider id ${id} is taken by another kind; not creating it`, {
          kind: existing.kind,
        });
        return;
      }
      const keep =
        existing !== undefined && models.some((model) => model.id === existing.defaultModelId);
      const now = new Date(this.#now()).toISOString();
      const record: ProviderProfileRecord = {
        id,
        kind,
        displayName:
          existing === undefined || existing.displayName === LEGACY_PROVIDER_NAMES[kind]
            ? ACCOUNT_PROVIDER_NAMES[kind]
            : existing.displayName,
        models,
        defaultModelId: keep ? existing.defaultModelId : defaultModelId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing?.enabled === false) record.enabled = false;
      if (
        existing !== undefined &&
        existing.displayName === record.displayName &&
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
    const previous = this.#lastStatus.get(state.kind);
    this.#lastStatus.set(state.kind, state.status);
    // 刚登录成功：建或刷新这种账号的 Provider（模型列表随账号的套餐变化）。
    if (state.status === 'signed_in' && previous !== 'signed_in') {
      this.#modelsRefreshedAt.delete(state.kind);
      this.#refreshInBackground(state.kind);
    }
    this.#notifyObservers(state);
    for (const watcher of [...this.#watchers]) {
      try {
        watcher(state);
      } catch (error) {
        this.#options.onWarning('account watcher failed', { error });
      }
    }
  }

  #notifyObservers(state: AccountState): void {
    for (const observer of [...this.#observers]) {
      try {
        observer(state);
      } catch (error) {
        this.#options.onWarning('account observer failed', { error });
      }
    }
  }

  #modelsStale(kind: AccountKind): boolean {
    const at = this.#modelsRefreshedAt.get(kind);
    return at === undefined || this.#now() - at >= MODEL_REFRESH_INTERVAL_MS;
  }

  #refreshInBackground(kind: AccountKind): void {
    this.refreshProvider(kind).catch((error: unknown) =>
      this.#options.onWarning(`failed to refresh the ${kind} provider`, { error }),
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
