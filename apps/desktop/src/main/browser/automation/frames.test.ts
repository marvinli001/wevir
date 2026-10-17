import { describe, expect, it } from 'vitest';
import { findFrame, frameNotFoundMessage, frameToTopPoint, type TabFrame } from './frames.js';
import type { SnapshotPage } from './snapshot-engine.js';

/** 每次量子 frame 时回答一个固定的位置。 */
function offsetPage(offset: { x: number; y: number; hit: boolean } | null): SnapshotPage & {
  scripts: string[];
} {
  const scripts: string[] = [];
  return {
    scripts,
    getURL: () => 'https://a.test/',
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      return offset;
    },
  };
}

function frame(id: string, url: string, name = '', page = offsetPage(null)): TabFrame {
  return { id, url, name, page };
}

describe('findFrame', () => {
  const frames = [
    frame('0', 'https://a.test/inner.html', 'inner'),
    frame('1', 'https://b.test/widget?x=1', ''),
    frame('1.0', 'https://c.test/deep', '0'),
  ];

  it('prefers the id, then the name, then a URL part', () => {
    expect(findFrame(frames, '1.0')?.id).toBe('1.0');
    expect(findFrame(frames, '0')?.id).toBe('0');
    expect(findFrame(frames, 'inner')?.id).toBe('0');
    expect(findFrame(frames, 'b.test/widget')?.id).toBe('1');
    expect(findFrame(frames, 'nothing')).toBeUndefined();
  });

  it('lists the frames when none matches', () => {
    expect(frameNotFoundMessage([], 'x')).toBe('The page has no frames, so there is no frame "x".');
    expect(frameNotFoundMessage(frames, 'x')).toContain('0 name="inner" https://a.test/inner.html');
  });
});

describe('frameToTopPoint', () => {
  it('adds the iframe offsets from the innermost frame out', async () => {
    const top = offsetPage({ x: 100, y: 50, hit: true });
    const outer = offsetPage({ x: 10, y: 5, hit: true });
    const frames = [frame('1', 'https://b.test/', '', outer), frame('1.2', 'https://c.test/')];
    await expect(frameToTopPoint(top, frames, '1.2', { x: 3, y: 4 })).resolves.toEqual({
      x: 113,
      y: 59,
      covered: false,
    });
    // 内层在外层 frame 里量第 2 个子 frame，外层在顶层量第 1 个。
    expect(outer.scripts[0]).toContain('window.frames[2]');
    expect(top.scripts[0]).toContain('window.frames[1]');
  });

  it('reports covered when a level hits something else', async () => {
    const top = offsetPage({ x: 0, y: 0, hit: false });
    await expect(frameToTopPoint(top, [], '0', { x: 1, y: 1 })).resolves.toEqual({
      x: 1,
      y: 1,
      covered: true,
    });
  });

  it('returns the point itself for the top page and null when a frame is gone', async () => {
    const top = offsetPage(null);
    await expect(frameToTopPoint(top, [], '', { x: 2, y: 3 })).resolves.toEqual({
      x: 2,
      y: 3,
      covered: false,
    });
    await expect(frameToTopPoint(top, [], '0', { x: 2, y: 3 })).resolves.toBeNull();
    await expect(frameToTopPoint(top, [], '0.1', { x: 2, y: 3 })).resolves.toBeNull();
  });
});
