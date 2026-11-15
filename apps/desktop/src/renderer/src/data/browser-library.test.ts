import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

describe('optional browser library', () => {
  it('does not treat an unavailable bound draft as an empty draft', async () => {
    vi.useFakeTimers();
    const request = {} as IDBOpenDBRequest;
    vi.stubGlobal('indexedDB', { open: () => request });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = await import('./browser-library');
    const binding = library.bindBrowserLibrary('host_fixture', 'client_fixture');
    await vi.advanceTimersByTimeAsync(0);
    try {
      await expect(
        library.browserDrafts.readState('host_fixture/client_fixture/ses_fixture'),
      ).rejects.toThrow('unavailable');
    } finally {
      request.onblocked?.({} as IDBVersionChangeEvent);
      await binding;
    }
  });
  it('keeps Host binding usable without IndexedDB and retries a later open', async () => {
    const open = vi.fn(() => {
      throw new Error('disabled');
    });
    vi.stubGlobal('indexedDB', { open });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = await import('./browser-library');
    await expect(library.bindBrowserLibrary('host_fixture', 'client_fixture')).resolves.toBe(false);
    await expect(library.bindBrowserLibrary('host_fixture', 'client_fixture')).resolves.toBe(false);
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
      await expect(binding).resolves.toBe(false);
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
