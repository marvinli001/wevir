import type { AccountRateLimitWindow, AccountState } from './entities.js';

export function rateLimitWindows(account: AccountState | undefined): AccountRateLimitWindow[] {
  const limits = account?.rateLimits;
  if (limits === undefined) return [];
  if (limits.windows !== undefined && limits.windows.length > 0) return [...limits.windows];
  return [limits.primary, limits.secondary].filter(
    (window): window is AccountRateLimitWindow => window !== undefined,
  );
}

/** 未分份的窗口任一用满即耗尽；全是 scoped 窗口时须每份都用满。读不到用量的不算。 */
export function isExhausted(account: AccountState | undefined, now: number = Date.now()): boolean {
  const windows = rateLimitWindows(account);
  if (windows.length === 0) return false;
  const full = (window: AccountRateLimitWindow) => {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return window.usedPercent >= 100 && (Number.isNaN(resetsAt) || resetsAt > now);
  };
  const whole = windows.filter((window) => window.scope === undefined);
  return whole.length > 0 ? whole.some(full) : windows.every(full);
}

/** 所有阻塞窗口恢复后才可用；分份额度任一份恢复即可。 */
export function exhaustionReset(
  account: AccountState | undefined,
  now = Date.now(),
): string | undefined {
  if (!isExhausted(account, now)) return undefined;
  const full = rateLimitWindows(account).filter(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) > now),
  );
  const whole = full.filter((window) => window.scope === undefined);
  const times = (whole.length ? whole : full).map((window) =>
    window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt),
  );
  if (whole.length && times.some((time) => !Number.isFinite(time))) return undefined;
  const known = times.filter(Number.isFinite);
  if (!known.length) return undefined;
  return new Date(whole.length ? Math.max(...known) : Math.min(...known)).toISOString();
}
