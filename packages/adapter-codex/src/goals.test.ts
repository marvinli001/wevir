import { describe, expect, it } from 'vitest';
import { engineGoal, goalNotification } from './goals.js';
import type { ThreadGoal } from './protocol.js';

const goal: ThreadGoal = {
  threadId: 't-1',
  objective: '  补齐测试  ',
  status: 'budgetLimited',
  tokenBudget: 5000,
  tokensUsed: 5120,
  timeUsedSeconds: 42,
  createdAt: 1_791_000_000,
  updatedAt: 1_791_000_042,
};

describe('会话目标的映射', () => {
  it('Codex 的目标 → EngineGoal：状态转成下划线，秒级时间戳转成 ISO，目标去掉首尾空白', () => {
    expect(engineGoal(goal)).toEqual({
      objective: '补齐测试',
      status: 'budget_limited',
      tokenBudget: 5000,
      tokensUsed: 5120,
      timeUsedSeconds: 42,
      updatedAt: new Date(1_791_000_042_000).toISOString(),
    });
    expect(engineGoal({ ...goal, status: 'usageLimited', tokenBudget: null })).toMatchObject({
      status: 'usage_limited',
    });
    expect(engineGoal({ ...goal, tokenBudget: null })).not.toHaveProperty('tokenBudget');
  });

  it('空的目标与不认识的状态当作没有目标', () => {
    expect(engineGoal({ ...goal, objective: '   ' })).toBeNull();
    expect(engineGoal({ ...goal, status: 'archived' as never })).toBeNull();
  });

  it('通知：updated 带目标，cleared 是 null，别的通知与残缺的参数不算', () => {
    expect(
      goalNotification('thread/goal/updated', { threadId: 't-1', turnId: null, goal }),
    ).toEqual({ goal: engineGoal(goal) });
    expect(goalNotification('thread/goal/cleared', { threadId: 't-1' })).toEqual({ goal: null });
    expect(goalNotification('thread/goal/updated', { threadId: 't-1' })).toBeUndefined();
    expect(goalNotification('turn/started', { threadId: 't-1' })).toBeUndefined();
  });
});
