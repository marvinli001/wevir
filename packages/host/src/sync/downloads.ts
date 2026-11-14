import { LIMITS } from '@wevir/protocol/sync';
import type { Storage, SyncBlobRecord, SyncVaultRecord } from '@wevir/storage';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { type SyncBlobCache, SyncCacheIntegrityError } from './cache.js';
import { parseEnvelope, sha256 } from './crypto.js';

export const TRANSFER_RETRY_MS = 60000;
export class SyncDownloads {
  constructor(
    readonly options: {
      storage: Storage;
      client: ZuvClient;
      cache: SyncBlobCache;
      guard: (vault: SyncVaultRecord, signal: AbortSignal) => void;
    },
  ) {}

  async read(
    vault: SyncVaultRecord,
    blobId: string,
    signal: AbortSignal,
    restore?: { restoreId: string; cipherBytes: number; cipherSha256: string },
  ): Promise<Buffer> {
    const { storage, client, cache, guard } = this.options;
    guard(vault, signal);
    let blob = storage.sync.blob(vault.vaultId, blobId);
    if (blob?.state === 'quarantined') throw new ZuvRequestError('INTEGRITY_FAILED');
    if (
      restore &&
      blob &&
      (blob.cipherBytes !== restore.cipherBytes || blob.cipherSha256 !== restore.cipherSha256)
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (blob?.state === 'ready') {
      try {
        return await cache.read(vault.vaultId, blobId, blob.cipherBytes, blob.cipherSha256);
      } catch (error) {
        if (error instanceof SyncCacheIntegrityError) await cache.remove(vault.vaultId, blobId);
        else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if ((blob?.retryAt ?? 0) > Date.now()) throw new ZuvRequestError('RATE_LIMITED');
    const limit = (name: string, baseline: number) => {
      const value = Math.min(baseline, client.entitlements?.limits[name] ?? baseline);
      if (!Number.isSafeInteger(value) || value < 1) throw new ZuvRequestError('QUOTA_EXCEEDED');
      return value;
    };
    const transfer = {
      bytesPerSecond: limit('transferBytesPerSecond', LIMITS.transferBytesPerSecond),
      chunkBytes: limit('transferChunkBytes', LIMITS.transferChunkBytes),
      timeoutMs: limit('transferMs', LIMITS.transferMs),
    };
    if (
      restore &&
      (restore.cipherBytes > limit('blobBytes', LIMITS.blobBytes) ||
        restore.cipherBytes > Math.floor((transfer.bytesPerSecond * transfer.timeoutMs) / 1000))
    )
      throw new ZuvRequestError('QUOTA_EXCEEDED');
    if (restore) await cache.assertSpace(vault.vaultId, restore.cipherBytes);
    guard(vault, signal);
    const ticket = await client.json(
      'downloadReserved',
      'POST',
      '/api/wevir/sync/v1/downloads',
      { blobId, ...(restore && { restoreId: restore.restoreId }) },
      { signal },
    );
    if (
      restore &&
      (ticket.cipherBytes !== restore.cipherBytes || ticket.cipherSha256 !== restore.cipherSha256)
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (
      ticket.cipherBytes > limit('blobBytes', LIMITS.blobBytes) ||
      ticket.cipherBytes > Math.floor((transfer.bytesPerSecond * transfer.timeoutMs) / 1000)
    )
      throw new ZuvRequestError('QUOTA_EXCEEDED');
    if (Date.parse(ticket.expiresAt) <= Date.now()) throw new ZuvRequestError('RATE_LIMITED');
    await cache.assertSpace(vault.vaultId, ticket.cipherBytes);
    blob = {
      vaultId: vault.vaultId,
      blobId,
      cipherBytes: ticket.cipherBytes,
      cipherSha256: ticket.cipherSha256,
      keyEpoch: blob?.keyEpoch ?? '',
      cachePath: cache.path(vault.vaultId, blobId),
      state: 'local',
      uploadAttempts: blob?.uploadAttempts ?? 0,
      downloadAttempts: (blob?.downloadAttempts ?? 0) + 1,
      retryAt: Date.now() + TRANSFER_RETRY_MS,
    } satisfies SyncBlobRecord;
    storage.sync.putBlob(blob);
    guard(vault, signal);
    const response = await client.transfer({
      method: 'GET',
      path: `/api/wevir/sync/v1/downloads/${ticket.downloadId}`,
      maxBytes: ticket.cipherBytes,
      signal,
      transfer,
    });
    if (
      response.bytes.length !== ticket.cipherBytes ||
      sha256(response.bytes) !== ticket.cipherSha256
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const path = await cache.put(vault.vaultId, blobId, response.bytes, ticket.cipherSha256);
    const header = parseEnvelope(response.bytes).header;
    if (header.vaultId !== vault.vaultId || header.blobId !== blobId)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    storage.sync.putBlob({
      ...blob,
      state: 'ready',
      cachePath: path,
      keyEpoch: header.keyEpoch,
      downloadAttempts: 0,
      retryAt: 0,
    });
    return response.bytes;
  }
}
