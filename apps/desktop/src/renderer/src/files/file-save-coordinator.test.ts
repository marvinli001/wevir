// 移植自 T3 Code 的 fileSaveCoordinator.test.ts（MIT，ec1313c），换成布尔的 persist。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSaveCoordinator } from './file-save-coordinator';

function deferred() {
  let resolve: (ok: boolean) => void = () => {};
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('FileSaveCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces edits and persists only the latest contents', async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<boolean>>().mockResolvedValue(true);
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn(() => undefined);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change('first');
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change('latest');
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith('latest');
    expect(onConfirmed).toHaveBeenCalledWith('latest');
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('keeps pending state until an edit made during a write is also saved', async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<boolean>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(true);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: () => undefined,
    });

    coordinator.change('first');
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change('latest');
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(true);
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith('latest');
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it('saves an edit made inside the debounce window when the editor closes', async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<boolean>>().mockResolvedValue(true);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: () => undefined,
    });
    coordinator.change('unsaved');
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledWith('unsaved');
  });

  it('a failed write (conflict) stays pending', async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<boolean>>().mockResolvedValue(false);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: () => undefined,
    });
    coordinator.change('mine');
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();
    expect(onPendingChange.mock.calls).toEqual([[true]]);
  });
});
