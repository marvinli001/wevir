/** 每个来源地址一分钟内最多开始几次握手。 */
export const HANDSHAKE_ATTEMPTS_PER_MINUTE = 20;
/** 每个来源地址十分钟内失败几次就暂时拒绝。 */
export const HANDSHAKE_FAILURES_BEFORE_BLOCK = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
/** 被拒绝多久。 */
export const HANDSHAKE_BLOCK_MS = 10 * 60_000;
/** 同时在握手的连接（所有来源合计）。 */
export const MAX_PENDING_HANDSHAKES = 32;
/** 记着的来源地址数的上限；超了丢掉最早的。 */
const MAX_TRACKED_ADDRESSES = 1024;

interface AddressState {
  attempts: number[];
  failures: number[];
  blockedUntil: number;
}

/**
 * 远程监听按来源地址的限速（ADR-0017 §1）：握手开始的频率与失败次数。成功的握手不清零已有的失败（失败本来就会过期）。
 * 只在内存里，Host 重启清零。
 */
export class HandshakeLimiter {
  readonly #now: () => number;
  readonly #addresses = new Map<string, AddressState>();
  #pending = 0;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** 新的握手能不能开始；能的话记下一次尝试并占一个名额，结束时调用返回的函数。 */
  begin(address: string): (() => void) | undefined {
    if (this.#pending >= MAX_PENDING_HANDSHAKES) return undefined;
    const now = this.#now();
    const state = this.#state(address, now);
    if (state.blockedUntil > now) return undefined;
    if (state.attempts.length >= HANDSHAKE_ATTEMPTS_PER_MINUTE) return undefined;
    state.attempts.push(now);
    this.#pending += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#pending -= 1;
    };
  }

  /** 握手失败一次。 */
  fail(address: string): void {
    const now = this.#now();
    const state = this.#state(address, now);
    state.failures.push(now);
    if (state.failures.length >= HANDSHAKE_FAILURES_BEFORE_BLOCK) {
      state.blockedUntil = now + HANDSHAKE_BLOCK_MS;
      state.failures = [];
    }
  }

  #state(address: string, now: number): AddressState {
    let state = this.#addresses.get(address);
    if (state === undefined) {
      if (this.#addresses.size >= MAX_TRACKED_ADDRESSES) {
        const oldest = this.#addresses.keys().next().value;
        if (oldest !== undefined) this.#addresses.delete(oldest);
      }
      state = { attempts: [], failures: [], blockedUntil: 0 };
      this.#addresses.set(address, state);
    }
    state.attempts = state.attempts.filter((at) => now - at < 60_000);
    state.failures = state.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    return state;
  }
}
