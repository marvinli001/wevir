import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  type MethodParams,
  SyncBundleContentSchema,
  SyncChunkContentSchema,
  SyncRelativePathSchema,
} from '@wevir/protocol';
import { jcs, packRecord } from '@wevir/protocol/sync';
import type {
  Storage,
  SyncBundleApplication,
  SyncBundleBinding,
  SyncEntityRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { SyncBundleFiles } from './bundle-files.js';
import { bundleFingerprint, excludedBundlePath, snapshotBundle } from './bundle-snapshot.js';
import { sha256 } from './crypto.js';
import type { SyncBundleRoot, SyncFilesCapture } from './files-capture.js';
import { type SyncDraftPayload, type SyncMaterialRevision, SyncQueue } from './queue.js';

type Body = typeof SyncBundleContentSchema._output;
interface Target {
  targetId: string;
  name: string;
  path: string;
  anchor: string;
  key: string;
  kind: 'file' | 'directory';
  managed: boolean;
  metadata?: unknown;
  root?: SyncBundleRoot;
}
interface Options {
  storage: Storage;
  home: string;
  userHome: string;
  files: SyncFilesCapture;
  nativeRoots: (vault: SyncVaultRecord) => Promise<SyncBundleRoot[]>;
  eligible: () => SyncVaultRecord | undefined;
}
export class SyncBundles {
  readonly files: SyncBundleFiles;
  constructor(readonly options: Options) {
    this.files = new SyncBundleFiles({
      ...options,
      currentScope: (binding, vault) => this.#currentScope(binding, vault),
      publish: (app, signal) => this.#publisher(app, signal),
    });
  }
  vaults() {
    return {
      vaults: this.options.storage.sync
        .vaults()
        .slice(-100)
        .reverse()
        .map((vault) => ({
          vaultId: vault.vaultId,
          active: vault.active,
          projects: this.options.storage.sync
            .projects(vault.vaultId)
            .slice(0, 2)
            .map(
              (project) =>
                this.options.storage.sync.projectName(vault.vaultId, project.projectId) ??
                project.projectId,
            ),
          ...(this.options.storage.sync.vaultTransport(vault.vaultId).lastSyncAt && {
            lastSyncAt: this.options.storage.sync.vaultTransport(vault.vaultId).lastSyncAt,
          }),
        })),
    };
  }
  list(vaultId: string, after?: string) {
    this.#localVault(vaultId);
    const entries = this.options.storage.sync.packageEntities(vaultId, after);
    const bundles = entries.slice(0, 100).flatMap((entity) => {
      const heads = this.#heads(vaultId, entity);
      if (!heads.length) return [];
      const version = this.#version(vaultId, entity, heads[0] as string);
      return [
        {
          entityId: entity.entityId,
          category: version.body.category as 'rule' | 'skill-bundle' | 'artifact',
          name: version.body.name,
          heads,
          ...(entity.projectId && { projectId: entity.projectId }),
          ...(this.#binding(vaultId, entity.entityId) && {
            binding: this.#binding(vaultId, entity.entityId),
          }),
        },
      ];
    });
    return { bundles, ...(entries.length > 100 && { next: entries[99]?.entityId }) };
  }
  async preview(vaultId: string, entityId: string, offset = 0, opId?: string) {
    const entity = this.#entity(vaultId, entityId);
    const heads = this.#heads(vaultId, entity);
    if (!heads.length) throw new ZuvRequestError('RECOVERY_REQUIRED');
    return {
      vaultId,
      entityId,
      heads,
      versions: (opId ? [opId] : heads).map((opId) => this.#summary(vaultId, entity, opId, offset)),
      ...(this.#binding(vaultId, entityId) && { binding: this.#binding(vaultId, entityId) }),
    };
  }
  versions(vaultId: string, entityId: string, after?: string) {
    const entity = this.#entity(vaultId, entityId);
    const ids = this.options.storage.sync.packageVersions(vaultId, entityId, after);
    return {
      versions: ids.slice(0, 100).map((opId) => this.#summary(vaultId, entity, opId)),
      ...(ids.length > 100 && { next: ids[99] }),
    };
  }
  #summary(vaultId: string, entity: SyncEntityRecord, opId: string, offset = 0) {
    const { body, operation } = this.#version(vaultId, entity, opId);
    return {
      opId,
      parents: operation.parents,
      name: body.name,
      deleted: operation.kind === 'delete',
      fileCount: body.files.length,
      bytes: body.files.reduce((sum, file) => sum + file.bytes, 0),
      files: body.files.slice(offset, offset + 100).map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        executable: file.executable === true,
      })),
    };
  }
  async targets(vaultId: string, entityId: string) {
    const { vault, entity } = this.#write(vaultId, entityId);
    const targets = await this.#targets(vault, entity);
    const result = [];
    for (const target of targets) {
      const binding = this.options.storage.sync.bundleBinding(vaultId, entityId);
      const metadata =
        binding?.targetPath === target.path ? binding.manifest.metadata : target.metadata;
      const snapshot = await snapshotBundle(
        {
          path: target.path,
          metadata,
          exclusions: binding?.targetPath === target.path ? binding.manifest.exclusions : [],
          guard: () => this.#write(vaultId, entityId, vault.revision),
        },
        true,
      );
      result.push({
        targetId: target.targetId,
        name: target.name,
        path: target.path,
        kind: target.kind,
        managed: target.managed,
        fingerprint: bundleFingerprint({
          ...snapshot,
          metadata,
          deleted:
            snapshot.deleted ||
            (binding?.targetPath === target.path &&
              binding.manifest.deleted &&
              !snapshot.files.length),
        }),
      });
    }
    return { targets: result };
  }
  async apply(input: MethodParams<'sync.applyBundle'>, signal: AbortSignal) {
    const { vault, entity } = this.#write(input.vaultId, input.entityId);
    await this.capture(entity, vault);
    this.#checkHeads(entity, input.expectedHeads);
    const selected = this.#version(vault.vaultId, entity, input.selectedOpId);
    const target = (await this.#targets(vault, entity)).find(
      (item) => item.targetId === input.targetId,
    );
    if (!target) throw new ZuvRequestError('SCOPE_DISABLED');
    let binding = this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
    if (
      binding &&
      (binding.revision !== input.localRevision ||
        (binding.targetKey !== target.targetId && binding.targetKey !== input.expectedTargetId) ||
        (binding.targetKey === target.targetId && !(await this.allowed(binding, vault))))
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (this.options.storage.sync.pendingBundleApplication(vault.vaultId, entity.entityId))
      throw new ZuvRequestError('REVISION_CONFLICT');
    const previousBinding = binding;
    const moving = Boolean(binding && binding.targetKey !== target.targetId);
    const metadata = binding && !moving ? binding.manifest.metadata : target.metadata;
    const snapshot = await snapshotBundle(
      {
        path: target.path,
        metadata,
        exclusions: !moving ? (binding?.manifest.exclusions ?? []) : [],
        guard: () => this.#write(vault.vaultId, entity.entityId, vault.revision),
      },
      true,
    );
    if (
      bundleFingerprint({
        ...snapshot,
        metadata,
        deleted:
          snapshot.deleted || (!moving && binding?.manifest.deleted && !snapshot.files.length),
      }) !== input.fingerprint
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (!binding || moving) {
      let previous: SyncEntityRecord | undefined;
      if (target.root) {
        await this.options.files.bundle(vault, target.root, true, true);
        previous = this.options.storage.sync.localEntity(vault.vaultId, target.root.localKey);
      }
      binding = {
        vaultId: vault.vaultId,
        entityId: entity.entityId,
        targetKey: target.targetId,
        targetPath: target.path,
        targetAnchor: target.anchor,
        targetKind: target.kind,
        scopeRoot: this.#scopeRoot(vault, entity),
        ...(previousBinding?.revision && { revision: previousBinding.revision }),
        fingerprint: input.fingerprint,
        manifest: {
          files: snapshot.files.map((file) => ({
            path: file.path,
            bytes: file.bytes.length,
            sha256: file.sha256,
            executable: file.executable,
          })),
          exclusions: snapshot.exclusions,
          ...(snapshot.deleted && { deleted: true }),
          ...(metadata !== undefined && { metadata }),
        },
      };
      this.options.storage.transaction(() => {
        if (!this.options.storage.sync.claimResource(entity.localKey, vault.vaultId))
          throw new ZuvRequestError('SCOPE_DISABLED');
        this.#write(vault.vaultId, entity.entityId, vault.revision);
        this.#checkHeads(entity, input.expectedHeads);
        if (previous && previous.entityId !== entity.entityId)
          this.options.storage.sync.putEntity({ ...previous, materialized: false });
        if (previousBinding)
          this.options.storage.sync.rebindBundle(previousBinding, binding as SyncBundleBinding);
        else this.options.storage.sync.putBundleBinding(binding as SyncBundleBinding);
        this.options.storage.sync.clearBundleSources(vault.vaultId, entity.entityId);
        if (target.root)
          this.options.storage.sync.putBundleSource(
            vault.vaultId,
            target.root.localKey,
            entity.entityId,
          );
        this.options.storage.sync.putFileBaseline({
          vaultId: vault.vaultId,
          entityId: entity.entityId,
          entityType: entity.entityType,
          path: target.path,
          fingerprint: input.fingerprint,
          ...(entity.projectId && { projectId: entity.projectId }),
        });
      });
    }
    const materialize =
      !moving && input.expectedHeads.length === 1 && input.expectedHeads[0] === input.selectedOpId;
    const op: SyncMaterialRevision = materialize
      ? selected.operation
      : {
          vaultId: vault.vaultId,
          entityId: entity.entityId,
          entityType: entity.entityType as 'rule' | 'skill-bundle' | 'artifact',
          opId: newId('sop'),
          deviceId: vault.deviceId,
          parents: input.expectedHeads,
          kind:
            selected.operation.kind === 'delete'
              ? 'delete'
              : input.expectedHeads.length > 1
                ? 'resolve'
                : 'put',
          clientTime: new Date().toISOString(),
        };
    return this.#applyBody(
      vault,
      entity,
      op,
      selected.body,
      signal,
      !materialize,
      input.selectedOpId,
    );
  }
  async file(input: MethodParams<'sync.bundleFile'>) {
    const entity = this.#entity(input.vaultId, input.entityId);
    let bytes: Buffer, fingerprint: string | undefined, localRevision: string | undefined;
    if (input.opId) {
      const version = this.#version(input.vaultId, entity, input.opId);
      bytes = await this.#bytes(input.vaultId, entity, version.body, input.path, input.opId);
    } else {
      const { vault } = this.#write(input.vaultId, input.entityId);
      const binding = this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
      if (!binding || !(await this.allowed(binding, vault)))
        throw new ZuvRequestError('SCOPE_DISABLED');
      const snapshot = await snapshotBundle(
        {
          ...this.#root(binding, entity),
          guard: () => this.#write(vault.vaultId, entity.entityId, vault.revision),
        },
        true,
      );
      const file = snapshot.files.find((item) => item.path === input.path.normalize('NFC'));
      if (!file) throw new ZuvRequestError('RECOVERY_REQUIRED');
      bytes = file.bytes;
      fingerprint = bundleFingerprint({
        ...snapshot,
        metadata: binding.manifest.metadata,
        deleted: binding.manifest.deleted,
      });
      localRevision = binding.revision;
    }
    let text: string | undefined;
    try {
      if (!bytes.includes(0))
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 128 * 1024), {
          stream: bytes.length > 128 * 1024,
        });
    } catch {}
    return {
      path: input.path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      binary: text === undefined,
      truncated: bytes.length > 128 * 1024,
      ...(text !== undefined && { text }),
      ...(fingerprint && { fingerprint }),
      ...(localRevision && { localRevision }),
    };
  }
  async keepLocal(input: MethodParams<'sync.keepLocalBundle'>, signal: AbortSignal) {
    const { vault, entity } = this.#write(input.vaultId, input.entityId);
    const binding = this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
    if (
      !binding ||
      binding.targetKey !== input.targetId ||
      binding.revision !== input.localRevision ||
      !(await this.allowed(binding, vault))
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    this.#checkHeads(entity, input.expectedHeads);
    signal.throwIfAborted();
    const opId = newId('sop');
    const missing = !(await lstat(binding.targetPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }));
    const commit = await this.options.files.prepareBundle(
      vault,
      {
        ...this.#root(binding, entity),
        opId,
        parents: input.expectedHeads,
        kind: missing ? 'delete' : 'resolve',
        expectedFingerprint: input.fingerprint,
      },
      false,
      false,
      signal,
    );
    if (!commit) throw new ZuvRequestError('SCOPE_DISABLED');
    signal.throwIfAborted();
    this.options.storage.transaction(() => {
      this.#write(vault.vaultId, entity.entityId, vault.revision);
      this.#checkHeads(entity, input.expectedHeads);
      const pending = this.options.storage.sync.pendingBundleApplication(
        vault.vaultId,
        entity.entityId,
      );
      if (pending)
        this.options.storage.sync.setBundleApplicationState(
          vault.vaultId,
          pending.opId,
          'abandoned',
        );
      if (commit(entity.localKey, binding.manifest.metadata) !== opId)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      this.options.storage.sync.clearMaterialConflicts(
        vault.vaultId,
        entity.entityId,
        input.expectedHeads,
      );
    });
    return { opId };
  }
  async edit(input: MethodParams<'sync.editBundleFile'>, signal: AbortSignal) {
    const { vault, entity } = this.#write(input.vaultId, input.entityId);
    const binding = this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
    if (
      !binding ||
      !(await this.allowed(binding, vault)) ||
      this.options.storage.sync.pendingBundleApplication(vault.vaultId, entity.entityId)
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (
      binding.revision !== input.localRevision ||
      !SyncRelativePathSchema.safeParse(input.path).success ||
      excludedBundlePath(input.path) ||
      (input.deleted === true) === (input.text !== undefined)
    )
      throw new ZuvRequestError('INVALID_REQUEST');
    const snapshot = await snapshotBundle(
      {
        ...this.#root(binding, entity),
        guard: () => this.#write(vault.vaultId, entity.entityId, vault.revision),
      },
      true,
    );
    if (
      bundleFingerprint({
        ...snapshot,
        metadata: binding.manifest.metadata,
        deleted: binding.manifest.deleted,
      }) !== input.fingerprint
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    const files = snapshot.files.filter((file) => file.path !== input.path.normalize('NFC'));
    if (!input.deleted) {
      const bytes = Buffer.from(input.text as string);
      files.push({
        path: input.path.normalize('NFC'),
        bytes,
        sha256: sha256(bytes),
        executable: snapshot.files.find((file) => file.path === input.path)?.executable ?? false,
      });
    }
    const body: Body = {
      schema: 'wevir-bundle/1',
      category: entity.entityType as Body['category'],
      name: this.#version(vault.vaultId, entity, this.#heads(vault.vaultId, entity)[0] as string)
        .body.name,
      files: files.map((file) => ({
        path: file.path,
        bytes: file.bytes.length,
        sha256: file.sha256,
        executable: file.executable,
        parts: [],
      })),
      exclusions: snapshot.exclusions,
      ...(binding.manifest.metadata !== undefined && {
        metadata: binding.manifest.metadata as Body['metadata'],
      }),
    };
    const op: SyncMaterialRevision = {
      vaultId: vault.vaultId,
      entityId: entity.entityId,
      entityType: entity.entityType as 'rule' | 'skill-bundle' | 'artifact',
      opId: newId('sop'),
      deviceId: vault.deviceId,
      parents: binding.revision ? [binding.revision] : [],
      kind: binding.targetKind === 'file' && !files.length ? 'delete' : 'put',
      clientTime: new Date().toISOString(),
    };
    const source = await this.#temporary();
    try {
      for (const file of files) {
        await mkdir(dirname(join(source, file.path)), { recursive: true, mode: 0o700 });
        await writeFile(join(source, file.path), file.bytes, { mode: 0o600 });
      }
      await this.files.prepare(op, body, source, signal, true);
      const finish = await this.files.apply(op.opId, signal);
      this.options.storage.transaction(finish);
      return { opId: op.opId };
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  }
  async retry(vaultId: string, entityId: string, opId: string, signal: AbortSignal) {
    const { vault } = this.#write(vaultId, entityId);
    const binding = this.options.storage.sync.bundleBinding(vaultId, entityId);
    const app = this.options.storage.sync.bundleApplication(vaultId, opId);
    if (!binding || !app || app.entityId !== entityId || !(await this.allowed(binding, vault)))
      throw new ZuvRequestError('SCOPE_DISABLED');
    if (app.scopeRevision !== vault.revision) this.files.reauthorize(opId, signal);
    const finish = await this.files.apply(opId, signal);
    this.#finish(app, finish);
    this.options.storage.transaction(() =>
      this.options.storage.sync.pauseBundleApplication(vaultId, opId, false),
    );
    return { opId };
  }
  async recover(vault: SyncVaultRecord) {
    let after = '';
    while (true) {
      const [app] = this.options.storage.sync.pendingBundleApplications(vault.vaultId, after);
      if (!app) break;
      after = app.opId;
      if (app.state === 'conflict' || app.paused) continue;
      const binding = this.options.storage.sync.bundleBinding(vault.vaultId, app.entityId);
      if (
        !binding ||
        !(await this.allowed(binding, vault)) ||
        app.scopeRevision !== vault.revision
      ) {
        this.options.storage.transaction(() =>
          this.options.storage.sync.setBundleApplicationState(vault.vaultId, app.opId, 'conflict'),
        );
        continue;
      }
      try {
        const finish = await this.files.apply(app.opId, new AbortController().signal);
        this.#finish(app, finish);
      } catch (error) {
        if (!(error instanceof ZuvRequestError)) throw error;
      }
    }
  }
  async *roots(vault: SyncVaultRecord) {
    const seen = new Set<string>();
    for (const root of await this.options.nativeRoots(vault)) {
      const alias = this.options.storage.sync.bundleSource(vault.vaultId, root.localKey);
      const entity = alias
        ? this.options.storage.sync.entity(vault.vaultId, alias)
        : this.options.storage.sync.localEntity(vault.vaultId, root.localKey);
      const binding =
        entity && this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
      if (!binding) {
        yield root;
        continue;
      }
      seen.add(binding.entityId);
      if (
        binding.targetPath === root.path &&
        (await this.allowed(binding, vault)) &&
        !this.options.storage.sync.pendingBundleApplication(vault.vaultId, binding.entityId)
      )
        yield this.#root(binding, entity as SyncEntityRecord);
    }
    let after = '';
    while (true) {
      const [binding] = this.options.storage.sync.bundleBindings(vault.vaultId, after);
      if (!binding) break;
      after = binding.entityId;
      if (
        seen.has(binding.entityId) ||
        this.options.storage.sync.pendingBundleApplication(vault.vaultId, binding.entityId) ||
        !(await this.allowed(binding, vault))
      )
        continue;
      yield this.#root(binding, this.#entity(vault.vaultId, binding.entityId));
    }
  }
  async receive(op: SyncMaterialRevision, body: Body, root: string, signal: AbortSignal) {
    const { vault } = this.#write(op.vaultId, op.entityId);
    const binding = this.options.storage.sync.bundleBinding(op.vaultId, op.entityId);
    if (!binding || !(await this.allowed(binding, vault)))
      throw new ZuvRequestError('SCOPE_DISABLED');
    await this.files.prepare(op, body, root, signal);
    return this.files.apply(op.opId, signal);
  }
  async allowed(binding: SyncBundleBinding, vault: SyncVaultRecord) {
    const entity = this.options.storage.sync.entity(vault.vaultId, binding.entityId);
    if (
      !entity ||
      !this.#currentScope(binding, vault) ||
      !vault.categories.includes(entity.entityType) ||
      (entity.projectId && !vault.projectIds.includes(entity.projectId))
    )
      return false;
    const managed = join(this.options.home, 'sync/working', vault.vaultId, binding.entityId);
    if (binding.targetPath === managed && binding.targetAnchor === this.options.home) return true;
    const roots = await this.options.nativeRoots(vault);
    if (
      roots.some(
        (root) =>
          sha256(root.localKey) === binding.targetKey &&
          root.path === binding.targetPath &&
          root.category === entity.entityType &&
          root.projectId === entity.projectId,
      )
    )
      return true;
    // A deleted entry file must not revoke an explicit binding before its tombstone is captured.
    const scope = this.#scopeRoot(vault, entity);
    if (!scope) return false;
    const path = relative(scope, binding.targetPath);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  }
  #scopeRoot(vault: SyncVaultRecord, entity: SyncEntityRecord) {
    const workspaceId = entity.projectId
      ? this.options.storage.sync
          .projects(vault.vaultId)
          .find((project) => project.projectId === entity.projectId)?.workspaceId
      : undefined;
    const workspace = workspaceId ? this.options.storage.workspaces.get(workspaceId) : undefined;
    return entity.projectId
      ? workspace && !workspace.removedAt
        ? workspace.rootPath
        : undefined
      : this.options.userHome;
  }
  #currentScope(binding: SyncBundleBinding, vault: SyncVaultRecord) {
    const entity = this.options.storage.sync.entity(vault.vaultId, binding.entityId);
    return Boolean(
      entity && binding.scopeRoot && binding.scopeRoot === this.#scopeRoot(vault, entity),
    );
  }
  async capture(entity: SyncEntityRecord, vault: SyncVaultRecord) {
    const binding = this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
    if (
      binding &&
      (await this.allowed(binding, vault)) &&
      !this.options.storage.sync.pendingBundleApplication(vault.vaultId, entity.entityId)
    )
      await this.options.files.bundle(vault, this.#root(binding, entity), false, false);
  }
  async #applyBody(
    vault: SyncVaultRecord,
    entity: SyncEntityRecord,
    op: SyncMaterialRevision,
    body: Body,
    signal: AbortSignal,
    publish = true,
    sourceOpId = op.opId,
  ) {
    const root = await this.#temporary();
    try {
      for (const file of body.files) {
        this.#write(vault.vaultId, entity.entityId, vault.revision);
        const bytes = await this.#bytes(vault.vaultId, entity, body, file.path, sourceOpId);
        await mkdir(dirname(join(root, file.path)), { recursive: true, mode: 0o700 });
        await writeFile(join(root, file.path), bytes, { mode: 0o600 });
      }
      const app = await this.files.prepare(op, body, root, signal, publish, true);
      const finish = await this.files.apply(op.opId, signal);
      this.#finish(app, finish);
      return { opId: op.opId };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  async #publisher(app: SyncBundleApplication, signal: AbortSignal) {
    const body = SyncBundleContentSchema.parse(app.content),
      op = app.operation as SyncMaterialRevision;
    const complete = body.files.every((file) => file.bytes === 0 || file.parts.length > 0);
    if (complete)
      return () => {
        const entity = this.#entity(app.vaultId, app.entityId);
        const id = new SyncQueue(this.options.storage).enqueue({
          vaultId: app.vaultId,
          entityId: app.entityId,
          entityType: op.entityType,
          localKey: entity.localKey,
          ...(entity.projectId && { projectId: entity.projectId }),
          opId: app.opId,
          kind: op.kind,
          parents: op.parents,
          content: body,
        });
        if (id !== app.opId) throw new ZuvRequestError('SCOPE_DISABLED');
      };
    const { vault, entity } = this.#write(app.vaultId, app.entityId);
    const binding = this.options.storage.sync.bundleBinding(app.vaultId, app.entityId);
    if (!binding) throw new ZuvRequestError('SCOPE_DISABLED');
    const commit = await this.options.files.prepareBundle(
      vault,
      {
        ...this.#root(binding, entity),
        opId: app.opId,
        parents: op.parents,
        kind: op.kind as 'put' | 'delete' | 'resolve',
        expectedFingerprint: app.nextHash,
      },
      false,
      false,
      signal,
    );
    if (!commit) throw new ZuvRequestError('SCOPE_DISABLED');
    return () => {
      if (commit(entity.localKey, binding.manifest.metadata) !== app.opId)
        throw new ZuvRequestError('INTEGRITY_FAILED');
    };
  }
  #finish(app: SyncBundleApplication, finish: () => void) {
    this.options.storage.transaction(() => {
      finish();
      const stored = this.options.storage.sync.getOperation(app.vaultId, app.opId),
        op = app.operation as SyncMaterialRevision;
      const entity = this.#entity(app.vaultId, app.entityId);
      if (
        !app.publish &&
        stored?.direction === 'inbox' &&
        stored.state === 'received' &&
        jcs(stored.envelope) === jcs(app.operation) &&
        !this.options.storage.sync.missingParents(app.vaultId, app.entityId, op.parents).length
      ) {
        this.options.storage.sync.putVerifiedRecord(
          app.vaultId,
          app.opId,
          packRecord.parse({
            opId: app.opId,
            entityId: app.entityId,
            kind: op.kind,
            parents: op.parents,
            ...(entity.projectId && { projectId: entity.projectId }),
            content: app.content,
          }),
        );
        this.options.storage.sync.applyHeads(app.vaultId, app.entityId, app.opId, op.parents);
        this.options.storage.sync.markOperation(app.vaultId, app.opId, 'applied');
      }
    });
  }
  #localVault(vaultId: string) {
    const vault = this.options.storage.sync.getVault(vaultId);
    if (!vault) throw new ZuvRequestError('RECOVERY_REQUIRED');
    return vault;
  }
  #entity(vaultId: string, entityId: string) {
    this.#localVault(vaultId);
    const entity = this.options.storage.sync.entity(vaultId, entityId);
    if (!entity || !['rule', 'skill-bundle', 'artifact'].includes(entity.entityType))
      throw new ZuvRequestError('SCOPE_DISABLED');
    return entity;
  }
  #write(vaultId: string, entityId: string, revision?: string) {
    const vault = this.options.eligible(),
      entity = this.#entity(vaultId, entityId);
    if (
      !vault ||
      vault.vaultId !== vaultId ||
      (revision !== undefined && vault.revision !== revision) ||
      !vault.categories.includes(entity.entityType) ||
      (entity.projectId &&
        (!vault.projectIds.includes(entity.projectId) || !this.#scopeRoot(vault, entity)))
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    return { vault, entity };
  }
  #version(vaultId: string, entity: SyncEntityRecord, opId: string) {
    const cached = this.options.storage.sync.getOperation(vaultId, opId);
    const app = this.options.storage.sync.bundleApplication(vaultId, opId);
    const stored =
      cached?.record &&
      (['applied', 'committed'].includes(cached.state) || cached.direction === 'outbox')
        ? cached
        : undefined;
    const draft = stored ? undefined : this.options.storage.sync.draft(vaultId, opId);
    if (
      (cached && (cached.entityId !== entity.entityId || cached.state === 'quarantined')) ||
      (draft && draft.entityId !== entity.entityId) ||
      (app && app.entityId !== entity.entityId) ||
      (!stored && !draft && !app)
    )
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const record = stored ? packRecord.parse(stored.record) : undefined;
    const body = SyncBundleContentSchema.parse(
      record ? record.content : draft ? (draft.content as SyncDraftPayload).body : app?.content,
    );
    if (
      body.category !== entity.entityType ||
      ['wevir-image/1', 'wevir-shared-files/1'].includes(
        (body.metadata as { schema?: string })?.schema ?? '',
      )
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    return {
      body,
      operation: stored
        ? (stored.envelope as SyncMaterialRevision)
        : !draft && app
          ? (app.operation as SyncMaterialRevision)
          : ({
              vaultId,
              entityId: entity.entityId,
              entityType: entity.entityType,
              opId,
              deviceId: this.#localVault(vaultId).deviceId,
              parents: draft?.parents ?? [],
              kind: draft?.kind ?? 'put',
              clientTime: draft?.createdAt ?? new Date().toISOString(),
            } as SyncMaterialRevision),
    };
  }
  async #bytes(
    vaultId: string,
    entity: SyncEntityRecord,
    body: Body,
    path: string,
    opId: string,
  ): Promise<Buffer> {
    const file = body.files.find((item) => item.path.normalize('NFC') === path.normalize('NFC'));
    if (!file) throw new ZuvRequestError('RECOVERY_REQUIRED');
    if (file.bytes > 0 && !file.parts.length)
      return this.files.versionFile(vaultId, opId, file.path);
    const buffers: Buffer[] = [],
      digest = createHash('sha256');
    let bytes = 0;
    for (const [index, part] of file.parts.entries()) {
      const stored = this.options.storage.sync.getOperation(vaultId, part.opId),
        draft = stored ? undefined : this.options.storage.sync.draft(vaultId, part.opId);
      if (
        (stored &&
          (stored.entityId !== part.entityId ||
            stored.projectId !== entity.projectId ||
            stored.state === 'quarantined' ||
            !stored.record)) ||
        (draft &&
          (draft.entityId !== part.entityId ||
            this.options.storage.sync.entity(vaultId, part.entityId)?.projectId !==
              entity.projectId)) ||
        (!stored && !draft)
      )
        throw new ZuvRequestError('MISSING_PARENT');
      const raw = stored
        ? packRecord.parse(stored.record).content
        : ((draft as NonNullable<typeof draft>).content as SyncDraftPayload).body;
      const chunk = SyncChunkContentSchema.parse(raw),
        data = Buffer.from(chunk.data, 'base64url');
      if (
        chunk.ownerId !== entity.entityId ||
        chunk.index !== index ||
        sha256(data) !== chunk.sha256
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      bytes += data.length;
      if (bytes > file.bytes) throw new ZuvRequestError('INTEGRITY_FAILED');
      digest.update(data);
      buffers.push(data);
    }
    if (bytes !== file.bytes || digest.digest('base64url') !== file.sha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return Buffer.concat(buffers);
  }
  #heads(vaultId: string, entity: SyncEntityRecord): string[] {
    const heads = this.options.storage.sync.heads(vaultId, entity.entityId);
    const current = this.options.storage.sync.entity(vaultId, entity.entityId)?.revision;
    if (
      current &&
      !heads.includes(current) &&
      (this.options.storage.sync.draft(vaultId, current) ||
        this.options.storage.sync.getOperation(vaultId, current)?.direction === 'outbox')
    ) {
      const ancestors = new Set<string>(),
        pending = [current];
      while (pending.length) {
        const id = pending.pop() as string;
        if (ancestors.has(id)) continue;
        if (ancestors.size >= 1024) throw new ZuvRequestError('QUOTA_EXCEEDED');
        ancestors.add(id);
        try {
          pending.push(...this.#version(vaultId, entity, id).operation.parents);
        } catch (error) {
          if (!(error instanceof ZuvRequestError && error.code === 'RECOVERY_REQUIRED'))
            throw error;
        }
      }
      return [...heads.filter((head) => !ancestors.has(head)), current].sort();
    }
    if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
    return heads;
  }
  #checkHeads(entity: SyncEntityRecord, expected: string[]) {
    const actual = this.#heads(entity.vaultId, entity);
    if (actual.length !== expected.length || actual.some((id) => !expected.includes(id)))
      throw new ZuvRequestError('REVISION_CONFLICT');
  }
  #binding(vaultId: string, entityId: string) {
    const b = this.options.storage.sync.bundleBinding(vaultId, entityId);
    if (!b) return;
    const pending = this.options.storage.sync.pendingBundleApplication(vaultId, entityId);
    return {
      targetId: b.targetKey,
      path: b.targetPath,
      ...(b.revision && { revision: b.revision }),
      fingerprint: b.fingerprint,
      ...(pending && {
        pending: {
          opId: pending.opId,
          state: pending.state as 'prepared' | 'applying' | 'conflict',
          paused: pending.paused === true,
        },
      }),
    };
  }
  #root(binding: SyncBundleBinding, entity: SyncEntityRecord): SyncBundleRoot {
    return {
      category: entity.entityType as SyncBundleRoot['category'],
      entityId: entity.entityId,
      localKey: entity.localKey,
      name: this.#version(
        binding.vaultId,
        entity,
        this.#heads(binding.vaultId, entity)[0] as string,
      ).body.name,
      path: binding.targetPath,
      ...(entity.projectId && { projectId: entity.projectId }),
      metadata: binding.manifest.metadata,
      exclusions: binding.manifest.exclusions,
    };
  }
  async #targets(vault: SyncVaultRecord, entity: SyncEntityRecord): Promise<Target[]> {
    const body = this.#version(
      vault.vaultId,
      entity,
      this.#heads(vault.vaultId, entity)[0] as string,
    ).body;
    const current = this.options.storage.sync.bundleBinding(vault.vaultId, entity.entityId);
    const targets: Target[] = [
      {
        targetId: sha256(`managed:${entity.entityId}`),
        name: this.#version(vault.vaultId, entity, this.#heads(vault.vaultId, entity)[0] as string)
          .body.name,
        path: join(this.options.home, 'sync/working', vault.vaultId, entity.entityId),
        anchor: this.options.home,
        key: `managed:${entity.entityId}`,
        kind: 'directory',
        managed: true,
      },
    ];
    for (const root of await this.options.nativeRoots(vault)) {
      if (
        root.category === 'artifact' ||
        root.category !== entity.entityType ||
        root.projectId !== entity.projectId ||
        (root.category === 'skill-bundle' &&
          (root.metadata as { source?: string })?.source === 'wevir')
      )
        continue;
      const owner = this.options.storage.sync.owner(root.localKey);
      if (owner && owner !== vault.vaultId) continue;
      const targetId = sha256(root.localKey),
        occupied = this.options.storage.sync.bundleTargetBinding(vault.vaultId, targetId);
      if (occupied && occupied.entityId !== entity.entityId) continue;
      const info = await lstat(root.path);
      if (info.isSymbolicLink()) continue;
      if (
        info.isFile() &&
        body.files.some((file) => file.path !== basename(root.path).normalize('NFC'))
      )
        continue;
      const scope = this.#scopeRoot(vault, entity);
      const child = scope && relative(scope, root.path);
      targets.push({
        targetId,
        name: root.name,
        path: root.path,
        anchor:
          scope &&
          child !== undefined &&
          child !== '..' &&
          !child.startsWith(`..${sep}`) &&
          !isAbsolute(child)
            ? scope
            : dirname(root.path),
        key: root.localKey,
        kind: info.isDirectory() ? 'directory' : 'file',
        managed: false,
        metadata: root.metadata,
        root,
      });
    }
    if (
      current &&
      !targets.some((target) => target.targetId === current.targetKey) &&
      (await this.allowed(current, vault))
    )
      targets.push({
        targetId: current.targetKey,
        name: body.name,
        path: current.targetPath,
        anchor: current.targetAnchor,
        key: current.targetKey,
        kind: current.targetKind,
        managed: false,
        metadata: current.manifest.metadata,
      });
    return targets;
  }
  async #temporary() {
    const sync = join(this.options.home, 'sync');
    await mkdir(sync, { recursive: true, mode: 0o700 });
    const info = await lstat(sync);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
    return mkdtemp(join(sync, '.bundle-'));
  }
}
