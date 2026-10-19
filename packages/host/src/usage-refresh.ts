import type { AccountKind, AccountState } from '@wevir/protocol';

// 订阅账号用量的自动刷新（domain-model §3.6）：Host 自己定时重读已登录账号的用量（引擎的 `refreshUsage`，读到变化经
// `account.updated` 推给客户端），客户端不用轮询，也没有手动刷新按钮。什么时候读：
//
// - 有客户端看着账号（连接调过 `account.*`）时每 5 分钟一次；没有客户端时不读（只在后台跑的 Host 不发请求）。
// - 用这个账号的会话回合结束后 3 秒读一次，之后 10 分钟里每分钟一次（刚用过，额度变得快）。
// - 某个窗口的重置时间过了 30 秒读一次，用量条自己回到 0。
// - 客户端回到前台时读账号（`account.list` / `account.get`），离上次读超过 1 分钟就在后台读一次（`nudge`）。
// - 电脑睡眠醒来（两次检查之间隔得远远超过检查间隔）时全部读一次。
//
// 每种账号同时只读一次；读不到由引擎留着上次的值。

/** 多久检查一次该不该读。 */
export const USAGE_TICK_MS = 30_000;
/** 有客户端看着时的间隔。 */
export const USAGE_IDLE_MS = 5 * 60_000;
/** 回合结束后的一段时间里的间隔。 */
export const USAGE_ACTIVE_MS = 60_000;
/** 回合结束后多久算“刚用过”。 */
export const USAGE_ACTIVE_WINDOW_MS = 10 * 60_000;
/** 回合结束后等多久再读（引擎那边的计量要一会儿才更新）。 */
export const USAGE_AFTER_TURN_MS = 3_000;
/** 重置时间过了多久再读。 */
export const USAGE_RESET_GRACE_MS = 30_000;
/** 客户端回到前台时，离上次读多久以上才读。 */
export const USAGE_NUDGE_MIN_MS = 60_000;

export interface UsageRefreshTarget {
  readonly kinds: readonly AccountKind[];
  /** 只重读用量（`EngineAccounts.refreshUsage`）。 */
  refreshUsage(kind: AccountKind): Promise<void>;
  /** 账号状态（读到的与引擎报的）；返回退订函数。 */
  observe(listener: (state: AccountState) => void): () => void;
  /** 有没有客户端看着账号。 */
  readonly watching: boolean;
}

export interface UsageRefresherOptions {
  target: UsageRefreshTarget;
  onWarning: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

interface KindState {
  signedIn: boolean;
  /** 最早的、还没过的重置时间（毫秒）。 */
  nextReset?: number;
  lastAt?: number;
  activeUntil?: number;
  due: boolean;
  running?: Promise<void>;
}

export class UsageRefresher {
  readonly #options: UsageRefresherOptions;
  readonly #kinds = new Map<AccountKind, KindState>();
  readonly #unobserve: () => void;
  readonly #afterTurn = new Map<AccountKind, ReturnType<typeof setTimeout>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTick: number;

  constructor(options: UsageRefresherOptions) {
    this.#options = options;
    for (const kind of options.target.kinds) this.#kinds.set(kind, { signedIn: false, due: false });
    this.#unobserve = options.target.observe((state) => this.#onState(state));
    this.#lastTick = this.#now();
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#lastTick = this.#now();
    this.#timer = setInterval(() => this.tick(), USAGE_TICK_MS);
    this.#timer.unref?.();
  }

  /** 用这种账号的会话回合结束了：稍后读一次，之后一段时间读得勤一些。 */
  turnEnded(kind: AccountKind): void {
    const state = this.#kinds.get(kind);
    if (state === undefined) return;
    state.activeUntil = this.#now() + USAGE_ACTIVE_WINDOW_MS;
    clearTimeout(this.#afterTurn.get(kind));
    const timer = setTimeout(() => {
      this.#afterTurn.delete(kind);
      state.due = true;
      this.tick();
    }, USAGE_AFTER_TURN_MS);
    timer.unref?.();
    this.#afterTurn.set(kind, timer);
  }

  /** 客户端读了账号（回到前台等）：离上次读超过 `USAGE_NUDGE_MIN_MS` 的已登录账号在后台读一次。省略 `kind` 是全部。 */
  nudge(kind?: AccountKind): void {
    const now = this.#now();
    for (const [each, state] of this.#kinds) {
      if (kind !== undefined && each !== kind) continue;
      if (state.lastAt === undefined || now - state.lastAt >= USAGE_NUDGE_MIN_MS) state.due = true;
    }
    this.tick();
  }

  /** 检查一遍该读的（定时器调用；测试直接调）。 */
  tick(): void {
    const now = this.#now();
    // 两次检查之间隔得远远超过间隔：电脑睡过一觉，全部读一次。
    const woke = this.#timer !== undefined && now - this.#lastTick > USAGE_TICK_MS * 3;
    this.#lastTick = now;
    const watching = this.#options.target.watching;
    for (const [kind, state] of this.#kinds) {
      if (!state.signedIn || state.running !== undefined) continue;
      const active = state.activeUntil !== undefined && now < state.activeUntil;
      if (!watching && !active && !state.due) continue;
      const interval = active ? USAGE_ACTIVE_MS : USAGE_IDLE_MS;
      const stale = state.lastAt === undefined || now - state.lastAt >= interval;
      const reset = state.nextReset !== undefined && now >= state.nextReset + USAGE_RESET_GRACE_MS;
      if (state.due || woke || stale || reset) this.#refresh(kind, state);
    }
  }

  dispose(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const timer of this.#afterTurn.values()) clearTimeout(timer);
    this.#afterTurn.clear();
    this.#unobserve();
  }

  #refresh(kind: AccountKind, state: KindState): void {
    state.due = false;
    state.lastAt = this.#now();
    // 重置时间用过了；读到新的状态时再记下一个。
    if (state.nextReset !== undefined && state.lastAt >= state.nextReset)
      state.nextReset = undefined;
    state.running = this.#options.target
      .refreshUsage(kind)
      .catch((error: unknown) =>
        this.#options.onWarning('failed to refresh account usage', { kind, error: String(error) }),
      )
      .finally(() => {
        state.running = undefined;
      });
  }

  #onState(account: AccountState): void {
    const state = this.#kinds.get(account.kind);
    if (state === undefined) return;
    const signedIn = account.status === 'signed_in';
    if (!signedIn) {
      state.nextReset = undefined;
      state.lastAt = undefined;
    } else if (!state.signedIn && account.rateLimits !== undefined) {
      // 刚读到已登录且带着用量：就是这次读的，不用马上再读。
      state.lastAt ??= this.#now();
    }
    state.signedIn = signedIn;
    if (signedIn) state.nextReset = nextReset(account, this.#now());
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

/** 各窗口里最早的、还没到的重置时间。 */
export function nextReset(account: AccountState, now: number): number | undefined {
  const limits = account.rateLimits;
  if (limits === undefined) return undefined;
  const windows = limits.windows ?? [limits.primary, limits.secondary];
  let earliest: number | undefined;
  for (const window of windows) {
    if (window?.resetsAt === undefined) continue;
    const at = Date.parse(window.resetsAt);
    if (Number.isNaN(at) || at <= now) continue;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}
