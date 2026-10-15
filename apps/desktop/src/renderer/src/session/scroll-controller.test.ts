import { describe, expect, it } from 'vitest';
import { JUMP_VISIBLE_GAP_PX, jumpVisible, RESNAP_GAP_PX, shouldResnap } from './scroll-controller';

describe('re-sticking after a gesture', () => {
  it('snaps back when the gesture stops near the bottom', () => {
    expect(shouldResnap(8)).toBe(true);
    expect(shouldResnap(RESNAP_GAP_PX)).toBe(true);
  });

  it('stays put when already at the bottom or further away', () => {
    expect(shouldResnap(0)).toBe(false);
    expect(shouldResnap(2)).toBe(false);
    expect(shouldResnap(RESNAP_GAP_PX + 1)).toBe(false);
    expect(shouldResnap(400)).toBe(false);
  });
});

describe('jump-to-latest visibility', () => {
  it('stays hidden while sticky, however far the content is', () => {
    expect(jumpVisible(true, 1000)).toBe(false);
  });

  it('stays hidden for a small nudge and shows once far from the bottom', () => {
    expect(jumpVisible(false, 40)).toBe(false);
    expect(jumpVisible(false, JUMP_VISIBLE_GAP_PX)).toBe(false);
    expect(jumpVisible(false, JUMP_VISIBLE_GAP_PX + 1)).toBe(true);
  });
});
