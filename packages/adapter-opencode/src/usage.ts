// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/usageLimits.ts（`readOpenCodeGoUsageLimits`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `rateLimits`（0.45.0 的按月窗口）；三个窗口缺哪个就少报哪个（T3 要求
// 三个都在）；不算 T3 用来跨环境合并账号的凭据指纹。
//
// OpenCode Go 的用量（opencode-event-mapping.md §2）：OpenCode Go 是 OpenCode 自己的订阅，额度分 5 小时（rolling）、每周、每月
// 三个窗口，`GET https://opencode.ai/zen/go/v1/usage` 用 Go 的 API Key 读。Key 在 opencode 的 auth.json 里（`opencode auth login`
// 存的，`opencode-go` 一项），只读、不改；没有时用 `OPENCODE_API_KEY`（opencode 自己也是 auth.json 盖过环境变量）。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type AccountRateLimitWindow, accountRateLimits, isoTime } from '@wevir/runtime-adapter';

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
/** opencode 里 OpenCode Go 这个上游的 ID（auth.json 的键、`provider.list` 的 `connected`）。 */
export const OPENCODE_GO_PROVIDER = 'opencode-go';
/** 读用量的时限（T3：5 s）。 */
export const USAGE_TIMEOUT_MS = 5_000;

/** opencode 的 auth.json：`$XDG_DATA_HOME/opencode/auth.json`，默认 `~/.local/share/opencode/auth.json`（T3）。 */
export function openCodeAuthPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const dataHome =
    env.XDG_DATA_HOME?.trim() ||
    path.join(env.HOME?.trim() || env.USERPROFILE?.trim() || home, '.local', 'share');
  return path.join(dataHome, 'opencode', 'auth.json');
}

/** Go 的 API Key：auth.json（或 `OPENCODE_AUTH_CONTENT`）里 `opencode-go` 的 `api` 凭据，否则 `OPENCODE_API_KEY`。 */
export async function openCodeGoApiKey(
  env: NodeJS.ProcessEnv,
  read: (file: string) => Promise<string> = (file) => readFile(file, 'utf8'),
): Promise<string | undefined> {
  let contents = env.OPENCODE_AUTH_CONTENT;
  if (contents === undefined || contents.trim() === '') {
    try {
      contents = await read(openCodeAuthPath(env));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      contents = '{}';
    }
  }
  const auth = JSON.parse(contents) as Record<string, unknown> | null;
  const entry = auth?.[OPENCODE_GO_PROVIDER] as { type?: unknown; key?: unknown } | undefined;
  const key =
    entry?.type === 'api' && typeof entry.key === 'string' ? entry.key : env.OPENCODE_API_KEY;
  const trimmed = key?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

const WINDOWS = [
  { field: 'rolling', window: { windowMinutes: 5 * 60 } },
  { field: 'weekly', window: { windowMinutes: 7 * 24 * 60 } },
  { field: 'monthly', window: { period: 'monthly' } },
] as const;

/** 用量接口的 JSON → 用量窗口：`usage.rolling` / `weekly` / `monthly` 各是 `{ percent, resetsAt }`。 */
export function openCodeGoUsageWindows(response: unknown): AccountRateLimitWindow[] {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage;
  if (typeof usage !== 'object' || usage === null) return [];
  const windows: AccountRateLimitWindow[] = [];
  for (const { field, window } of WINDOWS) {
    const entry = usage[field] as { percent?: unknown; resetsAt?: unknown } | undefined;
    if (typeof entry?.percent !== 'number' || !Number.isFinite(entry.percent)) continue;
    const resetsAt = typeof entry.resetsAt === 'string' ? isoTime(entry.resetsAt) : undefined;
    windows.push({
      usedPercent: entry.percent,
      ...window,
      ...(resetsAt !== undefined && { resetsAt }),
    });
  }
  return windows;
}

export interface OpenCodeGoUsageRequest {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  readFile?: (file: string) => Promise<string>;
  timeoutMs?: number;
}

/**
 * 读 OpenCode Go 的用量。没有 Go 的 Key、Key 没有 Go 订阅（403，Zen 的 Key 也能接上游）时 undefined；读文件、网络等失败时
 * 抛错（调用方留着上一次的值）。Key 不进错误消息。
 */
export async function readOpenCodeGoUsage(
  request: OpenCodeGoUsageRequest,
): Promise<ReturnType<typeof accountRateLimits>> {
  const apiKey = await openCodeGoApiKey(request.env, request.readFile);
  if (apiKey === undefined) return undefined;
  const response = await (request.fetch ?? fetch)(OPENCODE_GO_USAGE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(request.timeoutMs ?? USAGE_TIMEOUT_MS),
  });
  if (response.status === 403) return undefined;
  if (!response.ok)
    throw new Error(`OpenCode Go usage request failed with HTTP ${response.status}`);
  return accountRateLimits(openCodeGoUsageWindows(await response.json()));
}
