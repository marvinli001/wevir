// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/client-runtime/src/state/threadExecution.ts（presentProviderGoal）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：文案走 t()，token 用 Wevir 的 formatTokens，用时满 1 秒就写；进行中的目标多一个“暂停”，空闲时进行中的目标也能继续。
//
// 会话目标的横幅（0.35.0，desktop-tokens §48）：标题按状态，用量写 token 与用时，按钮按状态与回合给；会话空闲时进行中的目标
// 写成“已设目标”。

import type { GoalStatus, SessionGoal } from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';
import { formatTokens } from '@/layout/rail-model';
import { formatDuration } from './format';

const TITLES: Record<GoalStatus, PlainMessageKey> = {
  active: 'goal.status.active',
  paused: 'goal.status.paused',
  blocked: 'goal.status.blocked',
  usage_limited: 'goal.status.usageLimited',
  budget_limited: 'goal.status.budgetLimited',
  complete: 'goal.status.complete',
};

export interface GoalPresentation {
  title: string;
  /** token 与用时，`·` 隔开；都还没有时 undefined。 */
  usage: string | undefined;
  canPause: boolean;
  canResume: boolean;
}

/** `working`：会话有进行中的回合。 */
export function presentGoal(goal: SessionGoal, working: boolean): GoalPresentation {
  const usage: string[] = [];
  if (goal.tokensUsed > 0) {
    const tokens = formatTokens(goal.tokensUsed);
    usage.push(
      goal.tokenBudget === undefined
        ? t('goal.tokens', { tokens })
        : t('goal.tokensBudget', { tokens, budget: formatTokens(goal.tokenBudget) }),
    );
  }
  if (goal.timeUsedSeconds > 0) usage.push(formatDuration(goal.timeUsedSeconds * 1000));
  const active = goal.status === 'active';
  return {
    title: t(active && !working ? 'goal.status.set' : TITLES[goal.status]),
    usage: usage.length === 0 ? undefined : usage.join(' · '),
    canPause: active,
    // 空闲时进行中的目标（例如后台服务重启之后）也能继续：引擎随即接着做。
    canResume: goal.status !== 'complete' && !(active && working),
  };
}
