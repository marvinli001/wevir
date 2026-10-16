import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fitWindowState,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  WINDOW_STATE_FILE,
} from './window-state.js';

const MIN = { width: 960, height: 600 };
const MAIN = { x: 0, y: 25, width: 1512, height: 920 };
const SIDE = { x: 1512, y: 0, width: 1920, height: 1055 };

describe('parseWindowState', () => {
  it('keeps a valid state and drops unknown fields', () => {
    expect(
      parseWindowState({ x: 10, y: 40, width: 1400, height: 900, maximized: true, extra: 1 }),
    ).toEqual({ x: 10, y: 40, width: 1400, height: 900, maximized: true });
    expect(parseWindowState({ width: 1400, height: 900 })).toEqual({
      width: 1400,
      height: 900,
      maximized: false,
    });
  });

  it('drops a half position and rejects bad sizes', () => {
    expect(parseWindowState({ x: 10, width: 1400, height: 900 })).toEqual({
      width: 1400,
      height: 900,
      maximized: false,
    });
    expect(parseWindowState(null)).toBeUndefined();
    expect(parseWindowState({ width: 0, height: 900 })).toBeUndefined();
    expect(parseWindowState({ width: 1400.5, height: 900 })).toBeUndefined();
    expect(parseWindowState({ width: '1400', height: 900 })).toBeUndefined();
  });
});

describe('fitWindowState', () => {
  it('keeps a window that is on a display', () => {
    const state = { x: 100, y: 80, width: 1300, height: 800, maximized: false };
    expect(fitWindowState(state, [MAIN], MIN)).toEqual(state);
    const onSide = { x: 1700, y: 100, width: 1600, height: 900, maximized: true };
    expect(fitWindowState(onSide, [MAIN, SIDE], MIN)).toEqual(onSide);
  });

  it('centres a window whose display is gone', () => {
    const state = { x: 1700, y: 100, width: 1600, height: 900, maximized: false };
    expect(fitWindowState(state, [MAIN], MIN)).toEqual({
      width: 1512,
      height: 900,
      maximized: false,
    });
  });

  it('centres a window whose title bar is off screen', () => {
    expect(
      fitWindowState({ x: 100, y: -500, width: 1000, height: 700, maximized: false }, [MAIN], MIN),
    ).toEqual({ width: 1000, height: 700, maximized: false });
  });

  it('clamps the size between the minimum and the largest work area', () => {
    expect(fitWindowState({ width: 400, height: 300, maximized: false }, [MAIN], MIN)).toEqual({
      width: 960,
      height: 600,
      maximized: false,
    });
    expect(fitWindowState({ width: 4000, height: 3000, maximized: false }, [MAIN], MIN)).toEqual({
      width: 1512,
      height: 920,
      maximized: false,
    });
  });
});

describe('loadWindowState / saveWindowState', () => {
  it('round-trips through the file and ignores a broken one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wevir-window-'));
    try {
      expect(loadWindowState(dir)).toBeUndefined();
      const state = { x: 5, y: 30, width: 1200, height: 760, maximized: false };
      await saveWindowState(dir, state);
      expect(loadWindowState(dir)).toEqual(state);
      expect(JSON.parse(await readFile(join(dir, WINDOW_STATE_FILE), 'utf8'))).toEqual(state);
      await writeFile(join(dir, WINDOW_STATE_FILE), '{not json');
      expect(loadWindowState(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
