import { describe, expect, it } from 'vitest';
import { moreChunks, moreWindow } from './more-list-model';

describe('moreWindow', () => {
  it('先列一段，不够一段时没有按钮', () => {
    expect(moreWindow(3, 5, 5, -1)).toEqual({ visible: 3, floor: 3, more: false, less: false });
    expect(moreWindow(5, 5, 5, -1)).toEqual({ visible: 5, floor: 5, more: false, less: false });
    expect(moreWindow(12, 5, 5, -1)).toEqual({ visible: 5, floor: 5, more: true, less: false });
  });

  it('每次多列一段，中途两个按钮都有，列完只剩收起', () => {
    expect(moreWindow(12, 5, 10, -1)).toEqual({ visible: 10, floor: 5, more: true, less: true });
    expect(moreWindow(12, 5, 15, -1)).toEqual({ visible: 12, floor: 5, more: false, less: true });
  });

  it('当前项在后面时至少列到它所在的那一段，收起也只收到那一段', () => {
    expect(moreWindow(20, 5, 5, 7)).toEqual({ visible: 10, floor: 10, more: true, less: false });
    expect(moreWindow(20, 5, 15, 7)).toEqual({ visible: 15, floor: 10, more: true, less: true });
    expect(moreWindow(12, 5, 5, 11)).toEqual({ visible: 12, floor: 12, more: false, less: false });
    expect(moreWindow(12, 5, 5, 4)).toEqual({ visible: 5, floor: 5, more: true, less: false });
  });

  it('列表变短时不超出', () => {
    expect(moreWindow(6, 5, 15, -1)).toEqual({ visible: 6, floor: 5, more: false, less: true });
  });
});

describe('moreChunks', () => {
  it('第一段之后按段切开', () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    expect(moreChunks(items, 5)).toEqual([
      { start: 5, items: [5, 6, 7, 8, 9] },
      { start: 10, items: [10, 11] },
    ]);
    expect(moreChunks(items.slice(0, 5), 5)).toEqual([]);
  });
});
