import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type MethodParams,
  type SessionId,
  type SharedFile,
  type SyncConfigureParams,
  SyncProjectContentSchema,
  type SyncStatus,
  SyncStatusSchema,
} from '@wevir/protocol';
import { packRecord } from '@wevir/protocol/sync';
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
import { SyncBundles } from './bundles.js';
import { SyncBlobCache } from './cache.js';
import { SyncEventCapture } from './capture.js';
import { SyncProjectCatalog } from './catalog.js';
import { SyncEngine } from './engine.js';
import { type SyncBundleRoot, SyncFilesCapture } from './files-capture.js';
import { SyncVaultKeys } from './keys.js';
import { SyncMaterials } from './materials.js';
import { SyncMemoryConflicts } from './memory-conflicts.js';
import { SyncQueue } from './queue.js';
import { SyncRestoreData } from './restore-data.js';
import { SyncSettings } from './settings.js';
import { SyncSettingsConflicts } from './settings-conflicts.js';
import { SyncSnapshots } from './snapshots.js';

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
  intervalMs?: number;
  onEpisodeChanged?: (change: EpisodeChange) => void;
}

export class SyncService {
  readonly #options: SyncServiceOptions;
  readonly #engine: SyncEngine;
  readonly #materials: SyncMaterials;
  readonly #capture: SyncEventCapture;
  readonly #files: SyncFilesCapture;
  readonly #artifacts: SyncArtifacts;
  readonly #keys: SyncVaultKeys;
  readonly #settings: SyncSettings;
  readonly #catalog: SyncProjectCatalog;
  readonly #bootstrap: SyncBootstrap;
  readonly #memoryConflicts: SyncMemoryConflicts;
  readonly #settingsConflicts: SyncSettingsConflicts;
  readonly #bundles: SyncBundles;
  #bundleAbort: AbortController | undefined;
  #bundleEntity: string | undefined;
  #bundleVault: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  #initialized = false;
  #lastRefresh = 0;
  #errorCode: string | undefined;
  #configuring = false;
  #configurationDone: Promise<void> | undefined;
  #finishConfiguration: (() => void) | undefined;
  #resetTask: Promise<void> | undefined;
  #resetAbort: AbortController | undefined;
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
    this.#capture = new SyncEventCapture({
      storage: options.storage,
      eligible: () => this.#consented(),
    });
    this.#files = new SyncFilesCapture({
      ...options,
      eligible: () => (this.#closed ? undefined : this.#consented()),
    });
    this.#bundles = new SyncBundles({
      ...options,
      userHome: options.userHome ?? homedir(),
      files: this.#files,
      nativeRoots: options.bundleRoots,
      eligible: () => (this.#closed ? undefined : this.#consented()),
    });
    this.#materials = new SyncMaterials({
      ...options,
      settingsSync: this.#settings,
      bundles: this.#bundles,
      eligible: () => this.#consented(),
      nativeSource: (id) => this.#capture.source(id),
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
    const cache = new SyncBlobCache(join(options.home, 'sync/blobs'));
    const snapshots = new SyncSnapshots(options);
    const data = new SyncRestoreData({ ...options, cache, snapshots, keys: this.#keys });
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
  }

  start(): void {
    this.#schedule(0);
  }
  record = (events: Parameters<SyncEventCapture['record']>[0]): void => {
    this.#capture.record(events);
    this.#materials.sessions.metadataChanged([
      ...new Set(
        events
          .filter((event) => event.type === 'session.title_changed')
          .map((event) => event.sessionId),
      ),
    ]);
  };
  recordEpisode = (record: Parameters<SyncMaterials['sessions']['episode']>[0]): void => {
    this.#materials.sessions.episode(record);
  };
  recordSummary = (record: Parameters<SyncMaterials['sessions']['summary']>[0]): void => {
    this.#materials.sessions.summary(record);
  };
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
  };
  beforeMemoryWrite = (path: string, markdown?: string): (() => void) | undefined => {
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
  }
  async suspend(): Promise<void> {
    this.stop();
    await this.#running?.catch(() => {});
    await this.#catalog.drain();
    await this.#configurationDone;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.stop();
    await this.#running?.catch(() => {});
    await this.#catalog.drain();
    await this.#configurationDone;
  }

  status(): SyncStatus {
    const { storage, client } = this.#options;
    const vault = storage.sync.activeVault();
    const transport = vault && storage.sync.vaultTransport(vault.vaultId);
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
      if (counts.quarantined || counts.conflicts || this.#errorCode === 'LOCAL_STORAGE_ERROR')
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
    if (vault && this.#options.storage.sync.activeBootstrapJob(vault.vaultId))
      return this.resetPrepare();
    await this.#running?.catch(() => {});
    this.#errorCode = undefined;
    this.#engine.restart();
    await this.flush();
    return this.status();
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
    if (!application) {
      storage.transaction(() => storage.sync.closeBootstrapJob(job.vaultId, jobId));
      if (this.#options.client.entitlements?.syncState === 'ready') {
        this.#errorCode = undefined;
        storage.sync.setVaultTransport(job.vaultId, {
          ...storage.sync.vaultTransport(job.vaultId),
          state: 'pending',
          errorCode: undefined,
          retryAt: 0,
        });
      }
    }
    return this.status();
  }
  #launchReset(jobId: string | undefined, restart: boolean): SyncStatus {
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
    if (enable && !this.#consented()?.categories.includes('project')) {
      const { storage } = this.#options;
      const current = storage.sync.activeVault();
      await this.configure({
        enabled: true,
        categories: current?.enabled
          ? ([...new Set([...current.categories, 'project'])] as SyncConfigureParams['categories'])
          : ['project'],
        projects: current?.enabled
          ? storage.sync
              .projects(current.vaultId)
              .filter((value) => value.workspaceId && current.projectIds.includes(value.projectId))
              .map((value) => ({
                projectId: value.projectId,
                workspaceId:
                  value.workspaceId as SyncConfigureParams['projects'][number]['workspaceId'],
              }))
          : [],
        includeHistory: current?.enabled ? storage.sync.includeHistory(current.vaultId) : false,
        ...(current && { expectedRevision: current.revision }),
      });
    }
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
    this.#bundleAbort?.abort();
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
  resolveSettings(input: MethodParams<'sync.resolveSettings'>) {
    return this.#memoryOperation(() => this.#settingsConflicts.resolve(input));
  }
  previewMemoryMerge(entityId: string) {
    return this.#memoryOperation(() => this.#memoryConflicts.preview(entityId));
  }
  resolveMemory(input: MethodParams<'sync.resolveMemory'>) {
    return this.#memoryOperation(() => this.#memoryConflicts.resolve(input));
  }
  async #memoryOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#configuring)
      throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
    const active = this.#options.storage.sync.activeVault();
    if (active && this.#options.storage.sync.activeBootstrapJob(active.vaultId))
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

  async approveDevice(deviceId: string) {
    const vault = this.#options.storage.sync.activeVault();
    if (!vault) throw this.#failure(new ZuvRequestError('RECOVERY_REQUIRED'));
    try {
      return await this.#options.client.json(
        'approved',
        'POST',
        `/api/wevir/sync/v1/devices/${deviceId}/approve`,
        { keyEpoch: this.#options.storage.sync.vaultTransport(vault.vaultId).keyEpoch },
      );
    } catch (error) {
      throw this.#failure(error);
    }
  }

  #consented(): SyncVaultRecord | undefined {
    const vault = this.#options.storage.sync.activeVault();
    const identity = this.#options.client.entitlements;
    return vault?.enabled &&
      this.#options.client.signedIn &&
      !this.#options.client.requiresLogin &&
      !this.#options.client.changingIdentity &&
      !this.#options.client.enrollment &&
      identity?.subscriptionState === 'active' &&
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
    await this.#files.memory(vault, initialize, includeHistory);
    await this.#artifacts.scan(vault, initialize, includeHistory);
    this.#settings.capture(vault, initialize, includeHistory);
    this.#materials.sessions.scan(initialize, includeHistory);
    await this.#bundles.recover(vault);
    if (vault.categories.some((value) => ['rule', 'skill-bundle', 'artifact'].includes(value)))
      for await (const root of this.#bundles.roots(vault))
        await this.#files.bundle(vault, root, initialize, includeHistory);
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
      await this.#scan(vault, false, false);
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
