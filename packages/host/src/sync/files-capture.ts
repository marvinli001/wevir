import type { Dirent } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { FILES_READ_FILE_MAX_BYTES } from '@wevir/protocol';
import { type EntityType, jcs } from '@wevir/protocol/sync';
import type { Storage, SyncLocalWriteRecord, SyncVaultRecord } from '@wevir/storage';
import { isSafeRelativePath } from '../git-diff.js';
import { newId } from '../ids.js';
import { MEMORY_NAME_PATTERN } from '../memory.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import { SyncQueue } from './queue.js';

export interface SyncBundleRoot {
  category: 'rule' | 'skill-bundle' | 'artifact';
  localKey: string;
  name: string;
  path: string;
  projectId?: string;
  metadata?: unknown;
  paths?: readonly string[];
}
const EXCLUDED =
  /^(?:\.git|\.ssh|\.aws|\.gnupg|node_modules|dist|build|target|\.cache|\.next|\.venv|venv|coverage|__pycache__|\.npmrc|\.netrc|\.pypirc|\.git-credentials|secrets\.json|auth\.json|settings\.local\.json|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519))$/i;

export class SyncFilesCapture {
  readonly #storage: Storage;
  readonly #memoryDir: string;
  readonly #queue: SyncQueue;
  readonly #activeWrites = new Set<string>();
  constructor(options: { storage: Storage; memoryDir: string }) {
    this.#storage = options.storage;
    this.#memoryDir = options.memoryDir;
    this.#queue = new SyncQueue(options.storage);
  }

