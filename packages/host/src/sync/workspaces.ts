import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type MethodParams,
  type SessionId,
  SyncBundleContentSchema,
  SyncChunkContentSchema,
  SyncWorkspaceMetadataSchema,
  type SyncWorkspaceRef,
  SyncWorkspaceRefSchema,
  SyncWorkspaceSnapshotSchema,
} from '@wevir/protocol';
import { id, jcs } from '@wevir/protocol/sync';
import type { Storage, SyncVaultRecord } from '@wevir/storage';
import { newId } from '../ids.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { BundleFile } from './bundle-snapshot.js';
import { sha256 } from './crypto.js';
import { SyncQueue } from './queue.js';
import {
  captureWorkspaceTree,
  inspectWorkspaceTree,
  restoreWorkspaceTree,
  WORKSPACE_MAX_BYTES,
  workspaceLayers,
  workspaceTreeFingerprint,
} from './workspace-git.js';

interface SyncWorkspacesOptions {
  storage: Storage;
  home: string;
  eligible: () => SyncVaultRecord | undefined;
  source: (
    sessionId: SessionId,
  ) => { hostId: string; deviceId?: string; sessionId: string; streamId: string } | undefined;
}
interface RestoreJob {
  restoreId: string;
  snapshot: SyncWorkspaceRef;
  sessionId: SessionId;
  workspaceId: string;
  deviceId: string;
  originHostId: string;
  directory: string;
  state: 'building' | 'ready';
  fingerprint?: string;
  head?: string;
  requiresTrust?: string[];
}

export class SyncWorkspaces {
  readonly #options: SyncWorkspacesOptions;
  readonly #restoring = new Set<string>();
  constructor(options: SyncWorkspacesOptions) {
    this.#options = options;
  }

