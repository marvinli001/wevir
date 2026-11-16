import type { AgentInput } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { GOAL_KICKOFF, goalKickoffInput } from './codex-adapter.js';
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

describe('goalKickoffInput', () => {
  it('目标前面接上开头，告诉模型目标已经设好、不要再调 create_goal（照 T3 #33260）', () => {
    expect(GOAL_KICKOFF).toBe(
      "This thread's goal is already set. Do not call create_goal. Start working on it now: ",
    );
    expect(goalKickoffInput({ content: [{ type: 'text', text: '修好登录' }] }, '修好登录')).toEqual(
      {
        content: [{ type: 'text', text: `${GOAL_KICKOFF}修好登录` }],
      },
    );
  });

  it('前面有接力摘要时插在目标紧前面；其余段落与协作模式不变', () => {
    const input: AgentInput = {
      content: [
        { type: 'text', text: 'Context handoff (...)\n\nUser message:\n修好登录' },
        { type: 'image', path: '/tmp/a.png', mimeType: 'image/png' },
        { type: 'text', text: '<reminder>' },
      ],
    };
    expect(goalKickoffInput(input, '修好登录').content).toEqual([
      { type: 'text', text: `Context handoff (...)\n\nUser message:\n${GOAL_KICKOFF}修好登录` },
      input.content[1],
      input.content[2],
    ]);
  });

  it('第一段文字不以目标结尾时原样交', () => {
    const input = { content: [{ type: 'text' as const, text: '别的' }] };
    expect(goalKickoffInput(input, '修好登录')).toBe(input);
  });
});
