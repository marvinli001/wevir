import type { EffectCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findElement, hooks } from '../test-hooks.test-utils';
import { OfflineLibrary } from './offline-library';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
  request: vi.fn(),
  subscribe: vi.fn(),
  libraryStatus: undefined as string | undefined,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../test-hooks.test-utils')),
  useEffect: (effect: EffectCallback) => hooks.effects.push(effect),
  useCallback: (value: unknown) => value,
  useMemo: (value: () => unknown) => value(),
}));
vi.mock('@wevir/client-sdk', async (original) => ({
  ...(await original<typeof import('@wevir/client-sdk')>()),
  offlineTranscript: () => ({ messages: [] }),
}));
vi.mock('@/host/host-connection', () => ({
  describe: String,
  useHostConnection: () => ({
    client: {
      can: () => true,
      hello: { hostId: 'host_fixture' },
      request: h.request,
      subscribe: h.subscribe,
    },
    view: { status: 'connected' },
    identity: { clientId: 'client_fixture' },
    libraryStatus: h.libraryStatus,
  }),
}));
vi.mock('@/platform/platform', () => ({ capabilities: () => ({ localHost: false }) }));
vi.mock('@/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/data/browser-library', () => ({
  browserDrafts: { readState: h.read, writeState: h.write },
  browserConversations: vi.fn(),
  clearBrowserLibrary: vi.fn(),
  saveBrowserConversation: vi.fn(),
  watchBrowserLibrary: vi.fn(),
}));

afterEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  h.libraryStatus = undefined;
});
function render() {
  return hooks.render(OfflineLibrary);
}
function select() {
  hooks.reset([
    true,
    [],
    [],
    {
      hostId: 'host_fixture',
      clientId: 'client_fixture',
      session: { id: 'ses_fixture', title: 'Synthetic' },
      events: [],
    },
    'Local edit',
    false,
    undefined,
    false,
    'Previous error',
    false,
    false,
  ]);
  h.read.mockRejectedValue(new Error('Unavailable'));
  render();
  return hooks.effects[2]?.();
}
describe('offline library draft read failures', () => {
  it.each(['loading', 'failed'])(
    'defers cached session reconciliation while storage is %s',
    async (status) => {
      h.libraryStatus = status;
      select();
      h.request.mockResolvedValue({ session: { id: 'ses_fixture' } });
      h.subscribe.mockReturnValue({
        close: vi.fn(),
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      });
      const cleanup = hooks.effects[4]?.();
      try {
        expect(h.subscribe).not.toHaveBeenCalled();
      } finally {
        cleanup?.();
      }
      h.libraryStatus = 'ready';
      render();
      const readyCleanup = hooks.effects[4]?.();
      try {
        await Promise.resolve();
        expect(h.subscribe).toHaveBeenCalledOnce();
      } finally {
        readyCleanup?.();
      }
    },
  );
  it('reads the existing draft only after background Host binding is ready', async () => {
    h.libraryStatus = 'loading';
    select();
    await Promise.resolve();
    expect(h.read).not.toHaveBeenCalled();
    expect(hooks.values[5]).toBe(false);
    h.libraryStatus = 'ready';
    h.read.mockResolvedValue({ text: 'Existing persisted draft', uncertain: false });
    render();
    hooks.effects[2]?.();
    await vi.waitFor(() => expect(hooks.values[4]).toBe('Existing persisted draft'));
  });
  it('preserves an explicit edit while storage is rebound after a read failure', async () => {
    select();
    await vi.waitFor(() => expect(hooks.values[8]).toBe('portable.storageError'));
    const textarea = findElement(render(), (element) => element.props.value === 'Local edit');
    (textarea.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'Keep explicit edit' },
    });
    h.libraryStatus = 'loading';
    render();
    hooks.effects[2]?.();
    h.libraryStatus = 'ready';
    h.read.mockResolvedValue({ text: 'Previous stored text', uncertain: false });
    render();
    hooks.effects[2]?.();
    await vi.waitFor(() => expect(hooks.values[5]).toBe(true));
    expect(hooks.values[4]).toBe('Keep explicit edit');
  });
  it('preserves an unread draft until the user edits it after a failed read', async () => {
    select();
    await vi.waitFor(() => expect(hooks.values[8]).toBe('portable.storageError'));
    render();
    hooks.effects[3]?.();
    expect(h.write).not.toHaveBeenCalled();
    const textarea = findElement(render(), (element) => element.props.value === 'Local edit');
    (textarea.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'Edited after failure' },
    });
    render();
    hooks.effects[3]?.();
    expect(h.write).toHaveBeenCalledWith('host_fixture/client_fixture/ses_fixture', {
      text: 'Edited after failure',
      uncertain: false,
    });
  });
  it('clears the previous conversation error before reading another draft', () => {
    const cleanup = select();
    expect(hooks.values[8]).toBeUndefined();
    cleanup?.();
  });
});
