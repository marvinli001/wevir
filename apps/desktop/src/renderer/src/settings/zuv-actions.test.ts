import { type WevirClient, WevirRpcError } from '@wevir/client-sdk';
import { type AccountState, ErrorCode } from '@wevir/protocol';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../components/confirm-dialog';
import { ErrorNote } from '../components/error-note';
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
  it.each(['detach', 'complete'] as const)(
    'removes stale vault actions while %s refresh is pending',
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
        '',
        false,
        undefined,
        action,
      ]);
      let refresh!: (value: unknown) => void;
      request.mockImplementation(async (method: string) =>
        method === 'sync.recoveryInfo'
          ? new Promise((resolve) => {
              refresh = resolve;
            })
          : {},
      );
      const render = () =>
        hooks.render(() =>
          ZuvRecoverySection({
            client,
            account: { status: 'signed_in' } as AccountState,
            onChanged: async () => {},
          }),
        );
      await confirmation(render())();
      try {
        expect(hooks.values[1]).toBeUndefined();
        expect(() =>
          findElement(render(), (element) => element.props.children === 'portable.detach'),
        ).toThrow('missing test element');
      } finally {
        refresh({});
        await Promise.resolve();
      }
    },
  );
  it('ignores an old restore preview after the dialog closes and reopens', async () => {
    hooks.reset([true, false, { kind: 'memory', canRestore: true }, undefined, false, true]);
    let old!: (value: unknown) => void,
      reads = 0;
    request.mockImplementation(async (method: string) => {
      if (method === 'sync.importRestore') return {};
      if (!reads++)
        return new Promise((resolve) => {
          old = resolve;
        });
      return { kind: 'memory', canRestore: true, fingerprint: 'new-preview' };
    });
    const render = () =>
      hooks.render(() =>
        ZuvVersionRestore({ client, importId: 'import_fixture', entryId: 'entry_fixture' }),
      );
    await confirmation(render())();
    const dialog = findElement(
      render(),
      (element) => typeof element.props.onOpenChange === 'function',
    );
    (dialog.props.onOpenChange as (value: boolean) => void)(false);
    const trigger = findElement(
      render(),
      (element) =>
        typeof element.props.onClick === 'function' &&
        element.props.children === 'portable.restoreVersion',
    );
    (trigger.props.onClick as () => void)();
    await vi.waitFor(() => expect(hooks.values[2]).toMatchObject({ fingerprint: 'new-preview' }));
    old({ kind: 'memory', canRestore: false, fingerprint: 'old-preview' });
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.values[2]).toMatchObject({ fingerprint: 'new-preview' });
  });
  it('refreshes an explicitly paused application and exposes resume without an error', async () => {
    const render = bundle('apply');
    let pause!: () => void;
    request.mockImplementation(async (method: string) => {
      if (method === 'sync.applyBundle')
        await new Promise((_, reject) => {
          pause = () =>
            reject(
              new WevirRpcError(method, {
                code: ErrorCode.SYNC_FAILED,
                message: 'APPLICATION_PAUSED',
                data: { code: 'APPLICATION_PAUSED' },
              }),
            );
        });
      if (method === 'sync.cancelBundle') pause();
      if (method === 'sync.bundlePreview')
        return {
          heads: ['op_fixture'],
          versions: [],
          binding: {
            targetId: 'target_fixture',
            revision: 'op_local',
            pending: { opId: 'op_fixture', state: 'applying', paused: true },
          },
        };
      if (method === 'sync.bundleVersions') return { versions: [] };
      if (method === 'sync.bundleTargets')
        return { targets: [{ targetId: 'target_fixture', fingerprint: 'fixture' }] };
      if (method === 'sync.bundles') return { bundles: [] };
      return {};
    });
    const applying = confirmation(render())();
    const button = findElement(render(), (element) => element.props.children === 'sync.pauseApply');
    (button.props.onClick as () => void)();
    await applying;
    expect(hooks.values[2]).toBeUndefined();
    expect(
      findElement(render(), (element) => element.props.children === 'sync.applyPaused'),
    ).toBeDefined();
    expect(
      findElement(render(), (element) => element.props.children === 'sync.resumeApply').props
        .disabled,
    ).toBe(false);
  });
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
    const alert = findElement(tree, (element) => element.type === ErrorNote);
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
