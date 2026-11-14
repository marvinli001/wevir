import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PortableManifestSchema, type SessionId } from '@wevir/protocol';
import { jcs, type SyncOperation } from '@wevir/protocol/sync';
import { FileSecretStore, openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { EventStore } from '../event-store.js';
import { HostSettingsStore } from '../settings.js';
import { useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { SyncBlobCache } from './cache.js';
import { encryptPack, sha256 } from './crypto.js';
import { SyncVaultKeys } from './keys.js';
import { SyncPortable } from './portable.js';
import { SyncQueue } from './queue.js';

const temp = useTempDir();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(name: string) {
  const home = join(temp(), name);
  const storage = openStorage({ dataDir: home });
  const events = new EventStore({ storage });
  const secrets = new FileSecretStore(home);
  const client = new ZuvClient({
    secrets,
    origin: 'https://synthetic.invalid',
    fetch: async () => {
      throw new Error('network forbidden');
    },
  });
  cleanups.push(() => {
    events.close();
    storage.close();
  });
  cleanups.push(() => client.close());
  const keys = new SyncVaultKeys({ client, secrets, onSecret: () => {} });
  const portable = new SyncPortable({
    home,
    storage,
    events,
    keys,
    settings: new HostSettingsStore(),
    memoryDir: join(home, 'memory'),
    bundleRoots: async () => [],
  });
  storage.transaction(() =>
    storage.sync.bindVault({
      vaultId: 'vault_synthetic',
      accountId: 'account_synthetic',
      deviceId: 'device_original',
      originHostId: 'device_original',
      appliedCursor: 'synthetic-cursor',
    }),
  );
  return { home, storage, events, portable, secrets };
}

describe('portable local data', () => {
  it.each(['part-reuse', 'multiple-indexes'] as const)(
    'rejects amplified local file references: %s',
    async (failure) => {
      const source = fixture(`source-${failure}`),
        target = fixture(`target-${failure}`);
      const bytes = Buffer.from('synthetic part');
      const file = join(source.home, 'part.bin');
      await writeFile(file, bytes);
      source.portable.options.exportRoots = async () => [{ path: file }];
      const exported = await source.portable.exportLocal();
      const manifestPath = join(exported.path, 'manifest.json');
      const manifest = PortableManifestSchema.parse(
        JSON.parse(await readFile(manifestPath, 'utf8')),
      );
      const index = manifest.entries.find((entry) => entry.key === 'local-files');
      if (!index) throw new Error('missing file index');
      const indexPath = join(exported.path, 'entries', index.id);
      const body = JSON.parse(await readFile(indexPath, 'utf8'));
      if (failure === 'part-reuse') {
        body.files[0].parts.push(body.files[0].parts[0]);
        body.files[0].bytes *= 2;
        body.files[0].sha256 = sha256(Buffer.concat([bytes, bytes]));
        const changed = Buffer.from(jcs(body));
        await writeFile(indexPath, changed);
        index.bytes = changed.length;
        index.sha256 = sha256(changed);
      } else {
        const duplicate = { ...index, id: 'duplicate_index_entry' };
        manifest.entries.push(duplicate);
        await writeFile(join(exported.path, 'entries', duplicate.id), await readFile(indexPath));
      }
      await writeFile(manifestPath, jcs(manifest));
      await expect(target.portable.importPrepare(exported.path)).rejects.toMatchObject({
        code: 'INTEGRITY_FAILED',
      });
    },
  );
  it('exports a consistent database snapshot while unrelated writes continue', async () => {
    const h = fixture('active-host');
    h.portable.options.exportRoots = async () => {
      h.storage.sync.setVaultTransport('vault_synthetic', {
        keyEpoch: '1',
        state: 'idle',
        retryAt: 0,
      });
      return [];
    };
    await expect(h.portable.exportLocal()).resolves.toHaveProperty('path');
  });
  it('rejects a linked entry leaf as an integrity error before following its bytes', async () => {
    const source = fixture('leaf-source'),
      target = fixture('leaf-target');
    const exported = await source.portable.exportLocal();
    const manifest = PortableManifestSchema.parse(
      JSON.parse(await readFile(join(exported.path, 'manifest.json'), 'utf8')),
    );
    const entry = manifest.entries[0];
    if (!entry) throw new Error('missing synthetic entry');
    const leaf = join(exported.path, 'entries', entry.id),
      outside = join(source.home, 'outside-entry');
    await rename(leaf, outside);
    await symlink(outside, leaf, 'file');
    await expect(target.portable.importPrepare(exported.path)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect((await target.portable.list()).packages).toEqual([]);
  });
  it('splits native binary files into entries that fit the existing remote frame limit', async () => {
    const a = fixture('large-file');
    const path = join(a.home, 'synthetic.bin');
    await writeFile(path, Buffer.alloc(3 * 1024 * 1024, 71));
    a.portable.options.exportRoots = async () => [{ path }];
    const exported = await a.portable.exportLocal();
    const b = fixture('large-target');
    const staged = await b.portable.importPrepare(exported.path);
    await b.portable.importApply(staged.importId);
    const parts = (await b.portable.read(staged.importId)).entries.filter(
      (entry) => entry.kind === 'file',
    );
    expect(parts).toHaveLength(2);
    const buffers = [];
    for (const part of parts) {
      const result = await b.portable.entry(staged.importId, part.id);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4 * 1024 * 1024);
      buffers.push(Buffer.from(result.base64, 'base64'));
    }
    expect(Buffer.concat(buffers)).toEqual(Buffer.alloc(3 * 1024 * 1024, 71));
  });
  it('rejects source changes during export instead of publishing mixed revisions', async () => {
    const a = fixture('concurrent-source');
    a.portable.options.exportRoots = async () => {
      await a.portable.options.settings.update({ autoMemory: false });
      return [];
    };
    await expect(a.portable.exportLocal()).rejects.toThrow('REVISION_CONFLICT');
  });
  it('exports all versions, tombstones and referenced binary chunks, then imports offline without altering local facts', async () => {
    const a = fixture('source');
    a.storage.workspaces.insert(workspace({ rootPath: join(a.home, 'project') }));
    a.storage.sessions.insert(session({ cwd: join(a.home, 'project') }));
    a.events.append('ses_01' as SessionId, {
      type: 'session.created',
      source: 'host',
      payload: {
        workspaceId: 'ws_01',
        cwd: join(a.home, 'project'),
        engine: 'echo',
        engineSessionId: 'native_synthetic',
        providerId: 'deepseek-official',
        modelId: 'synthetic',
        title: 'Portable synthetic history',
      },
    });
    a.events.append('ses_01' as SessionId, {
      type: 'engine.raw',
      source: 'engine',
      payload: { protocol: 'synthetic', method: 'diagnostic-only', params: { omitted: true } },
    });
    await mkdir(join(a.home, 'memory/global'), { recursive: true });
    await writeFile(join(a.home, 'memory/global/synthetic.md'), 'Synthetic local memory');
    const bytes = Buffer.from([0, 255, 15, 128]);
    a.storage.transaction(() => {
      const queue = new SyncQueue(a.storage);
      queue.enqueue({
        vaultId: 'vault_synthetic',
        entityId: 'chunk_synthetic',
        opId: 'op_chunk_synthetic',
        entityType: 'artifact',
        localKey: 'chunk:synthetic',
        content: {
          schema: 'wevir-chunk/1',
          ownerId: 'bundle_synthetic',
          index: 0,
          data: bytes.toString('base64url'),
          sha256: sha256(bytes),
        },
      });
      queue.enqueue({
        vaultId: 'vault_synthetic',
        entityId: 'bundle_synthetic',
        opId: 'op_bundle_synthetic',
        entityType: 'skill-bundle',
        localKey: 'skill:synthetic',
        content: {
          schema: 'wevir-bundle/1',
          category: 'skill-bundle',
          name: 'Synthetic skill',
          exclusions: [],
          files: [
            {
              path: 'assets/binary.dat',
              bytes: bytes.length,
              sha256: sha256(bytes),
              parts: [{ entityId: 'chunk_synthetic', opId: 'op_chunk_synthetic' }],
            },
          ],
        },
      });
      queue.enqueue({
        vaultId: 'vault_synthetic',
        entityId: 'memory_synthetic',
        opId: 'op_memory_old',
        entityType: 'memory',
        localKey: 'memory:synthetic',
        content: {
          schema: 'wevir-memory/1',
          scope: 'global',
          name: 'synthetic',
          markdown: 'Synthetic history',
        },
      });
      queue.enqueue({
        vaultId: 'vault_synthetic',
        entityId: 'memory_synthetic',
        opId: 'op_memory_deleted',
        entityType: 'memory',
        localKey: 'memory:synthetic',
        kind: 'delete',
        content: { schema: 'wevir-memory/1', scope: 'global', name: 'synthetic', deleted: true },
      });
    });
    const exported = await a.portable.exportLocal();
    expect(exported.counts.version).toBe(4);
    expect(exported.omissions).toContain('engine.raw');
    const b = fixture('receiver');
    const before = b.storage.sync.counts('vault_synthetic');
    const staged = await b.portable.importPrepare(exported.path);
    expect(staged.state).toBe('staged');
    expect((await b.portable.list()).packages).toHaveLength(0);
    await b.portable.importApply(staged.importId);
    const entries = (await b.portable.read(staged.importId)).entries;
    const read = async (id: string) =>
      JSON.parse(
        Buffer.from((await b.portable.entry(staged.importId, id)).base64, 'base64').toString(),
      );
    const version = entries.find((entry) => entry.opId === 'op_bundle_synthetic');
    expect(version).toBeDefined();
    expect((await read(version?.id as string)).record.content.files[0].parts[0].opId).toBe(
      'op_chunk_synthetic',
    );
    expect(entries.some((entry) => entry.opId === 'op_memory_old')).toBe(true);
    expect(entries.some((entry) => entry.opId === 'op_memory_deleted')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'memory')).toBe(true);
    expect(b.storage.sync.counts('vault_synthetic')).toEqual(before);
    expect(b.storage.sessions.list()).toHaveLength(0);
    const conversation = await b.portable.conversation(staged.importId, 'ses_01');
    expect(conversation.session).toMatchObject({
      state: 'closed',
      readOnly: { reason: 'imported' },
    });
    expect(conversation.events.map((event) => event.type)).toEqual(['session.created']);
    expect(b.storage.sync.activeVault()?.originHostId).toBe('device_original');
    for (const entry of entries.filter((entry) => entry.kind === 'events'))
      expect(JSON.stringify(await read(entry.id))).not.toContain('diagnostic-only');
  });

  it('decrypts a cached encrypted pack while signed out and exports no vault keys', async () => {
    const a = fixture('offline-crypto');
    const key = Buffer.alloc(32, 7);
    await a.secrets.set('sync.vault_synthetic.key.1', key.toString('base64url'));
    const record = {
      opId: 'op_encrypted_synthetic',
      entityId: 'memory_encrypted',
      kind: 'put' as const,
      parents: [],
      content: {
        schema: 'wevir-memory/1',
        scope: 'global',
        name: 'encrypted',
        markdown: 'Recovered without a subscription',
      },
    };
    const operation: SyncOperation = {
      protocol: 'wevir-sync/1',
      vaultId: 'vault_synthetic',
      opId: record.opId,
      entityId: record.entityId,
      entityType: 'memory',
      kind: 'put',
      deviceId: 'device_original',
      deviceSeq: '1',
      parents: [],
      clientTime: new Date().toISOString(),
      payload: { blobId: 'blob_encrypted', recordIndex: 0 },
    };
    const manifest = { opId: operation.opId, blobId: 'blob_encrypted', recordIndex: 0 };
    const bytes = await encryptPack({
      vaultId: 'vault_synthetic',
      blobId: 'blob_encrypted',
      keyEpoch: '1',
      vaultKey: key,
      records: { v: 1, records: [record] },
    });
    const cachePath = await new SyncBlobCache(join(a.home, 'sync/blobs')).put(
      'vault_synthetic',
      'blob_encrypted',
      bytes,
      sha256(bytes),
    );
    a.storage.transaction(() => {
      a.storage.sync.putBlob({
        vaultId: 'vault_synthetic',
        blobId: 'blob_encrypted',
        keyEpoch: '1',
        cipherBytes: bytes.length,
        cipherSha256: sha256(bytes),
        cachePath,
        state: 'local',
        uploadAttempts: 0,
        downloadAttempts: 0,
      });
      a.storage.sync.putOperation({
        vaultId: 'vault_synthetic',
        opId: operation.opId,
        entityId: operation.entityId,
        entityType: 'memory',
        deviceId: operation.deviceId,
        deviceSeq: '1',
        envelope: operation,
        manifest,
        digest: sha256(jcs({ operation, manifest })),
        direction: 'outbox',
        state: 'queued',
      });
    });
    const exported = await a.portable.exportLocal();
    const parsed = PortableManifestSchema.parse(
      JSON.parse(await readFile(join(exported.path, 'manifest.json'), 'utf8')),
    );
    const version = parsed.entries.find((entry) => entry.kind === 'version');
    const data = await readFile(join(exported.path, 'entries', version?.id as string), 'utf8');
    expect(data).toContain('Recovered without a subscription');
    expect(data).not.toContain(key.toString('base64url'));
  });

  it('quarantines tampered and symlinked content before exposing any imported package', async () => {
    const a = fixture('tampering');
    const exported = await a.portable.exportLocal();
    const manifest = JSON.parse(await readFile(join(exported.path, 'manifest.json'), 'utf8'));
    await writeFile(join(exported.path, 'entries', manifest.entries[0].id), 'tampered');
    const b = fixture('target');
    await expect(b.portable.importPrepare(exported.path)).rejects.toThrow();
    expect((await b.portable.list()).packages).toHaveLength(0);
    const link = join(a.home, 'symlink-package');
    await symlink(exported.path, link, 'dir');
    await expect(b.portable.importPrepare(link)).rejects.toThrow('INTEGRITY_FAILED');
    expect(b.storage.sync.counts('vault_synthetic').pending).toBe(0);
  });
});
