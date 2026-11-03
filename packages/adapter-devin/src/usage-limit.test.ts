import { describe, expect, it } from 'vitest';
import { classifyDevinTurnError } from './engine.js';

describe('devin 额度失败', () => {
  it.each([
    { code: -32603, message: 'Quota exhausted: usage quota has been exhausted' },
    { code: -32603, message: 'Internal error', data: { message: 'monthly acu limit reached' } },
  ])('有依据的额度耗尽：%j', (error) => {
    expect(classifyDevinTurnError(error)).toMatchObject({ category: 'provider', usageLimit: {} });
  });
  it.each([
    { code: -32000, message: 'Please log in to use Devin' },
    new Error('connection closed'),
  ])('其他错误：%j', (error) => {
    expect(classifyDevinTurnError(error)).not.toHaveProperty('usageLimit');
  });
  it.each([
    { code: -32603, message: 'Rate limited: try again later' },
    { code: -32603, message: '429 usage limit reached' },
    {
      code: -32603,
      message: 'resource exhausted',
      data: { 'cognition.ai/errorKind': 'resource_exhausted' },
    },
    { code: -32603, message: 'usage frozen by an administrator' },
  ])('拿不准的错误保持原样：%j', (error) => {
    expect(classifyDevinTurnError(error)).not.toHaveProperty('usageLimit');
  });
});
