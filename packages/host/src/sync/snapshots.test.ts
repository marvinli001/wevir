import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSecretStore, openStorage, type SyncVaultRecord } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';
import { SyncBlobCache } from './cache.js';
import { SyncEngine } from './engine.js';
import { SyncVaultKeys } from './keys.js';
import { SyncQueue } from './queue.js';
import { SyncRestoreData } from './restore-data.js';
import { SyncSnapshots } from './snapshots.js';

const tempDir = useTempDir();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(fault: 'none' | 'page' | 'export' | 'manifest' = 'none') {
  const mock = await startMockZuv();
  cleanups.push(() => mock.close());
  const home = tempDir();
  const storage = openStorage({ dataDir: home });
  cleanups.push(() => storage.close());
  let pages = 0;
  let failed = false;
  const client = new ZuvClient({
    origin: mock.origin,
    allowLoopback: true,
    secrets: new FileSecretStore(home),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const response = await fetch(input, init);
      if (fault === 'export' && url.pathname.endsWith('/recovery/exports') && !failed) {
        failed = true;
        throw new TypeError('synthetic lost export response');
      }
      if (url.pathname.endsWith('/changes') && url.searchParams.has('restoreId')) {
        pages++;
        if (fault === 'page' && pages === 2 && !failed) {
          failed = true;
          throw new TypeError('synthetic lost metadata page');
        }
      }
      if (fault === 'manifest' && url.pathname.endsWith('/recovery/exports')) {
        const value = await response.json();
        value.manifest[0].cipherSha256 = 'A'.repeat(43);
        return Response.json(value);
      }
      return response;
    },
  });
  cleanups.push(() => client.close());
  await client.load();
  const login = await client.beginEnrollment('Synthetic snapshot');
  mock.approve(login.verificationUri);
  await client.pollEnrollment();
  await client.getEntitlements();
  const opened = await client.json('vaultOpened', 'POST', '/api/wevir/sync/v1/vaults/open', {
    protocol: 'wevir-sync/1',
    consent: true,
  });
  storage.transaction(() => {
    storage.sync.bindVault({
      ...opened,
      accountId: 'user_synthetic',
      appliedCursor: opened.cursor,
    });
    storage.sync.setVaultTransport(opened.vaultId, {
      keyEpoch: opened.keyEpoch,
      state: 'disabled',
      retryAt: 0,
    });
  });
  const scopes = await client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
    enabled: true,
    categories: ['memory'],
    projectIds: [],
    expectedRevision: '0',
  });
  storage.sync.setScopes(opened.vaultId, scopes);
  await client.getEntitlements();
  const keys = new SyncVaultKeys({
    client,
    secrets: new FileSecretStore(home),
    onSecret: () => {},
  });
  const engine = new SyncEngine({
    storage,
    client,
    cache: new SyncBlobCache(join(home, 'sync/blobs')),
    key: (vaultId, epoch, signal) => keys.unlock(vaultId, epoch, signal),
    prepareApply: async () => () => {},
  });
  cleanups.push(() => engine.stop());
  const enqueue = (name: string) =>
    storage.transaction(() =>
      new SyncQueue(storage).enqueue({
        vaultId: opened.vaultId,
        entityType: 'memory',
        localKey: name,
        content: { schema: 'synthetic/1', text: name },
      }),
    );
  for (const name of ['synthetic-first', 'synthetic-second', 'synthetic-third']) enqueue(name);
  expect(await engine.run()).toBe(true);
  enqueue('synthetic-offline-work');
  mock.sync.limitOverrides.operations = 1;
  await client.getEntitlements();
  const snapshots = new SyncSnapshots({ client, home });
  const jobId = async () =>
    (await readdir(join(home, 'sync/restores'), { withFileTypes: true })).find((entry) =>
      entry.isDirectory(),
    )?.name as string;
  return {
    mock,
    home,
    storage,
    client,
    engine,
    enqueue,
    snapshots,
    keys,
    jobId,
    vault: storage.sync.activeVault() as SyncVaultRecord,
  };
}

