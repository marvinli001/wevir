import { describe, expect, it } from 'vitest';
import { retryExpiredMessage, retryRateLimited } from './retry-budget.js';

describe('retryRateLimited', () => {
  it.each([
    'rate_limit (HTTP 429)',
    'unexpected status 429 Too Many Requests: {"error":"slow down"}',
    'Too many requests',
  ])('请求太多：%s', (reason) => {
    expect(retryRateLimited(reason)).toBe(true);
  });

  it.each([
    undefined,
    'stream disconnected before completion',
    'unexpected status 503 Service Unavailable',
    'read 4290 bytes then the connection reset',
  ])('别的原因：%s', (reason) => {
    expect(retryRateLimited(reason)).toBe(false);
  });
});

describe('retryExpiredMessage', () => {
  it('写出时限与最后一次重试的原因', () => {
    expect(retryExpiredMessage(600_000, 'HTTP 503')).toBe(
      'Stopped the turn: the model service was still being retried after 10 minutes. The last error was: HTTP 503',
    );
    expect(retryExpiredMessage(50, undefined)).toBe(
      'Stopped the turn: the model service was still being retried after 1 minute.',
    );
  });
});
