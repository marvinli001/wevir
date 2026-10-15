import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPRINGS, settleTime, springAt, springCss, springEasing } from './spring-easing.js';

const themeCss = readFileSync(
  new URL('../src/renderer/src/styles/theme.css', import.meta.url),
  'utf8',
);

describe('spring easing', () => {
  it('theme.css carries the generated block', () => {
    expect(themeCss).toContain(springCss());
  });

  it('starts at 0 and settles at 1', () => {
    for (const spring of Object.values(SPRINGS)) {
      expect(springAt(spring, 0)).toBeCloseTo(0, 6);
      expect(springAt(spring, settleTime(spring) + 0.01)).toBeCloseTo(1, 2);
      const { easing, durationMs } = springEasing(spring);
      expect(easing).toMatch(/^linear\(0, .*, 1\)$/);
      expect(durationMs).toBeGreaterThan(0);
    }
  });

  it('snap is overdamped and never overshoots; bounce overshoots most', () => {
    const peak = (spring: (typeof SPRINGS)[keyof typeof SPRINGS]) => {
      let max = 0;
      for (let t = 0; t < 1; t += 0.001) max = Math.max(max, springAt(spring, t));
      return max;
    };
    expect(peak(SPRINGS.snap)).toBeLessThanOrEqual(1);
    expect(peak(SPRINGS.reveal)).toBeLessThan(1.03);
    expect(peak(SPRINGS.bounce)).toBeGreaterThan(peak(SPRINGS.press));
  });
});