describe('fixed recoverable snapshot metadata', () => {
  it('verifies and persists a fixed manifest without applying data or touching offline work, then reads it offline', async () => {
    const h = await fixture();
    const pending = h.storage.sync.drafts(h.vault.vaultId);
    const before = h.storage.sync.activeVault()?.appliedCursor;
    const plan = await h.snapshots.prepare(h.vault, new AbortController().signal);
    expect(plan.operations).toBe(3);
    expect(h.mock.sync.exports).toBe(1);
    expect(h.mock.sync.attempts.downloads).toBe(0);
    expect(h.storage.sync.activeVault()?.appliedCursor).toBe(before);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toEqual(pending);
    const requests = h.mock.requests.length;
    await h.client.logout();
    const reopened = new SyncSnapshots({ client: h.client, home: h.home });
    const records = [];
    for await (const record of reopened.entries(plan.jobId)) records.push(record);
    expect(records).toHaveLength(3);
    expect(h.mock.requests).toHaveLength(requests);
  });

  it('downloads and decrypts only the requested fixed-snapshot records with normal sync disabled', async () => {
    const h = await fixture();
    const signal = new AbortController().signal;
    const plan = await h.snapshots.prepare(h.vault, signal);
    const descriptor = await h.snapshots.describe(plan.jobId);
    const cache = new SyncBlobCache(join(h.home, 'sync/blobs'));
    for (const ref of descriptor.exported.manifest)
      await rm(cache.path(h.vault.vaultId, ref.blobId), { force: true });
    const scopes = await h.client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
      enabled: false,
      categories: [],
      projectIds: [],
      expectedRevision: h.vault.revision,
    });
    h.storage.sync.setScopes(h.vault.vaultId, scopes);
    await h.client.getEntitlements();
    const reader = new SyncRestoreData({
      client: h.client,
      storage: h.storage,
      cache,
      snapshots: h.snapshots,
      keys: h.keys,
    });
    const before = h.storage.sync.activeVault()?.appliedCursor;
    const pending = h.storage.sync.drafts(h.vault.vaultId);
    const acknowledgements = h.mock.sync.acknowledgements.length;
    const none = [];
    for await (const item of reader.records(
      plan.jobId,
      h.vault,
      { categories: [], projectIds: [] },
      signal,
    ))
      none.push(item);
    expect(none).toEqual([]);
    expect(h.mock.sync.attempts.downloads).toBe(0);
    const records = [];
    for await (const item of reader.records(
      plan.jobId,
      h.vault,
      { categories: ['memory'], projectIds: [] },
      signal,
    ))
      records.push(item);
    expect(records.map((item) => item.record.content)).toEqual([
      { schema: 'synthetic/1', text: 'synthetic-first' },
      { schema: 'synthetic/1', text: 'synthetic-second' },
      { schema: 'synthetic/1', text: 'synthetic-third' },
    ]);
    expect(h.mock.sync.attempts.downloads).toBe(1);
    expect(h.mock.sync.acknowledgements).toHaveLength(acknowledgements);
    expect(h.storage.sync.activeVault()?.appliedCursor).toBe(before);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toEqual(pending);
  });

  it('resumes a lost page using the same restoreId and detects local corruption before yielding a record', async () => {
    const h = await fixture('page');
    const signal = new AbortController().signal;
    await expect(h.snapshots.prepare(h.vault, signal)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    const jobId = await h.jobId();
    const reopened = new SyncSnapshots({ client: h.client, home: h.home });
    const plan = await reopened.resume(jobId, h.vault, signal);
    expect(plan.operations).toBe(3);
    expect(h.mock.sync.exports).toBe(1);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toHaveLength(1);
    const first = join(h.home, 'sync/restores', jobId, '0.json');
    const bytes = await readFile(first);
    await writeFile(first, Buffer.concat([bytes, Buffer.from(' ')]));
    const yielded: unknown[] = [];
    await expect(
      (async () => {
        for await (const record of reopened.entries(jobId)) yielded.push(record);
      })(),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect(yielded).toEqual([]);
  });

  it('does not repeat an export after its response is lost', async () => {
    const h = await fixture('export');
    const signal = new AbortController().signal;
    await expect(h.snapshots.prepare(h.vault, signal)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    await expect(h.snapshots.resume(await h.jobId(), h.vault, signal)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    });
    expect(h.mock.sync.exports).toBe(1);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toHaveLength(1);
  });

  it('rejects a changed blob manifest before any content transfer', async () => {
    const h = await fixture('manifest');
    await expect(h.snapshots.prepare(h.vault, new AbortController().signal)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect(h.mock.sync.attempts.downloads).toBe(0);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toHaveLength(1);
  });
});
