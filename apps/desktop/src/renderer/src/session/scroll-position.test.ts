import { afterEach, describe, expect, it } from 'vitest';
import { captureScrollPosition, restoreScrollPosition, scrollPositions } from './scroll-position';

function surface(top: number, blocks: { id: string; top: number; height: number }[]) {
  const container = {
    scrollTop: top,
    getBoundingClientRect: () => ({ top: 40 }),
  } as HTMLElement;
  const content = {
    dataset: { renderStart: 'first-message' },
    querySelectorAll: () =>
      blocks.map((block) => ({
        dataset: { messageId: block.id },
        getBoundingClientRect: () => ({
          top: 40 + block.top - container.scrollTop,
          bottom: 40 + block.top + block.height - container.scrollTop,
        }),
      })),
  } as unknown as HTMLElement;
  return { container, content };
}

afterEach(() => scrollPositions.clear());

describe('session reading position', () => {
  it('remembers the visible block, its offset and the expanded history window', () => {
    const { container, content } = surface(350, [
      { id: 'earlier', top: 0, height: 300 },
      { id: 'reading', top: 300, height: 400 },
    ]);
    expect(captureScrollPosition(container, content)).toEqual({
      top: 350,
      start: 'first-message',
      anchor: { id: 'reading', offset: -50 },
    });
  });

  it('restores each session independently after content above it changes', () => {
    const first = surface(350, [{ id: 'reading', top: 300, height: 400 }]);
    const second = surface(90, [{ id: 'other', top: 0, height: 500 }]);
    scrollPositions.set('first', captureScrollPosition(first.container, first.content));
    scrollPositions.set('second', captureScrollPosition(second.container, second.content));

    const returned = surface(0, [
      { id: 'reading', top: 460, height: 400 },
      { id: 'new-message', top: 860, height: 500 },
    ]);
    const saved = scrollPositions.get('first');
    if (!saved) throw new Error('missing reading position');
    restoreScrollPosition(returned.container, returned.content, saved);
    expect(returned.container.scrollTop).toBe(510);
    restoreScrollPosition(returned.container, returned.content, saved);
    expect(returned.container.scrollTop).toBe(510);
    expect(scrollPositions.get('second')?.top).toBe(90);
  });

  it('uses the saved offset when the anchored message was removed', () => {
    const before = surface(180, [{ id: 'removed', top: 0, height: 400 }]);
    const saved = captureScrollPosition(before.container, before.content);
    const after = surface(0, [{ id: 'replacement', top: 0, height: 800 }]);
    restoreScrollPosition(after.container, after.content, saved);
    expect(after.container.scrollTop).toBe(180);
  });
});
