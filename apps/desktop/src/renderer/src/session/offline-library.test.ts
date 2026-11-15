import type { EffectCallback } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hooks } from '../test-hooks.test-utils';
import { OfflineLibrary } from './offline-library';

const h = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn().mockResolvedValue(undefined) }));
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
    client: { can: () => true, hello: { hostId: 'host_fixture' } },
    view: { status: 'connected' },
    identity: { clientId: 'client_fixture' },
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
  it('enables composition and retries draft persistence after a failed read', async () => {
    select();
    await vi.waitFor(() => expect(hooks.values[5]).toBe(true));
    expect(hooks.values[6]).toBe('host_fixture/client_fixture/ses_fixture');
    render();
    hooks.effects[3]?.();
    expect(h.write).toHaveBeenCalledWith('host_fixture/client_fixture/ses_fixture', {
      text: 'Local edit',
      uncertain: false,
    });
  });
  it('clears the previous conversation error before reading another draft', () => {
    const cleanup = select();
    expect(hooks.values[8]).toBeUndefined();
    cleanup?.();
  });
});
