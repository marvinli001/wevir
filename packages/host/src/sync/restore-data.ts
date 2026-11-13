import type { EntityType, RecordManifest, SyncOperation } from '@wevir/protocol/sync';
import type { Storage, SyncVaultRecord } from '@wevir/storage';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncBlobCache } from './cache.js';
import { decryptPack, parseEnvelope } from './crypto.js';
import { SyncDownloads } from './downloads.js';
import type { SyncVaultKeys } from './keys.js';
import type { SyncSnapshots } from './snapshots.js';

interface RestoreDataOptions {
  client: ZuvClient;
  storage: Storage;
  cache: SyncBlobCache;
  keys: SyncVaultKeys;
  snapshots: SyncSnapshots;
}
export class SyncRestoreData {
  readonly #options: RestoreDataOptions;
  readonly #downloads: SyncDownloads;
  constructor(options: RestoreDataOptions) {
    this.#options = options;
    this.#downloads = new SyncDownloads({
      ...options,
      guard: (vault, signal) => this.#guard(vault, signal),
    });
  }

  /** Callers stage these verified records; no business write or cursor ACK happens here. */
  async *records(
    jobId: string,
    vault: SyncVaultRecord,
    selection: { categories: readonly EntityType[]; projectIds: readonly string[] },
    signal: AbortSignal,
  ) {
    const { client, keys, snapshots } = this.#options;
    const descriptor = await snapshots.describe(jobId);
    this.#guard(vault, signal);
    if (
      descriptor.vaultId !== vault.vaultId ||
      descriptor.accountId !== vault.accountId ||
      descriptor.deviceId !== vault.deviceId ||
      descriptor.origin !== client.transport.origin
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
    const ordered: Array<{ operation: SyncOperation; recordManifest: RecordManifest }> = [];
    const groups = new Map<string, typeof ordered>();
    for await (const entry of snapshots.entries(jobId)) {
      this.#guard(vault, signal);
      if (
        !selection.categories.includes(entry.operation.entityType) ||
        (entry.recordManifest.projectId &&
          !selection.projectIds.includes(entry.recordManifest.projectId))
      )
        continue;
      ordered.push(entry);
      if (entry.operation.payload) {
        const group = groups.get(entry.operation.payload.blobId) ?? [];
        group.push(entry);
        if (group.length > 256) throw new ZuvRequestError('INTEGRITY_FAILED');
        groups.set(entry.operation.payload.blobId, group);
      }
    }
    const refs = new Map(descriptor.exported.manifest.map((value) => [value.blobId, value]));
    let currentBlob: string | undefined;
    let decoded: Awaited<ReturnType<typeof decryptPack>> | undefined;
    for (const entry of ordered) {
      this.#guard(vault, signal);
      const op = entry.operation;
      if (!op.payload) {
        yield {
          ...entry,
          record: {
            opId: op.opId,
            entityId: op.entityId,
            kind: op.kind,
            parents: op.parents,
            content: null,
            ...(entry.recordManifest.projectId && { projectId: entry.recordManifest.projectId }),
          },
        };
        continue;
      }
      if (currentBlob !== op.payload.blobId) {
        const ref = refs.get(op.payload.blobId);
        const group = groups.get(op.payload.blobId);
        if (!ref || !group) throw new ZuvRequestError('INTEGRITY_FAILED');
        const bytes = await this.#downloads.read(vault, op.payload.blobId, signal, {
          ...ref,
          restoreId: descriptor.exported.restoreId,
        });
        const header = parseEnvelope(bytes).header;
        if (
          header.vaultId !== vault.vaultId ||
          header.blobId !== op.payload.blobId ||
          BigInt(header.keyEpoch) < 1n
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        const key = await keys.unlock(vault.vaultId, header.keyEpoch, signal);
        try {
          decoded = await decryptPack(
            bytes,
            key,
            group.map((value) => value.operation),
            group.map((value) => value.recordManifest),
          );
        } catch {
          throw new ZuvRequestError('INTEGRITY_FAILED');
        }
        currentBlob = op.payload.blobId;
      }
      const record = decoded?.records[op.payload.recordIndex];
      if (!record || record.opId !== op.opId) throw new ZuvRequestError('INTEGRITY_FAILED');
      this.#guard(vault, signal);
      yield { ...entry, record };
    }
  }

  #guard(vault: SyncVaultRecord, signal: AbortSignal): void {
    signal.throwIfAborted();
    const { client } = this.#options;
    const identity = client.entitlements;
    if (
      !client.signedIn ||
      client.enrollment ||
      client.requiresLogin ||
      client.changingIdentity ||
      identity?.identity.userId !== vault.accountId ||
      identity.identity.deviceId !== vault.deviceId ||
      identity.vault?.vaultId !== vault.vaultId
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
  }
}
