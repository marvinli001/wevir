import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSecretStore, openStorage, type SyncVaultRecord } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { HostSettingsStore } from '../settings.js';
import { useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';
import { SyncBootstrap } from './bootstrap.js';
import { SyncBlobCache } from './cache.js';
import { eventDigest, sha256 } from './crypto.js';
import { SyncEngine } from './engine.js';
import { SyncVaultKeys } from './keys.js';
import { SyncPortable } from './portable.js';
import { SyncQueue } from './queue.js';
import { SyncRecoveryFiles } from './recovery-files.js';
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
  let storage = openStorage({ dataDir: home });
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
    get storage() {
      return storage;
    },
    reopen() {
      storage.close();
      storage = openStorage({ dataDir: home });
    },
    bootstrap() {
      return new SyncBootstrap({
        storage,
        client,
        snapshots,
        home,
        data: new SyncRestoreData({
          client,
          storage,
          cache: new SyncBlobCache(join(home, 'sync/blobs')),
          keys: new SyncVaultKeys({
            client,
            secrets: new FileSecretStore(home),
            onSecret: () => {},
          }),
          snapshots,
        }),
        eligible: () => storage.sync.activeVault(),
      });
    },
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
  it('includes only referenced chunks when restoring a selected bundle category', async () => {
    const h = await fixture();
    h.mock.sync.limitOverrides.operations = 256;
    await h.client.getEntitlements();
    const scopes = await h.client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
      enabled: true,
      categories: ['skill-bundle', 'artifact'],
      projectIds: [],
      expectedRevision: h.vault.revision,
    });
    h.storage.sync.setScopes(h.vault.vaultId, scopes);
    const bytes = Buffer.from('referenced synthetic binary');
    h.storage.transaction(() => {
      const queue = new SyncQueue(h.storage);
      queue.enqueue({
        vaultId: h.vault.vaultId,
        entityType: 'artifact',
        entityId: 'chunk_selected',
        opId: 'operation_chunk_selected',
        localKey: 'selected-chunk',
        content: {
          schema: 'wevir-chunk/1',
          ownerId: 'bundle_selected',
          index: 0,
          data: bytes.toString('base64url'),
          sha256: sha256(bytes),
        },
      });
      queue.enqueue({
        vaultId: h.vault.vaultId,
        entityType: 'skill-bundle',
        entityId: 'bundle_selected',
        opId: 'operation_bundle_selected',
        localKey: 'selected-bundle',
        content: {
          schema: 'wevir-bundle/1',
          category: 'skill-bundle',
          name: 'Selected synthetic skill',
          exclusions: [],
          files: [
            {
              path: 'binary.dat',
              bytes: bytes.length,
              sha256: sha256(bytes),
              parts: [{ entityId: 'chunk_selected', opId: 'operation_chunk_selected' }],
            },
          ],
        },
      });
      queue.enqueue({
        vaultId: h.vault.vaultId,
        entityType: 'artifact',
        entityId: 'chunk_unselected',
        opId: 'operation_chunk_unselected',
        localKey: 'unselected-chunk',
        content: {
          schema: 'wevir-chunk/1',
          ownerId: 'unselected_bundle',
          index: 0,
          data: Buffer.from('unselected private bytes').toString('base64url'),
          sha256: sha256('unselected private bytes'),
        },
      });
    });
    expect(await h.engine.run()).toBe(true);
    expect(await h.engine.run()).toBe(true);
    expect(h.storage.sync.getOperation(h.vault.vaultId, 'operation_bundle_selected')?.state).toBe(
      'committed',
    );
    const events = new EventStore({ storage: h.storage });
    cleanups.push(() => events.close());
    const portable = new SyncPortable({
      home: h.home,
      storage: h.storage,
      events,
      keys: h.keys,
      settings: new HostSettingsStore(),
      memoryDir: join(h.home, 'memory'),
      bundleRoots: async () => [],
    });
    const files = new SyncRecoveryFiles({
      client: h.client,
      storage: h.storage,
      snapshots: h.snapshots,
      data: new SyncRestoreData({
        client: h.client,
        storage: h.storage,
        snapshots: h.snapshots,
        keys: h.keys,
        cache: new SyncBlobCache(join(h.home, 'sync/blobs')),
      }),
      portable,
    });
    const snapshot = await files.snapshot(h.vault.vaultId);
    const staged = await files.download({
      vaultId: h.vault.vaultId,
      jobId: snapshot.jobId,
      categories: ['skill-bundle'],
      projectIds: [],
    });
    expect(staged.counts.version).toBe(2);
    await portable.importApply(staged.importId);
    const entries = (await portable.read(staged.importId)).entries;
    expect(entries.some((entry) => entry.opId === 'operation_chunk_selected')).toBe(true);
    expect(entries.some((entry) => entry.opId === 'operation_chunk_unselected')).toBe(false);
  });
  it('restores a newly approved expired device into an isolated offline mirror without enabling sync', async () => {
    const h = await fixture();
    const home = join(tempDir(), 'cold-device');
    const storage = openStorage({ dataDir: home });
    const events = new EventStore({ storage });
    cleanups.push(() => {
      events.close();
      storage.close();
    });
    const secrets = new FileSecretStore(home);
    const client = new ZuvClient({ origin: h.mock.origin, allowLoopback: true, secrets });
    cleanups.push(() => client.close());
    await client.load();
    const enrollment = await client.beginEnrollment('Synthetic cold restore');
    h.mock.approve(enrollment.verificationUri);
    await client.pollEnrollment();
    await client.getEntitlements();
    await client.json('vaultOpened', 'POST', '/api/wevir/sync/v1/vaults/open', {
      consent: true,
      protocol: 'wevir-sync/1',
    });
    const keys = new SyncVaultKeys({ client, secrets, onSecret: () => {} });
    const snapshots = new SyncSnapshots({ client, home });
    const data = new SyncRestoreData({
      client,
      storage,
      keys,
      snapshots,
      cache: new SyncBlobCache(join(home, 'sync/blobs')),
    });
    const portable = new SyncPortable({
      home,
      storage,
      events,
      keys,
      settings: new HostSettingsStore(),
      memoryDir: join(home, 'memory'),
      bundleRoots: async () => [],
    });
    const files = new SyncRecoveryFiles({ client, storage, data, snapshots, portable });
    await expect(files.snapshot(h.vault.vaultId)).rejects.toThrow();
    await h.client.json(
      'approved',
      'POST',
      `/api/wevir/sync/v1/devices/${client.deviceId}/approve`,
      { keyEpoch: '1' },
    );
    const entitlements = await client.getEntitlements();
    entitlements.subscriptionState = 'expired';
    const snapshot = await files.snapshot(h.vault.vaultId);
    h.enqueue('synthetic-later-than-fixed-snapshot');
    await h.engine.run();
    const acknowledgements = h.mock.sync.acknowledgements.length;
    const staged = await files.download({
      vaultId: h.vault.vaultId,
      jobId: snapshot.jobId,
      categories: ['memory'],
      projectIds: [],
    });
    expect(staged.counts.version).toBe(3);
    expect(storage.sync.activeVault()).toBeUndefined();
    expect(storage.sync.getVault(h.vault.vaultId)).toMatchObject({
      active: false,
      enabled: false,
      appliedCursor: '',
    });
    expect(h.mock.sync.acknowledgements).toHaveLength(acknowledgements);
    await portable.importApply(staged.importId);
    const entries = (await portable.read(staged.importId)).entries.filter(
      (entry) => entry.kind === 'version',
    );
    const texts = await Promise.all(
      entries.map(async (entry) =>
        Buffer.from((await portable.entry(staged.importId, entry.id)).base64, 'base64').toString(),
      ),
    );
    expect(texts.join()).toContain('synthetic-first');
    expect(texts.join()).not.toContain('synthetic-later-than-fixed-snapshot');
    expect(storage.sync.counts(h.vault.vaultId).pending).toBe(0);
  });
  it('applies each restored revision atomically, resumes after a projection crash and ACKs only the fixed snapshot', async () => {
    const h = await fixture();
    const home = join(tempDir(), 'receiver');
    let storage = openStorage({ dataDir: home });
    cleanups.push(() => storage.close());
    storage.transaction(() => {
      storage.sync.bindVault({
        vaultId: h.vault.vaultId,
        accountId: h.vault.accountId,
        deviceId: h.vault.deviceId,
        originHostId: h.vault.originHostId,
        appliedCursor: h.vault.appliedCursor,
      });
      storage.sync.setScopes(h.vault.vaultId, h.vault);
      storage.db
        .prepare('UPDATE sync_vaults SET device_seq = ? WHERE vault_id = ?')
        .run(h.vault.deviceSeq, h.vault.vaultId);
    });
    storage.db.exec('CREATE TABLE restored_synthetic (op_id TEXT PRIMARY KEY, value TEXT) STRICT');
    storage.transaction(() =>
      new SyncQueue(storage).enqueue({
        vaultId: h.vault.vaultId,
        entityType: 'memory',
        localKey: 'receiver-offline',
        content: { schema: 'synthetic/1', text: 'pending receiver work' },
      }),
    );
    const pending = storage.sync.drafts(h.vault.vaultId);
    const snapshots = new SyncSnapshots({ client: h.client, home });
    const bootstrap = () =>
      new SyncBootstrap({
        storage,
        client: h.client,
        snapshots,
        home,
        data: new SyncRestoreData({
          client: h.client,
          storage,
          cache: new SyncBlobCache(join(home, 'sync/blobs')),
          keys: h.keys,
          snapshots,
        }),
        eligible: () => storage.sync.activeVault(),
      });
    h.mock.sync.forceReset(h.vault.deviceId);
    await h.client.getEntitlements();
    const current = bootstrap();
    const prepared = await current.prepare(new AbortController().signal);
    const descriptor = await snapshots.describe(prepared.job.jobId);
    await expect(
      current.acknowledge(prepared.job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    let writes = 0;
    let interrupted = false;
    const project = async (operation: { opId: string }, record: { content: unknown }) => () => {
      storage.db
        .prepare('INSERT OR IGNORE INTO restored_synthetic(op_id,value) VALUES (?,?)')
        .run(operation.opId, JSON.stringify(record.content));
      if (++writes === 2 && !interrupted) {
        interrupted = true;
        throw new Error('synthetic apply crash');
      }
    };
    await expect(
      current.apply(prepared.job.jobId, new AbortController().signal, project),
    ).rejects.toThrow('synthetic apply crash');
    expect(storage.sync.bootstrapCounts(h.vault.vaultId, prepared.job.jobId).applied).toBe(1);
    expect(storage.sync.activeVault()?.appliedCursor).toBe(h.vault.appliedCursor);
    expect(
      h.mock.sync.acknowledgements.some((ack) => ack.restoreId === descriptor.exported.restoreId),
    ).toBe(false);
    storage.close();
    storage = openStorage({ dataDir: home });
    const resumed = bootstrap();
    expect(
      await resumed.apply(prepared.job.jobId, new AbortController().signal, project),
    ).toMatchObject({ applied: 3, application: { state: 'applied' } });
    expect(storage.db.prepare('SELECT COUNT(*) AS n FROM restored_synthetic').get()?.n).toBe(3);
    expect(storage.sync.activeVault()?.appliedCursor).toBe(descriptor.exported.snapshotCursor);
    expect(storage.sync.activeVault()?.deviceSeq).toBe(h.vault.deviceSeq);
    expect(storage.sync.drafts(h.vault.vaultId)).toEqual(pending);
    await resumed.acknowledge(prepared.job.jobId, new AbortController().signal);
    expect(h.mock.sync.acknowledgements.at(-1)).toMatchObject({
      restoreId: descriptor.exported.restoreId,
      cursor: descriptor.exported.snapshotCursor,
    });
    expect(h.client.entitlements?.syncState).toBe('disabled');
    await resumed.enable(prepared.job.jobId, new AbortController().signal);
    expect(h.client.entitlements?.syncState).toBe('ready');
    resumed.finish(prepared.job.jobId, new AbortController().signal);
    expect(storage.sync.activeBootstrapJob(h.vault.vaultId)).toBeUndefined();
  });

  it('stages selected event segments using the exact event tuple while excluding unselected content', async () => {
    const h = await fixture();
    const scopes = await h.client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
      expectedRevision: h.vault.revision,
      enabled: true,
      categories: ['event-segment'],
      projectIds: ['project_synthetic'],
    });
    h.storage.sync.setScopes(h.vault.vaultId, scopes);
    await h.client.getEntitlements();
    const source = {
      vaultId: h.vault.vaultId,
      hostId: h.vault.originHostId,
      sessionId: 'ses_synthetic_stream',
      streamId: 'stream_synthetic',
      seq: '1',
    };
    const event = {
      seq: 1,
      sessionId: source.sessionId,
      ts: '2026-11-14T00:00:00.000Z',
      source: 'host',
      type: 'user.message',
      payload: {
        turnId: 'trn_synthetic',
        sentBy: 'user',
        content: [{ type: 'text', text: 'Synthetic source event' }],
      },
    };
    h.storage.transaction(() =>
      new SyncQueue(h.storage).enqueue({
        vaultId: h.vault.vaultId,
        entityType: 'event-segment',
        projectId: 'project_synthetic',
        localKey: 'synthetic-event',
        content: {
          schema: 'wevir-event-stream/1',
          sessionId: source.sessionId,
          streamId: source.streamId,
          exclusions: ['engine.raw'],
        },
        source: {
          origin: {
            hostId: source.hostId,
            sessionId: source.sessionId,
            streamId: source.streamId,
            fromSeq: '1',
            throughSeq: '1',
          },
          events: [{ seq: '1', sha256: eventDigest(source, event), content: event }],
        },
      }),
    );
    await h.engine.run();
    const staging = h.bootstrap();
    const prepared = await staging.prepare(new AbortController().signal);
    expect(prepared).toMatchObject({ operations: 4, selected: 1, staged: 1 });
    const records = [];
    for await (const entry of staging.records(prepared.job.jobId, new AbortController().signal))
      records.push(entry.record);
    expect(records).toHaveLength(1);
    expect(records[0]?.events?.[0]?.content).toEqual(event);
    expect(records[0]?.content).toMatchObject({ exclusions: ['engine.raw'] });
  });

  it('stages a fixed snapshot through a DB failure and resumes only missing record indices without touching the outbox or ACK', async () => {
    const h = await fixture();
    const staging = h.bootstrap();
    const before = h.storage.sync.drafts(h.vault.vaultId);
    const cursor = h.storage.sync.activeVault()?.appliedCursor;
    const acknowledgements = [...h.mock.sync.acknowledgements];
    const first = h.storage.sync.localEntity(h.vault.vaultId, 'synthetic-first');
    const operation =
      first?.revision && h.storage.sync.getOperation(h.vault.vaultId, first.revision);
    if (!operation) throw new Error('missing synthetic operation');
    const blobId = (operation.envelope as { payload: { blobId: string } }).payload.blobId;
    await rm(new SyncBlobCache(join(h.home, 'sync/blobs')).path(h.vault.vaultId, blobId));
    const insert = h.storage.sync.putBootstrapRecord;
    let calls = 0;
    const write = vi.spyOn(h.storage.sync, 'putBootstrapRecord').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('synthetic staged row loss');
      return insert(...args);
    });
    await expect(staging.prepare(new AbortController().signal)).rejects.toThrow(
      'synthetic staged row loss',
    );
    write.mockRestore();
    const jobId = await h.jobId();
    expect(staging.status(jobId)).toMatchObject({
      job: { state: 'failed', pendingBefore: before.length },
      operations: 3,
      selected: 3,
      staged: 1,
    });
    const downloads = h.mock.sync.attempts.downloads;
    expect(downloads).toBe(1);
    h.reopen();
    const resumed = h.bootstrap();
    expect(await resumed.resume(jobId, new AbortController().signal)).toMatchObject({
      job: { state: 'staged' },
      selected: 3,
      staged: 3,
    });
    const records = [];
    for await (const entry of resumed.records(jobId, new AbortController().signal))
      records.push(entry.record.content);
    expect(records).toEqual(
      ['synthetic-first', 'synthetic-second', 'synthetic-third'].map((text) => ({
        schema: 'synthetic/1',
        text,
      })),
    );
    expect(h.mock.sync.exports).toBe(1);
    expect(h.mock.sync.attempts.downloads).toBe(downloads);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toEqual(before);
    expect(h.storage.sync.activeVault()?.appliedCursor).toBe(cursor);
    expect(h.mock.sync.acknowledgements).toEqual(acknowledgements);
    h.storage.db
      .prepare(
        'UPDATE sync_bootstrap_entries SET record = ? WHERE vault_id = ? AND job_id = ? AND position = 0',
      )
      .run('{}', h.vault.vaultId, jobId);
    await expect(
      (async () => {
        for await (const _record of resumed.records(jobId, new AbortController().signal)) {
          /* consume verified records */
        }
      })(),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect(h.mock.sync.attempts.downloads).toBe(downloads);
  });

  it('retains an uncertain export job and never allocates another snapshot when resumed', async () => {
    const h = await fixture('export');
    const staging = h.bootstrap();
    await expect(staging.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    const [job] = staging.jobs();
    expect(job?.state).toBe('failed');
    if (!job) throw new Error('missing uncertain bootstrap job');
    const requests = h.mock.requests.length;
    await expect(staging.resume(job.jobId, new AbortController().signal)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    });
    expect(h.mock.sync.exports).toBe(1);
    expect(h.mock.requests).toHaveLength(requests);
    expect(h.storage.sync.bootstrapCounts(h.vault.vaultId, job.jobId)).toEqual({
      operations: 0,
      selected: 0,
      staged: 0,
      applied: 0,
    });
  });

  it('does not stage without consent or install stale-scope roots after a scope change', async () => {
    const h = await fixture();
    const staging = h.bootstrap();
    h.storage.sync.setScopes(h.vault.vaultId, { ...h.vault, enabled: false });
    await expect(staging.prepare(new AbortController().signal)).rejects.toMatchObject({
      code: 'SCOPE_DISABLED',
    });
    expect(h.mock.sync.exports).toBe(0);
    h.storage.sync.setScopes(h.vault.vaultId, h.vault);
    const prepared = await staging.prepare(new AbortController().signal);
    const calls = h.mock.requests.length;
    h.storage.sync.setScopes(h.vault.vaultId, { ...h.vault, revision: '2' });
    await expect(
      staging.installRoots(prepared.job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(h.mock.requests).toHaveLength(calls);
    expect(h.storage.db.prepare('SELECT COUNT(*) AS n FROM sync_snapshot_roots').get()?.n).toBe(0);
  });

  it('derives pruned-parent boundaries from the complete signed snapshot without fabricating a retired record', async () => {
    const h = await fixture();
    const previous = h.storage.sync.localEntity(h.vault.vaultId, 'synthetic-first');
    if (!previous?.revision) throw new Error('missing synthetic base');
    const child = h.storage.transaction(() =>
      new SyncQueue(h.storage).enqueue({
        vaultId: h.vault.vaultId,
        entityType: 'memory',
        localKey: 'synthetic-first',
        content: { schema: 'synthetic/1', text: 'updated synthetic first' },
      }),
    );
    await h.engine.run();
    await h.engine.run();
    expect(child && h.storage.sync.getOperation(h.vault.vaultId, child)?.state).toBe('committed');
    h.mock.sync.retiredOperations.add(previous.revision);
    const bootstrap = h.bootstrap();
    const staged = await bootstrap.prepare(new AbortController().signal);
    const jobId = staged.job.jobId;
    const boundary = await h.snapshots.historyRoots(jobId);
    expect(boundary.roots).toEqual([{ opId: previous.revision, entityId: previous.entityId }]);
    const entries = [];
    for await (const entry of h.snapshots.entries(jobId)) entries.push(entry);
    expect(entries.some((entry) => entry.operation.opId === previous.revision)).toBe(false);
    expect(entries.find((entry) => entry.operation.opId === child)?.operation.parents).toEqual([
      previous.revision,
    ]);
    expect(h.storage.sync.getOperation(h.vault.vaultId, previous.revision)?.record).toBeDefined();
    expect(await bootstrap.installRoots(jobId, new AbortController().signal)).toBe(1);
    expect(
      h.storage.db
        .prepare('SELECT op_id, entity_id FROM sync_snapshot_roots WHERE vault_id = ?')
        .all(h.vault.vaultId),
    ).toEqual([{ op_id: previous.revision, entity_id: previous.entityId }]);
    expect(
      h.mock.sync.acknowledgements.some((ack) => ack.cursor === boundary.exported.snapshotCursor),
    ).toBe(false);
  });

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
