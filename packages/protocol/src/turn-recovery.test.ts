import { describe, expect, it } from 'vitest';
import { modelErrorRecovery } from './turn-recovery.js';

describe('modelErrorRecovery', () => {
  it('continues truncated output and retries temporary provider failures', () => {
    expect(
      modelErrorRecovery({
        category: 'provider',
        message: 'Incomplete response returned, reason: max_output_tokens',
      }),
    ).toBe('continue');
    for (const error of [
      { code: 503, message: 'Service unavailable' },
      { code: 429, message: 'Rate limit exceeded' },
      { message: 'API error (status 502 Bad Gateway)' },
      { message: 'stream disconnected before completion' },
      { message: 'error sending request for url (https://example.test/v1/responses)' },
      { message: 'connection timed out' },
    ]) {
      expect(modelErrorRecovery({ category: 'provider', ...error }), error.message).toBe('retry');
    }
  });

  it('does not retry errors that need credentials, credit, input changes or quota recovery', () => {
    for (const error of [
      { code: 401, message: 'Unauthorized' },
      { code: 400, message: 'Bad request' },
      { message: 'API error 403: server error' },
      { code: 429, message: 'insufficient_quota' },
      { code: 429, message: 'quota exhausted' },
      { code: 500, message: 'credit balance is too low' },
      { message: 'Incomplete response returned, reason: content_filter' },
      { message: 'context_length_exceeded' },
      { message: 'unknown provider failure' },
      { message: 'Rate limit exceeded', usageLimit: {} },
      { message: 'stream disconnected', fatal: true },
    ]) {
      expect(modelErrorRecovery({ category: 'provider', ...error }), error.message).toBeUndefined();
    }
    expect(modelErrorRecovery({ category: 'unknown', message: '503' })).toBeUndefined();
    expect(modelErrorRecovery({ category: 'missing_credentials', message: '503' })).toBeUndefined();
  });
});
