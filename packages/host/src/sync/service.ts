import { type FSWatcher, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type MethodParams,
  type SessionId,
  type SharedFile,
  type SyncConfigureParams,
  SyncProjectContentSchema,
  type SyncStatus,
  SyncStatusSchema,
} from '@wevir/protocol';
import { packRecord, validateOperation } from '@wevir/protocol/sync';
import type { SecretStore, Storage, SyncVaultRecord } from '@wevir/storage';
import type { EpisodeChange } from '../episodes/service.js';
import { HostError } from '../errors.js';
import type { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import type { ImageStore } from '../images.js';
import type { HostSettingsStore } from '../settings.js';
import type { ZuvAccounts } from '../zuv/accounts.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { SyncArtifacts } from './artifacts.js';
import { SyncBootstrap } from './bootstrap.js';
import { snapshotBundle } from './bundle-snapshot.js';
import { SyncBundles } from './bundles.js';
import { SyncBlobCache } from './cache.js';
import { SyncEventCapture } from './capture.js';
import { SyncProjectCatalog } from './catalog.js';
import { sha256 } from './crypto.js';
import { SyncEngine } from './engine.js';
import { SyncExecutions } from './executions.js';
import { type SyncBundleRoot, SyncFilesCapture } from './files-capture.js';
import { SyncVaultKeys } from './keys.js';
import { SyncLifecycle } from './lifecycle.js';
import { SyncMaterials } from './materials.js';
import { SyncMemoryConflicts } from './memory-conflicts.js';
import { SyncOutboxRecovery } from './outbox-recovery.js';
import { SyncPortable } from './portable.js';
import { SyncQueue } from './queue.js';
import { SyncRecoveryFiles } from './recovery-files.js';
import { SyncRestoreData } from './restore-data.js';
import { SyncSessionConflicts } from './session-conflicts.js';
import { SyncSettings } from './settings.js';
import { SyncSettingsConflicts } from './settings-conflicts.js';
import { SyncSnapshots } from './snapshots.js';
import { SyncVersionRestore } from './version-restore.js';
import { workspaceRequiresTrust } from './workspace-git.js';
import { SyncWorkspaces } from './workspaces.js';

export interface SyncServiceOptions {
  storage: Storage;
  events: EventStore;
  secrets: SecretStore;
  client: ZuvClient;
  accounts: ZuvAccounts;
  home: string;
  userHome?: string;
  memoryDir: string;
  images: ImageStore;
  settings: HostSettingsStore;
  onSecret: (value: string) => void;
  bundleRoots: (vault: SyncVaultRecord) => Promise<SyncBundleRoot[]>;
  exportRoots?: () => Promise<SyncBundleRoot[]>;
  intervalMs?: number;
  onEpisodeChanged?: (change: EpisodeChange) => void;
  workspaceInUse?: (root: string) => boolean;
}

export class SyncService {
  readonly workspaces: SyncWorkspaces;
  readonly #options: SyncServiceOptions;
  readonly #engine: SyncEngine;
  readonly #materials: SyncMaterials;
  readonly #capture: SyncEventCapture;
  readonly executions: SyncExecutions;
  readonly #files: SyncFilesCapture;
  readonly #artifacts: SyncArtifacts;
  readonly #keys: SyncVaultKeys;
  readonly #lifecycle: SyncLifecycle;
  readonly #portable: SyncPortable;
  readonly #recoveryFiles: SyncRecoveryFiles;
  readonly #settings: SyncSettings;
  readonly #catalog: SyncProjectCatalog;
  readonly #bootstrap: SyncBootstrap;
  readonly #memoryConflicts: SyncMemoryConflicts;
  readonly #settingsConflicts: SyncSettingsConflicts;
  readonly #sessionConflicts: SyncSessionConflicts;
  readonly #versionRestore: SyncVersionRestore;
  readonly #bundles: SyncBundles;
  #bundleAbort: AbortController | undefined;
  #bundleEntity: string | undefined;
  #bundleVault: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  #initialized = false;
  #lastRefresh = 0;
  #lastFullScan = 0;
  #dirty = true;
  #scanAfter = 0;
  readonly #watchers = new Map<string, FSWatcher>();
  #watchUnavailable = false;
  #errorCode: string | undefined;
  #configuring = false;
  #configurationDone: Promise<void> | undefined;
  #finishConfiguration: (() => void) | undefined;
  #resetTask: Promise<void> | undefined;
  #resetAbort: AbortController | undefined;
  #recoveryIoAbort: AbortController | undefined;
  #recoveryIoTask: Promise<unknown> | undefined;
  #workspaceCleanup: Promise<void> | undefined;
  constructor(options: SyncServiceOptions) {
    this.#options = options;
    this.#settings = new SyncSettings(options);
    this.#settingsConflicts = new SyncSettingsConflicts({
      ...options,
      settingsSync: this.#settings,
      eligible: () => (this.#closed ? undefined : this.#consented()),
    });
    this.#keys = new SyncVaultKeys({
      client: options.client,
      secrets: options.secrets,
      onSecret: options.onSecret,
    });
    this.#lifecycle = new SyncLifecycle({ ...options, keys: this.#keys });
    this.#portable = new SyncPortable({
      ...options,
      keys: this.#keys,
      origin: options.client.transport.origin,
    });
    this.#capture = new SyncEventCapture({
      storage: options.storage,
      eligible: () => this.#consented(),
    });
    this.executions = new SyncExecutions({
      ...options,
      capture: this.#capture,
      eligible: () => (this.#closed ? undefined : this.#consented()),
    });
    this.#files = new SyncFilesCapture({
      ...options,
      eligible: () => (this.#closed ? undefined : this.#localConsent()),
    });
    this.#bundles = new SyncBundles({
      ...options,
      userHome: options.userHome ?? homedir(),
      files: this.#files,
      nativeRoots: options.bundleRoots,
      eligible: () => (this.#closed ? undefined : this.#localConsent()),
    });
    this.#materials = new SyncMaterials({
      ...options,
      settingsSync: this.#settings,
      bundles: this.#bundles,
      eligible: () => this.#consented(),
      nativeSource: (id) => this.#capture.source(id),
    });
    this.#sessionConflicts = new SyncSessionConflicts({
      storage: options.storage,
      materials: this.#materials.sessions,
      eligible: () => (this.#closed || this.#configuring ? undefined : this.#consented()),
    });
    this.#memoryConflicts = new SyncMemoryConflicts({
      ...options,
      files: this.#files,
      materials: this.#materials,
      eligible: () => (this.#closed ? undefined : this.#consented()),
    });
    this.#artifacts = new SyncArtifacts({
      ...options,
      files: this.#files,
      eligible: () => this.#consented(),
      source: (id) => this.#capture.source(id),
    });
    this.workspaces = new SyncWorkspaces({
      ...options,
      inUse: options.workspaceInUse,
      eligible: () => (this.#closed ? undefined : this.#localConsent()),
      source: (sessionId) => this.#capture.source(sessionId),
    });
    const cache = new SyncBlobCache(join(options.home, 'sync/blobs'));
    const snapshots = new SyncSnapshots(options);
    const data = new SyncRestoreData({ ...options, cache, snapshots, keys: this.#keys });
    this.#recoveryFiles = new SyncRecoveryFiles({
      client: options.client,
      snapshots,
      data,
      portable: this.#portable,
      storage: options.storage,
    });
    this.#bootstrap = new SyncBootstrap({
      ...options,
      snapshots,
      data,
      eligible: () => this.#consented(),
    });
    this.#catalog = new SyncProjectCatalog({
      snapshots,
      data,
      eligible: () => this.#consented(),
    });
    this.#engine = new SyncEngine({
      storage: options.storage,
      client: options.client,
      cache,
      key: (vaultId, epoch, signal) => this.#keys.unlock(vaultId, epoch, signal),
      prepareApply: (op, record, signal) => this.#materials.prepareApply(op, record, { signal }),
    });
    const eligible = () => (this.#closed ? undefined : this.#localConsent());
    this.#versionRestore = new SyncVersionRestore({
      ...options,
      portable: this.#portable,
      materials: this.#materials,
      memory: new SyncMemoryConflicts({
        ...options,
        files: this.#files,
        materials: this.#materials,
        eligible,
      }),
      settings: new SyncSettingsConflicts({ ...options, settingsSync: this.#settings, eligible }),
      sessions: new SyncSessionConflicts({
        storage: options.storage,
        materials: this.#materials.sessions,
        eligible,
      }),
      bundles: this.#bundles,
      workspaces: this.workspaces,
      eligible,
      captureProject: (vault, entityId) => this.#capture.projects(vault, entityId),
      captureBundleTarget: async (vault, entity, targetId) => {
        const root = (await options.bundleRoots(vault)).find(
          (root) =>
            sha256(root.localKey) === targetId &&
            root.category === entity.entityType &&
            root.projectId === entity.projectId,
        );
        if (!root) return undefined;
        const guard = () => {
          const current = this.#localConsent();
          if (
            this.#closed ||
            current?.vaultId !== vault.vaultId ||
            current.deviceId !== vault.deviceId ||
            current.originHostId !== vault.originHostId ||
            current.revision !== vault.revision
          )
            throw new ZuvRequestError('SCOPE_DISABLED');
        };
        guard();
        await this.#files.bundle(vault, root, false, false);
        guard();
        const result = await snapshotBundle({ ...root, guard }, true);
        return { files: result.files, deleted: result.deleted };
      },
    });
  }

  start(): void {
    this.#collectWorkspaces();
    this.#schedule(0);
  }
  #collectWorkspaces() {
    const task = (this.#workspaceCleanup ?? Promise.resolve())
      .then(() => this.workspaces.collect())
      .catch(() => {
        this.#errorCode = 'LOCAL_STORAGE_ERROR';
      });
    this.#workspaceCleanup = task;
  }
  changed = (): void => {
    this.#dirty = true;
  };
  #watch(path: string, recursive = true, filter?: (name: string) => boolean) {
    if (this.#watchUnavailable || this.#watchers.has(path)) return;
    try {
      const watcher = watch(path, { recursive, persistent: false }, (_event, name) => {
        if (name && filter && !filter(String(name).split('\\').join('/'))) return;
        if (_event === 'rename' && !recursive) {
          watcher.close();
          this.#watchers.delete(path);
        }
        // Directory notifications can arrive before the write finishes.
        this.#scanAfter = Date.now() + 100;
        this.changed();
      });
      watcher.on('error', (error) => {
        this.#watchFailure(error);
        watcher.close();
        this.#watchers.delete(path);
      });
      this.#watchers.set(path, watcher);
    } catch (error) {
      this.#watchFailure(error as NodeJS.ErrnoException);
      if (
        !['ENOENT', 'ENOSYS', 'ENOTSUP', 'ENOSPC', 'EPERM', 'EMFILE', 'ENFILE'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  #watchFailure(error: NodeJS.ErrnoException): void {
    if (!['EMFILE', 'ENFILE'].includes(error.code ?? '') || this.#watchUnavailable) return;
    this.#watchUnavailable = true;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    console.warn('Sync file watching unavailable; using periodic scans', error.code);
  }
  record = (events: Parameters<SyncEventCapture['record']>[0]): void => {
    if (
      events.some(
        (event) =>
          event.type === 'file.shared' ||
          (event.type === 'user.message' &&
            event.payload.content.some((part) => part.type === 'image')),
      )
    )
      this.changed();
    this.#captureOperation(() => {
      this.#capture.record(events);
      this.#materials.sessions.metadataChanged([
        ...new Set(
          events
            .filter((event) => event.type === 'session.title_changed')
            .map((event) => event.sessionId),
        ),
      ]);
    });
  };
  recordEpisode = (record: Parameters<SyncMaterials['sessions']['episode']>[0]): void => {
    this.#captureOperation(() => this.#materials.sessions.episode(record));
  };
  recordSummary = (record: Parameters<SyncMaterials['sessions']['summary']>[0]): void => {
    this.#captureOperation(() => this.#materials.sessions.summary(record));
  };
  #captureOperation(operation: () => void) {
    const { db } = this.#options.storage;
    db.exec('SAVEPOINT sync_capture');
    try {
      operation();
      db.exec('RELEASE sync_capture');
    } catch {
      if (db.isTransaction) db.exec('ROLLBACK TO sync_capture; RELEASE sync_capture');
      this.#errorCode = 'LOCAL_STORAGE_ERROR';
    }
  }
  recordMetadata = (ids: readonly string[]): void => {
    try {
      this.#capture.metadataChanged(ids);
      this.#materials.sessions.metadataChanged(ids);
    } catch {
      this.#errorCode = 'LOCAL_STORAGE_ERROR';
    }
  };
  prepareSharedFiles = async (sessionId: SessionId, files: readonly SharedFile[]) => {
    try {
      return await this.#artifacts.prepare(sessionId, files);
    } catch (error) {
      this.#errorCode = error instanceof ZuvRequestError ? error.code : 'LOCAL_STORAGE_ERROR';
      return undefined;
    }
  };
  artifactFile = (sessionId: string, path: string, seq?: number) =>
    this.#artifacts.file(sessionId, path, seq);
  prepareRemoval = async (_sessionIds: readonly string[]): Promise<void> => {
    const vault = this.#consented();
    if (!vault) return;
    await this.#artifacts.scan(vault, false, false);
    if (vault.categories.some((value) => ['artifact', 'rule', 'skill-bundle'].includes(value)))
      for await (const root of this.#bundles.roots(vault))
        await this.#files.bundle(vault, root, false, false);
  };
  recordRemoval = (sessionIds: readonly string[]): void => {
    this.#capture.preserveForRemoval(sessionIds);
    this.#materials.sessions.remove(sessionIds);
    this.#collectWorkspaces();
  };
  beforeMemoryWrite = (path: string, markdown?: string): (() => void) | undefined => {
    this.changed();
    const vault = this.#consented();
    return vault && this.#fileWrite(() => this.#files.beforeMemoryWrite(vault, path, markdown));
  };
  beforeSettingsWrite = (
    next: Parameters<SyncSettings['beforeWrite']>[1],
  ): (() => void) | undefined => {
    const vault = this.#consented();
    return vault && this.#fileWrite(() => this.#settings.beforeWrite(vault, next));
  };

  #fileWrite(stage: () => (() => void) | undefined): (() => void) | undefined {
    try {
      const commit = stage();
      return (
        commit &&
        (() => {
          try {
            commit();
          } catch {
            this.#errorCode = 'LOCAL_STORAGE_ERROR';
          }
        })
      );
    } catch {
      this.#errorCode = 'LOCAL_STORAGE_ERROR';
      return;
    }
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#engine.stop();
    this.#catalog.stop();
    this.#resetAbort?.abort();
    this.#bundleAbort?.abort();
    this.#initialized = false;
    this.#lastFullScan = 0;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
  async suspend(): Promise<void> {
    this.executions.stop();
    this.stop();
    await this.#running?.catch(() => {});
    await this.#catalog.drain();
    await this.#configurationDone;
    await this.executions.drain();
  }
  async close(): Promise<void> {
    this.#recoveryIoAbort?.abort();
    await this.#recoveryIoTask?.catch(() => {});
    await this.#workspaceCleanup;
    this.executions.stop();
    this.#closed = true;
    this.stop();
    await this.#running?.catch(() => {});
    await this.#catalog.drain();
    await this.#configurationDone;
    await this.executions.drain();
  }

  status(): SyncStatus {
    const { storage, client } = this.#options;
    const vault = storage.sync.activeVault();
    const transport = vault && storage.sync.vaultTransport(vault.vaultId);
    const fileIssues = vault ? this.#files.memoryIssues(vault) : [];
    const keys = client.entitlements?.vault;
    const counts = vault
      ? storage.sync.counts(vault.vaultId)
      : { pending: 0, quarantined: 0, conflicts: 0 };
    const resetJob = vault && storage.sync.activeBootstrapJob(vault.vaultId);
    const application =
      resetJob && storage.sync.bootstrapApplication(resetJob.vaultId, resetJob.jobId);
    let state: SyncStatus['state'] = !vault?.enabled
      ? keys?.keyState === 'approval-required'
        ? 'approval_required'
        : 'disabled'
      : (transport?.state as SyncStatus['state']);
    if (vault?.enabled) {
      if (this.#catalog.busy) state = 'syncing';
      if (
        client.entitlements?.subscriptionState !== 'active' ||
        ['paused', 'disabled'].includes(client.entitlements.syncState)
      )
        state = 'paused';
      if (
        counts.quarantined ||
        counts.conflicts ||
        fileIssues.length ||
        this.#errorCode === 'LOCAL_STORAGE_ERROR'
      )
        state = 'attention';
      if (resetJob) state = this.#resetTask ? 'syncing' : 'reset_required';
      else if (this.#resetTask) state = 'configuring';
    }
    return SyncStatusSchema.parse({
      protocol: 'wevir-sync/1',
      artifactRevision: 1,
      ...(vault && {
        binding: {
          vaultId: vault.vaultId,
          deviceId: vault.deviceId,
          enabled: vault.enabled,
          revision: vault.revision,
          categories: vault.categories,
          projectIds: vault.projectIds,
        },
        includeHistory: storage.sync.includeHistory(vault.vaultId),
        projects: storage.sync.projects(vault.vaultId).map((value) => ({
          ...value,
          displayName:
            storage.sync.projectName(vault.vaultId, value.projectId) ??
            (value.workspaceId && storage.workspaces.get(value.workspaceId)?.displayName) ??
            value.projectId,
        })),
      }),
      ...counts,
      ...(fileIssues.length && { fileIssues }),
      ...(vault && {
        currentDeviceId: client.entitlements?.identity.deviceId,
        outbox: storage.sync
          .commits(vault.vaultId)
          .slice(0, 100)
          .map((commit) => {
            const batch = JSON.parse(commit.body) as { operations: unknown[] };
            const operation = validateOperation(batch.operations[0]);
            return {
              commitId: commit.commitId,
              deviceId: operation.deviceId,
              outcome:
                commit.outcome === 'rejected'
                  ? 'rejected'
                  : commit.attempts > 0
                    ? 'uncertain'
                    : 'ready',
              ...(commit.errorCode && { errorCode: commit.errorCode }),
              operations: batch.operations.length,
            };
          }),
      }),
      ...(resetJob && {
        reset: {
          jobId: resetJob.jobId,
          phase: application?.state ?? resetJob.state,
          busy: this.#resetTask !== undefined,
          pendingBefore: resetJob.pendingBefore,
          ...storage.sync.bootstrapCounts(resetJob.vaultId, resetJob.jobId),
          ...((this.#errorCode ?? application?.errorCode ?? resetJob.errorCode) && {
            errorCode: this.#errorCode ?? application?.errorCode ?? resetJob.errorCode,
          }),
        },
      }),
      state: state ?? 'disabled',
      ...((this.#errorCode ?? transport?.errorCode) && {
        errorCode: this.#errorCode ?? transport?.errorCode,
      }),
      ...(transport?.lastSyncAt && { lastSyncAt: transport.lastSyncAt }),
    });
  }

  async configure(params: SyncConfigureParams): Promise<SyncStatus> {
    if (this.#configuring) throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const current = this.#options.storage.sync.activeVault();
    if (
      params.enabled &&
      current &&
      this.#options.storage.sync.activeBootstrapJob(current.vaultId)
    ) {
      const identity = this.#options.client.entitlements;
      const bindings = this.#options.storage.sync.projects(current.vaultId);
      if (
        current.enabled ||
        this.#closed ||
        this.#options.client.changingIdentity ||
        this.#options.client.requiresLogin ||
        !this.#options.client.signedIn ||
        identity?.subscriptionState !== 'active' ||
        identity.identity.userId !== current.accountId ||
        identity.identity.deviceId !== current.deviceId ||
        params.expectedRevision !== current.revision ||
        params.categories.length !== current.categories.length ||
        new Set(params.categories).size !== current.categories.length ||
        params.categories.some((category) => !current.categories.includes(category)) ||
        params.projects.length !== current.projectIds.length ||
        new Set(params.projects.map((project) => project.projectId)).size !==
          current.projectIds.length ||
        params.projects.some(
          (project) =>
            !current.projectIds.includes(project.projectId ?? '') ||
            !bindings.some(
              (binding) =>
                binding.projectId === project.projectId &&
                binding.workspaceId === project.workspaceId,
            ),
        ) ||
        !!params.includeHistory !== this.#options.storage.sync.includeHistory(current.vaultId)
      )
        throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
      const job = this.#options.storage.sync.activeBootstrapJob(current.vaultId);
      if (!job) throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
      this.#options.storage.transaction(() => {
        this.#options.storage.sync.setScopes(current.vaultId, { ...current, enabled: true });
        this.#options.storage.sync.reconsentBootstrap(current.vaultId, job.jobId, current.revision);
      });
      return this.status();
    }
    this.#configuring = true;
    this.#configurationDone = new Promise((resolve) => {
      this.#finishConfiguration = resolve;
    });
    try {
      this.stop();
      await this.#running?.catch(() => {});
      await this.#catalog.drain();
      this.#errorCode = undefined;
      const { storage, client } = this.#options;
      let vault = storage.sync.activeVault();
      try {
        if (!params.enabled) {
          if (vault) {
            this.#capture.suspend(vault, vault.projectIds);
            storage.sync.setScopes(vault.vaultId, { ...vault, enabled: false });
            storage.sync.setVaultTransport(vault.vaultId, {
              ...storage.sync.vaultTransport(vault.vaultId),
              state: 'disabled',
              errorCode: undefined,
              retryAt: 0,
            });
            if (client.signedIn && !client.requiresLogin) {
              const result = await client.json(
                'scopesUpdated',
                'PUT',
                '/api/wevir/sync/v1/scopes',
                {
                  expectedRevision: vault.revision,
                  enabled: false,
                  categories: vault.categories,
                  projectIds: vault.projectIds,
                },
              );
              storage.sync.setScopes(vault.vaultId, result);
            }
          }
          return this.status();
        }
        if (
          !client.signedIn ||
          client.requiresLogin ||
          client.changingIdentity ||
          client.enrollment
        )
          throw new ZuvRequestError('AUTH_REQUIRED');
        await this.#refresh();
        const entitlements = client.entitlements;
        if (
          entitlements?.subscriptionState !== 'active' ||
          !entitlements.deviceScopes.includes('sync')
        )
          throw new ZuvRequestError('SUBSCRIPTION_REQUIRED');
        if (
          !params.categories.length ||
          new Set(params.categories).size !== params.categories.length ||
          new Set(params.projects.map((value) => value.workspaceId)).size !== params.projects.length
        )
          throw new ZuvRequestError('INVALID_REQUEST');
        if (
          (params.categories.includes('session') || params.categories.includes('event-segment')) &&
          !['project', 'session', 'event-segment'].every((value) =>
            params.categories.includes(value as (typeof params.categories)[number]),
          )
        )
          throw new ZuvRequestError('INVALID_REQUEST');
        if (
          params.categories.some((value) => ['rule', 'skill-bundle'].includes(value)) &&
          !params.categories.includes('artifact')
        )
          throw new ZuvRequestError('INVALID_REQUEST');
        const explicitProjects = params.projects.flatMap((project) =>
          project.projectId ? [project.projectId] : [],
        );
        if (new Set(explicitProjects).size !== explicitProjects.length)
          throw new ZuvRequestError('INVALID_REQUEST');
        if (params.projects.length && !params.categories.includes('project'))
          throw new ZuvRequestError('INVALID_REQUEST');
        for (const project of params.projects)
          if (!storage.workspaces.get(project.workspaceId))
            throw new ZuvRequestError('INVALID_REQUEST');
        if (
          vault &&
          params.expectedRevision !== undefined &&
          params.expectedRevision !== vault.revision
        )
          throw new ZuvRequestError('REVISION_CONFLICT');
        if (vault) storage.sync.setScopes(vault.vaultId, { ...vault, enabled: false });
        const opened = await client.json('vaultOpened', 'POST', '/api/wevir/sync/v1/vaults/open', {
          protocol: 'wevir-sync/1',
          consent: true,
        });
        storage.transaction(() =>
          storage.sync.bindVault({
            vaultId: opened.vaultId,
            accountId: entitlements.identity.userId,
            deviceId: opened.deviceId,
            originHostId: opened.originHostId,
            appliedCursor: opened.cursor,
          }),
        );
        vault = storage.sync.getVault(opened.vaultId) as SyncVaultRecord;
        storage.sync.setVaultTransport(vault.vaultId, {
          keyEpoch: opened.keyEpoch,
          state: 'configuring',
          retryAt: 0,
        });
        const projects = params.projects.map((project) => ({
          projectId:
            project.projectId ??
            storage.sync
              .projects(opened.vaultId)
              .find((value) => value.workspaceId === project.workspaceId)?.projectId ??
            newId('spr'),
          workspaceId: project.workspaceId,
        }));
        this.#capture.suspend(
          vault,
          vault.projectIds.filter(
            (id) =>
              !params.categories.includes('event-segment') ||
              !projects.some((project) => project.projectId === id),
          ),
        );
        for (const project of projects)
          storage.sync.bindProject(vault.vaultId, project.projectId, project.workspaceId);
        await client.getEntitlements();
        await this.#keys.unlock(vault.vaultId, opened.keyEpoch, new AbortController().signal);
        const selected = await client.json('scopesUpdated', 'PUT', '/api/wevir/sync/v1/scopes', {
          expectedRevision: vault.revision,
          enabled: true,
          categories: params.categories,
          projectIds: projects.map((value) => value.projectId),
        });
        const backfill =
          params.includeHistory === true && !storage.sync.includeHistory(vault.vaultId);
        const vaultId = vault.vaultId;
        const changed =
          vault.categories.length !== selected.categories.length ||
          vault.categories.some(
            (value) => !selected.categories.includes(value as (typeof selected.categories)[number]),
          ) ||
          vault.projectIds.length !== selected.projectIds.length ||
          vault.projectIds.some((value) => !selected.projectIds.includes(value));
        const previousCursor = vault.appliedCursor;
        storage.transaction(() => {
          if (changed) storage.sync.restartPull(vaultId, previousCursor, opened.cursor);
          storage.sync.setScopes(vaultId, selected);
          for (const project of projects)
            if (
              params.projects.some(
                (input) => input.workspaceId === project.workspaceId && input.projectId,
              )
            )
              this.#capture.adoptProject(vaultId, project.projectId, project.workspaceId);
          storage.sync.setIncludeHistory(vaultId, params.includeHistory === true);
          storage.sync.setScopeInitialized(vaultId, false);
          storage.sync.setHistoryBackfillPending(vaultId, backfill);
        });
        await client.getEntitlements();
        const enabled = this.#consented();
        if (!enabled) throw new ZuvRequestError('AUTH_REQUIRED');
        this.#engine.restart();
        this.#capture.initialize(params.includeHistory === true, backfill);
        await this.#scan(enabled, true, params.includeHistory === true);
        storage.transaction(() => {
          storage.sync.setScopeInitialized(vaultId, true);
          storage.sync.setHistoryBackfillPending(vaultId, false);
        });
        this.#initialized = true;
        storage.sync.setVaultTransport(vault.vaultId, {
          keyEpoch: opened.keyEpoch,
          state: 'pending',
          retryAt: 0,
        });
        this.#schedule(0);
        return this.status();
      } catch (error) {
        this.#errorCode = error instanceof ZuvRequestError ? error.code : 'LOCAL_STORAGE_ERROR';
        if (vault)
          storage.sync.setVaultTransport(vault.vaultId, {
            ...storage.sync.vaultTransport(vault.vaultId),
            state: this.#errorCode === 'RECOVERY_REQUIRED' ? 'approval_required' : 'paused',
            errorCode: this.#errorCode,
            retryAt: 0,
          });
        throw this.#failure(error);
      }
    } finally {
      this.#configuring = false;
      this.#finishConfiguration?.();
      this.#configurationDone = undefined;
      this.#finishConfiguration = undefined;
    }
  }

  async retry(): Promise<SyncStatus> {
    const vault = this.#options.storage.sync.activeVault();
    const resetJob = vault && this.#options.storage.sync.activeBootstrapJob(vault.vaultId);
    if (resetJob)
      return this.#options.storage.sync.bootstrapApplication(resetJob.vaultId, resetJob.jobId)
        ? this.resetApply(resetJob.jobId)
        : this.resetPrepare();
    await this.#running?.catch(() => {});
    if (
      vault &&
      ['reset_required', 'revoked'].includes(
        this.#options.storage.sync.vaultTransport(vault.vaultId).state,
      )
    )
      return this.status();
    this.#errorCode = undefined;
    this.#dirty = true;
    this.#scanAfter = 0;
    if (vault) {
      const { storage } = this.#options;
      storage.transaction(() => {
        const current = storage.sync.vaultTransport(vault.vaultId);
        storage.sync.setVaultTransport(vault.vaultId, {
          ...current,
          state: 'pending',
          errorCode: undefined,
          retryAt: 0,
        });
        storage.db
          .prepare('UPDATE sync_blobs SET retry_at = 0 WHERE vault_id = ?')
          .run(vault.vaultId);
        storage.db
          .prepare('UPDATE sync_commits SET retry_at = 0 WHERE vault_id = ?')
          .run(vault.vaultId);
      });
    }
    this.#engine.restart();
    await this.flush();
    return this.status();
  }

  async recoverOutbox(params: MethodParams<'sync.recoverOutbox'>): Promise<SyncStatus> {
    if (this.#closed || this.#configuring)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const vault = this.#options.storage.sync.activeVault();
    const job = vault && this.#options.storage.sync.activeBootstrapJob(vault.vaultId);
    if (
      job &&
      this.#options.storage.sync.bootstrapApplication(job.vaultId, job.jobId)?.state !==
        'acknowledged'
    )
      throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    this.#configuring = true;
    this.#configurationDone = new Promise((resolve) => {
      this.#finishConfiguration = resolve;
    });
    this.stop();
    const abort = new AbortController();
    this.#resetAbort = abort;
    try {
      await this.#running?.catch(() => {});
      await this.#catalog.drain();
      const storage = this.#options.storage;
      storage.transaction(() =>
        this.#capture.preserveForRemoval(
          vault ? storage.sync.captures(vault.vaultId).map((value) => value.localSessionId) : [],
        ),
      );
      await new SyncOutboxRecovery({ ...this.#options, engine: this.#engine }).recover(
        params,
        abort.signal,
      );
      this.#initialized = false;
      this.#errorCode = undefined;
      return this.status();
    } catch (error) {
      throw this.#failure(error);
    } finally {
      this.#resetAbort = undefined;
      this.#configuring = false;
      this.#finishConfiguration?.();
      this.#configurationDone = undefined;
      this.#finishConfiguration = undefined;
      if (!this.#closed && !this.#options.client.changingIdentity) {
        this.#engine.restart();
        this.#schedule(0);
      }
    }
  }

  resetPrepare(restart = false): SyncStatus {
    return this.#launchReset(undefined, restart);
  }
  resetApply(jobId: string): SyncStatus {
    return this.#launchReset(jobId, false);
  }
  async resetCancel(jobId: string): Promise<SyncStatus> {
    const { storage } = this.#options;
    const vault = storage.sync.activeVault();
    const job = vault && storage.sync.activeBootstrapJob(vault.vaultId);
    if (!job || job.jobId !== jobId) throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const task = this.#resetTask;
    this.#resetAbort?.abort();
    await task;
    if (this.#resetTask && this.#resetTask !== task)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const application = storage.sync.bootstrapApplication(job.vaultId, jobId);
    storage.transaction(() => storage.sync.closeBootstrapJob(job.vaultId, jobId));
    if (application) {
      this.#errorCode = 'RESET_REQUIRED';
      storage.sync.setVaultTransport(job.vaultId, {
        ...storage.sync.vaultTransport(job.vaultId),
        state: 'reset_required',
        errorCode: 'RESET_REQUIRED',
        retryAt: 0,
      });
    } else if (this.#options.client.entitlements?.syncState === 'ready') {
      this.#errorCode = undefined;
      storage.sync.setVaultTransport(job.vaultId, {
        ...storage.sync.vaultTransport(job.vaultId),
        state: 'pending',
        errorCode: undefined,
        retryAt: 0,
      });
    }
    return this.status();
  }
  #launchReset(jobId: string | undefined, restart: boolean): SyncStatus {
    if (this.#recoveryIoAbort)
      throw new HostError('RESOURCE_IN_USE', 'Recovery operation in progress', { sessionIds: [] });
    if (this.#closed || this.#configuring)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const vault = this.#consented();
    if (!vault) throw this.#failure(new ZuvRequestError('SCOPE_DISABLED'));
    const { storage } = this.#options;
    const current = storage.sync.activeBootstrapJob(vault.vaultId);
    if (jobId && current?.jobId !== jobId)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    this.#configuring = true;
    this.#configurationDone = new Promise((resolve) => {
      this.#finishConfiguration = resolve;
    });
    this.stop();
    this.#resetAbort = new AbortController();
    const signal = this.#resetAbort.signal;
    this.#errorCode = undefined;
    this.#resetTask = (async () => {
      await this.#running?.catch(() => {});
      await this.#catalog.drain();
      signal.throwIfAborted();
      await this.#refresh();
      signal.throwIfAborted();
      const selected = this.#consented();
      if (!selected || selected.vaultId !== vault.vaultId || selected.revision !== vault.revision)
        throw new ZuvRequestError('SCOPE_DISABLED');
      await this.#scan(selected, false, false);
      this.#capture.prepare();
      if (!jobId) {
        if (restart && current)
          storage.transaction(() => storage.sync.closeBootstrapJob(vault.vaultId, current.jobId));
        if (!current || restart) await this.#bootstrap.prepare(signal);
        else if (current.state !== 'staged') await this.#bootstrap.resume(current.jobId, signal);
      } else {
        await this.#bootstrap.apply(jobId, signal, (op, record, context) =>
          this.#materials.prepareApply(op, record, context),
        );
        await this.#bootstrap.acknowledge(jobId, signal);
        await this.#bootstrap.enable(jobId, signal);
        await this.#engine.reconcileReset(jobId, signal);
        await this.#bootstrap.reconcile(jobId, signal, (op, record, context) =>
          this.#materials.prepareApply(op, record, context),
        );
        this.#bootstrap.finish(jobId, signal);
        storage.sync.setVaultTransport(vault.vaultId, {
          ...storage.sync.vaultTransport(vault.vaultId),
          state: 'pending',
          errorCode: undefined,
          retryAt: 0,
        });
      }
    })()
      .catch((error) => {
        this.#errorCode =
          error instanceof ZuvRequestError
            ? error.code
            : signal.aborted
              ? 'SCOPE_DISABLED'
              : 'LOCAL_STORAGE_ERROR';
        storage.sync.setVaultTransport(vault.vaultId, {
          ...storage.sync.vaultTransport(vault.vaultId),
          state: 'reset_required',
          errorCode: this.#errorCode,
          retryAt: 0,
        });
      })
      .finally(() => {
        this.#materials.notify();
        this.#resetTask = undefined;
        this.#resetAbort = undefined;
        this.#configuring = false;
        this.#finishConfiguration?.();
        this.#configurationDone = undefined;
        this.#finishConfiguration = undefined;
        if (!this.#closed && !this.#options.client.changingIdentity) {
          this.#engine.restart();
          this.#schedule(0);
        }
      });
    return this.status();
  }

  flush(): Promise<void> {
    this.#running ??= this.#flush().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async projectCatalog(enable = false) {
    if (this.#configuring || this.#closed)
      throw this.#failure(new ZuvRequestError('SCOPE_DISABLED'));
    const active = this.#options.storage.sync.activeVault();
    if (active && this.#options.storage.sync.activeBootstrapJob(active.vaultId))
      throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    if (enable && !this.#consented()?.categories.includes('project'))
      throw this.#failure(new ZuvRequestError('SCOPE_DISABLED'));
    await this.#running?.catch(() => {});
    if (this.#configuring || this.#closed)
      throw this.#failure(new ZuvRequestError('SCOPE_DISABLED'));
    try {
      return await this.#catalog.fetch();
    } catch (error) {
      throw this.#failure(error);
    } finally {
      if (!this.#closed && !this.#configuring) this.#schedule(0);
    }
  }

  async workspaceCapture(params: MethodParams<'sync.workspaceCapture'>) {
    try {
      return await this.workspaces.capture(params);
    } catch (error) {
      throw this.#failure(error);
    } finally {
      if (!this.#closed) this.#schedule(0);
    }
  }

  workspaceSnapshots(sessionId: SessionId) {
    try {
      return this.workspaces.list(sessionId);
    } catch (error) {
      throw this.#failure(error);
    }
  }

  async workspaceRestore(params: MethodParams<'sync.workspaceRestore'>) {
    try {
      return await this.workspaces.restore(params);
    } catch (error) {
      throw this.#failure(error);
    }
  }

  resolveProject(params: MethodParams<'sync.resolveProject'>) {
    try {
      const vault = this.#consented();
      if (
        this.#closed ||
        this.#configuring ||
        !vault?.categories.includes('project') ||
        !vault.projectIds.includes(params.projectId)
      )
        throw new ZuvRequestError('SCOPE_DISABLED');
      if (this.#options.storage.sync.activeBootstrapJob(vault.vaultId))
        throw new ZuvRequestError('RECOVERY_REQUIRED');
      const { storage } = this.#options;
      this.#capture.projects();
      const result = storage.transaction(() => {
        const heads = storage.sync.heads(vault.vaultId, params.projectId);
        const entity = storage.sync.entity(vault.vaultId, params.projectId);
        if (
          heads.length !== params.expectedHeads.length ||
          heads.some((head) => !params.expectedHeads.includes(head)) ||
          !entity?.revision ||
          !heads.includes(entity.revision)
        )
          throw new ZuvRequestError('REVISION_CONFLICT');
        if (!heads.includes(params.selectedOpId)) throw new ZuvRequestError('INVALID_REQUEST');
        const selected = storage.sync.getOperation(vault.vaultId, params.selectedOpId);
        const record = packRecord.safeParse(selected?.record);
        const content = SyncProjectContentSchema.safeParse(
          record.success ? record.data.content : undefined,
        );
        if (
          !record.success ||
          !content.success ||
          selected?.entityType !== 'project' ||
          selected.entityId !== params.projectId ||
          record.data.projectId !== params.projectId ||
          content.data.projectId !== params.projectId ||
          !(
            ['applied', 'committed'].includes(selected.state) ||
            (selected.direction === 'outbox' && ['queued', 'pending'].includes(selected.state))
          )
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        const opId = new SyncQueue(storage).enqueue({
          vaultId: vault.vaultId,
          entityId: params.projectId,
          entityType: 'project',
          projectId: params.projectId,
          localKey: entity.localKey,
          kind: 'resolve',
          parents: heads,
          content: content.data,
        });
        if (!opId) throw new ZuvRequestError('SCOPE_DISABLED');
        storage.sync.setProjectName(vault.vaultId, params.projectId, content.data.displayName);
        return { opId };
      });
      this.#schedule(0);
      return result;
    } catch (error) {
      throw this.#failure(error);
    }
  }
  memoryConflicts(after?: string) {
    try {
      return this.#memoryConflicts.list(after);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  settingsConflicts(after?: string) {
    try {
      return this.#settingsConflicts.list(after);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  bundleVaults() {
    return this.#bundles.vaults();
  }
  bundleList(vaultId: string, after?: string) {
    try {
      return this.#bundles.list(vaultId, after);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  bundlePreview(vaultId: string, entityId: string, fileOffset?: number, opId?: string) {
    return this.#bundles.preview(vaultId, entityId, fileOffset, opId).catch((error) => {
      throw this.#failure(error);
    });
  }
  bundleTargets(vaultId: string, entityId: string) {
    return this.#bundles.targets(vaultId, entityId).catch((error) => {
      throw this.#failure(error);
    });
  }
  bundleVersions(vaultId: string, entityId: string, after?: string) {
    try {
      return this.#bundles.versions(vaultId, entityId, after);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  keepLocalBundle(input: MethodParams<'sync.keepLocalBundle'>) {
    return this.#bundleOperation(input.vaultId, input.entityId, (signal) =>
      this.#bundles.keepLocal(input, signal),
    );
  }
  bundleFile(input: MethodParams<'sync.bundleFile'>) {
    return this.#bundles.file(input).catch((error) => {
      throw this.#failure(error);
    });
  }
  applyBundle(input: MethodParams<'sync.applyBundle'>) {
    return this.#bundleOperation(input.vaultId, input.entityId, (signal) =>
      this.#bundles.apply(input, signal),
    );
  }
  editBundleFile(input: MethodParams<'sync.editBundleFile'>) {
    return this.#bundleOperation(input.vaultId, input.entityId, (signal) =>
      this.#bundles.edit(input, signal),
    );
  }
  retryBundle(input: MethodParams<'sync.retryBundle'>) {
    return this.#bundleOperation(input.vaultId, input.entityId, (signal) =>
      this.#bundles.retry(input.vaultId, input.entityId, input.opId, signal),
    );
  }
  async cancelBundle(vaultId: string, entityId: string) {
    if (this.#bundleEntity !== entityId || this.#bundleVault !== vaultId)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    this.#bundleAbort?.abort('APPLICATION_PAUSED');
    await this.#configurationDone;
    return { cancelled: true as const };
  }
  async #bundleOperation<T>(
    vaultId: string,
    entityId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed || this.#configuring)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    if (this.#options.storage.sync.activeBootstrapJob(vaultId))
      throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    this.#configuring = true;
    this.#configurationDone = new Promise((resolve) => {
      this.#finishConfiguration = resolve;
    });
    this.stop();
    const abort = new AbortController();
    this.#bundleAbort = abort;
    this.#bundleEntity = entityId;
    this.#bundleVault = vaultId;
    try {
      await this.#running?.catch(() => {});
      await this.#catalog.drain();
      return await operation(abort.signal);
    } catch (error) {
      if (abort.signal.reason === 'APPLICATION_PAUSED')
        throw new HostError('SYNC_FAILED', 'APPLICATION_PAUSED', { code: 'APPLICATION_PAUSED' });
      throw this.#failure(abort.signal.aborted ? new ZuvRequestError('SCOPE_DISABLED') : error);
    } finally {
      if (abort.signal.aborted) {
        const app = this.#options.storage.sync.pendingBundleApplication(vaultId, entityId);
        if (app)
          this.#options.storage.transaction(() =>
            this.#options.storage.sync.pauseBundleApplication(vaultId, app.opId, true),
          );
      }
      this.#bundleAbort = undefined;
      this.#bundleEntity = undefined;
      this.#bundleVault = undefined;
      this.#configuring = false;
      this.#finishConfiguration?.();
      this.#finishConfiguration = undefined;
      this.#configurationDone = undefined;
      if (!this.#closed && !this.#options.client.changingIdentity) {
        this.#engine.restart();
        this.#schedule(0);
      }
    }
  }
  previewSettingsMerge(entityId: string) {
    return this.#memoryOperation(() => this.#settingsConflicts.preview(entityId));
  }
  sessionConflicts(after?: string) {
    try {
      return this.#sessionConflicts.list(after);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  previewSessionMerge(entityId: string) {
    try {
      return this.#sessionConflicts.preview(entityId);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  async resolveSession(input: MethodParams<'sync.resolveSession'>) {
    if (this.#closed || this.#configuring)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const vault = this.#consented();
    if (vault && this.#options.storage.sync.activeBootstrapJob(vault.vaultId))
      throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    try {
      const result = await this.#sessionConflicts.resolve(input);
      this.#materials.notify();
      this.#schedule(0);
      return result;
    } catch (error) {
      throw this.#failure(error);
    }
  }
  resolveSettings(input: MethodParams<'sync.resolveSettings'>) {
    return this.#memoryOperation(() => this.#settingsConflicts.resolve(input));
  }
  previewMemoryMerge(entityId: string) {
    return this.#memoryOperation(() => this.#memoryConflicts.preview(entityId));
  }
  resolveMemory(input: MethodParams<'sync.resolveMemory'>) {
    return this.#memoryOperation(() => this.#memoryConflicts.resolve(input));
  }
  async #memoryOperation<T>(operation: () => Promise<T>, allowPendingReset = false): Promise<T> {
    if (this.#closed || this.#configuring)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const active = this.#options.storage.sync.activeVault();
    if (
      !allowPendingReset &&
      active &&
      this.#options.storage.sync.activeBootstrapJob(active.vaultId)
    )
      throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    this.#configuring = true;
    this.#configurationDone = new Promise((resolve) => {
      this.#finishConfiguration = resolve;
    });
    try {
      this.stop();
      await this.#running?.catch(() => {});
      await this.#catalog.drain();
      return await operation();
    } catch (error) {
      throw this.#failure(error);
    } finally {
      this.#configuring = false;
      this.#finishConfiguration?.();
      this.#configurationDone = undefined;
      this.#finishConfiguration = undefined;
      if (!this.#closed && !this.#options.client.changingIdentity) {
        this.#engine.restart();
        this.#schedule(0);
      }
    }
  }

  async devices() {
    try {
      return await this.#options.client.json('devices', 'GET', '/api/wevir/sync/v1/devices');
    } catch (error) {
      throw this.#failure(error);
    }
  }

  #recoveryOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.#memoryOperation(operation, true);
  }
  async #recoveryIo<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    if (this.#closed || this.#configuring || this.#recoveryIoAbort)
      throw new HostError('RESOURCE_IN_USE', 'Recovery operation in progress', { sessionIds: [] });
    const controller = new AbortController();
    this.#recoveryIoAbort = controller;
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      this.#recoveryIoTask = operation(signal);
      return (await this.#recoveryIoTask) as T;
    } catch (error) {
      throw this.#failure(error);
    } finally {
      this.#recoveryIoAbort = undefined;
      this.#recoveryIoTask = undefined;
    }
  }
  cancelRecovery() {
    const cancelled = Boolean(this.#recoveryIoAbort);
    this.#recoveryIoAbort?.abort();
    return { cancelled };
  }
  async workspaceDiscard(restoreId: string) {
    try {
      return await this.workspaces.discard(restoreId);
    } catch (error) {
      throw this.#failure(error);
    }
  }
  importRestorePreview(input: MethodParams<'sync.importRestorePreview'>) {
    return this.#recoveryOperation(() => this.#versionRestore.preview(input));
  }
  importRestore(input: MethodParams<'sync.importRestore'>) {
    return this.#memoryOperation(() => this.#versionRestore.restore(input));
  }

  recoveryRequest(vaultId: string) {
    return this.#recoveryOperation(() => this.#lifecycle.request(vaultId));
  }
  recoveryInfo() {
    return this.#lifecycle.info();
  }
  exportLocal(directory?: string, signal?: AbortSignal) {
    return this.#recoveryIo((token) => this.#portable.exportLocal(directory, token), signal);
  }
  importPrepare(path: string, signal?: AbortSignal) {
    return this.#recoveryIo((token) => this.#portable.importPrepare(path, token), signal);
  }
  importApply(importId: string, signal?: AbortSignal) {
    return this.#recoveryIo((token) => this.#portable.importApply(importId, token), signal);
  }
  importList() {
    return this.#portable.list().catch((error) => {
      throw this.#failure(error);
    });
  }
  importRead(importId: string, after?: number) {
    return this.#portable.read(importId, after).catch((error) => {
      throw this.#failure(error);
    });
  }
  importEntry(importId: string, entryId: string) {
    return this.#portable.entry(importId, entryId).catch((error) => {
      throw this.#failure(error);
    });
  }
  importConversation(importId: string, sessionId: string, afterSeq?: number) {
    return this.#portable.conversation(importId, sessionId, afterSeq).catch((error) => {
      throw this.#failure(error);
    });
  }
  recoveryStatus(vaultId: string, refresh?: boolean) {
    return this.#recoveryOperation(() => this.#lifecycle.status(vaultId, refresh));
  }
  recoveryComplete(vaultId: string, requestId: string) {
    return this.#recoveryOperation(() => this.#lifecycle.complete(vaultId, requestId));
  }
  recoverySnapshot(vaultId: string, jobId?: string, signal?: AbortSignal) {
    return this.#recoveryIo((token) => this.#recoveryFiles.snapshot(vaultId, jobId, token), signal);
  }
  recoveryDownload(input: MethodParams<'sync.recoveryDownload'>, signal?: AbortSignal) {
    return this.#recoveryIo((token) => this.#recoveryFiles.download(input, token), signal);
  }
  unlockKeys(vaultId: string, signal?: AbortSignal) {
    return this.#recoveryIo(async (token) => {
      await this.#options.client.getEntitlements(token);
      return this.#lifecycle.unlock(vaultId, token);
    }, signal);
  }
  deleteCloud(vaultId: string, stepUpId: string) {
    return this.#recoveryOperation(async () => {
      const result = await this.#lifecycle.deleteCloud(vaultId, stepUpId);
      const vault = this.#options.storage.sync.getVault(vaultId);
      if (vault) this.#options.storage.sync.setScopes(vaultId, { ...vault, enabled: false });
      return result;
    });
  }
  detach(vaultId: string) {
    return this.#recoveryOperation(async () => {
      const vault = this.#options.storage.sync.activeVault();
      if (vault?.vaultId !== vaultId) throw new ZuvRequestError('REVISION_CONFLICT');
      this.#options.storage.transaction(() => this.#options.storage.sync.detachVault(vaultId));
      await this.workspaces.collect();
      return { detached: true as const };
    });
  }

  async approveDevice(deviceId: string, parent?: AbortSignal) {
    const vault = this.#options.storage.sync.activeVault();
    if (!vault) throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    return this.#recoveryIo(async (signal) => {
      await this.#options.client.getEntitlements(signal);
      await this.#lifecycle.unlock(vault.vaultId, signal);
      return await this.#options.client.json(
        'approved',
        'POST',
        `/api/wevir/sync/v1/devices/${deviceId}/approve`,
        { keyEpoch: this.#options.client.entitlements?.vault?.keyEpoch },
        { signal },
      );
    }, parent);
  }

  #consented(): SyncVaultRecord | undefined {
    return this.#options.client.entitlements?.subscriptionState === 'active'
      ? this.#localConsent()
      : undefined;
  }
  #localConsent(): SyncVaultRecord | undefined {
    const vault = this.#options.storage.sync.activeVault();
    const identity = this.#options.client.entitlements;
    return vault?.enabled &&
      this.#options.client.signedIn &&
      !this.#options.client.requiresLogin &&
      !this.#options.client.changingIdentity &&
      !this.#options.client.enrollment &&
      identity !== undefined &&
      identity.identity.userId === vault.accountId &&
      identity.identity.deviceId === vault.deviceId
      ? vault
      : undefined;
  }
  async #refresh(): Promise<void> {
    await this.#options.accounts.read('zuv', { refresh: true });
    this.#lastRefresh = Date.now();
  }

  async #scan(vault: SyncVaultRecord, initialize: boolean, includeHistory: boolean): Promise<void> {
    this.#capture.projects();
    await this.#files.recoverWrites(vault);
    if (vault.categories.includes('memory')) this.#watch(this.#options.memoryDir);
    if (vault.categories.includes('memory'))
      this.#watch(join(this.#options.memoryDir, 'global'), false);
    if (vault.categories.includes('memory'))
      this.#watch(
        dirname(this.#options.memoryDir),
        false,
        (name) => name === basename(this.#options.memoryDir),
      );
    for (const project of this.#options.storage.sync.projects(vault.vaultId)) {
      if (!project.workspaceId || !vault.projectIds.includes(project.projectId)) continue;
      const workspace = this.#options.storage.workspaces.get(project.workspaceId);
      if (workspace)
        this.#watch(workspace.rootPath, process.platform !== 'linux', workspaceRequiresTrust);
      if (vault.categories.includes('memory'))
        this.#watch(join(this.#options.memoryDir, 'projects', project.workspaceId), false);
    }
    await this.#files.memory(vault, initialize, includeHistory);
    await this.#artifacts.scan(vault, initialize, includeHistory);
    this.#settings.capture(vault, initialize, includeHistory);
    this.#materials.sessions.scan(initialize, includeHistory);
    await this.#bundles.recover(vault);
    if (vault.categories.some((value) => ['rule', 'skill-bundle', 'artifact'].includes(value)))
      for await (const root of this.#bundles.roots(vault)) {
        this.#watch(root.path);
        await this.#files.bundle(vault, root, initialize, includeHistory);
      }
  }

  async #flush(): Promise<void> {
    const { storage, client } = this.#options;
    try {
      if (this.#configuring || this.#catalog.busy) return;
      const active = storage.sync.activeVault();
      if (active && storage.sync.activeBootstrapJob(active.vaultId)) return;
      if (!client.signedIn || client.requiresLogin || !storage.sync.activeVault()?.enabled) return;
      if (Date.now() - this.#lastRefresh >= 60000) await this.#refresh();
      const vault = this.#consented();
      if (!vault) {
        this.#initialized = false;
        return;
      }
      const transport = storage.sync.vaultTransport(vault.vaultId);
      if (
        ['attention', 'reset_required', 'revoked'].includes(transport.state) ||
        transport.retryAt > Date.now()
      )
        return;
      if (!this.#initialized) {
        const initialized = storage.sync.scopeInitialized(vault.vaultId);
        this.#capture.initialize(
          initialized || storage.sync.includeHistory(vault.vaultId),
          storage.sync.historyBackfillPending(vault.vaultId),
        );
        if (!initialized) await this.#scan(vault, true, storage.sync.includeHistory(vault.vaultId));
        storage.transaction(() => {
          storage.sync.setScopeInitialized(vault.vaultId, true);
          storage.sync.setHistoryBackfillPending(vault.vaultId, false);
        });
        this.#initialized = true;
      }
      await this.#files.recoverWrites(vault);
      if (
        Date.now() >= this.#scanAfter &&
        (this.#dirty || Date.now() - this.#lastFullScan >= 10 * 60 * 1000)
      ) {
        this.#dirty = false;
        try {
          await this.#scan(vault, false, false);
        } catch (error) {
          this.#dirty = true;
          throw error;
        }
        this.#lastFullScan = Date.now();
      } else if (this.#files.hasPendingMemory(vault))
        await this.#files.memory(vault, false, false, true);
      this.#capture.prepare();
      await this.#engine.run();
      this.#errorCode = undefined;
    } catch (error) {
      this.#errorCode = error instanceof ZuvRequestError ? error.code : 'LOCAL_STORAGE_ERROR';
      throw this.#failure(error);
    } finally {
      this.#materials.notify();
    }
  }

  #schedule(delay: number): void {
    clearTimeout(this.#timer);
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      void this.flush()
        .catch(() => {})
        .finally(() => this.#schedule(this.#options.intervalMs ?? 5000));
    }, delay);
    this.#timer.unref?.();
  }
  #failure(error: unknown): HostError<'SYNC_FAILED'> {
    const code = error instanceof ZuvRequestError ? error.code : 'LOCAL_STORAGE_ERROR';
    return new HostError('SYNC_FAILED', code, {
      code,
      ...(error instanceof ZuvRequestError &&
        error.retryAfterMs && { retryAfterMs: error.retryAfterMs }),
    });
  }
}
