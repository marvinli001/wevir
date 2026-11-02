import { DEVICE_NAME_MAX_LENGTH } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { pickDeviceName } from './device-name';

describe('pickDeviceName', () => {
  it('uses the name the user gave the phone', () => {
    expect(pickDeviceName('Marvin’s iPhone', 'iPhone 15 Pro')).toBe('Marvin’s iPhone');
    expect(pickDeviceName('  Pixel 小李  ', 'Pixel 8')).toBe('Pixel 小李');
  });

  it('falls back to the model when the system only gives the device family', () => {
    expect(pickDeviceName('iPhone', 'iPhone 15 Pro')).toBe('iPhone 15 Pro');
    expect(pickDeviceName('iPad', 'iPad Air (5th generation)')).toBe('iPad Air (5th generation)');
    expect(pickDeviceName(null, 'Pixel 8')).toBe('Pixel 8');
    expect(pickDeviceName(' ', 'Pixel 8')).toBe('Pixel 8');
  });

  it('keeps the family name or a placeholder when nothing better is known', () => {
    expect(pickDeviceName('iPhone', null)).toBe('iPhone');
    expect(pickDeviceName(null, null)).toBe('Wevir Mobile');
  });

  it('cuts the name to the protocol limit', () => {
    expect(pickDeviceName('a'.repeat(DEVICE_NAME_MAX_LENGTH + 5), null)).toHaveLength(
      DEVICE_NAME_MAX_LENGTH,
    );
  });
});
