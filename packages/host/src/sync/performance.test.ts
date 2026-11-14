import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from '@wevir/protocol/sync';
import { FileSecretStore, openStorage, type SyncVaultRecord } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { EventStore } from '../event-store.js';
import { ImageStore } from '../images.js';
import { HostSettingsStore } from '../settings.js';
import { useTempDir } from '../test-utils.js';
import type { ZuvClient } from '../zuv/client.js';
import { type SyncBundleRoot, SyncFilesCapture } from './files-capture.js';
import { SyncPortable } from './portable.js';
import { SyncService, type SyncServiceOptions } from './service.js';

const temp = useTempDir();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const home = join(temp(), 'home'),
    storage = openStorage({ dataDir: home });
  let service: SyncService | undefined;
  const events = new EventStore({
    storage,
    onAppendInTransaction: (batch) => service?.record(batch),
  });
  storage.workspaces.insert(workspace({ id: 'ws_perf', rootPath: temp() }));
  storage.sessions.insert(session({ id: 'ses_perf', workspaceId: 'ws_perf', cwd: temp() }));
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_perf',
      accountId: 'account_perf',
      deviceId: 'device_perf',
      originHostId: 'device_perf',
      appliedCursor: 'cursor_perf',
    });
    storage.sync.bindProject('vault_perf', 'project_perf', 'ws_perf');
    storage.sync.setScopes('vault_perf', {
      enabled: true,
      revision: '1',
      categories: ['project', 'session', 'event-segment', 'skill-bundle', 'artifact'],
      projectIds: ['project_perf'],
    });
    storage.sync.setScopeInitialized('vault_perf', true);
  });
  const json = vi.fn(async (name: string) => {
    if (name === 'missingBlobs') return { blobs: [], next: null, recovery: 'client-reupload' };
    if (name === 'changes')
      return { operations: [], recordManifest: [], nextCursor: 'cursor_perf', hasMore: false };
    if (name === 'applied') return { applied: true };
    throw new Error(`unexpected request: ${name}`);
  });
  const client = {
    signedIn: true,
    requiresLogin: false,
    changingIdentity: false,
    entitlements: {
      identity: { userId: 'account_perf', deviceId: 'device_perf' },
      subscriptionState: 'active',
      syncState: 'ready',
      deviceScopes: ['sync'],
      limits: LIMITS,
      vault: { vaultId: 'vault_perf', state: 'active', keyState: 'ready', keyEpoch: '1' },
    },
    transport: { origin: 'https://synthetic.invalid' },
    json,
  } as unknown as ZuvClient;
  const roots: SyncBundleRoot[] = [];
  const bundleRoots = vi.fn(async () => roots);
  const options = {
    storage,
    home,
    events,
    client,
    secrets: new FileSecretStore(home),
    accounts: { read: async () => {} },
    memoryDir: join(home, 'memory'),
    images: new ImageStore({ dir: join(home, 'images') }),
    settings: new HostSettingsStore(),
    bundleRoots,
    onSecret: () => {},
  } as unknown as SyncServiceOptions;
  service = new SyncService(options);
  cleanups.push(async () => {
    await service?.close();
    events.close();
    storage.close();
  });
  return { storage, home, events, service, roots, bundleRoots, json };
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('sync performance boundaries', () => {
  it('keeps synchronization running while a local export is in progress', async () => {
    const h = fixture();
    h.storage.sessions.remove(['ses_perf']);
    h.storage.sync.setScopes('vault_perf', {
      ...(h.storage.sync.activeVault() as SyncVaultRecord),
      categories: [],
      projectIds: [],
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(SyncPortable.prototype, 'exportLocal').mockImplementationOnce(async () => {
      await gate;
      return {} as Awaited<ReturnType<SyncPortable['exportLocal']>>;
    });
    const task = h.service.exportLocal();
    try {
      await Promise.resolve();
      await Promise.resolve();
      const before = h.json.mock.calls.length;
      await h.service.flush();
      expect(h.json.mock.calls.length).toBeGreaterThan(before);
    } finally {
      release();
      await task;
    }
  });
  it('cancels recovery I/O and distinguishes the busy operation', async () => {
    const h = fixture();
    const pending = vi
      .spyOn(SyncPortable.prototype, 'exportLocal')
      .mockImplementationOnce(
        async (_directory, signal) =>
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
      );
    const task = h.service.exportLocal();
    const failed = expect(task).rejects.toMatchObject({ code: 'SYNC_FAILED' });
    await expect(h.service.importPrepare('/synthetic/package')).rejects.toMatchObject({
      code: 'RESOURCE_IN_USE',
    });
    expect(h.service.cancelRecovery()).toEqual({ cancelled: true });
    await failed;
    expect(pending).toHaveBeenCalledTimes(1);
  });
  it('explicit retry clears attention and schedules actual work', async () => {
    const h = fixture();
    h.storage.sessions.remove(['ses_perf']);
    h.storage.sync.setScopes('vault_perf', {
      ...(h.storage.sync.activeVault() as SyncVaultRecord),
      categories: [],
      projectIds: [],
    });
    h.storage.sync.setVaultTransport('vault_perf', {
      keyEpoch: '1',
      state: 'attention',
      errorCode: 'LOCAL_STORAGE_ERROR',
      retryAt: Date.now() + 60000,
    });
    await h.service.retry();
    expect(h.storage.sync.vaultTransport('vault_perf').state).not.toBe('attention');
  });
  it('keeps idle rounds independent from unchanged native bundles', async () => {
    const h = fixture();
    h.storage.sessions.remove(['ses_perf']);
    h.storage.sync.setScopes('vault_perf', {
      ...(h.storage.sync.activeVault() as SyncVaultRecord),
      categories: ['skill-bundle', 'artifact'],
      projectIds: [],
    });
    const capture = new SyncFilesCapture({ storage: h.storage, memoryDir: join(h.home, 'memory') });
    for (let index = 0; index < 32; index++) {
      const path = join(h.home, 'native', `skill-${index}`);
      await mkdir(path, { recursive: true });
      for (let file = 0; file < 4; file++)
        await writeFile(join(path, `${file}.md`), Buffer.alloc(8192, 97));
      const root: SyncBundleRoot = {
        path,
        name: `skill-${index}`,
        localKey: `skill:${path}`,
        category: 'skill-bundle',
      };
      h.roots.push(root);
      await capture.bundle(h.storage.sync.activeVault() as SyncVaultRecord, root, true, false);
    }
    await h.service.flush();
    h.bundleRoots.mockClear();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await h.service.flush();
      times.push(performance.now() - start);
    }
    process.stdout.write(
      `idle 32 bundles/1MiB: median=${median(times)?.toFixed(3)}ms scans=${h.bundleRoots.mock.calls.length}\n`,
    );
    expect(h.bundleRoots.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('captures event batches through indexed source lookups and isolates hook failures', () => {
    const h = fixture();
    h.storage.transaction(() => {
      for (let i = 0; i < 3000; i++)
        h.storage.sync.putSource({
          vaultId: 'vault_perf',
          hostId: `host_${i}`,
          deviceId: `device_${i}`,
          sessionId: `ses_${i}`,
          streamId: `stream_${i}`,
          mirrored: true,
        });
    });
    h.events.append('ses_perf', {
      type: 'session.created',
      source: 'host',
      payload: {
        workspaceId: 'ws_perf',
        cwd: temp(),
        providerId: 'synthetic',
        modelId: 'synthetic',
      },
    });
    const sources = vi.spyOn(h.storage.sync, 'sources');
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      h.events.append('ses_perf', {
        type: 'session.title_changed',
        source: 'host',
        payload: { title: `Title ${i}`, source: 'user' },
      });
      times.push(performance.now() - start);
    }
    process.stdout.write(
      `append 3000 sources: median=${median(times)?.toFixed(3)}ms full-scans=${sources.mock.calls.filter((args) => args[1] === undefined).length}\n`,
    );
    vi.spyOn(h.storage.sync, 'putContentRef').mockImplementationOnce(() => {
      throw new Error('synthetic capture failure');
    });
    expect(() =>
      h.events.append('ses_perf', {
        type: 'session.title_changed',
        source: 'host',
        payload: { title: 'Business write survives', source: 'user' },
      }),
    ).not.toThrow();
    expect(sources.mock.calls.filter((args) => args[1] === undefined).length).toBe(0);
  });
});
