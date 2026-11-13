import { randomBytes, randomUUID } from 'node:crypto';
import { validateSyncBatch } from '@wevir/protocol';
import {
  jcs,
  LIMITS,
  type RecordManifest,
  type SyncOperation,
  schemas,
} from '@wevir/protocol/sync';
import { sha256 } from '../sync/crypto.js';

export class MockSyncError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
type Scopes = typeof schemas.scopesUpdated._output;
type Batch = ReturnType<typeof validateSyncBatch>;
type Blob = {
  bytes?: Buffer;
  cipherBytes: number;
  cipherSha256: string;
  purpose: string;
  projectId?: string;
};
type Vault = {
  id: string;
  key: string;
  scopes: Map<string, Scopes>;
  trusted: Set<string>;
  blobs: Map<string, Blob>;
  uploads: Map<string, string>;
  downloads: Map<string, string>;
  commits: Map<string, { batch: Batch; state: 'pending' | 'committed'; cursor?: string }>;
  operations: Array<{ operation: SyncOperation; manifest: RecordManifest }>;
  cursors: Map<string, number>;
  cursor: string;
};
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

export class MockSyncGateway {
  readonly #vaults = new Map<string, Vault>();
  readonly acknowledgements: Array<{ deviceId: string; cursor: string }> = [];
  readonly attempts = { uploads: 0, downloads: 0, reservations: 0, commits: 0 };
  pendingCommits = false;
  failDownloads = false;
  budgetPaused = false;
  readonly limitOverrides: Record<string, number> = {};

