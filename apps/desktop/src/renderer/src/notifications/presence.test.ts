import { describe, expect, it } from 'vitest';
import { PRESENCE_IDLE_MS, presenceActive } from './presence';

describe('presenceActive', () => {
  const base = { visible: true, focused: true, locked: false, lastInputAt: 1_000, now: 2_000 };

  it('is active only while the window is visible, focused, unlocked and recently used', () => {
    expect(presenceActive(base)).toBe(true);
    expect(presenceActive({ ...base, visible: false })).toBe(false);
    expect(presenceActive({ ...base, focused: false })).toBe(false);
    expect(presenceActive({ ...base, locked: true })).toBe(false);
    expect(presenceActive({ ...base, now: base.lastInputAt + PRESENCE_IDLE_MS })).toBe(false);
    expect(presenceActive({ ...base, now: base.lastInputAt + PRESENCE_IDLE_MS - 1 })).toBe(true);
  });
});
