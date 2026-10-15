import type { SessionGoal } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { presentGoal } from './goal-model';

const goal: SessionGoal = {
  objective: '补齐测试',
  status: 'active',
  tokensUsed: 0,
  timeUsedSeconds: 0,
  updatedAt: '2026-10-15T08:00:00.000Z',
};

describe('presentGoal', () => {
  it('进行中：回合在跑时只能暂停；空闲时写成已设目标，也能继续', () => {
    expect(presentGoal(goal, true)).toEqual({
      title: '目标进行中',
      usage: undefined,
      canPause: true,
      canResume: false,
    });
    expect(presentGoal(goal, false)).toMatchObject({
      title: '已设目标',
      canPause: true,
      canResume: true,
    });
  });

  it('暂停、受阻与上限能继续；完成的只能清除', () => {
    for (const status of ['paused', 'blocked', 'usage_limited', 'budget_limited'] as const) {
      expect(presentGoal({ ...goal, status }, false)).toMatchObject({
        canPause: false,
        canResume: true,
      });
    }
    expect(presentGoal({ ...goal, status: 'complete' }, false)).toMatchObject({
      title: '目标已完成',
      canPause: false,
      canResume: false,
    });
  });

  it('用量：token（有预算时写成 已用 / 预算）与用时', () => {
    expect(presentGoal({ ...goal, tokensUsed: 18420, timeUsedSeconds: 312 }, true).usage).toBe(
      '18.4k token · 5 分 12 秒',
    );
    expect(presentGoal({ ...goal, tokensUsed: 900, tokenBudget: 200000 }, true).usage).toBe(
      '900 / 200k token',
    );
  });
});
