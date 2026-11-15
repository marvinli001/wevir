import type { WevirClient } from '@wevir/client-sdk';
import type { AccountState } from '@wevir/protocol';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../components/confirm-dialog';
import { findElement, hooks } from '../test-hooks.test-utils';
import { ZuvBundles } from './zuv-bundles';
import { ZuvMemoryConflicts } from './zuv-memory-conflicts';
import { ZuvRecoverySection } from './zuv-recovery';
import { ZuvSessionConflicts } from './zuv-session-conflicts';
import { ZuvSettingsConflicts } from './zuv-settings-conflicts';
import { ZuvVersionRestore } from './zuv-version-restore';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../test-hooks.test-utils')),
  useEffect: () => {},
  useId: () => 'fixture',
  useCallback: (value: unknown) => value,
  useMemo: (value: () => unknown) => value(),
}));
vi.mock('@/host/host-connection', () => ({ describe: (error: Error) => error.message }));
vi.mock('@/i18n', () => ({ t: (key: string) => key, currentLocale: () => 'zh-CN' }));
vi.mock('@/platform/platform', () => ({
  capabilities: () => ({ localFiles: false }),
  platformApi: () => ({}),
}));
vi.mock('./sync-presentation', () => ({
  useSyncPresentation: () => ({ projectLabel: String, versionLabel: String }),
}));

const request = vi.fn();
const client = { request, supports: () => true } as unknown as WevirClient;
afterEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});
const confirmation = (tree: ReactNode) =>
  findElement(tree, (element) => element.type === ConfirmDialog).props
    .onConfirm as () => Promise<void>;
function bundle(confirm: string) {
  const values: unknown[] = [
    true,
    false,
    undefined,
    false,
    [],
    'vault_fixture',
    [],
    undefined,
    'entity_fixture',
    {
      versions: [],
      heads: ['op_fixture'],
      binding: { targetId: 'target_fixture', revision: 'op_local' },
    },
    'op_fixture',
    0,
    [{ targetId: 'target_fixture', fingerprint: 'fixture' }],
    'target_fixture',
    'file.md',
    [],
    { fingerprint: 'fixture', localRevision: 'op_local' },
    '',
    false,
    confirm,
    [],
    undefined,
  ];
  hooks.reset(values);
  return () =>
    hooks.render(() => ZuvBundles({ client, currentVaultId: 'vault_fixture', writable: true }));
}

describe('completed sync actions', () => {
  it.each([
    ['memory', ZuvMemoryConflicts],
    ['session', ZuvSessionConflicts],
    ['settings', ZuvSettingsConflicts],
  ] as const)('keeps retry controls outside conflict alerts for %s', (kind, Component) => {
    hooks.reset(
      kind === 'memory'
        ? [true, [], undefined, '', undefined, '', '', '', false, false, false, 'Failed']
        : kind === 'settings'
          ? [true, false, [], undefined, undefined, '', '', '', 'Failed']
          : [true, false, 'Failed', [], undefined, undefined, '', ''],
    );
    const tree = hooks.render(() =>
      Component({ client, disabled: false, onResolved: async () => {} }),
    );
    const alert = findElement(tree, (element) => element.props.role === 'alert');
    expect(() =>
      findElement(alert, (element) => typeof element.props.onClick === 'function'),
    ).toThrow('missing test element');
    expect(
      findElement(tree, (element) => element.props.children === 'connection.retry'),
    ).toBeDefined();
  });
  it('marks a restored version complete even if preview refresh fails', async () => {
    hooks.reset([true, false, { kind: 'memory', canRestore: true }, undefined, false, true]);
    request.mockImplementation(async (method: string) => {
      if (method === 'sync.importRestore') return {};
      throw new Error('Refresh failed');
    });
    const tree = hooks.render(() =>
      ZuvVersionRestore({ client, importId: 'import_fixture', entryId: 'entry_fixture' }),
    );
    await expect(confirmation(tree)()).resolves.toBeUndefined();
    expect(hooks.values[4]).toBe(true);
    await vi.waitFor(() => expect(hooks.values[3]).toBe('Refresh failed'));
  });
  it.each(['delete', 'detach', 'complete'])(
    'finishes %s recovery before refreshing parent data',
    async (action) => {
      hooks.reset([
        true,
        { vaultId: 'vault_fixture' },
        { request: { requestId: 'request_fixture' } },
        undefined,
        [],
        [],
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        'step_fixture',
        false,
        undefined,
        action,
      ]);
      request.mockImplementation(async (method: string) => {
        if (method === 'sync.recoveryInfo') throw new Error('Refresh failed');
        return {};
      });
      const tree = hooks.render(() =>
        ZuvRecoverySection({
          client,
          account: { status: 'signed_in' } as AccountState,
          onChanged: async () => {},
        }),
      );
      await expect(confirmation(tree)()).resolves.toBeUndefined();
      expect(hooks.values[16]).toBeUndefined();
      await vi.waitFor(() => expect(hooks.values[15]).toBe('Refresh failed'));
    },
  );
  it.each(['keep', 'delete'])(
    'closes %s bundle confirmation after success when refreshing fails',
    async (action) => {
      const render = bundle(action);
      request.mockImplementation(async (method: string) => {
        if (method === 'sync.bundlePreview') throw new Error('Refresh failed');
        return {};
      });
      await expect(confirmation(render())()).resolves.toBeUndefined();
      expect(hooks.values[19]).toBeUndefined();
      expect(hooks.values[2]).toBe('Refresh failed');
    },
  );
  it('exposes pause while bundle application is pending', async () => {
    const render = bundle('apply');
    let finish!: () => void;
    request.mockImplementation(async (method: string) => {
      if (method === 'sync.applyBundle')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      if (method === 'sync.bundlePreview') throw new Error('Refresh failed');
      return {};
    });
    const pending = confirmation(render())();
    expect(hooks.values[19]).toBeUndefined();
    const pause = findElement(render(), (element) => element.props.children === 'sync.pauseApply');
    (pause.props.onClick as () => void)();
    expect(request).toHaveBeenCalledWith('sync.cancelBundle', {
      vaultId: 'vault_fixture',
      entityId: 'entity_fixture',
    });
    finish();
    await pending;
    expect(hooks.values[2]).toBe('Refresh failed');
  });
});
