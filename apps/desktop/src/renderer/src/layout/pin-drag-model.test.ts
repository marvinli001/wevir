import { describe, expect, it } from 'vitest';
import {
  applyPinDrop,
  dropTarget,
  inPinZone,
  PIN_ROW_PITCH,
  pinInsertIndex,
  pinLayout,
} from './pin-drag-model';

describe('pinInsertIndex', () => {
  it('过了第 i 行的中线插在它后面，夹在 0 到行数之间', () => {
    const top = 100;
    expect(pinInsertIndex(top - 50, top, 2)).toBe(0);
    expect(pinInsertIndex(top + PIN_ROW_PITCH / 2 - 1, top, 2)).toBe(0);
    expect(pinInsertIndex(top + PIN_ROW_PITCH / 2 + 1, top, 2)).toBe(1);
    expect(pinInsertIndex(top + PIN_ROW_PITCH * 1.5 + 1, top, 2)).toBe(2);
    expect(pinInsertIndex(top + 500, top, 2)).toBe(2);
    expect(pinInsertIndex(top + 10, top, 0)).toBe(0);
  });
});

describe('inPinZone', () => {
  const zone = { left: 0, right: 300, top: 50, bottom: 150 };
  it('组的矩形里，下沿多出一点也算', () => {
    expect(inPinZone({ x: 10, y: 60 }, zone)).toBe(true);
    expect(inPinZone({ x: 10, y: 160 }, zone)).toBe(true);
    expect(inPinZone({ x: 10, y: 170 }, zone)).toBe(false);
    expect(inPinZone({ x: 10, y: 40 }, zone)).toBe(false);
    expect(inPinZone({ x: 310, y: 60 }, zone)).toBe(false);
  });
});

describe('applyPinDrop', () => {
  it('拖进组里按位置置顶，组里拖动改顺序', () => {
    expect(applyPinDrop(['a', 'b'], 'c', { kind: 'pin', index: 1 })).toEqual(['a', 'c', 'b']);
    expect(applyPinDrop(['a', 'b'], 'c', { kind: 'pin', index: 9 })).toEqual(['a', 'b', 'c']);
    expect(applyPinDrop(['a', 'b', 'c'], 'a', { kind: 'pin', index: 2 })).toEqual(['b', 'c', 'a']);
  });

  it('放回原处、没置顶的拖到组外时不变（同一个数组）', () => {
    const pinned = ['a', 'b'];
    expect(applyPinDrop(pinned, 'a', { kind: 'pin', index: 0 })).toBe(pinned);
    expect(applyPinDrop(pinned, 'c', { kind: 'none' })).toBe(pinned);
  });

  it('置顶的拖到组外取消置顶', () => {
    expect(applyPinDrop(['a', 'b'], 'a', { kind: 'unpin' })).toEqual(['b']);
  });

  it('dropTarget：组里置顶，组外置顶的取消、没置顶的不变', () => {
    expect(dropTarget(true, 1, false)).toEqual({ kind: 'pin', index: 1 });
    expect(dropTarget(false, 1, true)).toEqual({ kind: 'unpin' });
    expect(dropTarget(false, 1, false)).toEqual({ kind: 'none' });
  });
});

describe('pinLayout', () => {
  it('不在拖时不让位', () => {
    expect(pinLayout(['a', 'b'], undefined)).toEqual({ shifts: [0, 0], gap: undefined, slots: 2 });
  });

  it('外面的会话拖进组：插入处之后的行下移一格', () => {
    expect(pinLayout(['a', 'b'], { sessionId: 'c', over: true, index: 1 })).toEqual({
      shifts: [0, 1],
      gap: 1,
      slots: 3,
    });
  });

  it('外面的会话在组外：不让位；组是空的时留一格', () => {
    expect(pinLayout(['a'], { sessionId: 'c', over: false, index: 0 })).toEqual({
      shifts: [0],
      gap: undefined,
      slots: 1,
    });
    expect(pinLayout([], { sessionId: 'c', over: false, index: 0 })).toEqual({
      shifts: [],
      gap: 0,
      slots: 1,
    });
  });

  it('组里改顺序：被拖的那一行移到空位，其余的补上', () => {
    // a 拖到 c 后面：b、c 上移一格，a 的空位在第 2 格。
    expect(pinLayout(['a', 'b', 'c'], { sessionId: 'a', over: true, index: 2 })).toEqual({
      shifts: [2, -1, -1],
      gap: 2,
      slots: 3,
    });
  });

  it('置顶的拖到组外：原来那一格留空', () => {
    expect(pinLayout(['a', 'b', 'c'], { sessionId: 'b', over: false, index: 0 })).toEqual({
      shifts: [0, 0, 0],
      gap: 1,
      slots: 3,
    });
  });
});
