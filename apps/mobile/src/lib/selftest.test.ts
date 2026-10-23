import { describe, expect, it } from 'vitest';
import { runNoiseSelfTest } from './selftest';

describe('runNoiseSelfTest', () => {
  it('completes both handshakes and reports timings', () => {
    const result = runNoiseSelfTest(1);
    expect(result.pairMs).toBeGreaterThanOrEqual(0);
    expect(result.reconnectMs).toBeGreaterThanOrEqual(0);
  });
});
