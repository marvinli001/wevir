import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountState,
  AccountUpstream,
  SessionId,
} from '@wevir/protocol';
import type { AccountLoginOptions, AccountModels, EngineAccounts } from '@wevir/runtime-adapter';
import type { ProviderProfileRecord, Storage } from '@wevir/storage';
import type { EnginePathStore } from './engine-paths.js';
import type { AccountPool } from './engine-router.js';
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

/**
 * 首个账号用的是用户本机终端里的登录的种类（0.63.0 的 `localLogin`）：凭据在用户自己的 `~/.claude`、`~/.grok` 等处，登出会让
 * 终端也登出。添加的账号都在 Wevir 的数据目录里。
 */
const LOCAL_LOGIN_KINDS: readonly AccountKind[] = ['claude', 'grok', 'opencode', 'workbuddy'];

/** 读账号时刷新账号 Provider 的模型列表的最短间隔。 */
export const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;

/** 指一个账号：种类加账号 ID（省略 ID 是这种的首个账号，ID 等于种类）。 */
export interface AccountRef {
  kind: AccountKind;
  id?: string;
}

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
  /**
   * 0.63.0：给添加的账号开引擎（`EngineRouter.accountPool`）与它们的目录（`<数据目录>/accounts`）；省略时不能添加账号。
   */
  pool?: AccountPool;
  accountsDir?: string;
  /** Provider 被删时（`account.remove`）删了它的用量记录。 */
  onUsageRemoved?: () => void;
  now?: () => number;
}

/** 一个账号：首个账号的引擎账号是合并后的那个，添加的账号各有自己的引擎。 */
interface Slot {
  id: string;
  kind: AccountKind;
  /** 添加的账号（不是首个账号）。 */
  added: boolean;
  label?: string;
  engine: EngineAccounts;
  /** 添加的账号：引擎的状态变化的退订。 */
  unsubscribe?: () => void;
}

/**
 * Host 侧的账号（R6，host-api.md §3.1 `account.*`，domain-model §3.6）：方法交给引擎（`EngineAccounts`，多个引擎时是路由合并的），
 * 引擎报的状态变化转给调用过 `account.*` 的连接（`watch`），并维护每个账号的 Provider（ID 与账号 ID 相同）——第一次读到已登录时
 * 建它，之后读到已登录时刷新模型列表。账号状态与凭据都在引擎那边，Host 不存；用户指定的可执行文件记在 `engines.json`。
 *
 * 0.63.0 起一种可以有多个账号：首个账号的 ID 等于种类（以前唯一的那个），添加的账号（`add`）是 `<种类>-<4 位十六进制>`，每个
 * 是同类引擎的一个实例（`pool`），凭据与会话在 `<数据目录>/accounts/<id>/`，登记在存储的 `subscription_accounts` 里（首个账号
 * 只在设了标签时有一行）。表都按账号 ID。
 */
export class HostAccounts {
  readonly #options: HostAccountsOptions;
  readonly #watchers = new Set<(state: AccountState) => void>();
  /** Host 自己的监听（用量的自动刷新），不算“有客户端看着”。 */
  readonly #observers = new Set<(state: AccountState) => void>();
  readonly #unsubscribe: () => void;
  /** 账号 ID → 账号，首个账号在前、添加的按先后。 */
  readonly #slots = new Map<string, Slot>();
  /** 账号 ID → 最近一次的状态（引擎报的或读到的，没盖章）。 */
  readonly #last = new Map<string, AccountState>();
  readonly #modelsRefreshedAt = new Map<string, number>();
  readonly #refreshing = new Map<string, Promise<void>>();
  /** 用量的自动刷新（usage-refresh.ts）；`startUsageRefresh` 之后才定时读。 */
  readonly usage: UsageRefresher;

