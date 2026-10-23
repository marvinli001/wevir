/** 网关的限制。都可以用环境变量改（config.ts）。 */
export interface PushLimits {
  /** 一台电脑（路由 ID）每小时能发的推送。 */
  sendsPerHourPerRoute: number;
  /** 一个推送令牌每小时能收的推送。 */
  sendsPerHourPerToken: number;
  /** 一个推送令牌每小时能要的验证码。 */
  verifiesPerHourPerToken: number;
  /** 一个来源地址每小时能要的验证码。 */
  verifiesPerHourPerSource: number;
  /** 一个来源地址每分钟的请求（所有路径合计，签名校验之前就数）。 */
  requestsPerMinutePerSource: number;
  /** 一台电脑最多绑定几个令牌。 */
  maxBindingsPerRoute: number;
  /** 一台电脑每小时能绑定、解绑几次。 */
  bindsPerHourPerRoute: number;
}

export const DEFAULT_PUSH_LIMITS: PushLimits = Object.freeze({
  sendsPerHourPerRoute: 600,
  sendsPerHourPerToken: 120,
  verifiesPerHourPerToken: 6,
  verifiesPerHourPerSource: 60,
  requestsPerMinutePerSource: 600,
  maxBindingsPerRoute: 32,
  bindsPerHourPerRoute: 60,
});

/** 记着的键数的上限；超了丢掉最早的。 */
const MAX_TRACKED_KEYS = 100_000;

/**
 * 滑动窗口计数：每个键在 `windowMs` 里最多 `limit` 次。只在内存里，网关重启就清零（限制是防滥用，不是计费）。键是哈希，不是
 * 令牌或地址本身。
 */
export class WindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** 还有余量就记一次并返回 true。 */
  take(key: string): boolean {
    const now = this.#now();
    const hits = (this.#hits.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.delete(key);
    this.#hits.set(key, hits);
    if (this.#hits.size > MAX_TRACKED_KEYS) {
      const oldest = this.#hits.keys().next().value;
      if (oldest !== undefined) this.#hits.delete(oldest);
    }
    return true;
  }
}

/** 记一段时间、有上限的集合：签名请求用过的随机数。 */
export class ExpiringSet {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, number>();

  constructor(ttlMs: number, max: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  /** 没见过就记下并返回 true；见过（还没过期）返回 false。 */
  add(key: string): boolean {
    const now = this.#now();
    const expires = this.#entries.get(key);
    if (expires !== undefined && expires > now) return false;
    this.#entries.set(key, now + this.#ttlMs);
    if (this.#entries.size > this.#max) {
      for (const [entry, at] of this.#entries) {
        if (at <= now || this.#entries.size > this.#max) this.#entries.delete(entry);
        else break;
      }
    }
    return true;
  }
}
