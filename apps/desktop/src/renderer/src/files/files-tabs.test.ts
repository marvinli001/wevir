import { describe, expect, it } from 'vitest';
import { closePath, NO_OPEN_FILES, openPath, pinAll, pinPath, treeSide } from './files-tabs';

describe('openPath', () => {
  it('replaces the preview tab on single click', () => {
    const first = openPath(NO_OPEN_FILES, 'a.ts', { preview: true });
    expect(first).toEqual({ paths: ['a.ts'], active: 'a.ts', preview: 'a.ts' });
    expect(openPath(first, 'b.ts', { preview: true })).toEqual({
      paths: ['b.ts'],
      active: 'b.ts',
      preview: 'b.ts',
    });
  });

  it('keeps pinned tabs and opens new ones after the active tab', () => {
    let state = openPath(NO_OPEN_FILES, 'a.ts', { preview: true, pin: true });
    state = openPath(state, 'b.ts', { preview: false });
    state = { ...state, active: 'a.ts' };
    state = openPath(state, 'c.ts', { preview: true });
    expect(state).toEqual({ paths: ['a.ts', 'c.ts', 'b.ts'], active: 'c.ts', preview: 'c.ts' });
  });

  it('pins an open preview tab on double click', () => {
    const state = openPath(NO_OPEN_FILES, 'a.ts', { preview: true });
    expect(openPath(state, 'a.ts', { preview: true, pin: true })).toEqual({
      paths: ['a.ts'],
      active: 'a.ts',
    });
  });

  it('switches to an already open file without changing the preview', () => {
    let state = openPath(NO_OPEN_FILES, 'a.ts', { preview: false });
    state = openPath(state, 'b.ts', { preview: true });
    expect(openPath(state, 'a.ts', { preview: true })).toEqual({
      paths: ['a.ts', 'b.ts'],
      active: 'a.ts',
      preview: 'b.ts',
    });
  });
});

describe('closePath', () => {
  it('activates the right neighbour, then the left one', () => {
    const state = { paths: ['a', 'b', 'c'], active: 'b' };
    expect(closePath(state, 'b')).toEqual({ paths: ['a', 'c'], active: 'c' });
    expect(closePath({ paths: ['a', 'b'], active: 'b' }, 'b')).toEqual({
      paths: ['a'],
      active: 'a',
    });
    expect(closePath({ paths: ['a'], active: 'a', preview: 'a' }, 'a')).toEqual({ paths: [] });
  });
});

describe('pinning', () => {
  it('pins only the preview tab', () => {
    const state = { paths: ['a', 'b'], active: 'a', preview: 'b' };
    expect(pinPath(state, 'a')).toBe(state);
    expect(pinPath(state, 'b')).toEqual({ paths: ['a', 'b'], active: 'a' });
    expect(pinAll(state)).toEqual({ paths: ['a', 'b'], active: 'a' });
  });
});

describe('treeSide', () => {
  it('puts the tree against the nearer window edge in automatic mode', () => {
    expect(treeSide('auto', { left: 900, width: 400 }, 1400)).toBe('right');
    expect(treeSide('auto', { left: 0, width: 400 }, 1400)).toBe('left');
    expect(treeSide('auto', undefined, 1400)).toBe('right');
    expect(treeSide('left', { left: 900, width: 400 }, 1400)).toBe('left');
  });
});
