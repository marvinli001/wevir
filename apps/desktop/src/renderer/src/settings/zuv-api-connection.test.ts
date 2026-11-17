import type { WevirClient } from '@wevir/client-sdk';
import type { ZuvApiState } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../components/ui/button';
import { findElement, hooks } from '../test-hooks.test-utils';
import { ZuvApiConnectionPanel } from './zuv-api-connection';

const platform = vi.hoisted(() => ({ localHost: true, openExternal: vi.fn(), refresh: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../test-hooks.test-utils')),
  useEffect: () => {},
}));
vi.mock('@/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/host/host-connection', () => ({ describe: (error: Error) => error.message }));
vi.mock('@/data/workbench-data', () => ({
  useWorkbenchStore: () => ({ refresh: platform.refresh }),
}));
vi.mock('@/platform/platform', () => ({
  capabilities: () => ({ localHost: platform.localHost }),
  platformApi: () => ({ openExternal: platform.openExternal }),
}));

const request = vi.fn();
const client = { request } as unknown as WevirClient;
const login = {
  requestId: 'synthetic-browser-request',
  authorizationUrl: 'https://zuv.wevir.si/connect/wevir-api?request=synthetic-browser-request',
  expiresAt: '2030-01-01T00:00:00.000Z',
};
const waiting: ZuvApiState = { status: 'authorizing', login };
const connected: ZuvApiState = {
  status: 'connected',
  account: { id: 'api-a', email: 'api@fixture.test', name: 'API A' },
  keyPrefix: 'zuv-prefix',
};
afterEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  platform.localHost = true;
});
function render(state: ZuvApiState) {
  hooks.reset([state, undefined, undefined]);
  return hooks.render(() => ZuvApiConnectionPanel({ client }));
}
function click(state: ZuvApiState, label: string) {
  const button = findElement(
    render(state),
    (element) => element.type === Button && [element.props.children].flat().includes(label),
  );
  (button.props.onClick as () => void)();
}

describe('ZUV API shared renderer actions', () => {
  it('opens the system browser on desktop without a web popup', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    request.mockResolvedValue({ connection: waiting });
    click({ status: 'disconnected' }, 'provider.zuvApi.login');
    await vi.waitFor(() =>
      expect(platform.openExternal).toHaveBeenCalledWith(login.authorizationUrl),
    );
    expect(open).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('zuvApi.login', {}, { timeoutMs: 60_000 });
  });

  it('opens a popup before waiting for Host authorization in the Web shell', async () => {
    platform.localHost = false;
    const replace = vi.fn();
    const popup = { opener: {}, location: { replace }, close: vi.fn() };
    const open = vi.fn(() => popup);
    vi.stubGlobal('window', { open });
    request.mockImplementation(async () => {
      expect(open).toHaveBeenCalledWith('about:blank', '_blank');
      return { connection: waiting };
    });
    click({ status: 'disconnected' }, 'provider.zuvApi.login');
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(login.authorizationUrl));
    expect(popup.opener).toBeNull();
    expect(platform.openExternal).not.toHaveBeenCalled();
  });

  it('keeps an explicit authorization link when a browser blocks the popup', async () => {
    platform.localHost = false;
    vi.stubGlobal('window', { open: () => null });
    request.mockResolvedValue({ connection: waiting });
    click({ status: 'disconnected' }, 'provider.zuvApi.login');
    await vi.waitFor(() => expect(hooks.values[0]).toEqual(waiting));
    const tree = hooks.render(() => ZuvApiConnectionPanel({ client }));
    expect(findElement(tree, (element) => element.type === 'a').props.href).toBe(
      login.authorizationUrl,
    );
    expect(platform.openExternal).not.toHaveBeenCalled();
  });

  it('cancels only the displayed Host authorization', async () => {
    request.mockResolvedValue({ connection: { status: 'disconnected' } });
    click(waiting, 'common.cancel');
    await vi.waitFor(() => expect(platform.refresh).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(
      'zuvApi.cancel',
      { requestId: login.requestId },
      { timeoutMs: 60_000 },
    );
  });

  it('refreshes models and disconnects through the API-specific methods', async () => {
    request.mockResolvedValue({ connection: connected });
    click({ ...connected, modelsError: 'network' }, 'provider.zuvApi.models');
    await vi.waitFor(() => expect(platform.refresh).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith('zuvApi.refreshModels', {}, { timeoutMs: 60_000 });
    request.mockClear();
    platform.refresh.mockClear();
    request.mockResolvedValue({ connection: { status: 'disconnected' } });
    click(connected, 'provider.zuvApi.disconnect');
    await vi.waitFor(() => expect(platform.refresh).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith('zuvApi.disconnect', {}, { timeoutMs: 60_000 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
