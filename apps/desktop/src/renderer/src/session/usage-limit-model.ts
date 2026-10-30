// 额度用完的卡片上“换模型继续”（0.143.0）的模型列表：同输入框的模型菜单（停用的、订阅没登录的不列，订阅来源在前），额度也用完了
// 的来源排到最后并标出来。会话当前的来源刚碰到上限，总是算用完。

import type { AccountRateLimitWindow, AccountState, ProviderProfile } from '@wevir/protocol';
import { accountOfProvider, isPickable, pickerOrder } from '@/data/sources';

/**
 * 账号的额度用完了没有：没有分份的窗口（5 小时、每周等）有一个用到 100% 且还没重置就算；窗口都分份（`scope`，如 Cursor 的几份
 * 额度）时要每一份都用完。读不到用量的不算。
 */
export function isExhausted(account: AccountState | undefined, now: number = Date.now()): boolean {
  const windows = rateLimitWindows(account).filter((window) => {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return Number.isNaN(resetsAt) || resetsAt > now;
  });
  if (windows.length === 0) return false;
  const full = (window: AccountRateLimitWindow) => window.usedPercent >= 100;
  const whole = windows.filter((window) => window.scope === undefined);
  return whole.length > 0 ? whole.some(full) : windows.every(full);
}

/** 换模型继续能选的来源与其中额度用完的：可用的在前，用完的在后，各自保持模型菜单的顺序。 */
export function switchTargets(
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
  currentProviderId: string,
  now: number = Date.now(),
): { providers: ProviderProfile[]; exhausted: ReadonlySet<string> } {
  const listed = pickerOrder(
    providers.filter(
      (provider) => provider.id === currentProviderId || isPickable(provider, accounts),
    ),
  );
  const exhausted = new Set(
    listed
      .filter(
        (provider) =>
          provider.id === currentProviderId ||
          isExhausted(accountOfProvider(provider, accounts), now),
      )
      .map((provider) => provider.id),
  );
  return {
    providers: [
      ...listed.filter((provider) => !exhausted.has(provider.id)),
      ...listed.filter((provider) => exhausted.has(provider.id)),
    ],
    exhausted,
  };
}

function rateLimitWindows(account: AccountState | undefined): AccountRateLimitWindow[] {
  const limits = account?.rateLimits;
  if (limits === undefined) return [];
  if (limits.windows !== undefined && limits.windows.length > 0) return [...limits.windows];
  return [limits.primary, limits.secondary].filter(
    (window): window is AccountRateLimitWindow => window !== undefined,
  );
}
