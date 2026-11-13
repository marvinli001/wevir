import { join } from 'node:path';
import type { RecordManifest, SyncOperation } from '@wevir/protocol/sync';
import {
  FileSecretStore,
  openStorage,
  type Storage,
  type SyncCommitRecord,
  type SyncEntityRecord,
} from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../ids.js';
import { useTempDir } from '../test-utils.js';
import { ZuvClient, type ZuvClientOptions } from '../zuv/client.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { SyncBootstrap } from './bootstrap.js';
import { SyncBlobCache } from './cache.js';
import { encryptPack, sha256 } from './crypto.js';
import { SyncEngine } from './engine.js';
import { SyncVaultKeys } from './keys.js';
import { SyncOutboxRecovery } from './outbox-recovery.js';
import { SyncQueue } from './queue.js';
import { SyncRestoreData } from './restore-data.js';
import { SyncSnapshots } from './snapshots.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(fetcher?: typeof fetch) {
  const server = await startMockZuv();
  cleanups.push(() => server.close());
  async function peer(name: string, fetcher?: typeof fetch) {
    const home = join(tempDir(), name);
    const options: ZuvClientOptions = {
      origin: server.origin,
      allowLoopback: true,
      secrets: new FileSecretStore(home),
      ...(fetcher && { fetch: fetcher }),
    };
    let storage: Storage = openStorage({ dataDir: home });
    let client = new ZuvClient(options);
    await client.load();
    const start = await client.beginEnrollment(`Synthetic ${name}`);
    server.approve(start.verificationUri);
    await client.pollEnrollment();
    await client.getEntitlements();
    const opened = await client.json('vaultOpened', 'POST', '/api/wevir/sync/v1/vaults/open', {
      protocol: 'wevir-sync/1',
      consent: true,
    });
    storage.transaction(() => {
      storage.sync.bindVault({
        vaultId: opened.vaultId,
        deviceId: opened.deviceId,
        originHostId: opened.originHostId,
        accountId: 'user_synthetic',
        appliedCursor: opened.cursor,
      });
      storage.sync.setVaultTransport(opened.vaultId, {
        keyEpoch: opened.keyEpoch,
        state: 'disabled',
        retryAt: 0,
      });
    });
    const createEngine = () => {
      const keys = new SyncVaultKeys({ client, secrets: options.secrets, onSecret: () => {} });
      return new SyncEngine({
        storage,
        client,
        cache: new SyncBlobCache(join(home, 'sync/blobs')),
        key: (vaultId, keyEpoch, signal) => keys.unlock(vaultId, keyEpoch, signal),
        prepareApply: async (operation, record) => {
          const content = record.content as { schema: string; localKey: string; text: string };
          if (
            content?.schema !== 'synthetic-memory/1' ||
            typeof content.localKey !== 'string' ||
            typeof content.text !== 'string'
          )
            throw new ZuvRequestError('UPGRADE_REQUIRED');
          return () => {
            const material = storage.sync.localEntity(opened.vaultId, content.localKey);
            const existing = storage.sync.entity(opened.vaultId, operation.entityId);
            const canApply =
              !material ||
              (material.entityId === operation.entityId &&
                (!material.revision || operation.parents.includes(material.revision)));
            storage.sync.putEntity({
              vaultId: opened.vaultId,
              entityId: operation.entityId,
              entityType: operation.entityType,
              localKey: content.localKey,
              revision: canApply ? operation.opId : (existing?.revision ?? operation.opId),
              materialized: canApply || existing?.materialized === true,
            });
          };
        },
      });
    };
    let engine = createEngine();
    cleanups.push(async () => {
      engine.stop();
      await client.close();
      if (storage.db.isOpen) storage.close();
    });
    return {
      home,
      opened,
      options,
      get storage() {
        return storage;
      },
      get client() {
        return client;
      },
      get engine() {
        return engine;
      },
      async enable() {
        const scopes = await client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
          expectedRevision: '0',
          enabled: true,
          categories: ['memory'],
          projectIds: [],
        });
        storage.sync.setScopes(opened.vaultId, scopes);
        await client.getEntitlements();
      },
      enqueue(text: string, localKey = 'global/note.md') {
        return storage.transaction(() =>
          new SyncQueue(storage).enqueue({
            vaultId: opened.vaultId,
            entityType: 'memory',
            localKey,
            content: { schema: 'synthetic-memory/1', localKey, text },
          }),
        );
      },
      async reopen() {
        engine.stop();
        await client.close();
        storage.close();
        storage = openStorage({ dataDir: home });
        client = new ZuvClient(options);
        await client.load();
        engine = createEngine();
      },
    };
  }
  const first = await peer('first', fetcher);
  const second = await peer('second');
  await first.client.json(
    'approved',
    'POST',
    `/api/wevir/sync/v1/devices/${second.opened.deviceId}/approve`,
    { keyEpoch: '1' },
  );
  return { server, first, second };
}

