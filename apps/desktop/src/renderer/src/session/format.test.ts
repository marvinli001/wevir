import { describe, expect, it } from 'vitest';
import { formatElapsedShort, formatMessageTime } from './format';

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

describe('formatElapsedShort', () => {
  it('一分钟内写秒，之后只到分钟，一小时以上写时与分', () => {
    expect(formatElapsedShort(45_900)).toBe('45 秒');
    expect(formatElapsedShort(6 * 60_000 + 30_000)).toBe('6 分');
    expect(formatElapsedShort(65 * 60_000)).toBe('1 小时 5 分');
  });
});
