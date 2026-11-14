import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  PORTABLE_RECOVERY_INSTRUCTIONS,
  PortableConversationSchema,
  PortableLocalFilesSchema,
  type PortableManifest,
  PortableManifestSchema,
  PortablePreviewSchema,
  PortableVersionSchema,
  PROTOCOL_VERSION,
  type SessionId,
  SyncBundleContentSchema,
  SyncChunkContentSchema,
  SyncSettingsValuesSchema,
  SyncSigningKeysCacheSchema,
  SyncWorkspaceMetadataSchema,
  PortableVersionSchema as Version,
  WevirEventSchema,
} from '@wevir/protocol';
import { jcs, matchRecord, packRecord, schemas, validateOperation } from '@wevir/protocol/sync';
import {
  createEpisodeRepository,
  createEventRepository,
  createRetroRepository,
  createSessionRepository,
  createSyncRepository,
  createWorkspaceRepository,
  openReadOnlyDatabase,
  type SqliteDatabase,
  type Storage,
  type SyncVaultRecord,
} from '@wevir/storage';
import type { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import type { HostSettingsStore } from '../settings.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { type BundleRoot, excludedBundlePath, snapshotBundle } from './bundle-snapshot.js';
import { SyncBlobCache } from './cache.js';
import { decryptPack, eventDigest, parseEnvelope, sha256 } from './crypto.js';
import type { SyncVaultKeys } from './keys.js';
import { verifySyncSignature } from './signed.js';

type Entry = PortableManifest['entries'][number];
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY = 2 * 1024 * 1024;
const RECOVERY = PORTABLE_RECOVERY_INSTRUCTIONS;
const versionKey = (vaultId: string, opId: string) => `${vaultId}/${opId}`;

export interface PortableOptions {
  home: string;
  storage: Storage;
  events: EventStore;
  settings: HostSettingsStore;
  keys: SyncVaultKeys;
  memoryDir: string;
  bundleRoots: (vault: SyncVaultRecord) => Promise<BundleRoot[]>;
  exportRoots?: () => Promise<BundleRoot[]>;
  origin?: string;
}
export class SyncPortable {
  constructor(readonly options: PortableOptions) {}

  async exportLocal(directory = join(this.options.home, 'portable/exports'), signal?: AbortSignal) {
    if (!isAbsolute(directory)) throw new ZuvRequestError('INVALID_REQUEST');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const packageId = newId('wpk');
    const path = join(directory, `wevir-${packageId}`);
    const manifest: PortableManifest = {
      schema: 'wevir-portable/1',
      packageId,
      hostProtocol: PROTOCOL_VERSION,
      createdAt: new Date().toISOString(),
      protection: 'plaintext',
      recovery: RECOVERY,
      consistency: 'database-cas-and-per-root-snapshots',
      omissions: [
        'engine.raw',
        'engine-native state and running processes',
        'credentials and vault keys',
        'search indexes and rendering caches',
        'workspace files not selected in a captured workspace snapshot',
      ],
      entries: [],
    };
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, 'entries'), { mode: 0o700 });
    let total = 0;
    const add = async (
      kind: Entry['kind'],
      key: string,
      value: unknown,
      extra: Partial<Entry> = {},
    ) => {
      signal?.throwIfAborted();
      const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(jcs(value));
      total += bytes.length;
      if (bytes.length > MAX_ENTRY || total > MAX_BYTES || manifest.entries.length >= 100000)
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      const entry: Entry = {
        id: newId('wpe'),
        kind,
        key,
        bytes: bytes.length,
        sha256: sha256(bytes),
        encoding: value instanceof Uint8Array ? 'binary' : 'json',
        ...extra,
      };
      await writeFile(join(path, 'entries', entry.id), bytes, { flag: 'wx', mode: 0o600 });
      manifest.entries.push(entry);
      return entry.id;
    };
    let snapshot: SqliteDatabase | undefined;
    try {
      snapshot = openReadOnlyDatabase(this.options.storage.path);
      snapshot.exec('BEGIN');
      const storage: Storage = {
        ...this.options.storage,
        db: snapshot,
        workspaces: createWorkspaceRepository(snapshot),
        sessions: createSessionRepository(snapshot),
        events: createEventRepository(snapshot),
        sync: createSyncRepository(snapshot),
        episodes: createEpisodeRepository(snapshot),
        retros: createRetroRepository(snapshot),
      };
      const { events } = this.options;
      const workspaces = storage.workspaces.list({ includeRemoved: true });
      const sessions = storage.sessions.list({
        includeRemovedWorkspaces: true,
        includeChildren: true,
        includeSide: true,
        archived: 'include',
      });
      const highWater = sessions.map((session) => ({
        session,
        through: storage.events.lastSeq(session.id),
        state: events.state(session.id as SessionId),
      }));
      const settingsBefore = this.options.settings.get();
      const sourceStamp = () =>
        jcs({
          settings: this.options.settings.get(),
        });
      const stamp = sourceStamp();
      const sharedFiles: Array<{ key: string; path: string }> = [];
      for (const workspace of workspaces) {
        await add('project', workspace.id, workspace);
        for (const episode of storage.episodes.list(workspace.id))
          await add('episode', episode.id, episode);
      }
      for (const { session, through, state } of highWater) {
        if (!state) throw new ZuvRequestError('REVISION_CONFLICT');
        await add('session', session.id, state);
        let after = 0;
        while (after < through) {
          const page = storage.events
            .list(session.id, { afterSeq: after, limit: 128 })
            .filter((event) => event.seq <= through);
          if (!page.length) throw new ZuvRequestError('REVISION_CONFLICT');
          after = page.at(-1)?.seq ?? through;
          const safe = page
            .filter((event) => event.type !== 'engine.raw')
            .map((event) => WevirEventSchema.parse(event));
          if (session.origin?.kind !== 'synced' && session.origin?.kind !== 'imported')
            for (const event of safe)
              if (event.type === 'file.shared')
                for (const file of event.payload.files)
                  sharedFiles.push({
                    key: `shared:${session.id}:${event.seq}`,
                    path: isAbsolute(file.path) ? file.path : resolve(session.cwd, file.path),
                  });
          if (safe.length) await add('events', session.id, safe);
        }
        const summary = storage.retros.getSummary(session.id);
        if (summary) await add('retro', session.id, summary);
      }
      const settings = settingsBefore;
      await add(
        'settings',
        'settings',
        SyncSettingsValuesSchema.parse(
          Object.fromEntries(
            Object.keys(SyncSettingsValuesSchema.shape).flatMap((key) =>
              key in settings ? [[key, settings[key as keyof typeof settings]]] : [],
            ),
          ),
        ),
      );
      const allFiles: Array<{
        key: string;
        path: string;
        bytes: number;
        sha256: string;
        parts: string[];
      }> = [];
      const fileSnapshots: Array<{ root: BundleRoot; fingerprint: string }> = [];
      const files = async (key: string, root: BundleRoot, kind: Entry['kind'] = 'file') => {
        const snapshot = await snapshotBundle(root, true);
        fileSnapshots.push({ root, fingerprint: snapshot.fingerprint });
        for (const omitted of snapshot.exclusions) manifest.omissions.push(`${key}/${omitted}`);
        for (const file of snapshot.files) {
          const parts: string[] = [];
          for (
            let offset = 0;
            offset < file.bytes.length || (offset === 0 && file.bytes.length === 0);
            offset += MAX_ENTRY
          )
            parts.push(
              await add(kind, key, file.bytes.subarray(offset, offset + MAX_ENTRY), {
                path: file.path,
              }),
            );
          allFiles.push({
            key,
            path: file.path,
            bytes: file.bytes.length,
            sha256: file.sha256,
            parts,
          });
        }
      };
      await files('global-memory', { path: this.options.memoryDir }, 'memory');
      for (const shared of sharedFiles) {
        const info = await lstat(shared.path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        });
        if (!info?.isFile() || info.isSymbolicLink()) {
          manifest.omissions.push(`${shared.key}: unavailable file`);
          continue;
        }
        await files(shared.key, { path: shared.path });
      }
      if (sharedFiles.length)
        manifest.omissions.push(
          'uncaptured historical file.shared versions; local shared files contain export-time bytes',
        );
      await files('bundle-write-recovery', { path: join(this.options.home, 'sync/bundle-writes') });
      const vaults = storage.sync.vaults();
      const localVault: SyncVaultRecord = {
        vaultId: 'portable_local',
        accountId: 'portable_local',
        deviceId: 'portable_local',
        originHostId: 'portable_local',
        deviceSeq: '0',
        active: false,
        enabled: false,
        revision: '0',
        categories: ['rule', 'skill-bundle', 'artifact'],
        projectIds: [],
        appliedCursor: '',
      };
      for (const vault of vaults)
        localVault.projectIds.push(...storage.sync.projects(vault.vaultId).map((p) => p.projectId));
      // Host-known roots retain their exclusions; exporting never scans arbitrary user paths.
      const roots = this.options.exportRoots
        ? await this.options.exportRoots()
        : (
            await Promise.all(
              (vaults.length ? vaults : [localVault]).map((vault) =>
                this.options.bundleRoots({
                  ...vault,
                  categories: localVault.categories,
                  projectIds: storage.sync.projects(vault.vaultId).map((p) => p.projectId),
                }),
              ),
            )
          ).flat();
      for (const root of roots) await files(`material:${root.path}`, root);
      await add('references', 'local-files', { schema: 'wevir-portable-files/1', files: allFiles });
      for (const vault of vaults) {
        await add('references', `vault:${vault.vaultId}`, {
          schema: 'wevir-portable-vault/1',
          vault,
          projects: storage.sync.projects(vault.vaultId),
          sources: storage.sync.sources(vault.vaultId),
          contentRefs: storage.sync.contentRefs(vault.vaultId),
          entities: storage.sync.entities(vault.vaultId),
          localWrites: storage.sync.localWrites(vault.vaultId),
          historyRoots: storage.db
            .prepare('SELECT entity_id, op_id, job_id FROM sync_snapshot_roots WHERE vault_id = ?')
            .all(vault.vaultId),
          bundleApplications: storage.db
            .prepare('SELECT * FROM sync_bundle_applications WHERE vault_id = ?')
            .all(vault.vaultId),
          bundleBindings: storage.db
            .prepare('SELECT * FROM sync_bundle_bindings WHERE vault_id = ?')
            .all(vault.vaultId),
          commits: storage.db
            .prepare('SELECT * FROM sync_commits WHERE vault_id = ?')
            .all(vault.vaultId),
          recoveredOperations: storage.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox_recoveries'",
            )
            .get()
            ? storage.db
                .prepare('SELECT * FROM sync_outbox_recoveries WHERE vault_id = ?')
                .all(vault.vaultId)
            : [],
        });
        for (const opId of storage.sync.portableVersionIds(vault.vaultId)) {
          const version = await this.#version(vault.vaultId, opId, storage);
          await add('version', versionKey(vault.vaultId, opId), version, {
            vaultId: vault.vaultId,
            entityId: version.entityId,
            opId,
          });
        }
      }
      await writeFile(join(path, 'manifest.json'), jcs(PortableManifestSchema.parse(manifest)), {
        flag: 'wx',
        mode: 0o600,
      });
      await this.#verify(path, signal);
      for (const { root, fingerprint } of fileSnapshots)
        if ((await snapshotBundle(root, true)).fingerprint !== fingerprint)
          throw new ZuvRequestError('REVISION_CONFLICT');
      if (sourceStamp() !== stamp) throw new ZuvRequestError('REVISION_CONFLICT');
      return this.#preview(path, manifest, packageId, 'exported');
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    } finally {
      snapshot?.exec('ROLLBACK');
      snapshot?.close();
    }
  }

  async importPrepare(source: string, signal?: AbortSignal) {
    if (!isAbsolute(source)) throw new ZuvRequestError('INVALID_REQUEST');
    const importId = newId('wpi');
    const path = this.#path('staged', importId);
    await mkdir(join(this.options.home, 'portable/staged'), { recursive: true, mode: 0o700 });
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, 'entries'), { mode: 0o700 });
    try {
      const manifest = await this.#manifest(resolve(source));
      const space = await statfs(path, { bigint: true });
      if (
        space.bavail * space.bsize <
        BigInt(manifest.entries.reduce((n, entry) => n + entry.bytes, 16 * 1024 * 1024))
      )
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      for (const entry of manifest.entries) {
        signal?.throwIfAborted();
        const bytes = await this.#bytes(source, entry);
        await writeFile(join(path, 'entries', entry.id), bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(join(path, 'manifest.json'), jcs(manifest), { flag: 'wx', mode: 0o600 });
      await this.#verify(path, signal);
      return this.#preview(path, manifest, importId, 'staged');
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
  async stageRecords(
    records: AsyncIterable<typeof Version._output>,
    proof: unknown,
    signal?: AbortSignal,
  ) {
    const importId = newId('wpi');
    const path = this.#path('staged', importId);
    await mkdir(join(this.options.home, 'portable/staged'), { recursive: true, mode: 0o700 });
    await mkdir(path, { mode: 0o700 });
    await mkdir(join(path, 'entries'), { mode: 0o700 });
    const manifest: PortableManifest = {
      schema: 'wevir-portable/1',
      packageId: newId('wpk'),
      createdAt: new Date().toISOString(),
      hostProtocol: PROTOCOL_VERSION,
      protection: 'plaintext',
      consistency: 'fixed-signed-snapshot',
      recovery: RECOVERY,
      omissions: [
        'engine.raw',
        'engine-native state and running processes',
        'credentials and vault keys',
        'content outside the selected fixed snapshot',
      ],
      entries: [],
    };
    let total = 0;
    try {
      const save = async (entry: Entry, bytes: Buffer) => {
        total += bytes.length;
        if (bytes.length > MAX_ENTRY || total > MAX_BYTES || manifest.entries.length >= 100000)
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        await writeFile(join(path, 'entries', entry.id), bytes, { flag: 'wx', mode: 0o600 });
        manifest.entries.push(entry);
      };
      const proofBytes = Buffer.from(jcs(proof));
      await save(
        {
          id: newId('wpe'),
          kind: 'references',
          key: 'fixed-snapshot',
          bytes: proofBytes.length,
          sha256: sha256(proofBytes),
          encoding: 'json',
        },
        proofBytes,
      );
      for await (const record of records) {
        signal?.throwIfAborted();
        const version = Version.parse(record);
        const bytes = Buffer.from(jcs(version));
        await save(
          {
            id: newId('wpe'),
            kind: 'version',
            key: versionKey(version.vaultId, version.opId),
            vaultId: version.vaultId,
            entityId: version.entityId,
            opId: version.opId,
            bytes: bytes.length,
            sha256: sha256(bytes),
            encoding: 'json',
          },
          bytes,
        );
      }
      await writeFile(join(path, 'manifest.json'), jcs(manifest), { flag: 'wx', mode: 0o600 });
      await this.#verify(path, signal);
      return this.#preview(path, manifest, importId, 'staged');
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
  async importApply(importId: string, signal?: AbortSignal) {
    const path = this.#path('staged', importId);
    const exists = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    });
    if (!exists) {
      const target = this.#path('imported', importId);
      return this.#preview(target, await this.#verify(target, signal), importId, 'imported');
    }
    const manifest = await this.#verify(path, signal);
    await mkdir(join(this.options.home, 'portable/imported'), { recursive: true, mode: 0o700 });
    const target = this.#path('imported', importId);
    signal?.throwIfAborted();
    await rename(path, target);
    return this.#preview(target, manifest, importId, 'imported');
  }
  async list() {
    const directory = join(this.options.home, 'portable/imported');
    const names = await readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const packages = [];
    for (const importId of names) {
      if (!/^wpi_[A-Za-z0-9_-]+$/.test(importId)) continue;
      const path = this.#path('imported', importId);
      packages.push(this.#preview(path, await this.#manifest(path), importId, 'imported'));
    }
    return { packages };
  }
  async read(importId: string, after = 0) {
    const manifest = await this.#manifest(this.#path('imported', importId));
    return {
      entries: manifest.entries.slice(after, after + 100),
      ...(after + 100 < manifest.entries.length && { next: after + 100 }),
    };
  }
  async entry(importId: string, entryId: string) {
    const path = this.#path('imported', importId);
    const manifest = await this.#manifest(path);
    const entry = manifest.entries.find((entry) => entry.id === entryId);
    if (!entry) throw new ZuvRequestError('NOT_FOUND');
    return { entry, base64: (await this.#bytes(path, entry)).toString('base64') };
  }
  async version(importId: string, entryId: string) {
    const data = await this.entry(importId, entryId);
    if (data.entry.kind !== 'version') throw new ZuvRequestError('INVALID_REQUEST');
    const version = PortableVersionSchema.parse(
      JSON.parse(Buffer.from(data.base64, 'base64').toString()),
    );
    if (
      version.vaultId !== data.entry.vaultId ||
      version.entityId !== data.entry.entityId ||
      version.opId !== data.entry.opId ||
      version.record.opId !== version.opId ||
      version.record.entityId !== version.entityId
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return { ...version, sourceVerified: this.#knownSource(version) };
  }
  async material(importId: string, entryId: string) {
    const path = this.#path('imported', importId),
      manifest = await this.#manifest(path);
    const entries = new Map<string, Entry>();
    for (const entry of manifest.entries.filter((value) => value.kind === 'version')) {
      const key = versionKey(entry.vaultId as string, entry.opId as string);
      if (entries.has(key)) throw new ZuvRequestError('INTEGRITY_FAILED');
      entries.set(key, entry);
    }
    const used = new Map<string, string>();
    const read = async (entry: Entry) => {
      const value = PortableVersionSchema.parse(
        JSON.parse((await this.#bytes(path, entry)).toString()),
      );
      if (
        value.vaultId !== entry.vaultId ||
        value.entityId !== entry.entityId ||
        value.opId !== entry.opId ||
        value.record.opId !== value.opId ||
        value.record.entityId !== value.entityId
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      used.set(versionKey(value.vaultId, value.opId), entry.sha256);
      return { ...value, sourceVerified: this.#knownSource(value) };
    };
    const selected = manifest.entries.find(
      (entry) => entry.id === entryId && entry.kind === 'version',
    );
    if (!selected) throw new ZuvRequestError('INVALID_REQUEST');
    const version = await read(selected);
    let total = 0;
    const materialBytes = new Map<string, Buffer>();
    const contents = new Set<string>();
    const files = async (owner: typeof version) => {
      const body = SyncBundleContentSchema.parse(owner.record.content);
      if (body.category !== owner.entityType) throw new ZuvRequestError('INTEGRITY_FAILED');
      const result: Array<{ path: string; bytes: Buffer; sha256: string; executable: boolean }> =
        [];
      const paths = new Set<string>();
      for (const file of body.files) {
        const path = file.path.normalize('NFC').toLowerCase();
        if (paths.has(path) || excludedBundlePath(file.path))
          throw new ZuvRequestError('INTEGRITY_FAILED');
        paths.add(path);
        const fileKey = jcs([owner.vaultId, owner.entityId, file.bytes, file.sha256, file.parts]);
        const cached = materialBytes.get(fileKey);
        if (cached) {
          result.push({
            path: file.path,
            bytes: cached,
            sha256: file.sha256,
            executable: file.executable === true,
          });
          continue;
        }
        const parts: Buffer[] = [];
        for (const [index, reference] of file.parts.entries()) {
          const entry = entries.get(versionKey(owner.vaultId, reference.opId));
          if (!entry) throw new ZuvRequestError('MISSING_PARENT');
          const part = await read(entry);
          if (
            part.entityId !== reference.entityId ||
            part.entityType !== 'artifact' ||
            part.record.projectId !== owner.record.projectId ||
            part.record.kind === 'delete'
          )
            throw new ZuvRequestError('INTEGRITY_FAILED');
          const chunk = SyncChunkContentSchema.parse(part.record.content),
            bytes = Buffer.from(chunk.data, 'base64url');
          if (
            chunk.ownerId !== owner.entityId ||
            chunk.index !== index ||
            bytes.toString('base64url') !== chunk.data ||
            sha256(bytes) !== chunk.sha256
          )
            throw new ZuvRequestError('INTEGRITY_FAILED');
          parts.push(bytes);
        }
        const bytes = Buffer.concat(parts);
        const content = `${owner.vaultId}/${owner.entityId}/${file.sha256}`;
        if (!contents.has(content)) {
          total += bytes.length;
          contents.add(content);
        }
        if (total > 64 * 1024 * 1024) throw new ZuvRequestError('QUOTA_EXCEEDED');
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        materialBytes.set(fileKey, bytes);
        result.push({
          path: file.path,
          bytes,
          sha256: file.sha256,
          executable: file.executable === true,
        });
      }
      return { version: owner, body, files: result };
    };
    const material = await files(version);
    const rules: Array<typeof material> = [];
    if (version.entityType === 'workspace-snapshot') {
      const metadata = SyncWorkspaceMetadataSchema.parse(material.body.metadata);
      for (const reference of metadata.ruleVersions) {
        const entry = entries.get(versionKey(version.vaultId, reference.opId));
        if (!entry) throw new ZuvRequestError('MISSING_PARENT');
        const rule = await read(entry);
        if (
          rule.entityType !== 'rule' ||
          rule.entityId !== reference.entityId ||
          (rule.record.projectId && rule.record.projectId !== version.record.projectId)
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        rules.push(await files(rule));
      }
    }
    return {
      ...material,
      rules,
      fingerprint: sha256(jcs([...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
    };
  }
  async conversation(importId: string, sessionId: string, afterSeq = 0) {
    const path = this.#path('imported', importId);
    const manifest = await this.#manifest(path);
    const sessionEntry = manifest.entries.find(
      (entry) => entry.kind === 'session' && entry.key === sessionId,
    );
    if (!sessionEntry) throw new ZuvRequestError('NOT_FOUND');
    const session = JSON.parse((await this.#bytes(path, sessionEntry)).toString());
    const events = [];
    let bytes = Buffer.byteLength(jcs(session)) + 128;
    let more = false;
    for (const entry of manifest.entries) {
      if (entry.kind !== 'events' || entry.key !== sessionId) continue;
      for (const event of WevirEventSchema.array().parse(
        JSON.parse((await this.#bytes(path, entry)).toString()),
      )) {
        if (event.seq <= afterSeq) continue;
        const size = Buffer.byteLength(jcs(event)) + 1;
        if (events.length === 128 || bytes + size > 3 * 1024 * 1024) {
          if (!events.length) throw new ZuvRequestError('QUOTA_EXCEEDED');
          more = true;
          break;
        }
        bytes += size;
        events.push(event);
      }
      if (more) break;
    }
    return {
      ...PortableConversationSchema.parse({
        session: {
          ...session,
          state: 'closed',
          activeTurn: undefined,
          readOnly: { reason: 'imported', message: 'Portable mirror', since: manifest.createdAt },
        },
        events,
      }),
      ...(more && { next: events.at(-1)?.seq }),
    };
  }

  async #version(vaultId: string, opId: string, storage = this.options.storage) {
    const stored = storage.sync.getOperation(vaultId, opId);
    if (stored) {
      const operation = schemas.operation.parse(stored.envelope);
      const manifest = schemas.recordManifest.parse(stored.manifest);
      let record = stored.record;
      if (record === undefined && operation.payload) {
        const blob = storage.sync.blob(vaultId, operation.payload.blobId);
        if (!blob) throw new ZuvRequestError('BLOB_INCOMPLETE');
        const bytes = await new SyncBlobCache(join(this.options.home, 'sync/blobs')).read(
          vaultId,
          blob.blobId,
          blob.cipherBytes,
          blob.cipherSha256,
        );
        const key = await this.options.keys.cached(vaultId, parseEnvelope(bytes).header.keyEpoch);
        try {
          record = (await decryptPack(bytes, key, [operation], [manifest])).records.find(
            (record) => record.opId === opId,
          );
        } finally {
          key.fill(0);
        }
      }
      if (record === undefined && operation.kind === 'delete')
        record = {
          opId,
          entityId: operation.entityId,
          kind: 'delete',
          parents: operation.parents,
          content: null,
          ...(manifest.projectId && { projectId: manifest.projectId }),
        };
      const parsed = packRecord.parse(record);
      matchRecord(operation, parsed, manifest);
      return Version.parse({
        vaultId,
        opId,
        entityId: operation.entityId,
        entityType: operation.entityType,
        operation,
        manifest,
        record: parsed,
      });
    }
    const draft = storage.sync.draft(vaultId, opId);
    const entity = draft && storage.sync.entity(vaultId, draft.entityId);
    if (!draft || !entity) throw new ZuvRequestError('INTEGRITY_FAILED');
    const payload = draft.content as { schema: string; body: unknown; events?: unknown };
    if (payload.schema !== 'wevir-sync-draft/1') throw new ZuvRequestError('UPGRADE_REQUIRED');
    return Version.parse({
      vaultId,
      opId,
      entityId: draft.entityId,
      entityType: entity.entityType,
      record: {
        opId,
        entityId: draft.entityId,
        kind: draft.kind,
        parents: draft.parents,
        content: payload.body,
        ...(payload.events !== undefined ? { events: payload.events } : {}),
        ...(entity.projectId && { projectId: entity.projectId }),
      },
    });
  }
  #path(state: 'staged' | 'imported', importId: string) {
    if (!/^wpi_[A-Za-z0-9_-]+$/.test(importId)) throw new ZuvRequestError('INVALID_REQUEST');
    return join(this.options.home, 'portable', state, importId);
  }
  async #manifest(path: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
    const bytes = await this.#file(join(path, 'manifest.json'), 32 * 1024 * 1024);
    const manifest = PortableManifestSchema.parse(JSON.parse(bytes.toString()));
    if (
      new Set(manifest.entries.map((entry) => entry.id)).size !== manifest.entries.length ||
      manifest.entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_BYTES
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    await this.#verifyProof(path, manifest);
    return manifest;
  }
  #knownSource(version: typeof Version._output): boolean {
    const known = this.options.storage.sync.getOperation(version.vaultId, version.opId);
    return Boolean(
      version.operation &&
        version.manifest &&
        known?.record &&
        ['applied', 'committed'].includes(known.state) &&
        jcs(known.envelope) === jcs(version.operation) &&
        jcs(known.manifest) === jcs(version.manifest) &&
        jcs(known.record) === jcs(version.record),
    );
  }
  async #verifyProof(path: string, manifest: PortableManifest) {
    const proofs = manifest.entries.filter(
      (entry) => entry.kind === 'references' && entry.key === 'fixed-snapshot',
    );
    if (proofs.length > 1) throw new ZuvRequestError('INTEGRITY_FAILED');
    const entry = proofs[0];
    if (!entry) return;
    const proof = JSON.parse((await this.#bytes(path, entry)).toString()) as {
      schema?: string;
      exported?: unknown;
    };
    if (proof.schema !== 'wevir-portable-snapshot/1') throw new ZuvRequestError('INTEGRITY_FAILED');
    const parsed = schemas.exported.safeParse(proof.exported);
    if (!parsed.success) throw new ZuvRequestError('INTEGRITY_FAILED');
    const exported = parsed.data;
    if (
      exported.restoreId !== exported.snapshot.restoreId ||
      exported.snapshotCursor !== exported.snapshot.snapshotCursor ||
      sha256(jcs(exported.manifest)) !== exported.snapshot.blobManifestSha256
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (!this.options.origin) return;
    const pinsPath = join(
      this.options.home,
      'sync/restores',
      `${sha256(this.options.origin)}.keys.json`,
    );
    const bytes = await this.#file(pinsPath, 2 * 1024 * 1024).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    if (!bytes) return;
    const pins = new Map(SyncSigningKeysCacheSchema.parse(JSON.parse(bytes.toString())));
    if (pins.has(exported.snapshot.signingKeyId)) verifySyncSignature(exported.snapshot, pins);
  }
  async #file(path: string, maxBytes: number) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      if (!info.isFile() || info.size > maxBytes) throw new ZuvRequestError('INTEGRITY_FAILED');
      const bytes = await file.readFile();
      if (bytes.length > maxBytes) throw new ZuvRequestError('INTEGRITY_FAILED');
      return bytes;
    } finally {
      await file.close();
    }
  }
  async #bytes(path: string, entry: Entry) {
    const info = await lstat(join(path, 'entries'));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
    const bytes = await this.#file(join(path, 'entries', entry.id), entry.bytes);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return bytes;
  }
  async #verify(path: string, signal?: AbortSignal) {
    const manifest = await this.#manifest(path);
    const versions = new Map<string, Entry>();
    const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    const infos = new Map<string, { schema?: string; entityType: string; projectId?: string }>();
    const usedEntries = new Set<string>();
    const budget = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let verifiedBytes = 0;
    const nested = async (entry: Entry) => {
      signal?.throwIfAborted();
      if (usedEntries.has(entry.id)) throw new ZuvRequestError('INTEGRITY_FAILED');
      usedEntries.add(entry.id);
      verifiedBytes += entry.bytes;
      if (verifiedBytes > budget) throw new ZuvRequestError('QUOTA_EXCEEDED');
      return this.#bytes(path, entry);
    };
    if (
      manifest.entries.filter((entry) => entry.kind === 'references' && entry.key === 'local-files')
        .length > 1
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const readVersion = async (entry: Entry, data?: Buffer) => {
      const version = Version.parse(JSON.parse((data ?? (await nested(entry))).toString()));
      if (
        version.vaultId !== entry.vaultId ||
        version.opId !== entry.opId ||
        version.entityId !== entry.entityId ||
        version.record.opId !== version.opId ||
        version.record.entityId !== version.entityId
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      if (version.operation && version.manifest) {
        validateOperation(version.operation);
        if (
          version.operation.vaultId !== version.vaultId ||
          version.operation.entityType !== version.entityType
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        matchRecord(version.operation, version.record, version.manifest);
        if (version.operation.origin)
          for (const event of version.record.events ?? [])
            if (
              eventDigest(
                {
                  vaultId: version.vaultId,
                  hostId: version.operation.origin.hostId,
                  sessionId: version.operation.origin.sessionId,
                  streamId: version.operation.origin.streamId,
                  seq: event.seq,
                },
                event.content,
              ) !== event.sha256
            )
              throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      return version;
    };
    for (const entry of manifest.entries) {
      signal?.throwIfAborted();
      const data = await this.#bytes(path, entry);
      if (entry.kind === 'events') {
        const events = WevirEventSchema.array().parse(JSON.parse(data.toString()));
        if (events.some((event) => event.sessionId !== entry.key || event.type === 'engine.raw'))
          throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      if (entry.kind === 'references' && entry.key === 'local-files') {
        const groups = PortableLocalFilesSchema.parse(JSON.parse(data.toString()));
        for (const file of groups.files) {
          const parts: Buffer[] = [];
          let length = 0;
          for (const id of file.parts) {
            const part = entries.get(id);
            if (part?.encoding !== 'binary' || part.key !== file.key || part.path !== file.path)
              throw new ZuvRequestError('INTEGRITY_FAILED');
            const bytes = await nested(part);
            length += bytes.length;
            if (length > file.bytes || length > 64 * 1024 * 1024)
              throw new ZuvRequestError('INTEGRITY_FAILED');
            parts.push(bytes);
          }
          if (length !== file.bytes || sha256(Buffer.concat(parts)) !== file.sha256)
            throw new ZuvRequestError('INTEGRITY_FAILED');
        }
      }
      if (entry.kind === 'version') {
        if (
          !entry.vaultId ||
          !entry.opId ||
          !entry.entityId ||
          versions.has(versionKey(entry.vaultId, entry.opId))
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        const version = await readVersion(entry, data);
        infos.set(versionKey(entry.vaultId, entry.opId), {
          schema: (version.record.content as { schema?: string } | null)?.schema,
          entityType: version.entityType,
          projectId: version.record.projectId,
        });
        versions.set(versionKey(entry.vaultId, entry.opId), entry);
      }
    }
    const verifiedFiles = new Set<string>();
    const chunkFiles = new Map<string, string>();
    for (const entry of versions.values()) {
      if (
        infos.get(versionKey(entry.vaultId as string, entry.opId as string))?.schema !==
        'wevir-bundle/1'
      )
        continue;
      const version = await readVersion(entry);
      if ((version.record.content as { schema?: string } | null)?.schema !== 'wevir-bundle/1')
        continue;
      const bundle = SyncBundleContentSchema.parse(version.record.content);
      const metadata = bundle.metadata as
        | { schema?: string; ruleVersions?: Array<{ entityId: string; opId: string }> }
        | undefined;
      if (metadata?.schema === 'wevir-workspace-snapshot/1') {
        if (!Array.isArray(metadata.ruleVersions)) throw new ZuvRequestError('INTEGRITY_FAILED');
        for (const ref of metadata.ruleVersions) {
          const ruleEntry = versions.get(versionKey(version.vaultId, ref.opId));
          if (!ruleEntry || ruleEntry.entityId !== ref.entityId)
            throw new ZuvRequestError('MISSING_PARENT');
          const rule = infos.get(versionKey(version.vaultId, ref.opId)) as {
            entityType: string;
            projectId?: string;
          };
          if (
            rule.entityType !== 'rule' ||
            (rule.projectId !== undefined && rule.projectId !== version.record.projectId)
          )
            throw new ZuvRequestError('INTEGRITY_FAILED');
        }
      }
      const paths = new Set<string>();
      for (const file of bundle.files) {
        signal?.throwIfAborted();
        if (paths.has(file.path)) throw new ZuvRequestError('INTEGRITY_FAILED');
        paths.add(file.path);
        const fileKey = jcs([
          version.vaultId,
          version.entityId,
          bundle.category === 'workspace-snapshot' ? 'workspace-content' : file.path,
          file.sha256,
          file.bytes,
          file.parts,
        ]);
        if (verifiedFiles.has(fileKey)) continue;
        const parts: Buffer[] = [];
        let length = 0;
        for (const [index, ref] of file.parts.entries()) {
          const chunkKey = versionKey(version.vaultId, ref.opId);
          if (chunkFiles.has(chunkKey)) throw new ZuvRequestError('INTEGRITY_FAILED');
          chunkFiles.set(chunkKey, fileKey);
          const chunkEntry = versions.get(chunkKey);
          if (!chunkEntry || chunkEntry.entityId !== ref.entityId)
            throw new ZuvRequestError('MISSING_PARENT');
          const chunkVersion = await readVersion(chunkEntry);
          const chunk = SyncChunkContentSchema.parse(chunkVersion.record.content);
          const bytes = Buffer.from(chunk.data, 'base64url');
          if (
            chunk.ownerId !== version.entityId ||
            chunk.index !== index ||
            chunkVersion.record.projectId !== version.record.projectId ||
            sha256(bytes) !== chunk.sha256 ||
            bytes.toString('base64url') !== chunk.data
          )
            throw new ZuvRequestError('INTEGRITY_FAILED');
          length += bytes.length;
          if (length > file.bytes) throw new ZuvRequestError('INTEGRITY_FAILED');
          parts.push(bytes);
        }
        if (length !== file.bytes || sha256(Buffer.concat(parts)) !== file.sha256)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        verifiedFiles.add(fileKey);
      }
    }
    return manifest;
  }
  #preview(
    path: string,
    manifest: PortableManifest,
    importId: string,
    state: 'exported' | 'staged' | 'imported',
  ) {
    const counts: Record<string, number> = {};
    for (const entry of manifest.entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return PortablePreviewSchema.parse({
      importId,
      packageId: manifest.packageId,
      path,
      createdAt: manifest.createdAt,
      protection: manifest.protection,
      entries: manifest.entries.length,
      bytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0),
      counts,
      omissions: manifest.omissions.slice(0, 20),
      omissionCount: manifest.omissions.length,
      state,
    });
  }
}
