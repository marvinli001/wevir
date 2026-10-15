import { describe, expect, it } from 'vitest';
import { parseGoalCommand } from './goal-command';

describe('parseGoalCommand', () => {
  it('不带参数与 edit 是看目标；clear、pause、resume 不分大小写', () => {
    expect(parseGoalCommand('/goal')).toEqual({ type: 'show' });
    expect(parseGoalCommand('  /goal   ')).toEqual({ type: 'show' });
    expect(parseGoalCommand('/goal edit')).toEqual({ type: 'show' });
    expect(parseGoalCommand('/goal clear')).toEqual({ type: 'clear' });
    expect(parseGoalCommand('/goal PAUSE')).toEqual({ type: 'pause' });
    expect(parseGoalCommand('/goal Resume')).toEqual({ type: 'resume' });
  });

  it('其余文字是目标，去掉首尾空白，可以多行', () => {
    expect(parseGoalCommand('/goal  补齐登录页的测试 ')).toEqual({
      type: 'set',
      objective: '补齐登录页的测试',
    });
    expect(parseGoalCommand('/goal 第一步\n第二步')).toEqual({
      type: 'set',
      objective: '第一步\n第二步',
    });
    expect(parseGoalCommand('/goal pause the build')).toEqual({
      type: 'set',
      objective: 'pause the build',
    });
  });

  it('不是 /goal 开头的消息不算', () => {
    expect(parseGoalCommand('goal 补测试')).toBeUndefined();
    expect(parseGoalCommand('/goals 补测试')).toBeUndefined();
    expect(parseGoalCommand('请 /goal 补测试')).toBeUndefined();
  });
});
