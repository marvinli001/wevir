import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SyncSigningKeysCacheSchema,
  SyncSnapshotEntriesSchema,
  SyncSnapshotJobSchema,
  validateSyncPage,
} from '@wevir/protocol';
import { id, jcs, LIMITS, schemas } from '@wevir/protocol/sync';
import type { SyncVaultRecord } from '@wevir/storage';
import { newId } from '../ids.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import { verifySyncSignature } from './signed.js';

const MAX_OPERATIONS = 50000;
const MAX_METADATA_BYTES = 128 * 1024 * 1024;
const MAX_PAGE_BYTES = LIMITS.changeBytes + LIMITS.operations * 64;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
type Journal = typeof SyncSnapshotJobSchema._output;
type Entry = {
  operation: typeof schemas.operation._output;
  recordManifest: typeof schemas.recordManifest._output;
};

/** Immutable, signed snapshot metadata; this never applies records or advances a device cursor. */
export class SyncSnapshots {
  readonly #client: ZuvClient;
  readonly #root: string;
  constructor(options: { client: ZuvClient; home: string }) {
    this.#client = options.client;
    this.#root = join(options.home, 'sync/restores');
  }

  async prepare(
    vault: SyncVaultRecord,
    signal: AbortSignal,
    snapshotCursor?: string,
    jobId: string = newId('srj'),
  ) {
    this.#guard(vault, signal);
    const job: Journal = {
      v: 1,
      jobId,
      vaultId: vault.vaultId,
      accountId: vault.accountId,
      deviceId: vault.deviceId,
      origin: this.#client.transport.origin,
      state: 'creating',
      pages: [],
    };
    await this.#directory(job.jobId);
    await this.#save(job);
    try {
      job.exported = await this.#client.json(
        'exported',
        'POST',
        '/api/wevir/recovery/exports',
        snapshotCursor === undefined ? {} : { snapshotCursor },
        { signal, maxBytes: 16 * 1024 * 1024 },
      );
      this.#guard(vault, signal);
      await this.#verifyExport(job, signal);
      job.state = 'listing';
      await this.#save(job);
      return await this.#list(job, vault, signal);
    } catch (error) {
      await this.#failed(job, error);
      throw error;
    }
  }

  async resume(jobId: string, vault: SyncVaultRecord, signal: AbortSignal) {
    const job = await this.#load(jobId);
    this.#guard(vault, signal);
    if (
      job.vaultId !== vault.vaultId ||
      job.accountId !== vault.accountId ||
      job.deviceId !== vault.deviceId ||
      job.origin !== this.#client.transport.origin
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
    // An export response may have been lost; never create another chargeable snapshot automatically.
    if (!job.exported) throw new ZuvRequestError('RECOVERY_REQUIRED');
    try {
      await this.#verifyExport(job, signal);
      return await this.#list(job, vault, signal);
    } catch (error) {
      await this.#failed(job, error);
      throw error;
    }
  }

  async describe(jobId: string) {
    const job = await this.#load(jobId);
    if (job.state !== 'verified' || !job.exported) throw new ZuvRequestError('RECOVERY_REQUIRED');
    await this.#verifyPinned(job);
    return {
      vaultId: job.vaultId,
      accountId: job.accountId,
      deviceId: job.deviceId,
      origin: job.origin,
      exported: job.exported,
    };
  }

  async *entries(jobId: string): AsyncGenerator<Entry> {
    const job = await this.#load(jobId);
    if (job.state !== 'verified' || !job.exported) throw new ZuvRequestError('RECOVERY_REQUIRED');
    await this.#verifyPinned(job);
    await this.#scan(job, true);
    for (let index = 0; index < job.pages.length; index++)
      for (const entry of await this.#page(job, index)) yield entry;
  }

  async historyRoots(jobId: string) {
    const descriptor = await this.describe(jobId);
    const operations = new Map<string, string>();
    const references = new Map<string, string>();
    for await (const { operation } of this.entries(jobId)) {
      operations.set(operation.opId, operation.entityId);
      for (const parent of operation.parents) {
        if (references.has(parent) && references.get(parent) !== operation.entityId)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        references.set(parent, operation.entityId);
      }
    }
    const roots: Array<{ opId: string; entityId: string }> = [];
    for (const [parent, entityId] of references) {
      if (operations.has(parent)) {
        if (operations.get(parent) !== entityId) throw new ZuvRequestError('INTEGRITY_FAILED');
      } else roots.push({ opId: parent, entityId });
    }
    return { ...descriptor, roots };
  }

  async #list(job: Journal, vault: SyncVaultRecord, signal: AbortSignal) {
    const exported = job.exported;
    if (!exported) throw new ZuvRequestError('RECOVERY_REQUIRED');
    const seen = await this.#scan(job, false);
    const blobs = new Set(exported.manifest.map((value) => value.blobId));
    let fromCursor = job.pages.at(-1)?.nextCursor ?? '';
    while (!job.pages.length || job.pages.at(-1)?.hasMore) {
      this.#guard(vault, signal);
      if (Date.parse(exported.expiresAt) <= Date.now())
        throw new ZuvRequestError('RECOVERY_REQUIRED');
      const limit = Math.min(
        LIMITS.operations,
        this.#client.entitlements?.limits.operations ?? LIMITS.operations,
      );
      if (!Number.isSafeInteger(limit) || limit < 1) throw new ZuvRequestError('QUOTA_EXCEEDED');
      const query = new URLSearchParams({ restoreId: exported.restoreId, limit: String(limit) });
      if (fromCursor) query.set('cursor', fromCursor);
      await this.#space(job.jobId, LIMITS.changeBytes);
      const page = await this.#client.json(
        'changes',
        'GET',
        `/api/wevir/sync/v1/changes?${query}`,
        undefined,
        { signal, maxBytes: LIMITS.changeBytes },
      );
      try {
        validateSyncPage(page);
      } catch {
        throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      if (
        (page.hasMore && (!page.operations.length || page.nextCursor === fromCursor)) ||
        job.pages.some((old) => old.fromCursor === page.nextCursor)
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const entries = page.operations.map((operation) => ({
        operation,
        recordManifest: page.recordManifest.find(
          (value) => value.opId === operation.opId,
        ) as Entry['recordManifest'],
      }));
      for (const entry of entries) {
        const op = entry.operation;
        const sequence = `${op.deviceId}:${op.deviceSeq}`;
        if (
          seen.operationIds.has(op.opId) ||
          seen.sequences.has(sequence) ||
          op.vaultId !== job.vaultId ||
          (op.payload && !blobs.has(op.payload.blobId)) ||
          (seen.bindings.has(op.entityId) &&
            seen.bindings.get(op.entityId) !== entry.recordManifest.projectId)
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        seen.metadataBytes += Buffer.byteLength(jcs(entry));
        if (seen.operationIds.size >= MAX_OPERATIONS || seen.metadataBytes > MAX_METADATA_BYTES)
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        seen.operationIds.add(op.opId);
        seen.sequences.add(sequence);
        seen.bindings.set(op.entityId, entry.recordManifest.projectId);
      }
      this.#guard(vault, signal);
      const bytes = Buffer.from(jcs(entries));
      await this.#space(job.jobId, bytes.length);
      const path = join(this.#root, job.jobId, `${job.pages.length}.json`);
      try {
        const output = await open(path, 'wx', 0o600);
        try {
          await output.writeFile(bytes);
          await output.sync();
        } finally {
          await output.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (sha256(await this.#read(path, MAX_PAGE_BYTES)) !== sha256(bytes))
          throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      await this.#syncDirectory(join(this.#root, job.jobId));
      job.pages.push({
        digest: sha256(bytes),
        count: entries.length,
        fromCursor,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
      job.state = 'listing';
      delete job.errorCode;
      await this.#save(job);
      fromCursor = page.nextCursor;
    }
    const result = await this.#scan(job, true);
    job.state = 'verified';
    await this.#save(job);
    return {
      jobId: job.jobId,
      restoreId: exported.restoreId,
      vaultId: job.vaultId,
      snapshotCursor: exported.snapshotCursor,
      expiresAt: exported.expiresAt,
      operations: result.count,
      projectIds: [...result.projects].sort(),
    };
  }

  async #scan(job: Journal, complete: boolean) {
    const exported = job.exported;
    if (!exported) throw new ZuvRequestError('RECOVERY_REQUIRED');
    const blobs = new Set(exported.manifest.map((value) => value.blobId));
    const operations = new Set<string>();
    const sequences = new Set<string>();
    const projects = new Set<string>();
    const bindings = new Map<string, string | undefined>();
    const hash = createHash('sha256').update('[');
    let bytes = 0;
    let previous = '';
    for (let index = 0; index < job.pages.length; index++) {
      const pointer = job.pages[index];
      if (!pointer || pointer.fromCursor !== previous || (index && !job.pages[index - 1]?.hasMore))
        throw new ZuvRequestError('INTEGRITY_FAILED');
      previous = pointer.nextCursor;
      for (const entry of await this.#page(job, index)) {
        const { operation: op, recordManifest: manifest } = entry;
        const sequence = `${op.deviceId}:${op.deviceSeq}`;
        if (
          operations.has(op.opId) ||
          sequences.has(sequence) ||
          op.vaultId !== job.vaultId ||
          (op.payload && !blobs.has(op.payload.blobId)) ||
          (bindings.has(op.entityId) && bindings.get(op.entityId) !== manifest.projectId)
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
        const record = jcs(entry);
        bytes += Buffer.byteLength(record);
        if (operations.size >= MAX_OPERATIONS || bytes > MAX_METADATA_BYTES)
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        if (operations.size) hash.update(',');
        hash.update(record);
        operations.add(op.opId);
        sequences.add(sequence);
        bindings.set(op.entityId, manifest.projectId);
        if (manifest.projectId) projects.add(manifest.projectId);
      }
    }
    hash.update(']');
    if (
      complete &&
      (job.pages.at(-1)?.hasMore !== false ||
        hash.digest('base64url') !== exported.snapshot.operationsSha256)
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return {
      count: operations.size,
      projects,
      operationIds: operations,
      sequences,
      bindings,
      metadataBytes: bytes,
    };
  }

  async #verifyExport(job: Journal, signal: AbortSignal): Promise<void> {
    this.#checkExport(job);
    const exported = job.exported as NonNullable<Journal['exported']>;
    if (Date.parse(exported.expiresAt) <= Date.now())
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const result = await this.#client.json(
      'signingKeys',
      'GET',
      `/api/wevir/sync/v1/signing-keys?keyId=${encodeURIComponent(exported.snapshot.signingKeyId)}`,
      undefined,
      { signal },
    );
    const keys = new Map(result.keys.map((value) => [value.keyId, value.publicKey]));
    verifySyncSignature(exported.snapshot, keys);
    const pins = await this.#pins(job.origin);
    for (const [keyId, pem] of keys) {
      if (pins.has(keyId) && pins.get(keyId) !== pem) throw new ZuvRequestError('INTEGRITY_FAILED');
      pins.set(keyId, pem);
    }
    await this.#write(join(this.#root, `${sha256(job.origin)}.keys.json`), jcs([...pins]));
  }

  #checkExport(job: Journal): void {
    const exported = job.exported;
    if (
      !exported ||
      exported.snapshot.vaultId !== job.vaultId ||
      exported.restoreId !== exported.snapshot.restoreId ||
      exported.snapshotCursor !== exported.snapshot.snapshotCursor ||
      sha256(jcs(exported.manifest)) !== exported.snapshot.blobManifestSha256 ||
      new Set(exported.manifest.map((value) => value.blobId)).size !== exported.manifest.length ||
      exported.manifest.some(
        (value) => value.cipherBytes < 1 || value.cipherBytes > LIMITS.blobBytes,
      )
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
  }
  async #verifyPinned(job: Journal): Promise<void> {
    this.#checkExport(job);
    if (!job.exported) throw new ZuvRequestError('RECOVERY_REQUIRED');
    verifySyncSignature(job.exported.snapshot, await this.#pins(job.origin));
    if (sha256(jcs(job.exported.manifest)) !== job.exported.snapshot.blobManifestSha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
  }
  async #pins(origin: string): Promise<Map<string, string>> {
    try {
      const bytes = await this.#read(
        join(this.#root, `${sha256(origin)}.keys.json`),
        2 * 1024 * 1024,
      );
      return new Map(SyncSigningKeysCacheSchema.parse(JSON.parse(bytes.toString('utf8'))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }
  async #page(job: Journal, index: number): Promise<Entry[]> {
    const bytes = await this.#read(join(this.#root, job.jobId, `${index}.json`), MAX_PAGE_BYTES);
    const pointer = job.pages[index];
    if (!pointer || sha256(bytes) !== pointer.digest) throw new ZuvRequestError('INTEGRITY_FAILED');
    const entries = SyncSnapshotEntriesSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (entries.length !== pointer.count) throw new ZuvRequestError('INTEGRITY_FAILED');
    validateSyncPage({
      operations: entries.map((value) => value.operation),
      recordManifest: entries.map((value) => value.recordManifest),
      nextCursor: pointer.nextCursor,
      hasMore: pointer.hasMore,
    });
    return entries;
  }
  #guard(vault: SyncVaultRecord, signal: AbortSignal): void {
    signal.throwIfAborted();
    const state = this.#client.entitlements;
    if (
      !this.#client.signedIn ||
      this.#client.requiresLogin ||
      this.#client.enrollment ||
      this.#client.changingIdentity ||
      state?.identity.userId !== vault.accountId ||
      state.identity.deviceId !== vault.deviceId ||
      state.vault?.vaultId !== vault.vaultId
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
  }
  async #directory(jobId: string): Promise<void> {
    const path = join(this.#root, id.parse(jobId));
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(this.#root)).isSymbolicLink() || (await lstat(path)).isSymbolicLink())
      throw new ZuvRequestError('INTEGRITY_FAILED');
    await this.#syncDirectory(dirname(this.#root));
    await this.#syncDirectory(this.#root);
  }
  async #read(path: string, limit: number): Promise<Buffer> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new ZuvRequestError('INTEGRITY_FAILED');
    return bytes;
  }
  async #space(jobId: string, bytes: number): Promise<void> {
    const info = await statfs(join(this.#root, jobId), { bigint: true });
    if (info.bavail * info.bsize < BigInt(bytes + 16 * 1024 * 1024))
      throw Object.assign(new Error('restore metadata disk full'), { code: 'ENOSPC' });
  }
  async #write(path: string, value: string): Promise<void> {
    const temporary = `${path}.${newId('tmp')}`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await this.#syncDirectory(dirname(path));
  }
  async #syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async #save(job: Journal): Promise<void> {
    if (job.exported && !job.exportedDigest) {
      const body = jcs(job.exported);
      await this.#write(join(this.#root, job.jobId, 'export.json'), body);
      job.exportedDigest = sha256(body);
    }
    const { exported: _exported, ...progress } = job;
    await this.#write(join(this.#root, job.jobId, 'job.json'), jcs(progress));
  }
  async #load(jobId: string): Promise<Journal> {
    const job = SyncSnapshotJobSchema.parse(
      JSON.parse(
        (
          await this.#read(join(this.#root, id.parse(jobId), 'job.json'), MAX_JOURNAL_BYTES)
        ).toString('utf8'),
      ),
    );
    if (job.jobId !== jobId) throw new ZuvRequestError('INTEGRITY_FAILED');
    try {
      const bytes = await this.#read(join(this.#root, jobId, 'export.json'), 16 * 1024 * 1024);
      if (job.exportedDigest && sha256(bytes) !== job.exportedDigest)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      job.exported = schemas.exported.parse(JSON.parse(bytes.toString('utf8')));
      job.exportedDigest = sha256(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || job.exportedDigest) throw error;
    }
    return job;
  }
  async #failed(job: Journal, error: unknown): Promise<void> {
    job.state = 'failed';
    job.errorCode = error instanceof ZuvRequestError ? error.code : 'RESTORE_INCOMPLETE';
    await this.#save(job);
  }
}
