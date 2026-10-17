// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-core/src/server/usageLimits.ts（`clampPercent`、窗口的排序）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：输出 Wevir 的 `AccountState['rateLimits']`（0.45.0 的 `windows`，前两个同时放进 primary / secondary）；不做 T3 的
// unavailable / probeFailed 快照与回合里的合并，读不到时各适配器留着上一次的值。
//
// 订阅账号的用量窗口（domain-model §3.6）：Cursor、OpenCode、Grok、Antigravity 的适配器读到的窗口经这里变成账号状态的
// `rateLimits`。

import type { AccountRateLimitWindow, AccountState } from './types.js';

/** 百分比限制在 0–100；不是有限数时当 0。 */
export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** 时间（ISO 字符串或毫秒数）→ ISO；认不出时 undefined。 */
export function isoTime(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 窗口的先后（T3 的 WINDOW_KIND_ORDER）：短的在前，按月的其次，长度不明的最后；同样长的保持原来的顺序。 */
function rank(window: AccountRateLimitWindow): number {
  if (window.windowMinutes !== undefined) return window.windowMinutes;
  return window.period === 'monthly' ? 50_000 : 100_000;
}

/**
 * 窗口 → 账号的 `rateLimits`：全部窗口按长度排进 `windows`，前两个同时是 `primary` / `secondary`（旧客户端只认这两个）。
 * 没有窗口时 undefined。
 */
export function accountRateLimits(
  windows: readonly AccountRateLimitWindow[],
): AccountState['rateLimits'] | undefined {
  const sorted = windows
    .map((window, index) => ({
      window: { ...window, usedPercent: clampPercent(window.usedPercent) },
      index,
    }))
    .sort((a, b) => rank(a.window) - rank(b.window) || a.index - b.index)
    .map(({ window }) => window);
  const [primary, secondary] = sorted;
  if (primary === undefined) return undefined;
  return { primary, ...(secondary !== undefined && { secondary }), windows: sorted };
}