  async capture(params: MethodParams<'sync.workspaceCapture'>) {
    const { storage } = this.#options;
    const untracked = params.untracked ?? [];
    const vault = this.#options.eligible();
    const session = storage.sessions.get(params.sessionId);
    const project =
      vault &&
      storage.sync
        .projects(vault.vaultId)
        .find((value) => value.workspaceId === session?.workspaceId);
    if (!vault || !session || !project || session.origin?.kind === 'synced')
      throw new ZuvRequestError('SCOPE_DISABLED');
    const guard = () => {
      const current = this.#options.eligible();
      if (
        !current ||
        current.vaultId !== vault.vaultId ||
        current.deviceId !== vault.deviceId ||
        current.originHostId !== vault.originHostId ||
        current.revision !== vault.revision ||
        !current.categories.includes('workspace-snapshot') ||
        !current.categories.includes('artifact') ||
        !current.projectIds.includes(project.projectId)
      )
        throw new ZuvRequestError('SCOPE_DISABLED');
    };
    guard();
    const source = this.#options.source(params.sessionId);
    if (!source?.deviceId) throw new ZuvRequestError('SCOPE_DISABLED');
    const seq = session.lastSeq;
    const captured = await captureWorkspaceTree(session.cwd, untracked, guard);
    const ruleVersions = storage.sync
      .entities(vault.vaultId)
      .filter(
        (entity) =>
          entity.entityType === 'rule' &&
          entity.projectId === project.projectId &&
          entity.materialized &&
          entity.revision,
      )
      .map((entity) => ({ entityId: entity.entityId, opId: entity.revision as string }));
    const metadata = SyncWorkspaceMetadataSchema.parse({
      schema: 'wevir-workspace-snapshot/1',
      projectId: project.projectId,
      source,
      throughSeq: seq,
      sourceHead: captured.sourceHead,
      base: 'bounded-tree',
      statusHash: captured.statusHash,
      selectedUntracked: untracked,
      ruleVersions,
      capturedAt: new Date().toISOString(),
    });
    guard();
    if (storage.sessions.get(params.sessionId)?.lastSeq !== seq)
      throw new ZuvRequestError('REVISION_CONFLICT');
    const entityId = newId('sws'),
      queue = new SyncQueue(storage);
    const opId = storage.transaction(() => {
      guard();
      const files = captured.files.map((file) => {
        const parts: Array<{ entityId: string; opId: string }> = [];
        for (let offset = 0, index = 0; offset < file.bytes.length; offset += 64 * 1024, index++) {
          const chunkId = newId('spart'),
            bytes = file.bytes.subarray(offset, offset + 64 * 1024);
          const part = queue.enqueue({
            vaultId: vault.vaultId,
            entityId: chunkId,
            entityType: 'artifact',
            projectId: project.projectId,
            localKey: `chunk:${chunkId}`,
            content: {
              schema: 'wevir-chunk/1',
              ownerId: entityId,
              index,
              data: bytes.toString('base64url'),
              sha256: sha256(bytes),
            },
          });
          if (!part) throw new ZuvRequestError('SCOPE_DISABLED');
          parts.push({ entityId: chunkId, opId: part });
        }
        return {
          path: file.path,
          bytes: file.bytes.length,
          sha256: file.sha256,
          executable: file.executable,
          parts,
        };
      });
      const result = queue.enqueue({
        vaultId: vault.vaultId,
        entityId,
        entityType: 'workspace-snapshot',
        projectId: project.projectId,
        localKey: `workspace:${entityId}`,
        content: SyncBundleContentSchema.parse({
          schema: 'wevir-bundle/1',
          category: 'workspace-snapshot',
          name: 'Workspace',
          files,
          exclusions: captured.exclusions,
          metadata,
        }),
      });
      if (!result) throw new ZuvRequestError('SCOPE_DISABLED');
      return result;
    });
    return { snapshot: this.#summary({ vaultId: vault.vaultId, entityId, opId }) };
  }

  restoreVersion(
    input: { sessionId: SessionId; expectedLocalSeq: number },
    archived: {
      vaultId: string;
      opId: string;
      deviceId: string;
      body: typeof SyncBundleContentSchema._output;
      files: readonly BundleFile[];
      enqueueReferences?: () => void;
    },
  ) {
    const { storage } = this.#options;
    const vault = this.#options.eligible();
    const body = SyncBundleContentSchema.parse(archived.body);
    const original = SyncWorkspaceMetadataSchema.parse(body.metadata);
    const session = storage.sessions.get(input.sessionId);
    if (
      !vault ||
      !session ||
      archived.vaultId !== vault.vaultId ||
      !this.#project(input.sessionId, vault.vaultId, original.projectId)
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    id.parse(archived.opId);
    id.parse(archived.deviceId);
    if (body.category !== 'workspace-snapshot' || original.source.deviceId !== archived.deviceId)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const guard = () => {
      const current = this.#options.eligible(),
        bound = storage.sync.activeVault();
      if (
        !current?.active ||
        !current.enabled ||
        current.vaultId !== vault.vaultId ||
        current.accountId !== vault.accountId ||
        current.deviceId !== vault.deviceId ||
        current.originHostId !== vault.originHostId ||
        current.revision !== vault.revision ||
        !current.categories.includes('workspace-snapshot') ||
        !current.categories.includes('artifact') ||
        !current.projectIds.includes(original.projectId) ||
        (archived.enqueueReferences !== undefined &&
          original.ruleVersions.length > 0 &&
          !current.categories.includes('rule')) ||
        bound?.vaultId !== vault.vaultId ||
        !bound.active ||
        !bound.enabled ||
        bound.accountId !== vault.accountId ||
        bound.deviceId !== vault.deviceId ||
        bound.originHostId !== vault.originHostId ||
        this.#project(input.sessionId, vault.vaultId, original.projectId) !== session.workspaceId ||
        storage.workspaces.get(session.workspaceId)?.removedAt !== undefined
      )
        throw new ZuvRequestError('SCOPE_DISABLED');
      if (storage.sessions.get(input.sessionId)?.lastSeq !== input.expectedLocalSeq)
        throw new ZuvRequestError('REVISION_CONFLICT');
    };
    guard();
    workspaceLayers(archived.files);
    const manifest = new Map(body.files.map((file) => [file.path, file]));
    if (manifest.size !== body.files.length || manifest.size !== archived.files.length)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    for (const file of archived.files) {
      const expected = manifest.get(file.path);
      if (
        !expected ||
        expected.bytes !== file.bytes.length ||
        expected.sha256 !== file.sha256 ||
        (expected.executable === true) !== file.executable
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
    }
    const metadata = SyncWorkspaceMetadataSchema.parse({
      ...original,
      source: {
        hostId: vault.originHostId,
        deviceId: vault.deviceId,
        sessionId: input.sessionId,
        streamId: newId('sst'),
      },
      throughSeq: input.expectedLocalSeq,
      statusHash: sha256(
        jcs(
          archived.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            executable: file.executable,
          })),
        ),
      ),
      capturedAt: new Date().toISOString(),
    });
    const entityId = newId('sws'),
      queue = new SyncQueue(storage);
    const commit = () => {
      guard();
      const files = archived.files.map((file) => {
        const parts: Array<{ entityId: string; opId: string }> = [];
        for (let offset = 0, index = 0; offset < file.bytes.length; offset += 64 * 1024, index++) {
          guard();
          const chunkId = newId('spart'),
            bytes = file.bytes.subarray(offset, offset + 64 * 1024);
          const opId = queue.enqueue({
            vaultId: vault.vaultId,
            entityId: chunkId,
            entityType: 'artifact',
            projectId: original.projectId,
            localKey: `chunk:${chunkId}`,
            content: {
              schema: 'wevir-chunk/1',
              ownerId: entityId,
              index,
              data: bytes.toString('base64url'),
              sha256: sha256(bytes),
            },
          });
          if (!opId) throw new ZuvRequestError('SCOPE_DISABLED');
          parts.push({ entityId: chunkId, opId });
        }
        return {
          path: file.path,
          bytes: file.bytes.length,
          sha256: file.sha256,
          executable: file.executable,
          parts,
        };
      });
      guard();
      archived.enqueueReferences?.();
      guard();
      for (const version of original.ruleVersions) {
        const rule = this.#revision({ vaultId: vault.vaultId, ...version });
        if (
          rule.entity.entityType !== 'rule' ||
          (rule.entity.projectId && rule.entity.projectId !== original.projectId)
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      const opId = queue.enqueue({
        vaultId: vault.vaultId,
        entityId,
        entityType: 'workspace-snapshot',
        projectId: original.projectId,
        localKey: `workspace:${entityId}`,
        content: SyncBundleContentSchema.parse({
          ...body,
          files,
          metadata,
          recoveredFrom: {
            vaultId: archived.vaultId,
            deviceId: archived.deviceId,
            opId: archived.opId,
            source: original.source,
          },
        }),
      });
      if (!opId) throw new ZuvRequestError('SCOPE_DISABLED');
      return { snapshot: this.#summary({ vaultId: vault.vaultId, entityId, opId }) };
    };
    return storage.db.isTransaction ? commit() : storage.transaction(commit);
  }

  list(sessionId: SessionId) {
    const vault = this.#options.storage.sync.activeVault();
    if (!vault) return { snapshots: [] };
    const snapshots = [];
    for (const entity of this.#options.storage.sync.entities(vault.vaultId)) {
      if (entity.entityType !== 'workspace-snapshot' || !entity.revision) continue;
      const ref = { vaultId: vault.vaultId, entityId: entity.entityId, opId: entity.revision };
      const snapshot = this.#summary(ref);
      const { bundle } = this.#bundle(ref);
      if (
        this.#matches(sessionId, snapshot.source, bundle.recoveredFrom?.source) &&
        this.#project(sessionId, ref.vaultId, snapshot.projectId)
      )
        snapshots.push(snapshot);
    }
    return {
      snapshots: snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 100),
    };
  }

  #revision(ref: SyncWorkspaceRef) {
    const { storage } = this.#options;
    const draft = storage.sync.draft(ref.vaultId, ref.opId);
    const operation = storage.sync.getOperation(ref.vaultId, ref.opId);
    const entity = storage.sync.entity(ref.vaultId, ref.entityId);
    if (
      !entity ||
      (draft?.entityId ?? operation?.entityId) !== ref.entityId ||
      (!draft && !['applied', 'committed'].includes(operation?.state ?? '')) ||
      (!draft && operation?.projectId !== entity.projectId)
    )
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const content = draft
      ? (draft.content as { body: unknown }).body
      : ((operation as NonNullable<typeof operation>).record as { content: unknown }).content;
    return { content, entity };
  }

  #bundle(ref: SyncWorkspaceRef) {
    const { content, entity } = this.#revision(ref);
    const bundle = SyncBundleContentSchema.parse(content);
    const metadata = SyncWorkspaceMetadataSchema.parse(bundle.metadata);
    if (
      entity.entityType !== 'workspace-snapshot' ||
      bundle.category !== 'workspace-snapshot' ||
      entity.projectId !== metadata.projectId
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return { bundle, metadata };
  }

  #summary(ref: SyncWorkspaceRef) {
    const { bundle, metadata } = this.#bundle(ref);
    return SyncWorkspaceSnapshotSchema.parse({
      ...ref,
      projectId: metadata.projectId,
      source: metadata.source,
      capturedAt: metadata.capturedAt,
      files: bundle.files.filter((file) => file.path.startsWith('worktree/')).length,
      bytes: bundle.files.reduce((n, file) => n + file.bytes, 0),
      exclusions: bundle.exclusions,
    });
  }

