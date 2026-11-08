import { describe, expect, it } from 'vitest';
import { distanceFromEnd, ScrollFollow, showsLatest } from './scroll-follow';

const at = (offset: number) => ({ contentHeight: 5000, offset, viewport: 800 });
const bottom = at(4200);
const far = at(1000);

describe('scroll follow', () => {
  it('measures the distance from the end and shows the latest button past 240 pt', () => {
    expect(distanceFromEnd(bottom)).toBe(0);
    expect(showsLatest(at(4200 - 240))).toBe(false);
    expect(showsLatest(at(4200 - 241))).toBe(true);
  });

  it('stops following when the user drags away and follows again near the end', () => {
    const scroll = new ScrollFollow();
    scroll.beginDrag();
    scroll.endDrag(far, 0);
    expect(scroll.following).toBe(false);
    scroll.beginDrag();
    scroll.endDrag(at(4100), 0);
    expect(scroll.following).toBe(true);
  });

  it('waits for the momentum to end after a flick', () => {
    const scroll = new ScrollFollow();
    scroll.beginDrag();
    scroll.endDrag(at(3000), 2);
    expect(scroll.sticks).toBe(false);
    scroll.momentumEnd(far);
    expect(scroll.following).toBe(false);
  });

  it('does not stick to the end while a finger is down or the list is coasting', () => {
    const scroll = new ScrollFollow();
    scroll.beginDrag();
    expect(scroll.following).toBe(true);
    expect(scroll.sticks).toBe(false);
    scroll.endDrag(at(4150), 1.5);
    expect(scroll.sticks).toBe(false);
    scroll.momentumEnd(at(4180));
    expect(scroll.sticks).toBe(true);
  });

  it('keeps following when the latest button is tapped while the list is still coasting', () => {
    const scroll = new ScrollFollow();
    scroll.beginDrag();
    scroll.endDrag(at(2000), 3);
    scroll.jump();
    expect(scroll.sticks).toBe(true);
    // The interrupted momentum still reports its end, with the offset from before the jump.
    scroll.momentumEnd(far);
    expect(scroll.following).toBe(true);
    // The animated scroll to the end reports another one.
    scroll.momentumEnd(bottom);
    expect(scroll.sticks).toBe(true);
  });

  it('ignores programmatic scrolls that end away from the bottom', () => {
    const scroll = new ScrollFollow();
    scroll.momentumEnd(far);
    expect(scroll.following).toBe(true);
  });

  it('stops following after a fold toggle until the user scrolls back down', () => {
    const scroll = new ScrollFollow();
    scroll.release();
    expect(scroll.sticks).toBe(false);
    scroll.beginDrag();
    scroll.endDrag({ contentHeight: 1000, offset: 400, viewport: 560 }, 0);
    expect(scroll.sticks).toBe(true);
  });
});