  #vault(userId: string): Vault {
    const vault = this.#vaults.get(userId);
    if (!vault) throw new MockSyncError('NOT_FOUND', 404);
    return vault;
  }

  entitlements(userId: string, deviceId: string) {
    const vault = this.#vaults.get(userId);
    return {
      protocol: 'wevir-sync/1',
      vault: vault
        ? {
            vaultId: vault.id,
            keyEpoch: '1',
            keyState: vault.trusted.has(deviceId) ? 'ready' : 'approval-required',
            state: 'active',
          }
        : null,
      identity: { userId, deviceId },
      deviceScopes: ['identity', 'inference', 'sync', 'recovery'],
      subscriptionState: 'active',
      syncState: this.budgetPaused
        ? 'paused'
        : vault?.scopes.get(deviceId)?.enabled
          ? 'ready'
          : 'disabled',
      quota: { physicalBytes: 0, capacityBytes: 1024 ** 3 },
      retentionUntil: null,
      recovery: {
        eligible: Boolean(vault),
        requiresApproval: Boolean(vault && !vault.trusted.has(deviceId)),
      },
      limits: { ...LIMITS, ...this.limitOverrides },
    };
  }

  finalize(): void {
    for (const vault of this.#vaults.values())
      for (const commit of vault.commits.values()) {
        if (commit.state === 'committed') continue;
        for (const operation of commit.batch.operations) {
          if (vault.operations.some((entry) => entry.operation.opId === operation.opId)) continue;
          const manifest = commit.batch.recordManifest.find(
            (entry) => entry.opId === operation.opId,
          ) as RecordManifest;
          if (operation.payload)
            (vault.blobs.get(operation.payload.blobId) as Blob).projectId = manifest.projectId;
          vault.operations.push({ operation, manifest });
        }
        const cursor = newId('cursor');
        vault.cursors.set(cursor, vault.operations.length);
        vault.cursor = cursor;
        commit.state = 'committed';
        commit.cursor = cursor;
      }
  }

  handle(
    userId: string,
    deviceId: string,
    url: URL,
    method: string,
    value: unknown,
    raw: Buffer,
  ): { value?: unknown; bytes?: Buffer; status?: number } {
    const path = url.pathname.replace('/api/wevir', '');
    if (path === '/sync/v1/vaults/open' && method === 'POST') {
      schemas.vaultOpen.parse(value);
      let vault = this.#vaults.get(userId);
      if (!vault) {
        const cursor = newId('cursor');
        vault = {
          id: newId('vault'),
          key: randomBytes(32).toString('base64url'),
          scopes: new Map(),
          trusted: new Set([deviceId]),
          blobs: new Map(),
          uploads: new Map(),
          downloads: new Map(),
          commits: new Map(),
          operations: [],
          cursors: new Map([[cursor, 0]]),
          cursor,
        };
        this.#vaults.set(userId, vault);
      }
      if (!vault.scopes.has(deviceId))
        vault.scopes.set(deviceId, {
          revision: '0',
          enabled: false,
          categories: [],
          projectIds: [],
        });
      const zeroCursor = [...vault.cursors].find(([, offset]) => offset === 0)?.[0] as string;
      return {
        value: {
          vaultId: vault.id,
          deviceId,
          originHostId: deviceId,
          keyEpoch: '1',
          keyState: vault.trusted.has(deviceId) ? 'ready' : 'approval-required',
          cursor: zeroCursor,
        },
      };
    }
    const vault = this.#vault(userId);
    const scopes = vault.scopes.get(deviceId);
    if (!scopes) throw new MockSyncError('SCOPE_DISABLED', 403);
    if (path === '/sync/v1/keys/unlock' && method === 'POST') {
      const input = schemas.unlock.parse(value);
      if (!vault.trusted.has(deviceId)) throw new MockSyncError('RECOVERY_REQUIRED', 403);
      return { value: { vaultId: vault.id, keyEpoch: input.keyEpoch, keyMaterial: vault.key } };
    }
    if (path.endsWith('/approve') && method === 'POST') {
      schemas.approveDevice.parse(value);
      const target = path.split('/').at(-2) as string;
      if (!vault.trusted.has(deviceId) || !vault.scopes.has(target))
        throw new MockSyncError('SCOPE_DISABLED', 403);
      vault.trusted.add(target);
      return { value: { approved: true } };
    }
    if (path === '/sync/v1/scopes' && method === 'PUT') {
      const input = schemas.scopes.parse(value);
      if (input.expectedRevision !== scopes.revision) throw new MockSyncError('REVISION_CONFLICT');
      if (input.enabled && !vault.trusted.has(deviceId))
        throw new MockSyncError('RECOVERY_REQUIRED', 403);
      const { expectedRevision, ...selected } = input;
      const result = { ...selected, revision: String(BigInt(expectedRevision) + 1n) };
      vault.scopes.set(deviceId, result);
      return { value: result };
    }
    if (!scopes.enabled) throw new MockSyncError('SCOPE_DISABLED', 403);
    if (this.budgetPaused) throw new MockSyncError('BUDGET_PAUSED', 503);
    const allowed = (entityType: string, projectId?: string) => {
      if (
        !scopes.categories.includes(entityType as (typeof scopes.categories)[number]) ||
        (projectId !== undefined && !scopes.projectIds.includes(projectId))
      )
        throw new MockSyncError('SCOPE_DISABLED', 403);
    };
    if (path === '/sync/v1/blobs/reserve' && method === 'POST') {
      const input = schemas.reserveBlob.parse(value);
      allowed(input.purpose);
      this.attempts.reservations++;
      const previous = vault.blobs.get(input.blobId);
      if (
        previous &&
        (previous.cipherSha256 !== input.cipherSha256 || previous.cipherBytes !== input.cipherBytes)
      )
        throw new MockSyncError('INTEGRITY_FAILED');
      if (!previous) vault.blobs.set(input.blobId, { ...input });
      const uploadId = newId('upload');
      vault.uploads.set(uploadId, input.blobId);
      return { value: { uploadId, expiresAt: new Date(Date.now() + 300000).toISOString() } };
    }
    if (path.startsWith('/sync/v1/uploads/') && method === 'PUT') {
      const uploadId = path.split('/').at(-1) as string;
      const blobId = vault.uploads.get(uploadId);
      const blob = blobId ? vault.blobs.get(blobId) : undefined;
      if (!blob || !blobId) throw new MockSyncError('BLOB_INCOMPLETE');
      vault.uploads.delete(uploadId);
      this.attempts.uploads++;
      if (raw.length !== blob.cipherBytes || sha256(raw) !== blob.cipherSha256)
        throw new MockSyncError('INTEGRITY_FAILED');
      blob.bytes = raw;
      return { value: { blobId, state: 'ready' } };
    }
    if (path === '/sync/v1/commits' && method === 'POST') {
      const batch = validateSyncBatch(value);
      this.attempts.commits++;
      const previous = vault.commits.get(batch.commitId);
      if (previous) {
        if (jcs(previous.batch) !== jcs(batch)) throw new MockSyncError('OP_ID_REUSED');
      } else {
        for (const operation of batch.operations) {
          const manifest = batch.recordManifest.find(
            (entry) => entry.opId === operation.opId,
          ) as RecordManifest;
          allowed(operation.entityType, manifest.projectId);
          if (
            operation.vaultId !== vault.id ||
            operation.deviceId !== deviceId ||
            (operation.origin && operation.origin.hostId !== deviceId)
          )
            throw new MockSyncError('SCOPE_DISABLED', 403);
          const duplicate = vault.operations.find(
            (entry) => entry.operation.opId === operation.opId,
          );
          if (duplicate && jcs(duplicate) !== jcs({ operation, manifest }))
            throw new MockSyncError('OP_ID_REUSED');
          if (
            vault.operations.some(
              (entry) =>
                entry.operation.entityId === operation.entityId &&
                entry.manifest.projectId !== manifest.projectId,
            )
          )
            throw new MockSyncError('SCOPE_DISABLED', 403);
          if (operation.payload) {
            const blob = vault.blobs.get(operation.payload.blobId);
            if (!blob?.bytes || blob.purpose !== operation.entityType)
              throw new MockSyncError('BLOB_INCOMPLETE');
            if (blob.projectId !== undefined && blob.projectId !== manifest.projectId)
              throw new MockSyncError('SCOPE_DISABLED', 403);
          }
          for (const parent of operation.parents)
            if (
              ![...vault.operations.map((entry) => entry.operation), ...batch.operations].some(
                (entry) => entry.opId === parent && entry.entityId === operation.entityId,
              )
            )
              throw new MockSyncError('MISSING_PARENT');
        }
        vault.commits.set(batch.commitId, { batch, state: 'pending' });
        if (!this.pendingCommits) this.finalize();
      }
      const result = vault.commits.get(batch.commitId) as {
        state: 'pending' | 'committed';
        cursor?: string;
      };
      return {
        value: {
          state: result.state,
          commitId: batch.commitId,
          ...(result.cursor && { cursor: result.cursor }),
        },
        status: result.state === 'pending' ? 202 : 200,
      };
    }
    if (path.startsWith('/sync/v1/commits/') && method === 'GET') {
      const commitId = path.split('/').at(-1) as string;
      const commit = vault.commits.get(commitId);
      if (!commit) throw new MockSyncError('NOT_FOUND', 404);
      return {
        value: { commitId, state: commit.state, ...(commit.cursor && { cursor: commit.cursor }) },
      };
    }
    if (path === '/sync/v1/changes' && method === 'GET') {
      const cursor = url.searchParams.get('cursor');
      let offset = cursor ? vault.cursors.get(cursor) : 0;
      if (offset === undefined) throw new MockSyncError('RESET_REQUIRED');
      const limit = Number(url.searchParams.get('limit') ?? 256);
      const selected: typeof vault.operations = [];
      while (offset < vault.operations.length && selected.length < limit) {
        const entry = vault.operations[offset++];
        if (
          entry &&
          scopes.categories.includes(entry.operation.entityType) &&
          (!entry.manifest.projectId || scopes.projectIds.includes(entry.manifest.projectId))
        )
          selected.push(entry);
      }
      const nextCursor = newId('cursor');
      vault.cursors.set(nextCursor, offset);
      return {
        value: {
          operations: selected.map((entry) => entry.operation),
          recordManifest: selected.map((entry) => entry.manifest),
          nextCursor,
          hasMore: offset < vault.operations.length,
        },
      };
    }
    if (path === '/sync/v1/downloads' && method === 'POST') {
      const input = schemas.download.parse(value);
      const blob = vault.blobs.get(input.blobId);
      const reference = vault.operations.find(
        (entry) => entry.operation.payload?.blobId === input.blobId,
      );
      if (!blob?.bytes || !reference) throw new MockSyncError('NOT_FOUND', 404);
      allowed(reference.operation.entityType, reference.manifest.projectId);
      const downloadId = newId('download');
      vault.downloads.set(downloadId, input.blobId);
      return {
        value: {
          downloadId,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          cipherBytes: blob.cipherBytes,
          cipherSha256: blob.cipherSha256,
        },
      };
    }
    if (path.startsWith('/sync/v1/downloads/') && method === 'GET') {
      const downloadId = path.split('/').at(-1) as string;
      const blobId = vault.downloads.get(downloadId);
      const blob = blobId ? vault.blobs.get(blobId) : undefined;
      if (!blob?.bytes) throw new MockSyncError('NOT_FOUND', 404);
      vault.downloads.delete(downloadId);
      this.attempts.downloads++;
      if (this.failDownloads) throw new MockSyncError('SERVICE_UNAVAILABLE', 503);
      return { bytes: blob.bytes };
    }
    if (path === '/sync/v1/devices/ack' && method === 'POST') {
      const input = schemas.ack.parse(value);
      if (!vault.cursors.has(input.cursor)) throw new MockSyncError('INVALID_REQUEST', 400);
      this.acknowledgements.push({ deviceId, cursor: input.cursor });
      return { value: { applied: true } };
    }
    throw new MockSyncError('NOT_FOUND', 404);
  }
}
