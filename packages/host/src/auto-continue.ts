import {
  type AccountRateLimitWindow,
  type AccountState,
  AUTO_CONTINUE_MAX_WAIT_MS,
  type SessionId,
  type UsageLimit,
} from '@wevir/protocol';

// 额度恢复后自动继续（0.119.0，domain-model §3.54）：回合因订阅账号的用量上限失败时，消息流里的卡片可以勾选“额度恢复后自动继续”，
// Host 在额度恢复之后替用户发一条固定的继续消息（`from.usageLimit`，客户端不显示），照 Claude Code 桌面版。这里是与会话无关的部分：
// 补重置时刻、算发出的时刻、按墙上时钟等。会话这边（写事件、发消息）在 session-manager.ts。

/** 交给引擎的继续消息，同 Claude Code 的原文：模型从停下的地方接着做，不重发用户上一条消息。 */
export const AUTO_CONTINUE_PROMPT =
  'I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.';

/** 重置之后再等一会儿才发：服务端窗口的边界与本机时钟有出入，早了又会碰到上限。 */
export const AUTO_CONTINUE_DELAY_MS = 30_000;

/** 计时器一次最多睡多久：电脑睡眠时计时器不走，醒来之后最迟这么久按墙上时钟重新算。 */
const MAX_TICK_MS = 60_000;

/**
 * 引擎报的用量上限 → 事件里的 `usageLimit`：引擎没报重置时刻时，从账号最近的用量里取用完的窗口（用到 100%、知道何时重置）中最晚
 * 重置的那个，窗口长度跟着它。都没有时原样返回。
 */
export function completeUsageLimit(
  limit: { resetsAt?: string; windowMinutes?: number },
  account: AccountState | undefined,
): UsageLimit {
  const known = isoOrUndefined(limit.resetsAt);
  if (known !== undefined) {
    return {
      resetsAt: known,
      ...(limit.windowMinutes !== undefined && { windowMinutes: limit.windowMinutes }),
    };
  }
  let latest: { window: AccountRateLimitWindow; at: number } | undefined;
  for (const window of rateLimitWindows(account)) {
    const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (window.usedPercent < 100 || Number.isNaN(at)) continue;
    if (latest === undefined || at > latest.at) latest = { window, at };
  }
  const windowMinutes = limit.windowMinutes ?? latest?.window.windowMinutes;
  return {
    ...(latest !== undefined && { resetsAt: new Date(latest.at).toISOString() }),
    ...(windowMinutes !== undefined && { windowMinutes }),
  };
}

/**
 * 什么时候发继续消息：重置之后 `delayMs`（默认 `AUTO_CONTINUE_DELAY_MS`），已经重置过的从现在算。重置在
 * `AUTO_CONTINUE_MAX_WAIT_MS` 之后（每周额度）或不知道时 undefined，不能开。
 */
export function resumeAtFor(
  resetsAt: string | undefined,
  now: number,
  delayMs: number = AUTO_CONTINUE_DELAY_MS,
): string | undefined {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (Number.isNaN(at) || at - now > AUTO_CONTINUE_MAX_WAIT_MS) return undefined;
  return new Date(Math.max(at, now) + delayMs).toISOString();
}

/**
 * 每个会话一个到点就发的计时器。按墙上时钟：一次最多睡 `MAX_TICK_MS`，醒来看 `Date.now()` 到没到，电脑睡过头的醒来后很快补上。
 * `fire` 只调一次，之后这个会话的计时器就没了。
 */
export class AutoContinueTimers {
  readonly #timers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  readonly #fire: (sessionId: SessionId) => void;
  readonly #now: () => number;

  constructor(fire: (sessionId: SessionId) => void, now: () => number = Date.now) {
    this.#fire = fire;
    this.#now = now;
  }

  /** 排上（替换这个会话原来的）。 */
  set(sessionId: SessionId, resumeAt: string): void {
    this.clear(sessionId);
    const at = Date.parse(resumeAt);
    if (Number.isNaN(at)) return;
    const tick = () => {
      const remaining = at - this.#now();
      if (remaining <= 0) {
        this.#timers.delete(sessionId);
        this.#fire(sessionId);
        return;
      }
      const timer = setTimeout(tick, Math.min(remaining, MAX_TICK_MS));
      timer.unref?.();
      this.#timers.set(sessionId, timer);
    };
    tick();
  }

  clear(sessionId: SessionId): void {
    clearTimeout(this.#timers.get(sessionId));
    this.#timers.delete(sessionId);
  }

  has(sessionId: SessionId): boolean {
    return this.#timers.has(sessionId);
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}

function rateLimitWindows(account: AccountState | undefined): AccountRateLimitWindow[] {
  const limits = account?.rateLimits;
  if (limits === undefined) return [];
  if (limits.windows !== undefined && limits.windows.length > 0) return [...limits.windows];
  return [limits.primary, limits.secondary].filter(
    (window): window is AccountRateLimitWindow => window !== undefined,
  );
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}
