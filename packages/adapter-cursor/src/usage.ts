// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/usageLimits.ts（`cursorUsageResponseToLimits`、
// `readCursorUsageLimits`）与 packages/shared/src/usageLimits.ts（`CURSOR_USAGE_WINDOWS`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `rateLimits`（0.45.0 的按月窗口与额度名）；T3 读 Cursor CLI 的登录
// （~/.cursor/auth.json 或钥匙串里的 accessToken），Wevir 不读，而是像 @cursor/sdk 自己那样用登录铸出的 API Key 经
// `/auth/exchange_user_api_key` 换一个短期的 accessToken（只在内存里），再调同一个接口；三个窗口的名字用 Cursor 后台的说法。
//
// Cursor 的用量（cursor-event-mapping.md §2）：`DashboardService/GetCurrentPeriodUsage` 给本计费周期的百分比——总的、
// Auto + Composer 的、API 模型的（Cursor 后台的两份额度，总的不是第三份），周期结束时一起重置。百分比含赠送的额度
// （T3：spend / limit 不含）。

import { type AccountRateLimitWindow, accountRateLimits, isoTime } from '@wevir/runtime-adapter';

/** @cursor/sdk 的默认后端（它读 `CURSOR_BACKEND_URL`，没有时用这个）。 */
export const DEFAULT_CURSOR_BACKEND_URL = 'https://api2.cursor.sh';
/** 读用量的时限（T3：10 s，换令牌与读用量合计）。 */
export const USAGE_TIMEOUT_MS = 10_000;

/** 三个百分比各是哪个窗口（T3 的 CURSOR_USAGE_WINDOWS）。总的没有额度名。 */
const WINDOWS = [
  { field: 'totalPercentUsed' },
  { field: 'autoPercentUsed', scope: 'Auto + Composer' },
  { field: 'apiPercentUsed', scope: 'API' },
] as const;

/**
 * `GetCurrentPeriodUsage` 的 JSON（Connect 协议：字段是小驼峰，int64 是字符串）→ 用量窗口。没有任何百分比时（没有套餐
 * 用量的账号）是空的。
 */
export function cursorUsageRateLimits(response: unknown): AccountRateLimitWindow[] {
  if (typeof response !== 'object' || response === null) return [];
  const { billingCycleEnd, planUsage } = response as {
    billingCycleEnd?: unknown;
    planUsage?: Record<string, unknown>;
  };
  const end = Number(billingCycleEnd);
  const resetsAt =
    (typeof billingCycleEnd === 'string' || typeof billingCycleEnd === 'number') && end > 0
      ? isoTime(end)
      : undefined;
  if (typeof planUsage !== 'object' || planUsage === null) return [];
  const windows: AccountRateLimitWindow[] = [];
  for (const window of WINDOWS) {
    const usedPercent = planUsage[window.field];
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;
    windows.push({
      usedPercent,
      period: 'monthly',
      ...(resetsAt !== undefined && { resetsAt }),
      ...('scope' in window && { scope: window.scope }),
    });
  }
  return windows;
}

export interface CursorUsageRequest {
  apiKey: string;
  /** `CURSOR_BACKEND_URL`，没有时 `DEFAULT_CURSOR_BACKEND_URL`。 */
  backendUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 读用量：API Key 换 accessToken，再读本周期的用量。账号没有套餐用量时 undefined；网络、认证等失败时抛错（调用方留着上一次
 * 的值）。令牌与 Key 不进错误消息。
 */
export async function readCursorUsage(
  request: CursorUsageRequest,
): Promise<ReturnType<typeof accountRateLimits>> {
  const fetchImpl = request.fetch ?? fetch;
  const base = request.backendUrl.replace(/\/+$/, '');
  const signal = AbortSignal.timeout(request.timeoutMs ?? USAGE_TIMEOUT_MS);
  const exchange = await fetchImpl(`${base}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });
  if (!exchange.ok) throw new Error(`Cursor API key exchange failed with HTTP ${exchange.status}`);
  const { accessToken } = (await exchange.json()) as { accessToken?: unknown };
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Cursor API key exchange returned no access token');
  }
  const usage = await fetchImpl(`${base}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'connect-protocol-version': '1',
      'x-cursor-client-type': 'sdk',
    },
    body: '{}',
    signal,
  });
  if (!usage.ok) throw new Error(`Cursor usage request failed with HTTP ${usage.status}`);
  return accountRateLimits(cursorUsageRateLimits(await usage.json()));
}