describe('durable encrypted synchronization over HTTP', () => {
  it.each(['rule', 'skill-bundle', 'workspace-snapshot'] as const)(
    'commits chunks before an older %s draft can carry a later dependent revision',
    async (category) => {
      const { first, server } = await setup();
      await first.enable();
      const scopes = await first.client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
        expectedRevision: '1',
        enabled: true,
        categories: ['project', 'artifact', category],
        projectIds: ['project_synthetic'],
      });
      first.storage.sync.setScopes(first.opened.vaultId, scopes);
      await first.client.getEntitlements();
      const queue = new SyncQueue(first.storage);
      first.storage.transaction(() =>
        queue.enqueue({
          vaultId: first.opened.vaultId,
          entityId: 'project_synthetic',
          entityType: 'project',
          projectId: 'project_synthetic',
          localKey: 'project:synthetic',
          content: {
            schema: 'wevir-project/1',
            projectId: 'project_synthetic',
            displayName: 'Synthetic',
          },
        }),
      );
      await first.engine.run();
      const bytes = Buffer.from('Synthetic dependent file');
      first.storage.transaction(() => {
        const base = {
          vaultId: first.opened.vaultId,
          entityId: 'bundle_synthetic',
          entityType: category,
          projectId: 'project_synthetic',
          localKey: 'bundle:synthetic',
        };
        const body = {
          schema: 'wevir-bundle/1',
          category,
          name: 'Synthetic',
          files: [],
          exclusions: [],
        };
        queue.enqueue({ ...base, content: body });
        const chunk = queue.enqueue({
          vaultId: first.opened.vaultId,
          entityId: 'chunk_synthetic',
          entityType: 'artifact',
          projectId: 'project_synthetic',
          localKey: 'chunk:synthetic',
          content: {
            schema: 'wevir-chunk/1',
            ownerId: base.entityId,
            index: 0,
            data: bytes.toString('base64url'),
            sha256: sha256(bytes),
          },
        });
        queue.enqueue({
          ...base,
          content: {
            ...body,
            files: [
              {
                path: 'synthetic.txt',
                bytes: bytes.length,
                sha256: sha256(bytes),
                parts: [{ entityId: 'chunk_synthetic', opId: chunk }],
              },
            ],
          },
        });
      });
      await first.engine.run();
      expect(server.sync.acceptedOperations('chunk_synthetic')).toHaveLength(1);
      expect(server.sync.acceptedOperations('bundle_synthetic')).toHaveLength(0);
      await first.engine.run();
      expect(server.sync.acceptedOperations('bundle_synthetic')).toHaveLength(2);
      expect(server.errors).toEqual([]);
    },
  );
  it('retains both heads when an explicitly recovered uncertain commit is later confirmed', async () => {
    const { first, server } = await setup();
    await first.enable();
    server.sync.pendingCommits = true;
    const originalOp = first.enqueue('Synthetic uncertain history') as string;
    await first.engine.run();
    const commit = first.storage.sync.commits(first.opened.vaultId)[0] as ReturnType<
      Storage['sync']['commits']
    >[number];
    await new SyncOutboxRecovery({
      storage: first.storage,
      client: first.client,
      engine: first.engine,
    }).recover(
      { expectedDeviceId: first.opened.deviceId, commitIds: [commit.commitId] },
      new AbortController().signal,
    );
    const recoveredOp = first.storage.sync.outboxRecovery(first.opened.vaultId, originalOp)
      ?.opId as string;
    await first.engine.run();
    server.sync.finalize();
    await first.engine.run();
    const entityId = first.storage.sync.getOperation(first.opened.vaultId, originalOp)
      ?.entityId as string;
    expect(first.storage.sync.heads(first.opened.vaultId, entityId)).toEqual(
      expect.arrayContaining([originalOp, recoveredOp]),
    );
    expect(first.storage.sync.getOperation(first.opened.vaultId, originalOp)?.state).toBe(
      'committed',
    );
    expect(first.storage.sync.getOperation(first.opened.vaultId, recoveredOp)).toBeDefined();
  });
  it('recovers a cloned outbox under the newly approved device without impersonating the old origin', async () => {
    const { first, second, server } = await setup(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/commits') && init?.method === 'POST')
        throw new TypeError('synthetic old device unavailable');
      return fetch(input, init);
    });
    await first.enable();
    const oldOp = first.enqueue('Synthetic cloned offline work') as string;
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const oldCommit = first.storage.sync.commits(first.opened.vaultId)[0] as NonNullable<
      ReturnType<Storage['sync']['commits']>[number]
    >;
    const oldOperation = first.storage.sync.getOperation(first.opened.vaultId, oldOp);
    const keys = new SyncVaultKeys({
      client: second.client,
      secrets: second.options.secrets,
      onSecret: () => {},
    });
    const engine = new SyncEngine({
      storage: first.storage,
      client: second.client,
      cache: new SyncBlobCache(join(first.home, 'sync/blobs')),
      key: (vaultId, epoch, signal) => keys.unlock(vaultId, epoch, signal),
      prepareApply: async () => () => {},
    });
    await new SyncOutboxRecovery({ storage: first.storage, client: second.client, engine }).recover(
      { expectedDeviceId: first.opened.deviceId, commitIds: [oldCommit.commitId] },
      new AbortController().signal,
    );
    expect(first.storage.sync.activeVault()).toMatchObject({
      deviceId: second.opened.deviceId,
      originHostId: second.opened.originHostId,
      deviceSeq: '0',
    });
    expect(second.client.entitlements?.syncState).toBe('ready');
    await engine.run();
    const recovery = first.storage.sync.outboxRecovery(first.opened.vaultId, oldOp);
    expect(recovery?.opId).not.toBe(oldOp);
    const fresh = first.storage.sync.getOperation(first.opened.vaultId, recovery?.opId as string);
    expect(fresh).toMatchObject({
      deviceId: second.opened.deviceId,
      record: {
        content: {
          text: 'Synthetic cloned offline work',
          recoveredFrom: { deviceId: first.opened.deviceId, opId: oldOp },
        },
      },
    });
    expect(first.storage.sync.getOperation(first.opened.vaultId, oldOp)).toEqual(oldOperation);
    expect(
      first.storage.sync
        .commits(first.opened.vaultId, false)
        .find((value) => value.commitId === oldCommit.commitId)?.body,
    ).toBe(oldCommit.body);
    const attempts = server.sync.attempts.commits;
    const realIdentity = await second.client.getEntitlements();
    vi.spyOn(second.client, 'getEntitlements').mockResolvedValueOnce({
      ...realIdentity,
      identity: { ...realIdentity.identity, userId: 'user_other_synthetic' },
    });
    await expect(
      new SyncOutboxRecovery({ storage: first.storage, client: second.client, engine }).recover(
        { expectedDeviceId: second.opened.deviceId, commitIds: [oldCommit.commitId] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(server.sync.attempts.commits).toBe(attempts);
  });
  it('keeps pulling after a definite rejection and recovers with fresh IDs without rewriting the old commit', async () => {
    let rejected = 0;
    const { first, second } = await setup(async (input, init) => {
      if (
        new URL(String(input)).pathname.endsWith('/commits') &&
        init?.method === 'POST' &&
        !rejected++
      )
        return new Response(
          JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'synthetic rejection' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      return fetch(input, init);
    });
    await first.enable();
    await second.enable();
    const originalOp = first.enqueue('Synthetic local offline work') as string;
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const original = first.storage.sync.commits(first.opened.vaultId)[0] as SyncCommitRecord;
    expect(original).toMatchObject({ outcome: 'rejected', attempts: 1 });
    second.enqueue('Synthetic remote work', 'global/remote.md');
    await second.engine.run();
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(first.storage.sync.localEntity(first.opened.vaultId, 'global/remote.md')).toBeDefined();
    expect(rejected).toBe(1);
    await new SyncOutboxRecovery({
      storage: first.storage,
      client: first.client,
      engine: first.engine,
    }).recover(
      { expectedDeviceId: first.opened.deviceId, commitIds: [original.commitId] },
      new AbortController().signal,
    );
    const replacement = first.storage.sync
      .drafts(first.opened.vaultId)
      .find((value) => (value.content as { body: { recoveredFrom?: unknown } }).body.recoveredFrom);
    expect(replacement?.opId).not.toBe(originalOp);
    expect(replacement?.content).toMatchObject({
      body: {
        text: 'Synthetic local offline work',
        recoveredFrom: { opId: originalOp, commitId: original.commitId },
      },
    });
    expect(
      first.storage.sync
        .commits(first.opened.vaultId, false)
        .find((value) => value.commitId === original.commitId),
    ).toMatchObject({ body: original.body, outcome: 'recovered' });
    await first.engine.run();
    expect(first.storage.sync.commits(first.opened.vaultId)).toEqual([]);
  });

  it('queries an uncertain commit at most three times across restart and never repeats POST or upload', async () => {
    let loseResponse = true;
    const { server, first } = await setup(async (input, init) => {
      const result = await fetch(input, init);
      if (
        new URL(String(input)).pathname.endsWith('/commits') &&
        init?.method === 'POST' &&
        loseResponse
      ) {
        loseResponse = false;
        await result.arrayBuffer();
        throw new TypeError('synthetic lost commit response');
      }
      return result;
    });
    await first.enable();
    server.sync.pendingCommits = true;
    first.enqueue('Synthetic response loss');
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const original = first.storage.sync.commits(first.opened.vaultId)[0] as SyncCommitRecord;
    for (let index = 0; index < 3; index++) {
      const commit = first.storage.sync.commits(first.opened.vaultId)[0] as SyncCommitRecord;
      first.storage.transaction(() => first.storage.sync.putCommit({ ...commit, retryAt: 0 }));
      await first.engine.run();
      if (index === 1) await first.reopen();
    }
    const commit = first.storage.sync.commits(first.opened.vaultId)[0] as SyncCommitRecord;
    first.storage.transaction(() => first.storage.sync.putCommit({ ...commit, retryAt: 0 }));
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(server.sync.attempts).toMatchObject({ commits: 1, uploads: 1 });
    expect(
      server.requests.filter((path) => path.endsWith(`/commits/${original.commitId}`)),
    ).toHaveLength(3);
    expect(first.storage.sync.commits(first.opened.vaultId)[0]?.body).toBe(original.body);
    server.sync.finalize();
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await first.engine.run();
    expect(first.storage.sync.commits(first.opened.vaultId)).toEqual([]);
    expect(server.sync.attempts.commits).toBe(1);
  });

  it('does not treat NOT_FOUND as proof after an attempted commit and preserves deletion as a recovery branch', async () => {
    let offline = false;
    const { first, second } = await setup(async (input, init) => {
      if (
        offline &&
        new URL(String(input)).pathname.endsWith('/commits') &&
        init?.method === 'POST'
      )
        throw new TypeError('synthetic disconnected commit');
      return fetch(input, init);
    });
    await first.enable();
    await second.enable();
    first.enqueue('Synthetic baseline');
    await first.engine.run();
    await second.engine.run();
    const entity = first.storage.sync.localEntity(
      first.opened.vaultId,
      'global/note.md',
    ) as SyncEntityRecord;
    offline = true;
    first.storage.transaction(() =>
      new SyncQueue(first.storage).enqueue({
        vaultId: first.opened.vaultId,
        entityType: 'memory',
        localKey: entity.localKey,
        kind: 'delete',
        content: {
          schema: 'synthetic-memory/1',
          localKey: entity.localKey,
          text: '',
          deleted: true,
        },
      }),
    );
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const original = first.storage.sync.commits(first.opened.vaultId)[0] as SyncCommitRecord;
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(first.storage.sync.commits(first.opened.vaultId)[0]?.body).toBe(original.body);
    second.enqueue('Synthetic concurrent remote edit');
    await second.engine.run();
    await new SyncOutboxRecovery({
      storage: first.storage,
      client: first.client,
      engine: first.engine,
    }).recover(
      { expectedDeviceId: first.opened.deviceId, commitIds: [original.commitId] },
      new AbortController().signal,
    );
    offline = false;
    await first.engine.run();
    await second.engine.run();
    expect(second.storage.sync.heads(first.opened.vaultId, entity.entityId)).toHaveLength(2);
    const versions = second.storage.sync
      .heads(first.opened.vaultId, entity.entityId)
      .map((id) => second.storage.sync.getOperation(first.opened.vaultId, id)?.record);
    expect(versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'delete',
          content: expect.objectContaining({ deleted: true, recoveredFrom: expect.any(Object) }),
        }),
        expect.objectContaining({
          kind: 'put',
          content: expect.objectContaining({ text: 'Synthetic concurrent remote edit' }),
        }),
      ]),
    );
  });
  it.each(['reserve', 'commit'] as const)(
    'reconciles RESET outbox receipts without rewriting an uncertain %s request',
    async (point) => {
      let blocked = false;
      const { server, first } = await setup(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (
          blocked &&
          init?.method === 'POST' &&
          path.endsWith(point === 'reserve' ? '/blobs/reserve' : '/commits')
        )
          throw new TypeError('synthetic interrupted request');
        return fetch(input, init);
      });
      await first.enable();
      first.enqueue('Committed baseline');
      await first.engine.run();
      const oldId = first.enqueue('Unsent offline change') as string;
      blocked = true;
      await expect(first.engine.run()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      const original = first.storage.sync.commits(first.opened.vaultId)[0];
      if (!original) throw new Error('missing synthetic prepared commit');
      expect(original.attempts).toBe(point === 'reserve' ? 0 : 1);
      const nextId = first.enqueue('Later offline change') as string;
      const oldRecord = first.storage.sync.getOperation(first.opened.vaultId, oldId);
      if (!oldRecord) throw new Error('missing synthetic prepared operation');
      server.sync.forceReset(first.opened.deviceId);
      await first.client.getEntitlements();
      const snapshots = new SyncSnapshots({ client: first.client, home: first.home });
      const bootstrap = new SyncBootstrap({
        storage: first.storage,
        client: first.client,
        home: first.home,
        snapshots,
        eligible: () => first.storage.sync.activeVault(),
        data: new SyncRestoreData({
          client: first.client,
          storage: first.storage,
          snapshots,
          cache: new SyncBlobCache(join(first.home, 'sync/blobs')),
          keys: new SyncVaultKeys({
            client: first.client,
            secrets: first.options.secrets,
            onSecret: () => {},
          }),
        }),
      });
      const signal = new AbortController().signal;
      const { job } = await bootstrap.prepare(signal);
      await bootstrap.apply(job.jobId, signal, async () => () => {});
      await bootstrap.acknowledge(job.jobId, signal);
      await bootstrap.enable(job.jobId, signal);
      if (point === 'commit') {
        await expect(first.engine.reconcileReset(job.jobId, signal)).rejects.toMatchObject({
          code: 'RECOVERY_REQUIRED',
        });
        expect(first.storage.sync.commits(first.opened.vaultId)).toEqual([original]);
        expect(first.storage.sync.draft(first.opened.vaultId, nextId)?.parents).toEqual([oldId]);
      } else {
        await first.engine.reconcileReset(job.jobId, signal);
        expect(first.storage.sync.commits(first.opened.vaultId)).toEqual([]);
        expect(
          first.storage.sync
            .commits(first.opened.vaultId, false)
            .find((commit) => commit.commitId === original.commitId),
        ).toMatchObject({ ...original, rebased: true });
        const drafts = first.storage.sync.drafts(first.opened.vaultId);
        expect(drafts).toHaveLength(2);
        const replacement = drafts.find((draft) => draft.opId !== nextId);
        expect(replacement?.opId).not.toBe(oldId);
        expect(replacement?.parents).toEqual((oldRecord.envelope as { parents: string[] }).parents);
        expect(drafts.find((draft) => draft.opId === nextId)?.parents).toEqual([replacement?.opId]);
        bootstrap.finish(job.jobId, signal);
        blocked = false;
        await first.engine.run();
        expect(first.storage.sync.counts(first.opened.vaultId).pending).toBe(0);
      }
      expect(first.storage.sync.getOperation(first.opened.vaultId, oldId)).toEqual(oldRecord);
    },
  );

  it('enforces a smaller server plaintext limit before key release or paid upload', async () => {
    const { server, first } = await setup();
    await first.enable();
    server.sync.limitOverrides.plainBytes = 32;
    await first.client.getEntitlements();
    first.enqueue('synthetic body above the server limit');
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(server.sync.attempts).toMatchObject({
      uploads: 0,
      downloads: 0,
      reservations: 0,
      commits: 0,
    });
    expect(server.requests.some((path) => path.endsWith('/keys/unlock'))).toBe(false);
    expect(first.storage.sync.drafts(first.opened.vaultId)).toHaveLength(1);
  });
  it('rolls projection and applied marker back together and resumes from the cached pack', async () => {
    const { server, first, second } = await setup();
    await first.enable();
    await second.enable();
    const opId = first.enqueue('synthetic apply transaction') as string;
    await first.engine.run();
    const mark = second.storage.sync.markOperation.bind(second.storage.sync);
    const interrupted = vi
      .spyOn(second.storage.sync, 'markOperation')
      .mockImplementationOnce((vaultId, id, state, errorCode) => {
        if (state === 'applied') throw new Error('synthetic apply interruption');
        mark(vaultId, id, state, errorCode);
      });
    await expect(second.engine.run()).rejects.toThrow('synthetic apply interruption');
    interrupted.mockRestore();
    expect(second.storage.sync.localEntity(first.opened.vaultId, 'global/note.md')).toBeUndefined();
    expect(second.storage.sync.getOperation(first.opened.vaultId, opId)?.state).toBe('received');
    await second.reopen();
    await second.engine.run();
    expect(second.storage.sync.getOperation(first.opened.vaultId, opId)?.state).toBe('applied');
    expect(server.sync.attempts.downloads).toBe(1);
  });

  it('keeps applied data when cursor advancement is interrupted and never ACKs an incomplete page', async () => {
    const { server, first, second } = await setup();
    await first.enable();
    await second.enable();
    const opId = first.enqueue('synthetic cursor interruption') as string;
    await first.engine.run();
    vi.spyOn(second.storage.sync, 'applyPage').mockImplementationOnce(() => {
      throw new Error('synthetic cursor interruption');
    });
    await expect(second.engine.run()).rejects.toThrow('synthetic cursor interruption');
    expect(second.storage.sync.getOperation(first.opened.vaultId, opId)?.state).toBe('applied');
    expect(second.storage.sync.getVault(first.opened.vaultId)?.appliedCursor).toBe(
      second.opened.cursor,
    );
    expect(
      server.sync.acknowledgements.filter((value) => value.deviceId === second.opened.deviceId),
    ).toEqual([]);
    await second.reopen();
    await second.engine.run();
    expect(second.storage.sync.operations(first.opened.vaultId, 'inbox', 'applied')).toHaveLength(
      1,
    );
    expect(server.sync.attempts.downloads).toBe(1);
    expect(
      server.sync.acknowledgements.filter((value) => value.deviceId === second.opened.deviceId),
    ).toHaveLength(1);
  });
  it('does no transfer before explicit scopes, then applies a pack once and keeps independent identical notes', async () => {
    const { server, first, second } = await setup();
    const count = server.requests.length;
    expect(await first.engine.run()).toBe(false);
    expect(server.requests).toHaveLength(count);
    await first.enable();
    await second.enable();
    const opId = first.enqueue('synthetic note') as string;
    await first.engine.run();
    await second.engine.run();
    const stored = second.storage.sync.getOperation(first.opened.vaultId, opId);
    expect(stored).toMatchObject({
      state: 'applied',
      record: { content: { text: 'synthetic note' } },
    });
    expect(server.sync.attempts).toMatchObject({ uploads: 1, downloads: 1, commits: 1 });
    await second.engine.run();
    expect(server.sync.attempts.downloads).toBe(1);
    first.enqueue('same independent text', 'global/one.md');
    first.enqueue('same independent text', 'global/two.md');
    await first.engine.run();
    await second.engine.run();
    expect(second.storage.sync.entities(first.opened.vaultId)).toHaveLength(3);
    expect(second.storage.sync.getVault(first.opened.vaultId)?.appliedCursor).not.toBe(
      second.opened.cursor,
    );
    expect(server.errors).toEqual([]);
  });

  it('retains both concurrent revisions instead of advancing the local material to an unmerged remote head', async () => {
    const { first, second } = await setup();
    await first.enable();
    await second.enable();
    const base = first.enqueue('base') as string;
    await first.engine.run();
    await second.engine.run();
    const left = first.enqueue('left') as string;
    const right = second.enqueue('right') as string;
    await first.engine.run();
    await second.engine.run();
    await first.engine.run();
    const entityId = first.storage.sync.getOperation(first.opened.vaultId, base)
      ?.entityId as string;
    for (const peer of [first, second]) {
      expect(peer.storage.sync.heads(first.opened.vaultId, entityId).sort()).toEqual(
        [left, right].sort(),
      );
      expect(peer.storage.sync.getOperation(first.opened.vaultId, left)?.record).toMatchObject({
        content: { text: 'left' },
      });
      expect(peer.storage.sync.getOperation(first.opened.vaultId, right)?.record).toMatchObject({
        content: { text: 'right' },
      });
    }
    expect(first.storage.sync.localEntity(first.opened.vaultId, 'global/note.md')?.revision).toBe(
      left,
    );
    expect(second.storage.sync.localEntity(first.opened.vaultId, 'global/note.md')?.revision).toBe(
      right,
    );
  });

  it('keeps the immutable outbox after an accepted upload loses its response and restarts with the same IDs', async () => {
    const { server, first, second } = await setup();
    await first.enable();
    await second.enable();
    let lost = false;
    first.options.fetch = async (input, init) => {
      const result = await fetch(input, init);
      if (new URL(String(input)).pathname.includes('/uploads/') && !lost) {
        lost = true;
        await result.arrayBuffer();
        throw new Error('synthetic lost response');
      }
      return result;
    };
    await first.reopen();
    const opId = first.enqueue('survives interrupted upload') as string;
    await expect(first.engine.run()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const before = first.storage.sync.commits(first.opened.vaultId)[0];
    expect(before).toBeDefined();
    await first.reopen();
    await first.engine.run();
    await second.engine.run();
    const after = first.storage.sync.commits(first.opened.vaultId, false)[0];
    expect(after).toMatchObject({
      commitId: before?.commitId,
      body: before?.body,
      state: 'committed',
    });
    expect(second.storage.sync.operations(first.opened.vaultId, 'inbox', 'applied')).toHaveLength(
      1,
    );
    expect(second.storage.sync.getOperation(first.opened.vaultId, opId)?.state).toBe('applied');
    expect(server.sync.attempts.uploads).toBe(2);
    expect(server.sync.attempts.commits).toBe(1);
  });

  it('does not delete a pending commit or expose its prepared records and polls without another upload', async () => {
    const { server, first, second } = await setup();
    await first.enable();
    await second.enable();
    server.sync.pendingCommits = true;
    first.enqueue('pending snapshot');
    await first.engine.run();
    await second.engine.run();
    const commit = first.storage.sync.commits(first.opened.vaultId)[0];
    expect(commit?.state).toBe('pending');
    expect(second.storage.sync.operations(first.opened.vaultId, 'inbox', 'applied')).toEqual([]);
    server.sync.finalize();
    first.storage.transaction(() =>
      first.storage.sync.putCommit({ ...(commit as NonNullable<typeof commit>), retryAt: 0 }),
    );
    await first.engine.run();
    await second.engine.run();
    expect(first.storage.sync.commits(first.opened.vaultId)).toEqual([]);
    expect(server.sync.attempts).toMatchObject({ uploads: 1, downloads: 1, commits: 1 });
  });

  it('quarantines an authenticated wrong record reference before application or applied ACK, with no download loop', async () => {
    const { server, first, second } = await setup();
    await first.enable();
    await second.enable();
    const base = first.enqueue('local good copy') as string;
    await first.engine.run();
    await second.engine.run();
    const entityId = first.storage.sync.getOperation(first.opened.vaultId, base)
      ?.entityId as string;
    const key = await first.client.json('unlocked', 'POST', '/api/wevir/sync/v1/keys/unlock', {
      keyEpoch: '1',
    });
    const blobId = newId('sbl');
    const opId = newId('sop');
    const bytes = await encryptPack({
      vaultId: first.opened.vaultId,
      blobId,
      keyEpoch: '1',
      vaultKey: Buffer.from(key.keyMaterial, 'base64url'),
      records: {
        v: 1,
        records: [
          {
            opId: newId('wrong'),
            entityId,
            kind: 'put',
            parents: [base],
            content: {
              schema: 'synthetic-memory/1',
              localKey: 'global/note.md',
              text: 'must not replace good data',
            },
          },
        ],
      },
    });
    const upload = await first.client.json(
      'blobReserved',
      'POST',
      '/api/wevir/sync/v1/blobs/reserve',
      { blobId, cipherBytes: bytes.length, cipherSha256: sha256(bytes), purpose: 'memory' },
    );
    await first.client.transfer({
      method: 'PUT',
      path: `/api/wevir/sync/v1/uploads/${upload.uploadId}`,
      body: bytes,
      contentType: 'application/octet-stream',
    });
    const operation: SyncOperation = {
      protocol: 'wevir-sync/1',
      vaultId: first.opened.vaultId,
      opId,
      deviceId: first.opened.deviceId,
      deviceSeq: '2',
      entityType: 'memory',
      entityId,
      kind: 'put',
      parents: [base],
      payload: { blobId, recordIndex: 0 },
      clientTime: new Date().toISOString(),
    };
    const recordManifest: RecordManifest = { opId, blobId, recordIndex: 0 };
    await first.client.json('commitResult', 'POST', '/api/wevir/sync/v1/commits', {
      commitId: newId('scm'),
      operations: [operation],
      recordManifest: [recordManifest],
    });
    const before = second.storage.sync.getVault(first.opened.vaultId)?.appliedCursor;
    const ackCount = server.sync.acknowledgements.filter(
      (value) => value.deviceId === second.opened.deviceId,
    ).length;
    await expect(second.engine.run()).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    const downloads = server.sync.attempts.downloads;
    await expect(second.engine.run()).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect(server.sync.attempts.downloads).toBe(downloads);
    expect(second.storage.sync.getVault(first.opened.vaultId)?.appliedCursor).toBe(before);
    expect(
      server.sync.acknowledgements.filter((value) => value.deviceId === second.opened.deviceId),
    ).toHaveLength(ackCount);
    expect(second.storage.sync.localEntity(first.opened.vaultId, 'global/note.md')?.revision).toBe(
      base,
    );
    expect(second.storage.sync.getOperation(first.opened.vaultId, opId)?.state).toBe('quarantined');
  });

  it('bounds automatic paid download attempts across repeated runs and restart', async () => {
    const { server, first, second } = await setup();
    await first.enable();
    await second.enable();
    first.enqueue('download retry budget');
    await first.engine.run();
    server.sync.failDownloads = true;
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(second.engine.run()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await second.reopen();
    await expect(second.engine.run()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(server.sync.attempts.downloads).toBe(3);
  });
});
