import { describe, expect, it } from 'vitest';
import {
  compareProtocolVersions,
  MIN_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  PROTOCOL_VERSION,
  parseProtocolVersion,
} from './index.js';

describe('PROTOCOL_VERSION', () => {
  it('是 0.109.0，最低支持版本与它主版本相同且不更高', () => {
    expect(PROTOCOL_VERSION).toBe('0.109.0');
    expect(parseProtocolVersion(MIN_PROTOCOL_VERSION)?.major).toBe(
      parseProtocolVersion(PROTOCOL_VERSION)?.major,
    );
    expect(compareProtocolVersions(MIN_PROTOCOL_VERSION, PROTOCOL_VERSION)).toBeLessThanOrEqual(0);
  });
});

describe('negotiateProtocolVersion', () => {
  it('主版本相同时取较低的版本', () => {
    expect(negotiateProtocolVersion('0.1.0', '0.1.0', '0.1.0')).toEqual({
      ok: true,
      protocolVersion: '0.1.0',
    });
    expect(negotiateProtocolVersion('0.3.0', '0.2.5', '0.1.0')).toEqual({
      ok: true,
      protocolVersion: '0.2.5',
    });
    expect(negotiateProtocolVersion('0.2.0', '0.3.1', '0.1.0')).toEqual({
      ok: true,
      protocolVersion: '0.2.0',
    });
  });

  it('主版本不同拒绝', () => {
    expect(negotiateProtocolVersion('1.0.0', '0.9.0', '0.1.0')).toEqual({
      ok: false,
      reason: 'major_mismatch',
    });
  });

  it('低于最低支持版本拒绝', () => {
    expect(negotiateProtocolVersion('0.1.9', '0.4.0', '0.2.0')).toEqual({
      ok: false,
      reason: 'below_minimum',
    });
  });

  it('版本串不合法拒绝', () => {
    expect(negotiateProtocolVersion('0.1', '0.1.0', '0.1.0')).toEqual({
      ok: false,
      reason: 'invalid_version',
    });
  });

  it('按数值而不是字典序比较', () => {
    expect(compareProtocolVersions('0.11.0', '0.9.0')).toBeGreaterThan(0);
  });
});
