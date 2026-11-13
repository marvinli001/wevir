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
import { SyncBlobCache } from './cache.js';
import { SyncEventCapture } from './capture.js';
import { SyncProjectCatalog } from './catalog.js';
import { SyncEngine } from './engine.js';
import { type SyncBundleRoot, SyncFilesCapture } from './files-capture.js';
import { SyncVaultKeys } from './keys.js';
import { SyncMaterials } from './materials.js';
import { SyncQueue } from './queue.js';
import { SyncRestoreData } from './restore-data.js';
import { SyncSettings } from './settings.js';
import { SyncSnapshots } from './snapshots.js';

export interface SyncServiceOptions {
  storage: Storage;
  events: EventStore;
  secrets: SecretStore;
  client: ZuvClient;
  accounts: ZuvAccounts;
  home: string;
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
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  #initialized = false;
  #lastRefresh = 0;
  #errorCode: string | undefined;
  #configuring = false;
  #configurationDone: Promise<void> | undefined;
  #finishConfiguration: (() => void) | undefined;
  constructor(options: SyncServiceOptions) {
    this.#options = options;
    this.#settings = new SyncSettings(options);
    this.#keys = new SyncVaultKeys({
      client: options.client,
      secrets: options.secrets,
      onSecret: options.onSecret,
    });
    this.#capture = new SyncEventCapture({
      storage: options.storage,
      eligible: () => this.#consented(),
    });
    this.#materials = new SyncMaterials({
      ...options,
      settingsSync: this.#settings,
      eligible: () => this.#consented(),
      nativeSource: (id) => this.#capture.source(id),
    });
    this.#files = new SyncFilesCapture(options);
    this.#artifacts = new SyncArtifacts({
      ...options,
      files: this.#files,
      eligible: () => this.#consented(),
      source: (id) => this.#capture.source(id),
    });
    const cache = new SyncBlobCache(join(options.home, 'sync/blobs'));
    const snapshots = new SyncSnapshots(options);
    this.#catalog = new SyncProjectCatalog({
      snapshots,
      data: new SyncRestoreData({ ...options, cache, snapshots, keys: this.#keys }),
      eligible: () => this.#consented(),
    });
    this.#engine = new SyncEngine({
      storage: options.storage,
      client: options.client,
      cache,
      key: (vaultId, epoch, signal) => this.#keys.unlock(vaultId, epoch, signal),
      prepareApply: (op, record) => this.#materials.prepareApply(op, record),
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
      for (const root of await this.#options.bundleRoots(vault))
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
    let state: SyncStatus['state'] = !vault?.enabled
      ? keys?.keyState === 'approval-required'
        ? 'approval_required'
        : 'disabled'
      : (transport?.state as SyncStatus['state']);
    if (vault?.enabled) {
      if (this.#catalog.busy) state = 'syncing';
      if (
        client.entitlements?.subscriptionState !== 'active' ||
        client.entitlements.syncState === 'paused'
      )
        state = 'paused';
      if (counts.quarantined || counts.conflicts || this.#errorCode === 'LOCAL_STORAGE_ERROR')
        state = 'attention';
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
      state: state ?? 'disabled',
      ...((this.#errorCode ?? transport?.errorCode) && {
        errorCode: this.#errorCode ?? transport?.errorCode,
      }),
      ...(transport?.lastSyncAt && { lastSyncAt: transport.lastSyncAt }),
    });
  }

  async configure(params: SyncConfigureParams): Promise<SyncStatus> {
    if (this.#configuring) throw this.#failure(new ZuvRequestError('REVISION_CONFLICT'));
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
    await this.#running?.catch(() => {});
    this.#errorCode = undefined;
    this.#engine.restart();
    await this.flush();
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
    if (vault.categories.some((value) => ['rule', 'skill-bundle', 'artifact'].includes(value)))
      for (const root of await this.#options.bundleRoots(vault))
        await this.#files.bundle(vault, root, initialize, includeHistory);
  }

  async #flush(): Promise<void> {
    const { storage, client } = this.#options;
    try {
      if (this.#configuring || this.#catalog.busy) return;
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
