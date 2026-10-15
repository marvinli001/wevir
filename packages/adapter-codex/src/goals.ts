// 会话目标（0.35.0，codex-event-mapping.md §6.13）：Codex 的 thread 目标 ↔ 适配器的 `EngineGoal`。Codex 用驼峰的状态与秒级时间戳，
// Wevir 用下划线的状态与 ISO 时间。目标的通知（`thread/goal/updated` / `thread/goal/cleared`）不属于某个回合，回合之内或之间都可能。

import type { EngineGoal, EngineGoalStatus } from '@wevir/runtime-adapter';
import { isRecord } from './mapping.js';
import type { ThreadGoal, ThreadGoalStatus } from './protocol.js';

const STATUS_FROM_CODEX: Record<ThreadGoalStatus, EngineGoalStatus> = {
  active: 'active',
  paused: 'paused',
  blocked: 'blocked',
  usageLimited: 'usage_limited',
  budgetLimited: 'budget_limited',
  complete: 'complete',
};

/** Codex 的目标 → `EngineGoal`；目标是空的或状态不认识时 `null`（当作没有目标）。 */
export function engineGoal(goal: ThreadGoal): EngineGoal | null {
  const objective = goal.objective.trim();
  const status = STATUS_FROM_CODEX[goal.status];
  if (objective === '' || status === undefined) return null;
  const tokenBudget = goal.tokenBudget ?? undefined;
  return {
    objective,
    status,
    ...(tokenBudget !== undefined && tokenBudget > 0 && { tokenBudget }),
    tokensUsed: Math.max(0, Math.trunc(goal.tokensUsed)),
    timeUsedSeconds: Math.max(0, Math.trunc(goal.timeUsedSeconds)),
    updatedAt: new Date(goal.updatedAt * 1000).toISOString(),
  };
}

/** 目标的通知：`thread/goal/updated` 带完整的目标，`thread/goal/cleared` 是清除（`null`）；别的通知 `undefined`。 */
export function goalNotification(
  method: string,
  params: unknown,
): { goal: EngineGoal | null } | undefined {
  if (method === 'thread/goal/cleared') return { goal: null };
  if (method !== 'thread/goal/updated' || !isRecord(params) || !isThreadGoal(params.goal)) {
    return undefined;
  }
  return { goal: engineGoal(params.goal) };
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return (
    isRecord(value) &&
    typeof value.objective === 'string' &&
    typeof value.status === 'string' &&
    typeof value.tokensUsed === 'number' &&
    typeof value.timeUsedSeconds === 'number' &&
    typeof value.updatedAt === 'number'
  );
}