  constructor(options: HostAccountsOptions) {
    this.#options = options;
    const labels = new Map(
      options.storage.accounts.list().map((record) => [record.id, record.label] as const),
    );
    for (const kind of options.accounts.kinds) {
      const label = labels.get(kind);
      this.#slots.set(kind, {
        id: kind,
        kind,
        added: false,
        engine: options.accounts,
        ...(label !== undefined && { label }),
      });
    }
    this.#unsubscribe = options.accounts.onChange((state) => {
      if (this.#slots.get(state.kind)?.added === false) this.#onChange(state.kind, state);
    });
    // 添加的账号：建好它们的引擎（会话恢复时要找得到）。种类现在不能添加了（SDK 没装等）的，登记留着、不列出。
    for (const record of options.storage.accounts.list()) {
      if (record.id === record.kind || this.#slots.has(record.id)) continue;
      const kind = record.kind as AccountKind;
      if (!this.#canAdd(kind)) {
        options.onWarning('an added account cannot be opened in this host; skipping it', {
          id: record.id,
          kind,
        });
        continue;
      }
      try {
        this.#open(kind, record.id, record.label);
      } catch (error) {
        options.onWarning('failed to open an added account', { id: record.id, error });
      }
    }
    this.usage = new UsageRefresher({
      target: this,
      onWarning: options.onWarning,
      ...(options.now !== undefined && { now: options.now }),
    });
  }

  get kinds(): readonly AccountKind[] {
    return this.#options.accounts.kinds;
  }

  /** 全部账号的 ID（首个账号在前）。 */
  get ids(): readonly string[] {
    return [...this.#slots.keys()];
  }

  /** 引擎能不能指定可执行文件、能不能下载安装（Host 据此声明 `subscription_sources`）。 */
  get hasSubscriptions(): boolean {
    return this.kinds.some((kind) => kind !== 'chatgpt');
  }

  /** 有没有引擎的账号后面接着好几家上游（Host 据此声明 `subscription_upstreams`）。 */
  get hasUpstreams(): boolean {
    return this.#options.accounts.upstreams !== undefined;
  }

  /** 能不能添加账号（Host 据此声明 `subscription_accounts`）。 */
  get canAddAccounts(): boolean {
    return this.kinds.some((kind) => this.#canAdd(kind));
  }

  /** 这个 ID 的账号的种类；不是账号时 `undefined`（用量刷新据此认会话的 Provider）。 */
  kindOf(id: string): AccountKind | undefined {
    return this.#slots.get(id)?.kind;
  }

  /** 把 `engines.json` 里记下的路径交给引擎。Host 启动时调用一次；失败只告警。 */
  async applySavedPaths(): Promise<void> {
    const store = this.#options.paths;
    if (store === undefined) return;
    const saved = await store.load();
    for (const slot of this.#slots.values()) {
      const path = saved.get(slot.kind);
      if (path !== undefined) await this.#applyPath(slot, path);
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

  /** Host 内部看账号状态（盖过章的）：读到的结果与引擎报的变化都给。返回退订函数。 */
  observe(listener: (state: AccountState) => void): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  async read(ref: AccountRef, options?: { refresh?: boolean }): Promise<AccountState> {
    const slot = this.#slot(ref);
    const raw = await this.#call(() => slot.engine.read(slot.kind, options));
    this.#last.set(slot.id, raw);
    const state = this.#stamp(slot, raw);
    this.#notifyObservers(state);
    if (raw.status === 'signed_in' && this.#modelsStale(slot.id)) this.#refreshInBackground(slot);
    return state;
  }

  /**
   * 只重读用量（usage-refresh.ts 定时调）：引擎实现了 `refreshUsage` 用它，否则用不带 `refresh` 的 `read`（引擎的缓存过期才
   * 真的去读）。变化经 `account.updated` 推给客户端。
   */
  async refreshUsage(id: string): Promise<void> {
    const slot = this.#slots.get(id);
    if (slot === undefined) return;
    if (slot.engine.refreshUsage !== undefined) await slot.engine.refreshUsage(slot.kind);
    else await this.read(slot);
  }

  /** 全部账号的状态（`account.list`）；读不到的是 `signed_out` 带 `lastError`，不让一个引擎拖垮整张表。 */
  list(): Promise<AccountState[]> {
    return Promise.all(
      [...this.#slots.values()].map((slot) =>
        this.read(slot).catch(
          (error: unknown): AccountState =>
            this.#stamp(slot, {
              kind: slot.kind,
              status: 'signed_out',
              lastError: error instanceof Error ? error.message : String(error),
            }),
        ),
      ),
    );
  }

  login(
    ref: AccountRef,
    method: AccountLoginMethod,
    options?: AccountLoginOptions,
  ): Promise<AccountState> {
    const slot = this.#slot(ref);
    return this.#stamped(slot, () => slot.engine.login(slot.kind, method, options));
  }

  /** 订阅来源后面能在应用内接的上游（`account.upstreams`，首个账号）。 */
  upstreams(kind: AccountKind): Promise<AccountUpstream[]> {
    return this.#call(async () => {
      const { accounts } = this.#options;
      if (accounts.upstreams === undefined) throw new Error(`the ${kind} account has no upstreams`);
      return accounts.upstreams(kind);
    });
  }

  cancelLogin(ref: AccountRef, loginId?: string): Promise<AccountState> {
    const slot = this.#slot(ref);
    return this.#stamped(slot, () => slot.engine.cancelLogin(slot.kind, loginId));
  }

  logout(ref: AccountRef, options?: { upstream?: string }): Promise<AccountState> {
    const slot = this.#slot(ref);
    return this.#stamped(slot, () => slot.engine.logout(slot.kind, options));
  }

  /** 指定可执行文件（`account.setPath`，按种类，这种的账号都用它）：先交给引擎（它重新检测），再记进 `engines.json`。 */
  setPath(kind: AccountKind, path: string | null): Promise<AccountState> {
    const slot = this.#slot({ kind });
    return this.#stamped(slot, async () => {
      const { accounts, paths } = this.#options;
      if (accounts.setExecutablePath === undefined || paths === undefined) {
        throw new Error(`the ${kind} engine has no executable path setting`);
      }
      const state = await accounts.setExecutablePath(kind, path);
      await paths.set(kind, path);
      for (const other of this.#slots.values()) {
        if (other.added && other.kind === kind) await this.#applyPath(other, path);
      }
      return state;
    });
  }

  install(kind: AccountKind): Promise<AccountState> {
    const slot = this.#slot({ kind });
    return this.#stamped(slot, async () => {
      const { accounts } = this.#options;
      if (accounts.install === undefined) throw new Error(`the ${kind} engine cannot be installed`);
      return accounts.install(kind);
    });
  }

  /** 账号 Provider 可选的模型（`provider.upsert` 用）。 */
  models(ref: AccountRef): Promise<AccountModels> {
    const slot = this.#slot(ref);
    return this.#call(() => slot.engine.models(slot.kind));
  }

  /**
   * 添加一个账号（`account.add`）：建它的引擎与目录、登记，返回它的状态（未登录）。种类不能添加时 `INVALID_PARAMS`。
   */
  async add(kind: AccountKind, label?: string): Promise<AccountState> {
    if (!this.#canAdd(kind)) {
      throw invalidAccount(['kind'], `${kind} accounts cannot be added in this host`);
    }
    const id = this.#newId(kind);
    const now = new Date(this.#now()).toISOString();
    await mkdir(this.#rootOf(id), { recursive: true, mode: 0o700 });
    const slot = this.#call(async () => this.#open(kind, id, label));
    const opened = await slot.catch(async (error: unknown) => {
      await rm(this.#rootOf(id), { recursive: true, force: true });
      throw error;
    });
    this.#options.storage.accounts.upsert({
      id,
      kind,
      ...(label !== undefined && { label }),
      createdAt: now,
    });
    const saved = (await this.#options.paths?.load())?.get(kind);
    if (saved !== undefined) await this.#applyPath(opened, saved);
    const state = await this.read(opened);
    this.#broadcast(state);
    return state;
  }

  /**
   * 删掉添加的账号（`account.remove`）：登出（尽力而为）、停掉它的引擎，删它的 Provider、用量记录、登记与目录。首个账号不能删；
   * 有没关闭的会话在用它的 Provider 时 `RESOURCE_IN_USE`（同 `provider.remove`）。
   */
  async remove(id: string, openSessions: () => string[]): Promise<void> {
    const slot = this.#slots.get(id);
    if (slot === undefined) throw invalidAccount(['id'], `no account ${id}`);
    if (!slot.added) {
      throw invalidAccount(['id'], `the first ${slot.kind} account cannot be removed`);
    }
    const open = openSessions();
    if (open.length > 0) {
      throw new HostError('RESOURCE_IN_USE', `account ${id} is used by open sessions`, {
        sessionIds: open.map((session) => session as SessionId),
      });
    }
    await slot.engine
      .logout(slot.kind)
      .catch((error: unknown) =>
        this.#options.onWarning('failed to sign out a removed account', { id, error }),
      );
    slot.unsubscribe?.();
    this.#slots.delete(id);
    this.#last.delete(id);
    this.#modelsRefreshedAt.delete(id);
    this.usage.forget(id);
    await this.#options.pool?.close(id);
    const { storage } = this.#options;
    await this.#options.providerLock(async () => {
      const removed = storage.providers.delete(id);
      if (storage.usage.deleteProvider(id) > 0) this.#options.onUsageRemoved?.();
      if (removed) await this.#options.applyProviders();
    });
    storage.accounts.remove(id);
    await rm(this.#rootOf(id), { recursive: true, force: true });
  }

  /** 设或清掉账号的标签（`account.setLabel`）：记进登记，改它的 Provider 的显示名。 */
  async setLabel(id: string, label: string | null): Promise<AccountState> {
    const slot = this.#slots.get(id);
    if (slot === undefined) throw invalidAccount(['id'], `no account ${id}`);
    const { storage } = this.#options;
    const existing = storage.accounts.get(id);
    if (label === null) delete slot.label;
    else slot.label = label;
    if (!slot.added && label === null) {
      storage.accounts.remove(id);
    } else {
      storage.accounts.upsert({
        id,
        kind: slot.kind,
        ...(label !== null && { label }),
        createdAt: existing?.createdAt ?? new Date(this.#now()).toISOString(),
      });
    }
    await this.#renameProvider(slot);
    const last = this.#last.get(id);
    const state = last === undefined ? await this.read(slot) : this.#stamp(slot, last);
    this.#broadcast(state);
    return state;
  }

  /**
   * 按引擎的模型列表建或更新这个账号的 Provider：没有就建（显示名见 `providerName`，默认模型取引擎标的默认），有就换模型列表，
   * 默认模型不在新列表里时换成新的默认。模型列表为空时不动。
   */
  async refreshProvider(ref: AccountRef = { kind: 'chatgpt' }): Promise<void> {
    const slot = this.#slot(ref);
    let running = this.#refreshing.get(slot.id);
    if (running === undefined) {
      running = this.#refreshProvider(slot).finally(() => this.#refreshing.delete(slot.id));
      this.#refreshing.set(slot.id, running);
    }
    return running;
  }

  /** 账号的 Provider 该叫什么（0.63.0）：种类的名字，有标签时加 “ · 标签”，添加的账号没标签时加序号（“Claude 2”）。 */
  providerName(id: string): string {
    const slot = this.#slots.get(id);
    if (slot === undefined) return id;
    const name = ACCOUNT_PROVIDER_NAMES[slot.kind];
    if (slot.label !== undefined) return `${name} · ${slot.label}`;
    if (!slot.added) return name;
    const same = [...this.#slots.values()].filter((other) => other.kind === slot.kind);
    return `${name} ${same.indexOf(slot) + 1}`;
  }

  dispose(): void {
    this.usage.dispose();
    this.#unsubscribe();
    for (const slot of this.#slots.values()) slot.unsubscribe?.();
    this.#watchers.clear();
    this.#observers.clear();
  }

  #canAdd(kind: AccountKind): boolean {
    const { pool, accountsDir } = this.#options;
    return pool !== undefined && accountsDir !== undefined && pool.kinds.includes(kind);
  }

  #rootOf(id: string): string {
    const dir = this.#options.accountsDir;
    if (dir === undefined) throw new Error('this host has no accounts directory');
    return join(dir, id);
  }

  #newId(kind: AccountKind): string {
    const { storage } = this.#options;
    for (;;) {
      const id = `${kind}-${randomBytes(2).toString('hex')}`;
      if (!this.#slots.has(id) && storage.providers.get(id) === undefined) return id;
    }
  }

  /** 建添加的账号的引擎（`pool.open`），挂上它的状态变化。 */
  #open(kind: AccountKind, id: string, label: string | undefined): Slot {
    const pool = this.#options.pool;
    if (pool === undefined) throw new Error('this host cannot add accounts');
    const engine = pool.open(kind, { id, root: this.#rootOf(id) });
    const slot: Slot = { id, kind, added: true, engine, ...(label !== undefined && { label }) };
    slot.unsubscribe = engine.onChange((state) => this.#onChange(id, state));
    this.#slots.set(id, slot);
    return slot;
  }

  async #applyPath(slot: Slot, path: string | null): Promise<void> {
    const setPath = slot.engine.setExecutablePath;
    if (setPath === undefined) return;
    await setPath.call(slot.engine, slot.kind, path).catch((error: unknown) =>
      this.#options.onWarning('failed to apply a saved engine path', {
        kind: slot.kind,
        id: slot.id,
        error,
      }),
    );
  }

  #slot(ref: AccountRef): Slot {
    const id = ref.id ?? ref.kind;
    const slot = this.#slots.get(id);
    if (slot === undefined || slot.kind !== ref.kind) {
      if (ref.id === undefined) {
        throw new HostError('ENGINE_ERROR', `no ${ref.kind} account in this host`, {
          category: 'unknown',
          message: `no ${ref.kind} account in this host`,
        });
      }
      throw invalidAccount(['id'], `no ${ref.kind} account ${id}`);
    }
    return slot;
  }

  /** 引擎给的状态加上账号的字段（0.63.0）。 */
  #stamp(slot: Slot, state: AccountState): AccountState {
    const { id: _id, label: _label, localLogin: _local, multiAccount: _multi, ...rest } = state;
    return {
      ...rest,
      kind: slot.kind,
      id: slot.id,
      ...(slot.label !== undefined && { label: slot.label }),
      ...(!slot.added && LOCAL_LOGIN_KINDS.includes(slot.kind) && { localLogin: true as const }),
      ...(this.#canAdd(slot.kind) && { multiAccount: true as const }),
    };
  }

  async #stamped(slot: Slot, op: () => Promise<AccountState>): Promise<AccountState> {
    const state = await this.#call(op);
    this.#last.set(slot.id, state);
    return this.#stamp(slot, state);
  }

  async #refreshProvider(slot: Slot): Promise<void> {
    const { models, defaultModelId } = await this.#call(() => slot.engine.models(slot.kind));
    if (models.length === 0 || defaultModelId === undefined) return;
    this.#modelsRefreshedAt.set(slot.id, this.#now());
    const { id, kind } = slot;
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
        displayName: this.#displayName(slot, existing),
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

  /** 标签变了：账号的 Provider 还叫 Host 起的名字时换成新的（用户用 `provider.upsert` 改过的不动）。 */
  async #renameProvider(slot: Slot): Promise<void> {
    await this.#options.providerLock(async () => {
      const { storage } = this.#options;
      const existing = storage.providers.get(slot.id);
      if (existing === undefined || existing.kind !== slot.kind) return;
      const displayName = this.#displayName(slot, existing);
      if (displayName === existing.displayName) return;
      storage.providers.update({
        ...existing,
        displayName,
        updatedAt: new Date(this.#now()).toISOString(),
      });
      await this.#options.applyProviders();
    });
  }

  /**
   * Provider 的显示名：新建、还叫 Host 起的名字（种类的名字、旧的默认名、“名字 2”、“名字 · 标签”）时用 `providerName`；用户
   * 改过的照旧。
   */
  #displayName(slot: Slot, existing: ProviderProfileRecord | undefined): string {
    const next = this.providerName(slot.id);
    if (existing === undefined) return next;
    const name = ACCOUNT_PROVIDER_NAMES[slot.kind];
    const current = existing.displayName;
    const generated =
      current === name ||
      current === LEGACY_PROVIDER_NAMES[slot.kind] ||
      current.startsWith(`${name} · `) ||
      new RegExp(`^${escapeRegExp(name)} \\d+$`).test(current);
    return generated ? next : current;
  }

  #onChange(id: string, raw: AccountState): void {
    const slot = this.#slots.get(id);
    if (slot === undefined) return;
    const previous = this.#last.get(id)?.status;
    this.#last.set(id, raw);
    // 刚登录成功：建或刷新这个账号的 Provider（模型列表随账号的套餐变化）。
    if (raw.status === 'signed_in' && previous !== 'signed_in') {
      this.#modelsRefreshedAt.delete(id);
      this.#refreshInBackground(slot);
    }
    const state = this.#stamp(slot, raw);
    this.#notifyObservers(state);
    this.#broadcast(state);
  }

  #broadcast(state: AccountState): void {
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

  #modelsStale(id: string): boolean {
    const at = this.#modelsRefreshedAt.get(id);
    return at === undefined || this.#now() - at >= MODEL_REFRESH_INTERVAL_MS;
  }

  #refreshInBackground(slot: Slot): void {
    this.refreshProvider(slot).catch((error: unknown) =>
      this.#options.onWarning(`failed to refresh the ${slot.id} provider`, { error }),
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

function invalidAccount(path: string[], message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
