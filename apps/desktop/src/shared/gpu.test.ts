import { describe, expect, it } from 'vitest';
import { isLowGpu } from './gpu.js';

describe('GPU feature status', () => {
  it('只在合成与光栅化均有硬件加速时启用完整效果', () => {
    expect(isLowGpu({ gpu_compositing: 'enabled', rasterization: 'enabled_on' })).toBe(false);
    for (const disabled of [
      'disabled_software',
      'unavailable_software',
      'disabled_off',
      undefined,
    ]) {
      expect(isLowGpu({ gpu_compositing: disabled, rasterization: 'enabled' })).toBe(true);
      expect(isLowGpu({ gpu_compositing: 'enabled', rasterization: disabled })).toBe(true);
    }
  });
});
