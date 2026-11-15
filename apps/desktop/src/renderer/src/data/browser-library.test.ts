import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

describe('optional browser library', () => {
  it('keeps Host binding usable without IndexedDB and retries a later open', async () => {
    const open = vi.fn(() => {
      throw new Error('disabled');
    });
    vi.stubGlobal('indexedDB', { open });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = await import('./browser-library');
    await expect(
      library.bindBrowserLibrary('host_fixture', 'client_fixture'),
    ).resolves.toBeUndefined();
    await expect(
      library.bindBrowserLibrary('host_fixture', 'client_fixture'),
    ).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it.each(['blocked', 'timeout'] as const)(
    'bounds a %s upgrade and closes a late connection',
    async (failure) => {
      vi.useFakeTimers();
      const request = {} as IDBOpenDBRequest;
      const close = vi.fn();
      Object.assign(request, { result: { close, onversionchange: null } });
      const open = vi.fn(() => request);
      vi.stubGlobal('indexedDB', { open });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const library = await import('./browser-library');
      const binding = library.bindBrowserLibrary('host_fixture', 'client_fixture');
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'blocked') request.onblocked?.({} as IDBVersionChangeEvent);
      else await vi.advanceTimersByTimeAsync(5000);
      await expect(binding).resolves.toBeUndefined();
      request.onsuccess?.({} as Event);
      expect(close).toHaveBeenCalledOnce();
      const next = library.bindBrowserLibrary('host_fixture', 'client_fixture');
      await vi.advanceTimersByTimeAsync(0);
      request.onerror?.({} as Event);
      await next;
      expect(open).toHaveBeenCalledTimes(2);
    },
  );
});
