import { describe, expect, it } from 'vitest';
import { classifyTurnError } from './engine.js';

describe('grok 额度失败', () => {
  it.each([{ code: -32003, message: 'Rate limited' }])('有依据的额度耗尽：%j', (error) => {
    expect(classifyTurnError(error)).toMatchObject({ category: 'provider', usageLimit: {} });
  });
  it.each([{ code: -32000, message: 'Authentication required' }, new Error('connection closed')])(
    '其他错误：%j',
    (error) => {
      expect(classifyTurnError(error)).not.toHaveProperty('usageLimit');
    },
  );
  it.each([
    {
      code: -32603,
      message: 'Internal error',
      data: { http_status: 429, message: 'Too many requests' },
    },
    { code: -32603, message: 'rate_limit' },
  ])('拿不准的错误保持原样：%j', (error) => {
    expect(classifyTurnError(error)).not.toHaveProperty('usageLimit');
  });
});
