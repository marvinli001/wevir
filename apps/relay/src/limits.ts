/** 中继的限制。都可以用环境变量改（config.ts）。 */
export interface RelayLimits {
  /** 同时注册的路由 ID（Host）数。 */
  maxRoutes: number;
  /** 一个路由 ID 上同时的设备连接（等 Host 接上的与接通的合计）。 */
  maxConnectionsPerRoute: number;
  /** 所有 WebSocket 连接合计。 */
  maxConnections: number;
  /** 同一来源地址同时的 WebSocket 连接。 */
  maxConnectionsPerSource: number;
  /** 同一来源地址每分钟能发起的 WebSocket 升级。 */
  connectsPerMinutePerSource: number;
  /** 一条接通的连接每个方向的平均带宽（字节 / 秒）。超了暂停读那一侧，不丢消息。 */
  bytesPerSecond: number;
  /** 每个方向能一口气发的字节数（令牌桶的容量），至少放得下一个 4 MiB 的整帧。 */
  burstBytes: number;
  /** Host 接上之前，设备连接上最多排几条消息、多少字节；超了断开。 */
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  /** 对端的发送缓冲超过这么多字节时暂停读这一侧，等它发出去。 */
  highWaterBytes: number;
  /** 设备连上之后 Host 接上数据连接的时限。 */
  acceptTimeoutMs: number;
  /** Host 连上控制连接之后完成注册的时限。 */
  registerTimeoutMs: number;
  /** 多久 ping 一次每条连接；上一次的 ping 没有回 pong 就断开。 */
  pingIntervalMs: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_RELAY_LIMITS: RelayLimits = Object.freeze({
  maxRoutes: 10_000,
  maxConnectionsPerRoute: 32,
  maxConnections: 20_000,
  maxConnectionsPerSource: 64,
  connectsPerMinutePerSource: 60,
  bytesPerSecond: 2 * MiB,
  burstBytes: 8 * MiB,
  maxQueuedMessages: 8,
  maxQueuedBytes: 256 * 1024,
  highWaterBytes: 8 * MiB,
  acceptTimeoutMs: 10_000,
  registerTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
});

/** 令牌桶：按 `rate` 字节 / 秒补充，最多 `capacity`。可以透支，透支时 `waitMs()` 给出补回来要等多久。 */
export class TokenBucket {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #now: () => number;
  #tokens: number;
  #at: number;

  constructor(rate: number, capacity: number, now: () => number = Date.now) {
    this.#rate = rate;
    this.#capacity = capacity;
    this.#now = now;
    this.#tokens = capacity;
    this.#at = now();
  }

  take(bytes: number): void {
    this.#refill();
    this.#tokens -= bytes;
  }

  waitMs(): number {
    this.#refill();
    return this.#tokens >= 0 ? 0 : Math.ceil((-this.#tokens / this.#rate) * 1000);
  }

  #refill(): void {
    const now = this.#now();
    this.#tokens = Math.min(this.#capacity, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
    this.#at = now;
  }
}

/** 记着的来源地址数的上限；超了丢掉最早的。 */
const MAX_TRACKED_SOURCES = 65_536;

interface SourceState {
  open: number;
  connects: number[];
}

/** 按来源地址的连接数与发起频率。只在内存里。 */
export class SourceLimiter {
  readonly #limits: Pick<RelayLimits, 'maxConnectionsPerSource' | 'connectsPerMinutePerSource'>;
  readonly #now: () => number;
  readonly #sources = new Map<string, SourceState>();

  constructor(
    limits: Pick<RelayLimits, 'maxConnectionsPerSource' | 'connectsPerMinutePerSource'>,
    now: () => number = Date.now,
  ) {
    this.#limits = limits;
    this.#now = now;
  }

  /** 能不能再开一条；能的话占一个名额，连接关闭时调用返回的函数。 */
  begin(source: string): (() => void) | undefined {
    const now = this.#now();
    let state = this.#sources.get(source);
    if (state === undefined) {
      if (this.#sources.size >= MAX_TRACKED_SOURCES) this.#evict();
      state = { open: 0, connects: [] };
      this.#sources.set(source, state);
    }
    state.connects = state.connects.filter((at) => now - at < 60_000);
    if (state.open >= this.#limits.maxConnectionsPerSource) return undefined;
    if (state.connects.length >= this.#limits.connectsPerMinutePerSource) return undefined;
    state.connects.push(now);
    state.open += 1;
    const tracked = state;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      tracked.open -= 1;
    };
  }

  #evict(): void {
    for (const [source, state] of this.#sources) {
      if (state.open === 0) {
        this.#sources.delete(source);
        return;
      }
    }
  }
}
