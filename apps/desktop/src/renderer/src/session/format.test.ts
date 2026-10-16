import { describe, expect, it } from 'vitest';
import { formatMessageTime } from './format';

describe('formatMessageTime（0.38.0）', () => {
  const now = new Date(2026, 9, 15, 18, 0);
  const at = (month: number, day: number, year = 2026) =>
    new Date(year, month, day, 13, 21).toISOString();

  it('今天只写时刻，六天内写星期，今年内写月日，再早写完整日期', () => {
    expect(formatMessageTime(at(9, 15), 'zh-CN', now)).toBe('13:21');
    expect(formatMessageTime(at(9, 14), 'zh-CN', now)).toBe('星期三13:21');
    expect(formatMessageTime(at(9, 1), 'zh-CN', now)).toBe('10月1日 13:21');
    expect(formatMessageTime(at(9, 1, 2025), 'zh-CN', now)).toBe('2025年10月1日 13:21');
    expect(formatMessageTime(at(9, 14), 'en', now)).toBe('Wednesday 1:21 PM');
  });

  it('不是时间时是空的', () => {
    expect(formatMessageTime('x', 'zh-CN', now)).toBe('');
  });
});
