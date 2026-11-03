import { describe, expect, it } from 'vitest';
import { classifyWorkBuddyTurnError } from './engine.js';

describe('workbuddy 额度失败', () => {
  it.each([
    { code: -32603, message: 'Internal error', data: { code: 14019 } },
    {
      code: -32603,
      message: 'Internal error',
      data: { 'codebuddy.ai/error': { businessCode: 14018 } },
    },
    { code: -32603, message: 'Internal error', data: { details: 'No available credits' } },
    { code: -32603, message: '额度已用尽' },
  ])('有依据的额度耗尽：%j', (error) => {
    expect(classifyWorkBuddyTurnError(error)).toMatchObject({
      category: 'provider',
      usageLimit: {},
    });
  });
  it.each([{ code: -32000, message: 'Authentication required' }, new Error('connection closed')])(
    '其他错误：%j',
    (error) => {
      expect(classifyWorkBuddyTurnError(error)).not.toHaveProperty('usageLimit');
    },
  );
  it.each([
    { code: -32603, message: '429 rate limit exceeded' },
    { code: -32603, message: 'RESOURCE_EXHAUSTED' },
    {
      code: -32603,
      message: 'Internal error',
      data: { 'codebuddy.ai/error': { code: 'usage_limit_exceeded', httpStatusCode: 429 } },
    },
    { code: -32603, message: 'Internal error', data: { code: 14017 } },
  ])('拿不准的错误保持原样：%j', (error) => {
    expect(classifyWorkBuddyTurnError(error)).not.toHaveProperty('usageLimit');
  });
});
