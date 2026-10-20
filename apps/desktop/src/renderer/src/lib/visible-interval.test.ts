import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { everyWhileVisible } from './visible-interval';

/** 测试跑在 Node 上：给一个只有 visibilityState 与 visibilitychange 的 document。 */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

let doc: FakeDocument;

beforeEach(() => {
  vi.useFakeTimers();
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('everyWhileVisible', () => {
  it('看得见时按间隔调用', () => {
    const tick = vi.fn();
    const stop = everyWhileVisible(tick, 1000);
    vi.advanceTimersByTime(3500);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it('看不见时停下，重新看见时先调一次再接着计时', () => {
    const tick = vi.fn();
    const stop = everyWhileVisible(tick, 1000);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    doc.setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    doc.setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it('开始时就看不见：不计时，看见后才开始', () => {
    doc.visibilityState = 'hidden';
    const tick = vi.fn();
    const stop = everyWhileVisible(tick, 1000);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
    doc.setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it('停止后不再调用，也不再响应可见性变化', () => {
    const tick = vi.fn();
    const stop = everyWhileVisible(tick, 1000);
    stop();
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });
});