  #project(sessionId: SessionId, vaultId: string, projectId: string) {
    const session = this.#options.storage.sessions.get(sessionId);
    const project = this.#options.storage.sync
      .projects(vaultId)
      .find((value) => value.projectId === projectId);
    return session && project?.workspaceId === session.workspaceId
      ? session.workspaceId
      : undefined;
  }

  #matches(
    sessionId: SessionId,
    source: { hostId: string; deviceId: string; sessionId: string; streamId: string },
    recovered?: { hostId: string; deviceId: string; sessionId: string; streamId: string },
  ) {
    const vault = this.#options.storage.sync.activeVault();
    const sources = this.#options.storage.sync.sources(vault?.vaultId ?? '');
    const matches = (ref: typeof source) =>
      sources.some(
        (value) =>
          value.localSessionId === sessionId &&
          value.hostId === ref.hostId &&
          value.deviceId === ref.deviceId &&
          value.sessionId === ref.sessionId &&
          value.streamId === ref.streamId,
      );
    return (
      matches(source) ||
      (recovered !== undefined &&
        ((source.hostId === vault?.originHostId &&
          source.deviceId === vault?.deviceId &&
          source.sessionId === sessionId) ||
          matches(recovered)))
    );
  }

  /** Also used by offline packages: immutable records/chunks, no filesystem activation. */
  read(ref: SyncWorkspaceRef) {
    const { bundle, metadata } = this.#bundle(ref);
    for (const version of metadata.ruleVersions) {
      const rule = this.#revision({ vaultId: ref.vaultId, ...version });
      if (
        rule.entity.entityType !== 'rule' ||
        (rule.entity.projectId && rule.entity.projectId !== metadata.projectId)
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
    }
    const files: BundleFile[] = [];
    for (const file of bundle.files) {
      const chunks: Buffer[] = [];
      let length = 0;
      for (const [index, part] of file.parts.entries()) {
        const { entity, content } = this.#revision({ vaultId: ref.vaultId, ...part });
        const chunk = SyncChunkContentSchema.parse(content);
        const bytes = Buffer.from(chunk.data, 'base64url');
        if (
          entity.entityType !== 'artifact' ||
          entity.projectId !== metadata.projectId ||
          chunk.ownerId !== ref.entityId ||
          chunk.index !== index ||
          bytes.toString('base64url') !== chunk.data ||
          sha256(bytes) !== chunk.sha256
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        length += bytes.length;
        if (length > file.bytes) throw new ZuvRequestError('INTEGRITY_FAILED');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      files.push({
        path: file.path,
        bytes,
        sha256: file.sha256,
        executable: file.executable === true,
      });
    }
    workspaceLayers(files);
    return { metadata, files, exclusions: bundle.exclusions, recoveredFrom: bundle.recoveredFrom };
  }

  async restore(params: MethodParams<'sync.workspaceRestore'>) {
    await this.#safeRoot();
    const ref = SyncWorkspaceRefSchema.parse(params.snapshot),
      { storage } = this.#options;
    const vault = storage.sync.activeVault();
    const { metadata, files, recoveredFrom } = this.read(ref);
    const workspaceId = this.#project(params.sessionId, ref.vaultId, metadata.projectId);
    if (
      vault?.vaultId !== ref.vaultId ||
      !workspaceId ||
      !this.#matches(params.sessionId, metadata.source, recoveredFrom?.source)
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    const restoreId = params.restoreId ?? newId('swr');
    id.parse(restoreId);
    if (this.#restoring.has(restoreId)) throw new ZuvRequestError('EXECUTION_CONFLICT');
    this.#restoring.add(restoreId);
    try {
      let job: RestoreJob;
      if (params.restoreId) {
        job = JSON.parse((await this.#readFile(this.#journal(restoreId), 16 * 1024)).toString());
        if (
          job.restoreId !== restoreId ||
          jcs(job.snapshot) !== jcs(ref) ||
          job.sessionId !== params.sessionId ||
          job.workspaceId !== workspaceId
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
      } else
        job = {
          restoreId,
          snapshot: ref,
          sessionId: params.sessionId,
          workspaceId,
          deviceId: vault.deviceId,
          originHostId: vault.originHostId,
          directory: newId('tree'),
          state: 'building',
        };
      const guard = () => this.#guardRestore(job);
      guard();
      if (job.state === 'building') {
        // A fresh attempt never resets a directory someone could have edited after a crash.
        job.directory = newId('tree');
        await this.#save(job);
        guard();
        const cwd = this.#directory(job);
        await mkdir(cwd, { recursive: false, mode: 0o700 });
        guard();
        const space = await statfs(cwd, { bigint: true });
        if (
          space.bavail * space.bsize <
          BigInt(files.reduce((sum, file) => sum + file.bytes.length, 16 * 1024 * 1024))
        )
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        const restored = await restoreWorkspaceTree(cwd, files, metadata, guard);
        job.head = restored.head;
        job.requiresTrust = restored.requiresTrust;
        job.fingerprint = await workspaceTreeFingerprint(cwd);
        job.state = 'ready';
        await this.#save(job);
        guard();
      } else if (job.state !== 'ready') throw new ZuvRequestError('INTEGRITY_FAILED');
      const cwd = this.#directory(job);
      const current = await inspectWorkspaceTree(cwd);
      guard();
      return {
        restoreId,
        cwd,
        sourceHead: metadata.sourceHead,
        head: job.head as string,
        requiresTrust: current.requiresTrust,
        modified: current.fingerprint !== job.fingerprint,
        ...(recoveredFrom && {
          recoveredFrom: {
            deviceId: recoveredFrom.deviceId,
            opId: recoveredFrom.opId,
            ...(recoveredFrom.source && { source: recoveredFrom.source }),
          },
        }),
      };
    } finally {
      this.#restoring.delete(restoreId);
    }
  }

  async restoredRoot(workspaceId: string, restoreId: string) {
    await this.#safeRoot();
    const job: RestoreJob = JSON.parse(
      (await this.#readFile(this.#journal(restoreId), 16 * 1024)).toString(),
    );
    const { metadata } = this.#bundle(job.snapshot);
    if (
      job.restoreId !== restoreId ||
      job.workspaceId !== workspaceId ||
      job.state !== 'ready' ||
      this.#options.storage.sync.activeVault()?.vaultId !== job.snapshot.vaultId ||
      this.#project(job.sessionId, job.snapshot.vaultId, metadata.projectId) !== workspaceId
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    this.#guardRestore(job);
    const cwd = this.#directory(job);
    await workspaceTreeFingerprint(cwd);
    this.#guardRestore(job);
    return cwd;
  }

  #guardRestore(job: RestoreJob) {
    const current = this.#options.storage.sync.activeVault();
    const { metadata } = this.#bundle(job.snapshot);
    if (
      current?.vaultId !== job.snapshot.vaultId ||
      current.deviceId !== job.deviceId ||
      current.originHostId !== job.originHostId ||
      this.#project(job.sessionId, job.snapshot.vaultId, metadata.projectId) !== job.workspaceId
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
  }

  #directory(job: RestoreJob) {
    return join(this.#options.home, 'sync/workspaces/trees', id.parse(job.directory));
  }
  #journal(restoreId: string) {
    return join(this.#options.home, 'sync/workspaces/jobs', `${id.parse(restoreId)}.json`);
  }
  async #safeRoot() {
    const root = join(this.#options.home, 'sync/workspaces');
    for (const path of [
      join(this.#options.home, 'sync'),
      root,
      join(root, 'jobs'),
      join(root, 'trees'),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ZuvRequestError('INTEGRITY_FAILED');
    }
  }
  async #save(job: RestoreJob) {
    await this.#safeRoot();
    const path = this.#journal(job.restoreId),
      temp = `${path}.${newId('tmp')}`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(jcs(job));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    if (process.platform !== 'win32') {
      const dir = await open(dirname(path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async #readFile(path: string, limit: number) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > Math.min(limit, WORKSPACE_MAX_BYTES))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.size !== info.size)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new ZuvRequestError('INTEGRITY_FAILED');
      return bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }
}
