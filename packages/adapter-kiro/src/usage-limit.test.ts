import { describe, expect, it } from 'vitest';
import { classifyKiroTurnError } from './engine.js';

describe('kiro 额度失败', () => {
  it.each([
    { code: -32603, message: 'ServiceQuotaExceededError: MONTHLY_REQUEST_COUNT' },
    { code: -32603, message: 'Internal error', data: { details: 'MonthlyRequestCount' } },
    { code: -32603, message: 'Monthly request limit reached' },
  ])('有依据的额度耗尽：%j', (error) => {
    expect(classifyKiroTurnError(error)).toMatchObject({ category: 'provider', usageLimit: {} });
  });
  it.each([
    { code: -32603, message: 'Not logged in. Run kiro-cli login' },
    new Error('connection closed'),
  ])('其他错误：%j', (error) => {
    expect(classifyKiroTurnError(error)).not.toHaveProperty('usageLimit');
  });
  it.each([
    { code: -32603, message: '429 ThrottlingException' },
    { code: -32603, message: 'InsufficientModelCapacity' },
    { code: -32603, message: 'CreditConsumptionRateExceeded' },
    { code: -32603, message: 'ServiceQuotaExceededError' },
    { code: -32603, message: 'credits unavailable' },
  ])('拿不准的错误保持原样：%j', (error) => {
    expect(classifyKiroTurnError(error)).not.toHaveProperty('usageLimit');
  });
});