  beforeMemoryWrite(
    vault: SyncVaultRecord,
    path: string,
    markdown?: string,
  ): (() => void) | undefined {
    if (!vault.categories.includes('memory')) return;
    const location = this.#memoryLocation(vault, path);
    if (!location) return;
    const { scope, name, projectId, localKey } = location;
    const owner = this.#storage.sync.owner(localKey);
    if (owner && owner !== vault.vaultId) return;
    let pending: SyncLocalWriteRecord | undefined;
    this.#storage.transaction(() => {
      if (!this.#storage.sync.claimResource(localKey, vault.vaultId)) return;
      const existing = this.#storage.sync.localEntity(vault.vaultId, localKey);
      pending = {
        id: newId('sjr'),
        vaultId: vault.vaultId,
        entityId: existing?.entityId ?? newId('sen'),
        entityType: 'memory',
        ...(projectId && { projectId }),
        localKey,
        path,
        content: {
          schema: 'wevir-memory/1',
          scope,
          name,
          ...(markdown === undefined ? { deleted: true } : { markdown }),
        },
        kind: markdown === undefined ? 'delete' : 'put',
        parents: existing?.revision ? [existing.revision] : [],
        nextHash: markdown === undefined ? 'missing' : sha256(Buffer.from(markdown)),
        state: 'pending',
      };
      this.#storage.sync.putLocalWrite(pending);
    });
    if (!pending) return;
    const write = pending;
    this.#activeWrites.add(write.id);
    return () => {
      try {
        this.#finishWrite(write);
      } finally {
        this.#activeWrites.delete(write.id);
      }
    };
  }

  async recoverWrites(vault: SyncVaultRecord): Promise<void> {
    for (const pending of this.#storage.sync.localWrites(vault.vaultId)) {
      if (
        pending.state !== 'pending' ||
        this.#activeWrites.has(pending.id) ||
        !this.#memoryLocation(vault, pending.path)
      )
        continue;
      let actual = 'missing';
      try {
        const info = await lstat(pending.path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        actual = sha256(await readFile(pending.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (actual === pending.nextHash) this.#finishWrite(pending);
      else this.#storage.sync.abandonLocalWrite(pending.id);
    }
  }

  #memoryLocation(vault: SyncVaultRecord, path: string) {
    const parts = relative(this.#memoryDir, path).split(/[\\/]/);
    const name = parts.at(-1)?.replace(/\.md$/, '');
    if (!name || !path.endsWith('.md') || !MEMORY_NAME_PATTERN.test(name)) return;
    if (parts.length === 2 && parts[0] === 'global')
      return {
        scope: 'global' as const,
        name,
        localKey: `memory:global:${name}`,
        projectId: undefined,
      };
    if (parts.length !== 3 || parts[0] !== 'projects') return;
    const project = this.#storage.sync
      .projects(vault.vaultId)
      .find(
        (value) => value.workspaceId === parts[1] && vault.projectIds.includes(value.projectId),
      );
    if (!project) return;
    return {
      scope: 'project' as const,
      name,
      localKey: `memory:${project.workspaceId}:${name}`,
      projectId: project.projectId,
    };
  }

  #finishWrite(pending: SyncLocalWriteRecord): void {
    this.#storage.transaction(() => {
      if (!this.#storage.sync.localWrites(pending.vaultId).some((value) => value.id === pending.id))
        return;
      const opId = this.#queue.enqueue({
        ...pending,
        entityType: 'memory',
      });
      this.#storage.sync.putFileBaseline({
        ...pending,
        fingerprint: pending.nextHash,
        ...(opId && { opId }),
      });
      this.#storage.sync.removeLocalWrite(pending.id);
    });
  }

  async memory(
    vault: SyncVaultRecord,
    initialize: boolean,
    includeHistory: boolean,
  ): Promise<void> {
    if (!vault.categories.includes('memory')) return;
    const scopes = [
      {
        root: join(this.#memoryDir, 'global'),
        scope: 'global' as const,
        workspaceId: undefined as string | undefined,
        projectId: undefined as string | undefined,
      },
      ...this.#storage.sync
        .projects(vault.vaultId)
        .filter((value) => value.workspaceId && vault.projectIds.includes(value.projectId))
        .map((value) => ({
          root: join(this.#memoryDir, 'projects', value.workspaceId as string),
          scope: 'project' as const,
          workspaceId: value.workspaceId,
          projectId: value.projectId,
        })),
    ];
    for (const scope of scopes) {
      const found = new Set<string>();
      let entries: Dirent[];
      try {
        entries = await readdir(scope.root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries = [];
      }
      for (const file of entries) {
        if (!file.name.endsWith('.md') || !MEMORY_NAME_PATTERN.test(file.name.slice(0, -3)))
          continue;
        const name = file.name.slice(0, -3);
        const key = `memory:${scope.workspaceId ?? 'global'}:${name}`;
        found.add(key);
        if (
          this.#storage.sync
            .localWrites(vault.vaultId)
            .some(
              (value) =>
                value.path === join(scope.root, file.name) && this.#activeWrites.has(value.id),
            )
        )
          continue;
        const owner = this.#storage.sync.owner(key);
        if (owner && owner !== vault.vaultId) continue;
        const path = join(scope.root, file.name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        const bytes = await readFile(path);
        const after = await lstat(path);
        if (info.ino !== after.ino || info.mtimeMs !== after.mtimeMs || info.size !== after.size)
          continue;
        const fingerprint = sha256(bytes);
        let entity = this.#storage.sync.localEntity(vault.vaultId, key);
        const baseline = entity && this.#storage.sync.fileBaseline(vault.vaultId, entity.entityId);
        const interrupted = this.#storage.sync
          .materialJournals(vault.vaultId)
          .some(
            (value) =>
              value.localKey === key && value.state === 'staged' && value.nextHash === fingerprint,
          );
        if (
          interrupted ||
          (baseline?.fingerprint === fingerprint &&
            !(initialize && includeHistory && !entity?.revision))
        )
          continue;
        const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        this.#storage.transaction(() => {
          if (!entity) {
            entity = {
              vaultId: vault.vaultId,
              entityId: newId('sen'),
              entityType: 'memory',
              ...(scope.projectId && { projectId: scope.projectId }),
              localKey: key,
              materialized: true,
            };
            this.#storage.sync.putEntity(entity);
          }
          if (!this.#storage.sync.claimResource(key, vault.vaultId)) return;
          const opId =
            initialize && !includeHistory
              ? undefined
              : this.#queue.enqueue({
                  vaultId: vault.vaultId,
                  entityId: entity.entityId,
                  entityType: 'memory',
                  ...(scope.projectId && { projectId: scope.projectId }),
                  localKey: key,
                  content: { schema: 'wevir-memory/1', scope: scope.scope, name, markdown },
                });
          this.#storage.sync.putFileBaseline({
            vaultId: vault.vaultId,
            entityId: entity.entityId,
            entityType: 'memory',
            ...(scope.projectId && { projectId: scope.projectId }),
            path,
            fingerprint,
            ...(opId && { opId }),
          });
        });
      }
      for (const entity of this.#storage.sync
        .entities(vault.vaultId)
        .filter(
          (value) =>
            value.materialized &&
            value.entityType === 'memory' &&
            value.localKey.startsWith(`memory:${scope.workspaceId ?? 'global'}:`),
        )) {
        if (found.has(entity.localKey)) continue;
        const baseline = this.#storage.sync.fileBaseline(vault.vaultId, entity.entityId);
        if (!baseline || baseline.fingerprint === 'missing') continue;
        const name = entity.localKey.split(':').at(-1) as string;
        this.#storage.transaction(() => {
          const opId = this.#queue.enqueue({
            vaultId: vault.vaultId,
            entityId: entity.entityId,
            entityType: 'memory',
            ...(scope.projectId && { projectId: scope.projectId }),
            localKey: entity.localKey,
            kind: 'delete',
            content: { schema: 'wevir-memory/1', scope: scope.scope, name, deleted: true },
          });
          this.#storage.sync.putFileBaseline({
            vaultId: vault.vaultId,
            entityId: entity.entityId,
            entityType: 'memory',
            ...(scope.projectId && { projectId: scope.projectId }),
            path: baseline.path,
            fingerprint: 'missing',
            ...(opId && { opId }),
          });
        });
      }
    }
  }

  async bundle(
    vault: SyncVaultRecord,
    root: SyncBundleRoot,
    initialize: boolean,
    includeHistory: boolean,
  ): Promise<void> {
    const commit = await this.prepareBundle(vault, root, initialize, includeHistory);
    if (commit) this.#storage.transaction(() => commit(root.localKey, root.metadata));
  }

  async prepareBundle(
    vault: SyncVaultRecord,
    root: SyncBundleRoot,
    initialize: boolean,
    includeHistory: boolean,
  ): Promise<((localKey: string, metadata?: unknown) => string | undefined) | undefined> {
    if (
      !vault.categories.includes(root.category) ||
      (root.projectId && !vault.projectIds.includes(root.projectId))
    )
      return;
    const owner = this.#storage.sync.owner(root.localKey);
    if (owner && owner !== vault.vaultId) return;
    const top = await lstat(root.path);
    if (top.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
    const base = top.isDirectory() ? root.path : dirname(root.path);
    const files: Array<{ path: string; bytes: Buffer; sha256: string; executable: boolean }> = [];
    const exclusions: string[] = [];
    let totalBytes = 0;
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path);
      const name = relative(base, path).split('\\').join('/');
      if (info.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
      if (EXCLUDED.test(basename(path))) {
        exclusions.push(name);
        return;
      }
      if (info.isDirectory()) {
        for (const entry of await readdir(path)) await visit(join(path, entry));
        return;
      }
      if (!info.isFile() || files.length >= 10000) throw new ZuvRequestError('QUOTA_EXCEEDED');
      if (root.paths && info.size > FILES_READ_FILE_MAX_BYTES)
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      totalBytes += info.size;
      if (totalBytes > 64 * 1024 * 1024) throw new ZuvRequestError('QUOTA_EXCEEDED');
      const handle = await open(path, 'r');
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.size !== info.size)
          throw new ZuvRequestError('REVISION_CONFLICT');
        bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        bytes = bytes.subarray(0, offset);
      } finally {
        await handle.close();
      }
      const after = await lstat(path);
      if (
        info.ino !== after.ino ||
        info.mtimeMs !== after.mtimeMs ||
        info.size !== after.size ||
        bytes.length !== info.size
      )
        throw new ZuvRequestError('REVISION_CONFLICT');
      files.push({
        path: name || basename(path),
        bytes,
        sha256: sha256(bytes),
        executable: Boolean(info.mode & 0o111),
      });
    };
    if (root.paths) {
      for (const path of root.paths) {
        if (!isSafeRelativePath(path)) throw new ZuvRequestError('INTEGRITY_FAILED');
        let current = root.path;
        const parts = path.split('/');
        if (parts.some((part) => EXCLUDED.test(part))) {
          exclusions.push(path);
          continue;
        }
        try {
          for (const part of parts) {
            current = join(current, part);
            if ((await lstat(current)).isSymbolicLink())
              throw new ZuvRequestError('INTEGRITY_FAILED');
          }
          if (!(await lstat(current)).isFile()) throw new ZuvRequestError('INTEGRITY_FAILED');
          await visit(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          exclusions.push(path);
        }
      }
    } else if (top.isDirectory()) {
      for (const name of await readdir(root.path)) await visit(join(root.path, name));
    } else await visit(root.path);
    return (localKey, metadata = root.metadata) => {
      if (!this.#storage.db.isTransaction)
        throw new Error('sync bundle capture requires a transaction');
      const fingerprint = sha256(
        jcs({
          files: files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            executable: file.executable,
          })),
          exclusions,
          metadata: metadata ?? null,
        }),
      );
      let entity = this.#storage.sync.localEntity(vault.vaultId, localKey);
      const baseline = entity && this.#storage.sync.fileBaseline(vault.vaultId, entity.entityId);
      if (
        baseline?.fingerprint === fingerprint &&
        !(initialize && includeHistory && !entity?.revision)
      )
        return;
      if (!(initialize && !includeHistory) && !vault.categories.includes('artifact'))
        throw new ZuvRequestError('SCOPE_DISABLED');
      const owner = this.#storage.sync.owner(localKey);
      if (owner && owner !== vault.vaultId) return;
      if (!entity) {
        entity = {
          vaultId: vault.vaultId,
          entityId: newId('sbun'),
          entityType: root.category as EntityType,
          ...(root.projectId && { projectId: root.projectId }),
          localKey,
          materialized: true,
        };
        this.#storage.sync.putEntity(entity);
      }
      this.#storage.sync.claimResource(localKey, vault.vaultId);
      const entries = files.map((file) => {
        const parts: Array<{ entityId: string; opId: string }> = [];
        if (!(initialize && !includeHistory))
          for (
            let offset = 0, index = 0;
            offset < file.bytes.length;
            offset += 64 * 1024, index++
          ) {
            const partId = newId('spart');
            const bytes = file.bytes.subarray(offset, offset + 64 * 1024);
            const opId = this.#queue.enqueue({
              vaultId: vault.vaultId,
              entityId: partId,
              entityType: 'artifact',
              ...(root.projectId && { projectId: root.projectId }),
              localKey: `chunk:${partId}`,
              content: {
                schema: 'wevir-chunk/1',
                ownerId: entity?.entityId,
                index,
                data: bytes.toString('base64url'),
                sha256: sha256(bytes),
              },
            });
            if (!opId) throw new Error('sync chunk capture failed');
            parts.push({ entityId: partId, opId });
          }
        return {
          path: file.path,
          bytes: file.bytes.length,
          sha256: file.sha256,
          parts,
          executable: file.executable,
        };
      });
      const opId =
        initialize && !includeHistory
          ? undefined
          : this.#queue.enqueue({
              vaultId: vault.vaultId,
              entityId: entity.entityId,
              entityType: root.category as EntityType,
              ...(root.projectId && { projectId: root.projectId }),
              localKey,
              content: {
                schema: 'wevir-bundle/1',
                category: root.category,
                name: root.name,
                files: entries,
                exclusions,
                ...(metadata !== undefined && { metadata }),
              },
            });
      this.#storage.sync.putFileBaseline({
        vaultId: vault.vaultId,
        entityId: entity.entityId,
        entityType: root.category,
        ...(root.projectId && { projectId: root.projectId }),
        path: root.path,
        fingerprint,
        ...(opId && { opId }),
      });
      return opId;
    };
  }
}
