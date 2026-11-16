import { describe, expect, it, vi } from 'vitest';
import { ThemeSceneGuard } from './theme-scene.js';

const id = 'wevir-theme-12345678-1234-1234-1234-123456789abc';
const url = `http://127.0.0.1:1234/files/token/backdrop.html?v=r1&theme-scene=1&theme-mount=${id}`;

describe('theme scene navigation identity', () => {
  it('binds before inline code runs and blocks rewritten paths, markers and cross-site requests by frame identity', () => {
    const failed = vi.fn();
    const guard = new ThemeSceneGuard(failed);
    guard.set({ id, url }, []);
    guard.begin(7, url, true);
    expect(guard.blocks(7, url)).toBe(false);
    expect(guard.blocks(7, 'http://127.0.0.1:9999/files/escape/backdrop.html')).toBe(true);
    expect(failed).toHaveBeenCalledExactlyOnceWith({ id, url });
    for (const next of [url, 'https://example.test', 'data:text/html,escape', 'about:blank'])
      expect(guard.blocks(7, next)).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('never treats an existing frame targeting another marked scene as a new first load', () => {
    const failed = vi.fn();
    const guard = new ThemeSceneGuard(failed);
    guard.set({ id, url }, []);
    guard.begin(7, url, true);
    const nextId = id.replace('abc', 'def');
    const nextUrl = url.replaceAll(id, nextId);
    guard.set({ id: nextId, url: nextUrl }, [7]);
    guard.begin(7, nextUrl, true);
    expect(guard.blocks(7, nextUrl)).toBe(true);
    expect(failed).toHaveBeenCalledExactlyOnceWith({ id, url });
    guard.begin(8, nextUrl, true);
    expect(guard.blocks(8, nextUrl)).toBe(false);
  });

  it('requires the registered mount URL and direct parent, leaving previews untouched', () => {
    const guard = new ThemeSceneGuard(vi.fn());
    guard.begin(1, url, true);
    expect(guard.blocks(1, 'http://127.0.0.1:1234/files/preview/page.html')).toBe(false);
    guard.set({ id, url }, []);
    guard.begin(2, url, false);
    guard.begin(3, url.replace('r1', 'r2'), true);
    expect(guard.blocks(2, 'about:blank')).toBe(false);
    expect(guard.blocks(3, 'about:blank')).toBe(false);
  });

  it('retains blocking during teardown but does not notify a released or replaced mount', () => {
    const failed = vi.fn();
    const guard = new ThemeSceneGuard(failed);
    guard.set({ id, url }, []);
    guard.begin(7, url, true);
    guard.set({ id }, [7]);
    expect(guard.blocks(7, 'about:blank')).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    const nextId = id.replace('abc', 'def'),
      nextUrl = url.replaceAll(id, nextId);
    guard.set({ id: nextId, url: nextUrl }, []);
    guard.begin(8, nextUrl, true);
    guard.fail(7);
    expect(guard.blocks(8, nextUrl)).toBe(false);
    expect(failed).not.toHaveBeenCalled();
  });
});
