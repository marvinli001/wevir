import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  statfs,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { SyncBundleContentSchema, SyncRelativePathSchema } from '@wevir/protocol';
import { jcs } from '@wevir/protocol/sync';
import type {
  Storage,
  SyncBundleApplication,
  SyncBundleBinding,
  SyncBundleChange,
  SyncBundleManifest,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { bundleFingerprint, excludedBundlePath, snapshotBundle } from './bundle-snapshot.js';
import { sha256 } from './crypto.js';
import { type SyncMaterialRevision, SyncQueue } from './queue.js';

type Body = typeof SyncBundleContentSchema._output;
interface Options {
  storage: Storage;
  home: string;
  eligible: () => SyncVaultRecord | undefined;
  currentScope?: (binding: SyncBundleBinding, vault: SyncVaultRecord) => boolean;
  publish?: (application: SyncBundleApplication, signal: AbortSignal) => Promise<() => void>;
}
const folded = (path: string) => path.normalize('NFC').toLowerCase();
const signature = (value: SyncBundleChange['next']) =>
  value ? jcs({ sha256: value.sha256, executable: value.executable }) : 'missing';
export class SyncBundleFiles {
  readonly #options: Options;
  constructor(options: Options) {
    this.#options = options;
  }

  async prepare(
    operation: SyncMaterialRevision,
    content: Body,
    sourceRoot: string,
    signal: AbortSignal,
    publish = false,
    explicit = false,
  ) {
    signal.throwIfAborted();
    const body = SyncBundleContentSchema.parse(content);
    const vault = this.#options.eligible();
    const binding = this.#options.storage.sync.bundleBinding(operation.vaultId, operation.entityId);
    const entity = this.#options.storage.sync.entity(operation.vaultId, operation.entityId);
    if (
      !vault ||
      !binding ||
      vault.vaultId !== operation.vaultId ||
      !vault.categories.includes(operation.entityType) ||
      !entity ||
      (entity.projectId && !vault.projectIds.includes(entity.projectId)) ||
      this.#options.storage.sync.owner(entity.localKey) !== vault.vaultId ||
      (operation.entityType !== 'rule' &&
        operation.entityType !== 'skill-bundle' &&
        operation.entityType !== 'artifact') ||
      body.category !== operation.entityType ||
      (body.metadata as { schema?: string })?.schema === 'wevir-shared-files/1' ||
      (body.metadata as { schema?: string })?.schema === 'wevir-image/1'
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    if (!['put', 'delete', 'resolve'].includes(operation.kind))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const frame = {
      vaultId: vault.vaultId,
      entityId: operation.entityId,
      deviceId: vault.deviceId,
      scopeRevision: vault.revision,
      operation,
    };
    const guard = () => this.#guard(frame, signal);
    guard();
    const old = this.#options.storage.sync.bundleApplication(operation.vaultId, operation.opId);
    if (old) {
      if (
        jcs(old.operation) !== jcs(operation) ||
        jcs(old.content) !== jcs(body) ||
        old.publish !== publish
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      return old;
    }
    if (this.#options.storage.sync.pendingBundleApplication(vault.vaultId, binding.entityId))
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (
      binding.revision &&
      binding.revision !== operation.opId &&
      !operation.parents.includes(binding.revision)
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    await this.#directory(dirname(binding.targetPath), binding.targetAnchor, false);
    const before = await snapshotBundle(
      {
        path: binding.targetPath,
        metadata: binding.manifest.metadata,
        exclusions: binding.manifest.exclusions,
        guard,
      },
      true,
    );
    if (!binding.revision && before.files.length && !publish && !explicit)
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (
      bundleFingerprint({
        ...before,
        metadata: binding.manifest.metadata,
        deleted: binding.manifest.deleted,
      }) !== binding.fingerprint
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (operation.kind === 'delete' && body.files.length)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const exclusions = [
      ...new Set([...before.exclusions, ...body.exclusions].map((path) => path.normalize('NFC'))),
    ].sort();
    const omittedPaths = new Set(exclusions.map(folded));
    const omitted = (path: string) => {
      let prefix = '';
      for (const part of folded(path).split('/')) {
        prefix = prefix ? `${prefix}/${part}` : part;
        if (omittedPaths.has(prefix)) return true;
      }
      return false;
    };
    const files = body.files.map((file) => ({
      path: file.path.normalize('NFC'),
      bytes: file.bytes,
      sha256: file.sha256,
      executable: file.executable === true,
    }));
    this.#validatePaths(
      files.map((file) => file.path),
      true,
    );
    if (files.some((file) => omitted(file.path))) throw new ZuvRequestError('SCOPE_DISABLED');
    const protectedParents = new Set<string>();
    for (const path of before.exclusions) {
      const parts = folded(path).split('/');
      let prefix = '';
      for (const part of parts.slice(0, -1)) {
        prefix = prefix ? `${prefix}/${part}` : part;
        protectedParents.add(prefix);
      }
    }
    if (files.some((file) => protectedParents.has(folded(file.path))))
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (
      binding.targetKind === 'file' &&
      files.some((file) => file.path !== basename(binding.targetPath).normalize('NFC'))
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (binding.targetKind === 'file' && operation.kind !== 'delete' && files.length !== 1)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const manifest: SyncBundleManifest = {
      files,
      exclusions,
      ...(binding.manifest.metadata !== undefined && { metadata: binding.manifest.metadata }),
      ...(operation.kind === 'delete' && { deleted: true }),
    };
    const nextHash = bundleFingerprint(manifest);
    const previous = new Map(before.files.map((file) => [folded(file.path), file]));
    const changes: SyncBundleChange[] = files.map((file) => {
      const found = previous.get(folded(file.path));
      previous.delete(folded(file.path));
      return {
        path: file.path,
        next: { sha256: file.sha256, executable: file.executable },
        ...(found && {
          previous: { sha256: found.sha256, executable: found.executable },
          ...(found.path !== file.path && { previousPath: found.path }),
        }),
      };
    });
    for (const file of previous.values())
      if (!omitted(file.path))
        changes.unshift({
          path: file.path,
          previous: { sha256: file.sha256, executable: file.executable },
        });
    changes.sort(
      (a, b) =>
        Number(Boolean(a.next)) - Number(Boolean(b.next)) ||
        (a.next ? a.path.length - b.path.length : b.path.length - a.path.length) ||
        (a.path < b.path ? -1 : 1),
    );
    const app: SyncBundleApplication = {
      vaultId: vault.vaultId,
      opId: operation.opId,
      entityId: operation.entityId,
      deviceId: vault.deviceId,
      scopeRevision: vault.revision,
      ...(binding.revision && { previousRevision: binding.revision }),
      previousHash: binding.fingerprint,
      nextHash,
      digest: '',
      operation,
      content: body,
      files: changes,
      manifest,
      publish,
      state: 'prepared',
    };
    app.digest = this.#digest(app);
    const disk = await statfs(this.#options.home, { bigint: true });
    const bytes =
      body.files.reduce((sum, file) => sum + file.bytes, 0) +
      before.files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (disk.bavail * disk.bsize < BigInt(bytes + 16 * 1024 * 1024))
      throw Object.assign(new Error('sync bundle disk full'), { code: 'ENOSPC' });
    const staging = this.#staging(app);
    await this.#directory(staging, this.#options.home, true);
    const previousFiles = new Map(before.files.map((file) => [file.path, file]));
    const sourceFiles = new Map(body.files.map((file) => [file.path.normalize('NFC'), file]));
    for (const [index, change] of changes.entries()) {
      this.#guard(app, signal);
      if (change.previous) {
        const local = previousFiles.get(change.previousPath ?? change.path);
        if (!local) throw new ZuvRequestError('INTEGRITY_FAILED');
        await this.#save(join(staging, `${index}.previous`), local.bytes, change.previous.sha256);
      }
      if (change.next) {
        const source = sourceFiles.get(change.path);
        if (!source) throw new ZuvRequestError('INTEGRITY_FAILED');
        await this.#directory(dirname(join(sourceRoot, source.path)), sourceRoot, false);
        const data = await this.#read(join(sourceRoot, source.path), guard);
        if (data.bytes.length !== source.bytes || data.sha256 !== source.sha256)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        await this.#save(join(staging, `${index}.next`), data.bytes, source.sha256);
      }
    }
    const after = await snapshotBundle(
      {
        path: binding.targetPath,
        metadata: binding.manifest.metadata,
        exclusions: binding.manifest.exclusions,
        guard,
      },
      true,
    );
    if (
      bundleFingerprint({
        ...after,
        metadata: binding.manifest.metadata,
        deleted: binding.manifest.deleted,
      }) !== binding.fingerprint
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    this.#guard(app, signal);
    this.#options.storage.transaction(() => this.#options.storage.sync.putBundleApplication(app));
    return app;
  }

  async apply(opId: string, signal: AbortSignal): Promise<() => void> {
    const vault = this.#options.eligible();
    const app = vault && this.#options.storage.sync.bundleApplication(vault.vaultId, opId);
    if (!app || app.state === 'abandoned') throw new ZuvRequestError('RECOVERY_REQUIRED');
    const guard = () => this.#guard(app, signal);
    this.#guard(app, signal);
    if (app.digest !== this.#digest(app)) throw new ZuvRequestError('INTEGRITY_FAILED');
    if (app.state === 'applied') return () => {};
    this.#validatePaths(app.files.map((file) => file.path));
    const binding = this.#options.storage.sync.bundleBinding(
      app.vaultId,
      app.entityId,
    ) as SyncBundleBinding;
    if (binding.revision !== app.previousRevision || binding.fingerprint !== app.previousHash)
      throw new ZuvRequestError('REVISION_CONFLICT');
    this.#options.storage.transaction(() =>
      this.#options.storage.sync.setBundleApplicationState(app.vaultId, app.opId, 'applying'),
    );
    try {
      await this.#directory(this.#staging(app), this.#options.home, false);
      for (const [index, change] of app.files.entries()) {
        this.#guard(app, signal);
        for (const [suffix, expected] of [
          ['previous', change.previous],
          ['next', change.next],
        ] as const)
          if (
            expected &&
            (await this.#read(join(this.#staging(app), `${index}.${suffix}`), guard)).sha256 !==
              expected.sha256
          )
            throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      await this.#preflight(app, binding, signal);
      for (const [index, change] of app.files.entries())
        await this.#promote(app, binding, change, index, signal);
      const scratch = new Set(
        app.files.flatMap((change) => [
          this.#scratch(app, this.#path(binding, change.path)),
          this.#scratch(app, this.#path(binding, change.previousPath ?? change.path)),
        ]),
      );
      for (const directory of scratch) {
        const parent = await lstat(dirname(directory)).catch((error) => {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
          throw error;
        });
        if (!parent || parent.isFile()) continue;
        await this.#directory(dirname(directory), binding.targetAnchor, false);
        await rm(directory, { recursive: true, force: true });
      }
      if (binding.targetKind === 'directory') {
        if (app.manifest.deleted)
          await rmdir(binding.targetPath).catch((error) => {
            if (
              !['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
          });
        else await this.#directory(binding.targetPath, binding.targetAnchor, true);
      }
      this.#guard(app, signal);
      const actual = await snapshotBundle(
        {
          path: binding.targetPath,
          metadata: app.manifest.metadata,
          exclusions: app.manifest.exclusions,
          guard,
        },
        true,
      );
      if (
        bundleFingerprint({
          ...actual,
          metadata: app.manifest.metadata,
          deleted: app.manifest.deleted,
        }) !== app.nextHash
      )
        throw new ZuvRequestError('REVISION_CONFLICT');
    } catch (error) {
      if (!signal.aborted)
        this.#options.storage.transaction(() =>
          this.#options.storage.sync.setBundleApplicationState(app.vaultId, app.opId, 'conflict'),
        );
      throw error;
    }
    const publish =
      app.publish && this.#options.publish ? await this.#options.publish(app, signal) : undefined;
    return () => {
      this.#guard(app, signal);
      const current = this.#options.storage.sync.bundleBinding(app.vaultId, app.entityId);
      if (
        !current ||
        current.revision !== app.previousRevision ||
        current.fingerprint !== app.previousHash
      )
        throw new ZuvRequestError('REVISION_CONFLICT');
      const operation = app.operation as SyncMaterialRevision;
      const entity = this.#options.storage.sync.entity(app.vaultId, app.entityId);
      if (!entity) throw new ZuvRequestError('INTEGRITY_FAILED');
      if (publish) publish();
      else if (app.publish) {
        const id = new SyncQueue(this.#options.storage).enqueue({
          opId: app.opId,
          vaultId: app.vaultId,
          entityId: app.entityId,
          entityType: operation.entityType,
          localKey: entity.localKey,
          ...(entity.projectId && { projectId: entity.projectId }),
          kind: operation.kind,
          parents: operation.parents,
          content: app.content,
        });
        if (id !== app.opId) throw new ZuvRequestError('SCOPE_DISABLED');
      } else
        this.#options.storage.sync.putEntity({
          ...entity,
          revision: app.opId,
          fingerprint: sha256(
            jcs({
              kind: operation.kind,
              content: { schema: 'wevir-sync-draft/1', body: app.content },
            }),
          ),
          materialized: true,
        });
      this.#options.storage.sync.putBundleBinding({
        ...binding,
        revision: app.opId,
        fingerprint: app.nextHash,
        manifest: app.manifest,
      });
      this.#options.storage.sync.putFileBaseline({
        vaultId: app.vaultId,
        entityId: app.entityId,
        entityType: operation.entityType,
        ...(entity.projectId && { projectId: entity.projectId }),
        path: binding.targetPath,
        fingerprint: app.nextHash,
        opId: app.opId,
      });
      if (app.publish || operation.kind === 'resolve')
        this.#options.storage.sync.clearMaterialConflicts(
          app.vaultId,
          app.entityId,
          operation.parents,
        );
      this.#options.storage.sync.setBundleApplicationState(app.vaultId, app.opId, 'applied');
    };
  }
  reauthorize(opId: string, signal: AbortSignal): void {
    const vault = this.#options.eligible();
    const old = vault && this.#options.storage.sync.bundleApplication(vault.vaultId, opId);
    if (!vault || !old || old.digest !== this.#digest(old))
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const next = { ...old, scopeRevision: vault.revision };
    this.#guard(next, signal);
    this.#options.storage.transaction(() =>
      this.#options.storage.sync.reauthorizeBundleApplication(
        old.vaultId,
        opId,
        old.digest,
        vault.revision,
        this.#digest(next),
      ),
    );
  }

  async versionFile(vaultId: string, opId: string, path: string): Promise<Buffer> {
    const app = this.#options.storage.sync.bundleApplication(vaultId, opId);
    if (!app || app.digest !== this.#digest(app)) throw new ZuvRequestError('INTEGRITY_FAILED');
    const index = app.files.findIndex((file) => file.path === path && file.next);
    if (index < 0) throw new ZuvRequestError('RECOVERY_REQUIRED');
    await this.#directory(this.#staging(app), this.#options.home, false);
    const file = await this.#read(join(this.#staging(app), `${index}.next`));
    if (file.sha256 !== app.files[index]?.next?.sha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return file.bytes;
  }

  async #preflight(
    app: SyncBundleApplication,
    binding: SyncBundleBinding,
    signal: AbortSignal,
  ): Promise<void> {
    this.#guard(app, signal);
    const guard = () => this.#guard(app, signal);
    const actual = await snapshotBundle(
      {
        path: binding.targetPath,
        metadata: app.manifest.metadata,
        guard,
        exclusions:
          app.state === 'prepared' ? binding.manifest.exclusions : app.manifest.exclusions,
      },
      true,
    );
    if (
      app.state === 'prepared' &&
      bundleFingerprint({
        ...actual,
        metadata: binding.manifest.metadata,
        deleted: binding.manifest.deleted,
      }) !== app.previousHash
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    const paths = new Map(actual.files.map((file) => [folded(file.path), file]));
    const changes = new Map(app.files.map((change) => [folded(change.path), change]));
    for (const file of actual.files) {
      const change = changes.get(folded(file.path));
      if (
        !change ||
        (signature(file) !== signature(change.previous) &&
          signature(file) !== signature(change.next))
      )
        throw new ZuvRequestError('REVISION_CONFLICT');
    }
    for (const [index, change] of app.files.entries()) {
      if (change.previous && change.next && !paths.has(folded(change.path))) {
        const retired =
          change.previousPath &&
          (await this.#status(this.#retired(app, binding, change, index), guard));
        if (!retired || signature(retired) !== signature(change.previous))
          throw new ZuvRequestError('REVISION_CONFLICT');
      }
    }
  }
  #scratch(app: SyncBundleApplication, target: string): string {
    return join(dirname(target), `.wevir-sync-${app.opId}`);
  }
  #retired(
    app: SyncBundleApplication,
    binding: SyncBundleBinding,
    change: SyncBundleChange,
    index: number,
  ): string {
    return join(
      this.#scratch(app, this.#path(binding, change.previousPath ?? change.path)),
      `${index}.previous`,
    );
  }
  async #promote(
    app: SyncBundleApplication,
    binding: SyncBundleBinding,
    change: SyncBundleChange,
    index: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.#guard(app, signal);
    const guard = () => this.#guard(app, signal);
    const target = this.#path(binding, change.path),
      previousTarget = this.#path(binding, change.previousPath ?? change.path);
    await this.#directory(dirname(target), binding.targetAnchor, false);
    const current = await this.#status(target, guard),
      previous = change.previousPath ? await this.#status(previousTarget, guard) : current;
    const named = change.previousPath
      ? (
          await readdir(dirname(target)).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
          })
        ).some((name) => name.normalize('NFC') === basename(target).normalize('NFC'))
      : true;
    const already = signature(current) === signature(change.next) && named;
    const retiredPath = this.#retired(app, binding, change, index);
    const retired = change.previousPath && (await this.#status(retiredPath, guard));
    if (
      !already &&
      signature(previous) !== signature(change.previous) &&
      !(retired && signature(retired) === signature(change.previous) && !current && !previous)
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (change.next && !already) {
      await this.#directory(dirname(target), binding.targetAnchor, true);
      const scratch = this.#scratch(app, target);
      await this.#directory(scratch, binding.targetAnchor, true);
      const bytes = await this.#read(join(this.#staging(app), `${index}.next`), guard);
      if (bytes.sha256 !== change.next.sha256) throw new ZuvRequestError('INTEGRITY_FAILED');
      const temporary = join(scratch, `${index}-${newId('tmp')}.next`);
      try {
        const file = await open(temporary, 'wx', change.next.executable ? 0o700 : 0o600);
        try {
          await file.writeFile(bytes.bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        this.#guard(app, signal);
        if (change.previousPath) {
          const legacy = await this.#status(previousTarget, guard);
          if (legacy) {
            if (signature(legacy) !== signature(change.previous))
              throw new ZuvRequestError('REVISION_CONFLICT');
            await this.#directory(dirname(retiredPath), binding.targetAnchor, true);
            if (retired && signature(retired) !== signature(change.previous))
              throw new ZuvRequestError('INTEGRITY_FAILED');
            await rename(previousTarget, retiredPath);
          }
        } else {
          const latest = await this.#status(target, guard);
          if (signature(latest) !== signature(change.previous))
            throw new ZuvRequestError('REVISION_CONFLICT');
        }
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    } else if (!change.next && !already) {
      const latest = await this.#status(target, guard);
      if (signature(latest) !== signature(change.previous))
        throw new ZuvRequestError('REVISION_CONFLICT');
      await unlink(target);
      await this.#emptyParents(
        dirname(target),
        binding.targetKind === 'directory' ? binding.targetPath : dirname(binding.targetPath),
      );
    }
    if (change.previousPath && (await this.#status(retiredPath, guard))) {
      if (signature(await this.#status(target, guard)) !== signature(change.next))
        throw new ZuvRequestError('REVISION_CONFLICT');
      await unlink(retiredPath);
      await rmdir(dirname(retiredPath)).catch((error) => {
        if (
          !['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
      });
      await this.#emptyParents(
        dirname(previousTarget),
        binding.targetKind === 'directory' ? binding.targetPath : dirname(binding.targetPath),
      );
    }
    const scratch = this.#scratch(app, target);
    await rmdir(scratch).catch((error) => {
      if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    });
  }
  #guard(
    app: Pick<
      SyncBundleApplication,
      'vaultId' | 'entityId' | 'deviceId' | 'scopeRevision' | 'operation'
    >,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    const vault = this.#options.eligible(),
      op = app.operation as SyncMaterialRevision;
    const entity = this.#options.storage.sync.entity(app.vaultId, app.entityId);
    const binding = this.#options.storage.sync.bundleBinding(app.vaultId, app.entityId);
    if (
      !vault ||
      vault.vaultId !== app.vaultId ||
      vault.deviceId !== app.deviceId ||
      vault.revision !== app.scopeRevision ||
      !vault.categories.includes(op.entityType) ||
      (entity?.projectId && !vault.projectIds.includes(entity.projectId)) ||
      this.#options.storage.sync.owner(entity?.localKey ?? '') !== app.vaultId ||
      (binding && this.#options.currentScope && !this.#options.currentScope(binding, vault))
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
  }
  #digest(app: SyncBundleApplication): string {
    return sha256(
      jcs({
        operation: app.operation,
        content: app.content,
        files: app.files,
        manifest: app.manifest,
        publish: app.publish,
        previousRevision: app.previousRevision ?? null,
        previousHash: app.previousHash,
        nextHash: app.nextHash,
        deviceId: app.deviceId,
        scopeRevision: app.scopeRevision,
      }),
    );
  }
  #staging(app: SyncBundleApplication): string {
    return join(this.#options.home, 'sync/bundle-writes', app.vaultId, app.opId);
  }
  #path(binding: SyncBundleBinding, path: string): string {
    if (!SyncRelativePathSchema.safeParse(path).success || excludedBundlePath(path))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (binding.targetKind === 'file') {
      if (path !== basename(binding.targetPath).normalize('NFC'))
        throw new ZuvRequestError('INTEGRITY_FAILED');
      return binding.targetPath;
    }
    return join(binding.targetPath, path);
  }
  #validatePaths(paths: readonly string[], prefixes = false): void {
    const seen = new Set<string>();
    for (const path of paths) {
      if (
        !SyncRelativePathSchema.safeParse(path).success ||
        excludedBundlePath(path) ||
        seen.has(folded(path))
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      seen.add(folded(path));
    }
    const ordered = [...seen].sort();
    if (
      prefixes &&
      ordered.some((path, index) => index > 0 && path.startsWith(`${ordered[index - 1]}/`))
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
  }
  async #directory(path: string, anchor: string, create: boolean): Promise<void> {
    const child = relative(anchor, path);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    let current = anchor;
    for (const part of ['', ...child.split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      let info = await lstat(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      });
      if (!info) {
        if (!create) return;
        await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new ZuvRequestError('INTEGRITY_FAILED');
    }
  }
  async #read(
    path: string,
    guard?: () => void,
  ): Promise<{ bytes: Buffer; sha256: string; executable: boolean; ino: number }> {
    guard?.();
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 64 * 1024 * 1024)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== before.ino || info.size !== before.size)
        throw new ZuvRequestError('REVISION_CONFLICT');
      const bytes = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        guard?.();
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          Math.min(64 * 1024, bytes.length - offset),
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size)
        throw new ZuvRequestError('REVISION_CONFLICT');
      return {
        bytes: bytes.subarray(0, offset),
        sha256: sha256(bytes.subarray(0, offset)),
        executable: Boolean(info.mode & 0o111),
        ino: info.ino,
      };
    } finally {
      await handle.close();
    }
  }
  async #status(
    path: string,
    guard?: () => void,
  ): Promise<{ sha256: string; executable: boolean; ino: number } | undefined> {
    try {
      const { bytes: _bytes, ...value } = await this.#read(path, guard);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  async #save(path: string, bytes: Buffer, digest: string): Promise<void> {
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (sha256(await readFile(path)) !== digest) throw new ZuvRequestError('INTEGRITY_FAILED');
    }
  }
  async #emptyParents(path: string, root: string): Promise<void> {
    for (let current = path; current !== root; current = dirname(current)) {
      const child = relative(root, current);
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return;
      try {
        await rmdir(current);
      } catch (error) {
        if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return;
        throw error;
      }
    }
  }
}
