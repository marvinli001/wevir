import { describe, expect, it } from 'vitest';
import {
  JUMP_VISIBLE_GAP_PX,
  jumpVisible,
  RESNAP_GAP_PX,
  shouldFollow,
  shouldResnap,
} from './scroll-controller';

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

describe('following new content while sticky', () => {
  it('keeps following after input that cannot move the view up', () => {
    // 点一下、向下滚、横向滚：没有往上的输入，内容一长就跟。
    expect(shouldFollow(false, Number.POSITIVE_INFINITY, false)).toBe(true);
  });

  it('waits while the pointer is down or right after an upward gesture', () => {
    expect(shouldFollow(true, Number.POSITIVE_INFINITY, false)).toBe(false);
    expect(shouldFollow(false, 0, false)).toBe(false);
    expect(shouldFollow(false, 599, false)).toBe(false);
    expect(shouldFollow(false, 600, false)).toBe(true);
  });

  it('lets a smooth jump to latest finish', () => {
    expect(shouldFollow(false, Number.POSITIVE_INFINITY, true)).toBe(false);
  });
});
