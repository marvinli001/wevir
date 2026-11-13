import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import {
  type EntityType,
  jcs,
  matchRecord,
  packRecord,
  schemas,
  validateOperation,
} from '@wevir/protocol/sync';
import type {
  Storage,
  SyncBootstrapEntry,
  SyncBootstrapJob,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { eventDigest, sha256 } from './crypto.js';
import type { SyncRestoreData } from './restore-data.js';
import type { SyncSnapshots } from './snapshots.js';

interface BootstrapOptions {
  storage: Storage;
  client: ZuvClient;
  snapshots: SyncSnapshots;
  data: SyncRestoreData;
  home: string;
  eligible: () => SyncVaultRecord | undefined;
}
export class SyncBootstrap {
  readonly #options: BootstrapOptions;
  constructor(options: BootstrapOptions) {
    this.#options = options;
  }

  async prepare(signal: AbortSignal) {
    const vault = this.#vault();
    const job: SyncBootstrapJob = {
      vaultId: vault.vaultId,
      jobId: newId('srj'),
      accountId: vault.accountId,
      deviceId: vault.deviceId,
      hostId: vault.originHostId,
      origin: this.#options.client.transport.origin,
      scopeRevision: vault.revision,
      categories: [...vault.categories],
      projectIds: [...vault.projectIds],
      fromCursor: vault.appliedCursor,
      pendingBefore: this.#options.storage.sync.counts(vault.vaultId).pending,
      state: 'creating',
    };
    this.#options.storage.transaction(() => this.#options.storage.sync.putBootstrapJob(job));
    return this.#stage(job, vault, signal, true);
  }
  async resume(jobId: string, signal: AbortSignal) {
    const vault = this.#vault();
    const job = this.#options.storage.sync.bootstrapJob(vault.vaultId, jobId);
    if (!job) throw new ZuvRequestError('RECOVERY_REQUIRED');
    this.#guard(job, signal);
    return this.#stage(job, vault, signal, false);
  }
  status(jobId: string) {
    const vault = this.#vault();
    const job = this.#options.storage.sync.bootstrapJob(vault.vaultId, jobId);
    if (!job) throw new ZuvRequestError('RECOVERY_REQUIRED');
    return { job, ...this.#options.storage.sync.bootstrapCounts(vault.vaultId, jobId) };
  }
  jobs() {
    const vault = this.#vault();
    return this.#options.storage.sync.bootstrapJobs(vault.vaultId);
  }
  async *records(jobId: string, signal: AbortSignal) {
    const { job } = this.status(jobId);
    this.#guard(job, signal);
    if (job.state !== 'staged') throw new ZuvRequestError('RECOVERY_REQUIRED');
    await this.#verifyMetadata(job);
    for (const entry of this.#entries(job, true)) {
      this.#guard(job, signal);
      if (!entry.selected) continue;
      yield this.#record(entry);
    }
  }
  async installRoots(jobId: string, signal: AbortSignal): Promise<number> {
    const { job } = this.status(jobId);
    if (job.state !== 'staged') throw new ZuvRequestError('RECOVERY_REQUIRED');
    this.#guard(job, signal);
    await this.#verifyMetadata(job);
    const boundary = await this.#options.snapshots.historyRoots(jobId);
    const selected = new Set<string>();
    for (const entry of this.#entries(job)) if (entry.selected) selected.add(entry.entityId);
    const roots = boundary.roots.filter((root) => selected.has(root.entityId));
    this.#guard(job, signal);
    this.#options.storage.transaction(() => {
      this.#options.storage.sync.putSnapshotProof(job.vaultId, jobId, boundary.exported.snapshot);
      for (const root of roots)
        this.#options.storage.sync.putSnapshotRoot(job.vaultId, jobId, root.entityId, root.opId);
    });
    return roots.length;
  }

  async #stage(
    job: SyncBootstrapJob,
    vault: SyncVaultRecord,
    signal: AbortSignal,
    create: boolean,
  ) {
    const { storage, snapshots, data } = this.#options;
    try {
      this.#guard(job, signal);
      if (create) await snapshots.prepare(vault, signal, undefined, job.jobId);
      else {
        try {
          await snapshots.describe(job.jobId);
        } catch (error) {
          if (!(error instanceof ZuvRequestError) || error.code !== 'RECOVERY_REQUIRED')
            throw error;
          await snapshots.resume(job.jobId, vault, signal);
        }
      }
      this.#state(job, 'metadata');
      let position = 0;
      for await (const { operation, recordManifest } of snapshots.entries(job.jobId)) {
        this.#guard(job, signal);
        const selected =
          job.categories.includes(operation.entityType) &&
          (!recordManifest.projectId || job.projectIds.includes(recordManifest.projectId));
        const digest = sha256(jcs({ operation, recordManifest }));
        await this.#space(Buffer.byteLength(jcs([operation, recordManifest])));
        storage.transaction(() =>
          storage.sync.putBootstrapEntry({
            vaultId: job.vaultId,
            jobId: job.jobId,
            position: position++,
            opId: operation.opId,
            entityId: operation.entityId,
            envelope: operation,
            manifest: recordManifest,
            digest,
            selected,
          }),
        );
      }
      await this.#verifyMetadata(job);
      const missing = new Set<string>();
      for (const entry of this.#entries(job, true)) {
        if (!entry.selected) continue;
        if (entry.record === undefined) {
          if (entry.recordDigest !== undefined) throw new ZuvRequestError('INTEGRITY_FAILED');
          missing.add(entry.opId);
        } else this.#record(entry);
      }
      this.#state(job, 'records');
      for await (const entry of data.records(
        job.jobId,
        vault,
        {
          categories: job.categories as EntityType[],
          projectIds: job.projectIds,
        },
        signal,
        missing,
      )) {
        this.#guard(job, signal);
        const record = jcs(entry.record);
        await this.#space(Buffer.byteLength(record));
        storage.transaction(() =>
          storage.sync.putBootstrapRecord(
            job.vaultId,
            job.jobId,
            entry.operation.opId,
            entry.record,
            sha256(record),
          ),
        );
      }
      const counts = storage.sync.bootstrapCounts(job.vaultId, job.jobId);
      if (counts.selected !== counts.staged) throw new ZuvRequestError('INTEGRITY_FAILED');
      this.#guard(job, signal);
      this.#state(job, 'staged');
      return this.status(job.jobId);
    } catch (error) {
      const code = signal.aborted
        ? 'SCOPE_DISABLED'
        : error instanceof ZuvRequestError
          ? error.code
          : (error as NodeJS.ErrnoException)?.code === 'ENOSPC'
            ? 'LOCAL_STORAGE_FULL'
            : 'LOCAL_STORAGE_ERROR';
      storage.transaction(() =>
        storage.sync.setBootstrapState(job.vaultId, job.jobId, 'failed', code),
      );
      throw error;
    }
  }
  #state(job: SyncBootstrapJob, state: SyncBootstrapJob['state']) {
    this.#options.storage.transaction(() =>
      this.#options.storage.sync.setBootstrapState(job.vaultId, job.jobId, state),
    );
  }
  #vault() {
    const vault = this.#options.eligible();
    const { client } = this.#options;
    const identity = client.entitlements;
    if (
      !vault?.active ||
      !vault.enabled ||
      !vault.categories.length ||
      !client.signedIn ||
      client.requiresLogin ||
      client.changingIdentity ||
      identity?.identity.userId !== vault.accountId ||
      identity.identity.deviceId !== vault.deviceId ||
      identity.vault?.vaultId !== vault.vaultId
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    return vault;
  }
  #guard(job: SyncBootstrapJob, signal: AbortSignal) {
    signal.throwIfAborted();
    const vault = this.#vault();
    if (
      job.vaultId !== vault.vaultId ||
      job.accountId !== vault.accountId ||
      job.deviceId !== vault.deviceId ||
      job.hostId !== vault.originHostId ||
      job.origin !== this.#options.client.transport.origin ||
      job.scopeRevision !== vault.revision ||
      job.fromCursor !== vault.appliedCursor ||
      jcs(job.categories) !== jcs(vault.categories) ||
      jcs(job.projectIds) !== jcs(vault.projectIds)
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
  }
  *#entries(job: SyncBootstrapJob, records = false): Generator<SyncBootstrapEntry> {
    let after = -1;
    while (true) {
      const entries = this.#options.storage.sync.bootstrapEntries(
        job.vaultId,
        job.jobId,
        after,
        records,
      );
      if (!entries.length) return;
      for (const entry of entries) yield entry;
      after = entries.at(-1)?.position as number;
    }
  }
  async #verifyMetadata(job: SyncBootstrapJob) {
    const descriptor = await this.#options.snapshots.describe(job.jobId);
    if (
      descriptor.vaultId !== job.vaultId ||
      descriptor.accountId !== job.accountId ||
      descriptor.deviceId !== job.deviceId ||
      descriptor.origin !== job.origin
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
    const hash = createHash('sha256').update('[');
    let count = 0;
    for (const entry of this.#entries(job)) {
      const body = jcs({ operation: entry.envelope, recordManifest: entry.manifest });
      if (entry.position !== count || sha256(body) !== entry.digest)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const operation = validateOperation(entry.envelope);
      const manifest = schemas.recordManifest.parse(entry.manifest);
      const selected =
        job.categories.includes(operation.entityType) &&
        (!manifest.projectId || job.projectIds.includes(manifest.projectId));
      if (
        entry.entityId !== operation.entityId ||
        entry.opId !== operation.opId ||
        entry.selected !== selected
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      if (count++) hash.update(',');
      hash.update(body);
    }
    hash.update(']');
    if (hash.digest('base64url') !== descriptor.exported.snapshot.operationsSha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
  }
  #record(entry: SyncBootstrapEntry) {
    if (entry.record === undefined || sha256(jcs(entry.record)) !== entry.recordDigest)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const operation = validateOperation(entry.envelope);
    const manifest = schemas.recordManifest.parse(entry.manifest);
    const record = packRecord.parse(entry.record);
    try {
      matchRecord(operation, record, manifest);
      for (const event of record.events ?? []) {
        if (
          !operation.origin ||
          eventDigest(
            {
              vaultId: operation.vaultId,
              hostId: operation.origin.hostId,
              sessionId: operation.origin.sessionId,
              streamId: operation.origin.streamId,
              seq: event.seq,
            },
            event.content,
          ) !== event.sha256
        )
          throw new Error('event mismatch');
      }
    } catch {
      throw new ZuvRequestError('INTEGRITY_FAILED');
    }
    return { operation, recordManifest: manifest, record };
  }
  async #space(bytes: number) {
    const space = await statfs(this.#options.home, { bigint: true });
    if (space.bavail * space.bsize < BigInt(bytes * 2 + 16 * 1024 * 1024))
      throw Object.assign(new Error('sync bootstrap disk full'), { code: 'ENOSPC' });
  }
}
