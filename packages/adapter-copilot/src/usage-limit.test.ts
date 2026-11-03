import { describe, expect, it } from 'vitest';
import { classifyCopilotTurnError } from './engine.js';

describe('copilot 额度失败', () => {
  it.each([
    { code: -32603, message: 'quota_exceeded' },
    {
      code: -32603,
      message: 'Internal error',
      data: { details: "You've run out of your included AI credits for the month" },
    },
    { code: -32603, message: 'additional_spend_limit_reached' },
  ])('有依据的额度耗尽：%j', (error) => {
    expect(classifyCopilotTurnError(error)).toMatchObject({ category: 'provider', usageLimit: {} });
  });
  it.each([{ code: -32000, message: 'Authentication required' }, new Error('connection closed')])(
    '其他错误：%j',
    (error) => {
      expect(classifyCopilotTurnError(error)).not.toHaveProperty('usageLimit');
    },
  );
  it.each([
    { code: -32603, message: '429 rate limit exceeded' },
    { code: -32603, message: '402 billing error' },
    { code: -32603, message: 'session_quota_exceeded' },
    { code: -32603, message: 'quota snapshot unavailable' },
  ])('拿不准的错误保持原样：%j', (error) => {
    expect(classifyCopilotTurnError(error)).not.toHaveProperty('usageLimit');
  });
});
