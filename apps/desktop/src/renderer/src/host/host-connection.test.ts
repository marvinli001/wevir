import { ConnectionLostError } from '@wevir/client-sdk';
import { CloseCode } from '@wevir/protocol';
import type { EffectCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hooks } from '../test-hooks.test-utils';
import { HostConnectionProvider } from './host-connection';

const h = vi.hoisted(() => ({ connect: vi.fn(), bind: vi.fn(), invalidate: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../test-hooks.test-utils')),
  useEffect: (effect: EffectCallback) => hooks.effects.push(effect),
  useMemo: (value: () => unknown) => value(),
}));
vi.mock('@wevir/client-sdk', async (original) => ({
  ...(await original<typeof import('@wevir/client-sdk')>()),
  WevirClient: { connect: h.connect },
}));
vi.mock('@/data/browser-library', () => ({
  bindBrowserLibrary: h.bind,
  invalidateBrowserLibrary: h.invalidate,
  watchBrowserLibrary: vi.fn(),
}));
vi.mock('@/platform/platform', () => ({ capabilities: () => ({ localHost: false }) }));
vi.mock('./error-text', () => ({ describeError: (error: Error) => error.message }));

afterEach(() => {
  hooks.reset();
  vi.resetAllMocks();
});
const hello = { hostId: 'host_fixture' };
function mount() {
  hooks.render(() =>
    HostConnectionProvider({
      children: null,
      source: {
        open: async () => ({
          identity: {
            clientId: 'client_fixture',
            deviceId: 'device_fixture',
            clientKind: 'desktop',
          },
          endpoint: { url: 'ws://synthetic.invalid', token: 'synthetic' },
          transport: vi.fn(),
        }),
      },
    }),
  );
  return hooks.effects[0]?.();
}
const fields = () =>
  hooks.values[0] as { view: { status: string; error?: string }; libraryStatus?: string };

describe('browser Host connection and optional storage', () => {
  it('reports authorization failure even when invalidating IndexedDB fails', async () => {
    const expired = new ConnectionLostError(
      undefined,
      CloseCode.UNAUTHORIZED,
      'Authorization expired',
    );
    h.connect.mockRejectedValue(expired);
    h.invalidate.mockRejectedValue(new Error('browser storage unavailable'));
    const cleanup = mount();
    try {
      await vi.waitFor(() =>
        expect(fields().view).toEqual({ status: 'failed', error: expired.message }),
      );
      expect(h.invalidate).toHaveBeenCalledOnce();
    } finally {
      cleanup?.();
    }
  });
  it('connects while IndexedDB is still opening and reports storage separately', async () => {
    let finish!: (ready: boolean) => void;
    h.bind.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    h.connect.mockResolvedValue({ hello, close: vi.fn() });
    const cleanup = mount();
    try {
      await vi.waitFor(() => expect(fields().view.status).toBe('connected'));
      expect(fields().libraryStatus).toBe('loading');
      finish(false);
      await vi.waitFor(() => expect(fields().libraryStatus).toBe('failed'));
      expect(fields().view.status).toBe('connected');
    } finally {
      cleanup?.();
    }
  });
  it('keeps the authorization error when storage invalidation fails after connection', async () => {
    const expired = new ConnectionLostError(
      undefined,
      CloseCode.UNAUTHORIZED,
      'Authorization expired',
    );
    h.bind.mockResolvedValue(true);
    h.invalidate.mockRejectedValue(new Error('browser storage unavailable'));
    h.connect.mockResolvedValue({ hello, close: vi.fn() });
    const cleanup = mount();
    try {
      await vi.waitFor(() => expect(fields().view.status).toBe('connected'));
      h.connect.mock.calls[0]?.[0].onStateChange({
        status: 'closed',
        error: expired,
      });
      await Promise.resolve();
      expect(fields().view).toEqual({ status: 'closed', error: expired.message });
    } finally {
      cleanup?.();
    }
  });
});
