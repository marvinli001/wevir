// 额度：Copilot 不经 ACP 报用量，但订阅了原始会话事件（engine.ts 的 `clientCapabilitiesMeta`）后，每次调模型后的
// `assistant.usage` 带 `quotaSnapshots`（1.0.103 的 session-events.schema.json：按额度名，`entitlementRequests`、`usedRequests`、
// `remainingPercentage`、`resetDate`、`isUnlimitedEntitlement`）。这些字段在 schema 里标着 internal，没有公开文档；读不懂就不报。
// 按月重置（计费周期），所以窗口是 `period: 'monthly'`；无限额度的不列。

import type { AccountState } from '@wevir/runtime-adapter';
import { record } from './models.js';

type RateLimits = NonNullable<AccountState['rateLimits']>;
type Window = NonNullable<RateLimits['windows']>[number];

/** 已知的额度名 → 界面上的说法（产品名，原样显示）。 */
const SCOPES: Readonly<Record<string, string>> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Completions',
};

/** 额度名的先后：高级请求在前。 */
const ORDER = ['premium_interactions', 'chat', 'completions'];

/** `assistant.usage` 事件的 `data.quotaSnapshots` → 用量窗口；没有可报的时 undefined。 */
export function copilotRateLimits(snapshots: unknown): RateLimits | undefined {
  const entries = Object.entries(record(snapshots) ?? {}).sort(
    ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b),
  );
  const windows: Window[] = [];
  for (const [name, value] of entries) {
    const snapshot = record(value);
    if (snapshot === undefined || snapshot.isUnlimitedEntitlement === true) continue;
    const used = usedPercent(snapshot);
    if (used === undefined) continue;
    const resetsAt = isoTime(snapshot.resetDate);
    windows.push({
      usedPercent: used,
      period: 'monthly',
      scope: SCOPES[name] ?? name,
      ...(resetsAt !== undefined && { resetsAt }),
    });
  }
  if (windows.length === 0) return undefined;
  return {
    windows,
    ...(windows[0] !== undefined && { primary: windows[0] }),
    ...(windows[1] !== undefined && { secondary: windows[1] }),
  };
}

/** 原始会话事件（`github.com/copilot/sessionEvent` 的参数）里的额度；不是 `assistant.usage` 或没有额度时 undefined。 */
export function rateLimitsOfEvent(params: unknown): RateLimits | undefined {
  const event = record(params);
  if (event?.type !== 'assistant.usage') return undefined;
  return copilotRateLimits(record(event.data)?.quotaSnapshots);
}

function rank(name: string): number {
  const index = ORDER.indexOf(name);
  return index === -1 ? ORDER.length : index;
}

function usedPercent(snapshot: Record<string, unknown>): number | undefined {
  const remaining = snapshot.remainingPercentage;
  if (typeof remaining === 'number' && Number.isFinite(remaining)) {
    return clamp(100 - remaining);
  }
  const total = snapshot.entitlementRequests;
  const used = snapshot.usedRequests;
  if (typeof total === 'number' && total > 0 && typeof used === 'number' && used >= 0) {
    return clamp((used / total) * 100);
  }
  return undefined;
}

function clamp(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
