import {
  PROTOCOL_VERSION,
  SyncBundleContentSchema,
  validateSyncBatch,
  validateSyncPage,
} from '@wevir/protocol';
import {
  jcs,
  LIMITS,
  origin,
  packRecord,
  type RecordManifest,
  type SyncOperation,
  schemas,
  validateOperation,
} from '@wevir/protocol/sync';
import type {
  Storage,
  SyncCommitRecord,
  SyncDraftRecord,
  SyncEntityRecord,
  SyncOperationRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncBlobCache } from './cache.js';
import { decryptPack, encryptPack, parseEnvelope, sha256 } from './crypto.js';
import { SyncDownloads, TRANSFER_RETRY_MS } from './downloads.js';
import { MAX_PREPARATION_REFERENCES, type SyncDraftPayload } from './queue.js';
import { rebaseResetCommit } from './reset-queue.js';

type Record = typeof packRecord._output;
type PreparedDraft = {
  draft: SyncDraftRecord;
  entity: SyncEntityRecord;
  payload: SyncDraftPayload;
};

const PACK_TARGET_BYTES = 256 * 1024;
const COMMIT_REJECTIONS = new Set([
  'MISSING_PARENT',
  'REVISION_CONFLICT',
  'BLOB_INCOMPLETE',
  'OP_ID_REUSED',
  'INVALID_REQUEST',
  'SCOPE_DISABLED',
  'QUOTA_EXCEEDED',
]);

export interface SyncEngineOptions {
  storage: Storage;
  client: ZuvClient;
  cache: SyncBlobCache;
  key: (vaultId: string, epoch: string, signal: AbortSignal) => Promise<Uint8Array>;
  prepareApply: (op: SyncOperation, record: Record, signal?: AbortSignal) => Promise<() => void>;
}

export class SyncEngine {
  readonly #options: SyncEngineOptions;
  #running: Promise<boolean> | undefined;
  #missingAt = 0;
  #abort = new AbortController();
  constructor(options: SyncEngineOptions) {
    this.#options = options;
  }

  stop(): void {
    this.#abort.abort();
  }
  restart(): void {
    this.#abort = new AbortController();
  }

  run(): Promise<boolean> {
    this.#running ??= this.#run(this.#abort.signal).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  eligible(): SyncVaultRecord | undefined {
    const { storage, client } = this.#options;
    const vault = storage.sync.activeVault();
    const entitlements = client.entitlements;
    return vault?.enabled &&
      client.signedIn &&
      !client.requiresLogin &&
      entitlements?.subscriptionState === 'active' &&
      entitlements.syncState === 'ready' &&
      entitlements.vault?.vaultId === vault.vaultId &&
      entitlements.vault.state === 'active' &&
      entitlements.vault.keyState === 'ready' &&
      entitlements.deviceScopes.includes('sync') &&
      vault.accountId === entitlements.identity.userId &&
      vault.deviceId === entitlements.identity.deviceId
      ? vault
      : undefined;
  }

  async outboxRecords(commit: SyncCommitRecord, signal: AbortSignal): Promise<Map<string, Record>> {
    const { storage, cache } = this.#options;
    const batch = validateSyncBatch(JSON.parse(commit.body));
    const verified = new Map<string, Record>();
    for (const blobId of new Set(
      batch.operations.flatMap((op) => (op.payload ? [op.payload.blobId] : [])),
    )) {
      const blob = storage.sync.blob(commit.vaultId, blobId);
      if (!blob) throw new ZuvRequestError('INTEGRITY_FAILED');
      const bytes = await cache.read(commit.vaultId, blobId, blob.cipherBytes, blob.cipherSha256);
      const key = await this.#options.key(commit.vaultId, blob.keyEpoch, signal);
      try {
        if (parseEnvelope(bytes).header.keyEpoch !== blob.keyEpoch)
          throw new Error('epoch changed');
        const records = await decryptPack(
          bytes,
          key,
          batch.operations.filter((op) => op.payload?.blobId === blobId),
          batch.recordManifest,
        );
        for (const record of records.records) {
          const stored = storage.sync.getOperation(commit.vaultId, record.opId);
          if (!stored || jcs(stored.record) !== jcs(record))
            throw new Error('outbox record changed');
          verified.set(record.opId, record);
        }
      } catch {
        throw new ZuvRequestError('INTEGRITY_FAILED');
      }
    }
    for (const operation of batch.operations)
      if (!operation.payload) {
        const stored = storage.sync.getOperation(commit.vaultId, operation.opId);
        verified.set(operation.opId, packRecord.parse(stored?.record));
      }
    return verified;
  }

  async reconcileReset(jobId: string, signal: AbortSignal): Promise<void> {
    const { storage, client } = this.#options;
    const vault = this.eligible();
    if (!vault || storage.sync.bootstrapApplication(vault.vaultId, jobId)?.state !== 'acknowledged')
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    for (const commit of storage.sync.commits(vault.vaultId)) {
      if (commit.outcome === 'rejected') continue;
      if (!this.#commitInScope(vault, commit)) continue;
      this.#guard(vault, signal);
      try {
        const result = await client.json(
          'commitResult',
          'GET',
          `/api/wevir/sync/v1/commits/${commit.commitId}`,
          undefined,
          { signal },
        );
        this.#guard(vault, signal);
        this.#commitResult(
          vault,
          commit,
          result,
          validateSyncBatch(JSON.parse(commit.body)).operations,
        );
      } catch (error) {
        if (!(error instanceof ZuvRequestError) || error.code !== 'NOT_FOUND') throw error;
        this.#guard(vault, signal);
        if (commit.attempts || commit.state !== 'queued')
          throw new ZuvRequestError('RECOVERY_REQUIRED');
        const batch = validateSyncBatch(JSON.parse(commit.body));
        const verified = new Map<string, Record>();
        for (const blobId of new Set(
          batch.operations.flatMap((op) => (op.payload ? [op.payload.blobId] : [])),
        )) {
          const blob = storage.sync.blob(vault.vaultId, blobId);
          if (!blob) throw new ZuvRequestError('INTEGRITY_FAILED');
          const bytes = await this.#options.cache.read(
            vault.vaultId,
            blobId,
            blob.cipherBytes,
            blob.cipherSha256,
          );
          const key = await this.#options.key(vault.vaultId, blob.keyEpoch, signal);
          try {
            if (parseEnvelope(bytes).header.keyEpoch !== blob.keyEpoch)
              throw new Error('outbox key epoch changed');
            const records = await decryptPack(
              bytes,
              key,
              batch.operations.filter((op) => op.payload?.blobId === blobId),
              batch.recordManifest,
            );
            for (const record of records.records) verified.set(record.opId, record);
          } catch {
            throw new ZuvRequestError('INTEGRITY_FAILED');
          }
        }
        this.#guard(vault, signal);
        rebaseResetCommit(storage, vault, jobId, commit, verified);
      }
    }
  }

  async #run(signal: AbortSignal): Promise<boolean> {
    const vault = this.eligible();
    if (!vault || signal.aborted) return false;
    const previous = this.#options.storage.sync.vaultTransport(vault.vaultId);
    if (previous.errorCode === 'BLOB_INCOMPLETE' && previous.retryAt > Date.now()) return false;
    this.#state(vault.vaultId, 'syncing');
    try {
      const epoch = this.#options.client.entitlements?.vault?.keyEpoch as string;
      const transport = this.#options.storage.sync.vaultTransport(vault.vaultId);
      if (BigInt(epoch) < BigInt(transport.keyEpoch))
        throw new ZuvRequestError('RECOVERY_REQUIRED');
      if (epoch !== transport.keyEpoch)
        this.#options.storage.sync.setVaultTransport(vault.vaultId, {
          ...transport,
          keyEpoch: epoch,
        });
      await this.#repairMissing(vault, signal);
      let pushFailure: unknown;
      try {
        await this.#push(vault, signal);
      } catch (error) {
        if (
          !(error instanceof ZuvRequestError) ||
          ![
            'MISSING_PARENT',
            'REVISION_CONFLICT',
            'BLOB_INCOMPLETE',
            'OP_ID_REUSED',
            'RECOVERY_REQUIRED',
            'NETWORK_ERROR',
            'RATE_LIMITED',
            'QUOTA_EXCEEDED',
            'SCOPE_DISABLED',
          ].includes(error.code)
        )
          throw error;
        pushFailure = error;
      }
      await this.#pull(vault, signal);
      if (pushFailure) throw pushFailure;
      await this.#prepare(vault, signal);
      await this.#push(vault, signal);
      this.#guard(vault, signal);
      this.#state(
        vault.vaultId,
        this.#options.storage.sync.counts(vault.vaultId).pending ? 'pending' : 'idle',
        undefined,
        0,
        new Date().toISOString(),
      );
      return true;
    } catch (error) {
      if (signal.aborted || !this.eligible()) return false;
      const code =
        error instanceof ZuvRequestError
          ? error.code
          : (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'
            ? 'LOCAL_STORAGE_FULL'
            : 'LOCAL_STORAGE_ERROR';
      const state =
        code === 'RESET_REQUIRED'
          ? 'reset_required'
          : code === 'DEVICE_REVOKED'
            ? 'revoked'
            : ['INTEGRITY_FAILED', 'UPGRADE_REQUIRED'].includes(code)
              ? 'attention'
              : 'paused';
      this.#state(
        vault.vaultId,
        state,
        code,
        Date.now() +
          (code === 'BLOB_INCOMPLETE'
            ? 60000
            : error instanceof ZuvRequestError
              ? (error.retryAfterMs ?? 5000)
              : 5000),
      );
      throw error;
    }
  }

  #guard(vault: SyncVaultRecord, signal: AbortSignal): void {
    const current = this.eligible();
    if (signal.aborted || current?.vaultId !== vault.vaultId || current.revision !== vault.revision)
      throw new ZuvRequestError('SCOPE_DISABLED');
  }

  #scope(vault: SyncVaultRecord, entityType: string, projectId?: string): void {
    if (
      !vault.categories.includes(entityType) ||
      (projectId !== undefined && !vault.projectIds.includes(projectId))
    )
      throw new ZuvRequestError('SCOPE_DISABLED', 403);
  }
  #commitInScope(vault: SyncVaultRecord, commit: SyncCommitRecord): boolean {
    const batch = validateSyncBatch(JSON.parse(commit.body));
    return batch.operations.every(
      (op) =>
        vault.categories.includes(op.entityType) &&
        (!batch.recordManifest.find((entry) => entry.opId === op.opId)?.projectId ||
          vault.projectIds.includes(
            batch.recordManifest.find((entry) => entry.opId === op.opId)?.projectId as string,
          )),
    );
  }

  #state(
    vaultId: string,
    state: string,
    errorCode?: string,
    retryAt = 0,
    lastSyncAt?: string,
  ): void {
    const current = this.#options.storage.sync.vaultTransport(vaultId);
    this.#options.storage.sync.setVaultTransport(vaultId, {
      keyEpoch: current.keyEpoch,
      state,
      retryAt,
      ...(errorCode && { errorCode }),
      ...((lastSyncAt ?? current.lastSyncAt) && { lastSyncAt: lastSyncAt ?? current.lastSyncAt }),
    });
  }

  // Only dependencies in the same category/project can precede a record inside its pack.
  #readyDrafts(vault: SyncVaultRecord, initial: SyncDraftRecord[]): Map<string, PreparedDraft[]> {
    const { storage } = this.#options;
    const nodes = new Map<string, PreparedDraft>();
    const dependencies = new Map<string, PreparedDraft[]>();
    const state = new Map<string, 'visiting' | 'ready'>();
    const ordered: PreparedDraft[] = [];
    const references = new Set<string>();
    const node = (draft: SyncDraftRecord): PreparedDraft => {
      const cached = nodes.get(draft.opId);
      if (cached) return cached;
      if (nodes.size >= MAX_PREPARATION_REFERENCES) throw new ZuvRequestError('QUOTA_EXCEEDED');
      const entity = storage.sync.entity(vault.vaultId, draft.entityId);
      if (!entity) throw new ZuvRequestError('INTEGRITY_FAILED');
      this.#scope(vault, entity.entityType, entity.projectId);
      const payload = draft.content as SyncDraftPayload;
      if (payload.schema !== 'wevir-sync-draft/1') throw new ZuvRequestError('UPGRADE_REQUIRED');
      const value = { draft, entity, payload };
      nodes.set(draft.opId, value);
      return value;
    };
    const referencesOf = (current: PreparedDraft): PreparedDraft[] => {
      const result: PreparedDraft[] = [];
      const reference = (
        opId: string,
        entityId: string,
        kind: 'parent' | 'part' | 'rule' | 'project',
      ) => {
        references.add(opId);
        if (references.size > MAX_PREPARATION_REFERENCES)
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        const draft = storage.sync.draft(vault.vaultId, opId);
        const target = draft ? node(draft) : undefined;
        const stored = target ? undefined : storage.sync.getOperation(vault.vaultId, opId);
        const entity = target?.entity ?? stored;
        if (!entity) {
          if (
            (kind === 'parent' || kind === 'project') &&
            !storage.sync.missingParents(vault.vaultId, entityId, [opId]).length
          )
            return;
          throw new ZuvRequestError('MISSING_PARENT');
        }
        const expectedType =
          kind === 'parent' ? current.entity.entityType : kind === 'part' ? 'artifact' : kind;
        if (entity.entityId !== entityId || entity.entityType !== expectedType)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        if (kind !== 'project' || target) this.#scope(vault, entity.entityType, entity.projectId);
        if (
          kind === 'project'
            ? entity.projectId !== entityId
            : kind === 'rule'
              ? entity.projectId !== undefined && entity.projectId !== current.entity.projectId
              : entity.projectId !== current.entity.projectId
        )
          throw new ZuvRequestError('SCOPE_DISABLED');
        if (target) result.push(target);
        else if (!stored || !['applied', 'committed'].includes(stored.state))
          throw new ZuvRequestError('RECOVERY_REQUIRED');
      };
      for (const parent of current.draft.parents)
        reference(parent, current.draft.entityId, 'parent');
      if (current.entity.projectId && current.entity.entityType !== 'project') {
        const project = storage.sync.projectOperationId(vault.vaultId, current.entity.projectId);
        if (!project) throw new ZuvRequestError('MISSING_PARENT');
        reference(project, current.entity.projectId, 'project');
      }
      if ((current.payload.body as { schema?: string })?.schema === 'wevir-bundle/1') {
        const parsed = SyncBundleContentSchema.safeParse(current.payload.body);
        if (!parsed.success) throw new ZuvRequestError('INTEGRITY_FAILED');
        for (const file of parsed.data.files)
          for (const part of file.parts) reference(part.opId, part.entityId, 'part');
        if (parsed.data.category === 'workspace-snapshot') {
          const metadata = parsed.data.metadata as { ruleVersions?: unknown } | undefined;
          if (metadata?.ruleVersions !== undefined) {
            const rules = SyncBundleContentSchema.shape.files.element.shape.parts.safeParse(
              metadata.ruleVersions,
            );
            if (!rules.success) throw new ZuvRequestError('INTEGRITY_FAILED');
            for (const rule of rules.data) reference(rule.opId, rule.entityId, 'rule');
          }
        }
      }
      return result;
    };
    for (const draft of initial) {
      const stack: Array<{ value: PreparedDraft; next: number }> = [
        { value: node(draft), next: 0 },
      ];
      while (stack.length) {
        const frame = stack[stack.length - 1] as (typeof stack)[number];
        const id = frame.value.draft.opId;
        if (state.get(id) === 'ready') {
          stack.pop();
          continue;
        }
        if (!dependencies.has(id)) {
          state.set(id, 'visiting');
          dependencies.set(id, referencesOf(frame.value));
        }
        const refs = dependencies.get(id) as PreparedDraft[];
        const dependency = refs[frame.next++];
        if (dependency) {
          if (state.get(dependency.draft.opId) === 'visiting')
            throw new ZuvRequestError('INTEGRITY_FAILED');
          if (state.get(dependency.draft.opId) !== 'ready')
            stack.push({ value: dependency, next: 0 });
        } else {
          state.set(id, 'ready');
          ordered.push(frame.value);
          stack.pop();
        }
      }
    }
    const groups = new Map<string, PreparedDraft[]>();
    const first = ordered[0];
    if (!first) return groups;
    const groupKey = (value: PreparedDraft) =>
      jcs([value.entity.entityType, value.entity.projectId ?? null]);
    const key = groupKey(first);
    const selected = new Set<string>();
    const group: PreparedDraft[] = [];
    for (const value of ordered) {
      if (
        groupKey(value) !== key ||
        dependencies.get(value.draft.opId)?.some((ref) => !selected.has(ref.draft.opId))
      )
        continue;
      group.push(value);
      selected.add(value.draft.opId);
      if (group.length >= this.#limit('operations', LIMITS.operations)) break;
    }
    groups.set(key, group);
    return groups;
  }

  async #prepare(vault: SyncVaultRecord, signal: AbortSignal): Promise<void> {
    const { storage, cache } = this.#options;
    if (
      storage.sync
        .commits(vault.vaultId)
        .some(
          (commit) =>
            commit.outcome !== 'rejected' &&
            commit.outcome !== 'recovered' &&
            this.#commitInScope(vault, commit),
        )
    )
      return;
    // A later bundle revision can reference chunks queued after an earlier bundle draft.
    const drafts = storage.sync.drafts(
      vault.vaultId,
      this.#limit('operations', LIMITS.operations),
      vault,
      true,
    );
    const groups = this.#readyDrafts(vault, drafts);
    const keyEpoch = storage.sync.vaultTransport(vault.vaultId).keyEpoch;
    for (const group of groups.values()) {
      const blobId = newId('sbl');
      const commitId = newId('scm');
      const operations: SyncOperation[] = [];
      const manifests: RecordManifest[] = [];
      const records: Record[] = [];
      const selected: SyncDraftRecord[] = [];
      let plainBytes = 32;
      const startSeq = storage.sync.getVault(vault.vaultId)?.deviceSeq as string;
      for (const { draft, entity, payload } of group) {
        const record = packRecord.parse({
          opId: draft.opId,
          entityId: draft.entityId,
          kind: draft.kind,
          parents: draft.parents,
          ...(entity.projectId && { projectId: entity.projectId }),
          content: payload.body,
          ...(payload.events && { events: payload.events }),
        });
        const size = Buffer.byteLength(jcs(record));
        if (
          records.length &&
          plainBytes + size >
            Math.min(
              PACK_TARGET_BYTES,
              this.#limit('blobBytes', LIMITS.blobBytes) - LIMITS.headerBytes,
            )
        )
          break;
        if (size > this.#limit('blobBytes', LIMITS.blobBytes) - LIMITS.headerBytes)
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        if (payload.origin && origin.parse(payload.origin).hostId !== vault.originHostId)
          throw new ZuvRequestError('SCOPE_DISABLED');
        const op = validateOperation({
          protocol: 'wevir-sync/1',
          vaultId: vault.vaultId,
          opId: draft.opId,
          deviceId: vault.deviceId,
          deviceSeq: String(BigInt(startSeq) + BigInt(operations.length + 1)),
          entityType: entity.entityType,
          entityId: draft.entityId,
          kind: draft.kind,
          parents: draft.parents,
          payload: { blobId, recordIndex: records.length },
          ...(payload.origin && { origin: payload.origin }),
          clientTime: draft.createdAt,
        });
        if (op.parents.length > this.#limit('parents', LIMITS.parents))
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        operations.push(op);
        records.push(record);
        selected.push(draft);
        plainBytes += size;
        manifests.push({
          opId: op.opId,
          blobId,
          recordIndex: op.payload?.recordIndex,
          ...(entity.projectId && { projectId: entity.projectId }),
          ...(record.events && {
            events: record.events.map(({ seq, sha256 }) => ({ seq, sha256 })),
          }),
        });
      }
      const body = jcs(validateSyncBatch({ commitId, operations, recordManifest: manifests }));
      if (Buffer.byteLength(jcs({ v: 1, records })) > this.#limit('plainBytes', LIMITS.plainBytes))
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      if (Buffer.byteLength(body) > this.#limit('commitBytes', LIMITS.commitBytes))
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      await cache.assertSpace(vault.vaultId, plainBytes + LIMITS.headerBytes);
      const key = await this.#options.key(vault.vaultId, keyEpoch, signal);
      const bytes = await encryptPack({
        vaultId: vault.vaultId,
        blobId,
        keyEpoch,
        vaultKey: key as Uint8Array,
        records: { v: 1, records },
      });
      if (bytes.length > this.#limit('blobBytes', LIMITS.blobBytes))
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      if (parseEnvelope(bytes).aad.length > this.#limit('headerBytes', LIMITS.headerBytes))
        throw new ZuvRequestError('QUOTA_EXCEEDED');
      const digest = sha256(bytes);
      const path = await cache.put(vault.vaultId, blobId, bytes, digest);
      this.#guard(vault, signal);
      storage.transaction(() => {
        if (storage.sync.getVault(vault.vaultId)?.deviceSeq !== startSeq)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        storage.sync.putBlob({
          vaultId: vault.vaultId,
          blobId,
          cipherBytes: bytes.length,
          cipherSha256: digest,
          keyEpoch,
          cachePath: path,
          state: 'local',
          uploadAttempts: 0,
          downloadAttempts: 0,
        });
        for (const [index, op] of operations.entries()) {
          if (storage.sync.nextDeviceSeq(vault.vaultId) !== op.deviceSeq)
            throw new ZuvRequestError('INTEGRITY_FAILED');
          const manifest = manifests[index] as RecordManifest;
          storage.sync.putOperation({
            vaultId: vault.vaultId,
            opId: op.opId,
            deviceId: op.deviceId,
            deviceSeq: op.deviceSeq,
            entityType: op.entityType,
            entityId: op.entityId,
            ...(manifest.projectId && { projectId: manifest.projectId }),
            envelope: op,
            manifest,
            digest: sha256(jcs({ operation: op, recordManifest: manifest })),
            record: records[index],
            direction: 'outbox',
            state: 'queued',
            commitId,
          });
          storage.sync.applyHeads(vault.vaultId, op.entityId, op.opId, op.parents);
          storage.sync.removeDraft(vault.vaultId, op.opId);
        }
        storage.sync.putCommit({
          vaultId: vault.vaultId,
          commitId,
          body,
          state: 'queued',
          attempts: 0,
          retryAt: 0,
        });
      });
      // Keep one immutable commit in flight so later revisions cannot overtake its parents.
      if (selected.length) return;
    }
  }

  async #push(vault: SyncVaultRecord, signal: AbortSignal): Promise<void> {
    const { storage, client } = this.#options;
    const commit = storage.sync
      .commits(vault.vaultId)
      .find(
        (value) =>
          value.outcome !== 'rejected' &&
          value.outcome !== 'recovered' &&
          this.#commitInScope(vault, value),
      );
    if (!commit || commit.retryAt > Date.now()) return;
    if (commit.outcome === 'rejected')
      throw new ZuvRequestError(
        (commit.errorCode ?? 'RECOVERY_REQUIRED') as ConstructorParameters<
          typeof ZuvRequestError
        >[0],
      );
    if (commit.outcome === 'recovered') return;
    const batch = validateSyncBatch(JSON.parse(commit.body));
    for (const op of batch.operations) {
      const manifest = batch.recordManifest.find(
        (entry) => entry.opId === op.opId,
      ) as RecordManifest;
      this.#scope(vault, op.entityType, manifest.projectId);
      if (op.deviceId !== vault.deviceId || (op.origin && op.origin.hostId !== vault.originHostId))
        throw new ZuvRequestError('RECOVERY_REQUIRED');
    }
    if (commit.state === 'pending' || commit.attempts > 0) {
      this.#guard(vault, signal);
      const queried = {
        ...commit,
        outcome: 'uncertain' as const,
        queries: (commit.queries ?? 0) + 1,
        retryAt: Date.now() + 10000,
      };
      storage.transaction(() => storage.sync.putCommit(queried));
      try {
        const result = await client.json(
          'commitResult',
          'GET',
          `/api/wevir/sync/v1/commits/${commit.commitId}`,
          undefined,
          { signal },
        );
        this.#guard(vault, signal);
        this.#commitResult(vault, queried, result, batch.operations);
        return;
      } catch (error) {
        if (!(error instanceof ZuvRequestError) || error.code !== 'NOT_FOUND') throw error;
      }
    }

    for (const blobId of new Set(
      batch.operations.flatMap((op) => (op.payload ? [op.payload.blobId] : [])),
    )) {
      await this.#upload(
        vault,
        blobId,
        (batch.operations.find((op) => op.payload?.blobId === blobId) as SyncOperation).entityType,
        signal,
      );
    }
    this.#guard(vault, signal);
    const attempted = { ...commit, attempts: commit.attempts + 1, outcome: 'uncertain' as const };
    storage.transaction(() => storage.sync.putCommit(attempted));
    try {
      const result = await client.transfer({
        method: 'POST',
        path: '/api/wevir/sync/v1/commits',
        body: Buffer.from(commit.body),
        maxBytes: 8192,
        signal,
      });
      const parsed = schemas.commitResult.safeParse(JSON.parse(result.bytes.toString('utf8')));
      if (!parsed.success) throw new ZuvRequestError('INTEGRITY_FAILED');
      this.#guard(vault, signal);
      this.#commitResult(vault, attempted, parsed.data, batch.operations);
    } catch (error) {
      if (
        error instanceof ZuvRequestError &&
        [
          'RATE_LIMITED',
          'BUDGET_PAUSED',
          'SUBSCRIPTION_REQUIRED',
          'AUTH_REQUIRED',
          'DEVICE_REVOKED',
        ].includes(error.code)
      )
        storage.transaction(() => storage.sync.putCommit({ ...commit, attempts: 0, queries: 0 }));
      if (
        error instanceof ZuvRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        COMMIT_REJECTIONS.has(error.code)
      ) {
        storage.transaction(() => {
          storage.sync.putCommit({
            ...attempted,
            outcome: 'rejected',
            errorCode: error.code,
            retryAt: 0,
          });
          for (const op of batch.operations) {
            const entity = storage.sync.entity(vault.vaultId, op.entityId);
            if (op.kind === 'resolve' && entity?.revision === op.opId) {
              storage.sync.putEntity({ ...entity, revision: undefined });
              storage.db
                .prepare('DELETE FROM sync_heads WHERE vault_id=? AND entity_id=? AND op_id=?')
                .run(vault.vaultId, op.entityId, op.opId);
              for (const parent of op.parents) {
                const descendant = storage.db
                  .prepare(`SELECT 1 FROM sync_operations o LEFT JOIN sync_commits c
                  ON c.vault_id=o.vault_id AND c.commit_id=o.commit_id
                  WHERE o.vault_id=? AND o.entity_id=? AND o.state IN ('queued','pending','committed','applied')
                  AND coalesce(c.outcome,'ready')!='rejected'
                  AND ? IN (SELECT value FROM json_each(o.envelope,'$.parents')) LIMIT 1`)
                  .get(vault.vaultId, op.entityId, parent);
                if (!descendant)
                  storage.db
                    .prepare(
                      'INSERT OR IGNORE INTO sync_heads (vault_id,entity_id,op_id) VALUES (?,?,?)',
                    )
                    .run(vault.vaultId, op.entityId, parent);
              }
            }
          }
        });
      }
      throw error;
    }
  }

  async #repairMissing(vault: SyncVaultRecord, signal: AbortSignal) {
    if (this.#missingAt > Date.now()) return;
    this.#missingAt = Date.now() + 10 * 60 * 1000;
    const { storage, client, cache } = this.#options;
    const referenced = storage.db
      .prepare(`SELECT json_extract(envelope,'$.payload.blobId') AS blob_id
      FROM sync_operations WHERE vault_id=? UNION SELECT json_extract(envelope,'$.payload.blobId') AS blob_id
      FROM sync_bootstrap_entries WHERE vault_id=?`)
      .all(vault.vaultId, vault.vaultId);
    const removed = await cache.collect(
      vault.vaultId,
      new Set(referenced.flatMap((row) => (typeof row.blob_id === 'string' ? [row.blob_id] : []))),
      Date.now() - 7 * 86400000,
    );
    if (removed.length)
      storage.db
        .prepare(
          'DELETE FROM sync_blobs WHERE vault_id=? AND blob_id IN (SELECT value FROM json_each(?))',
        )
        .run(vault.vaultId, JSON.stringify(removed));
    let after: string | undefined;
    do {
      const page = await client.json(
        'missingBlobs',
        'GET',
        `/api/wevir/sync/v1/blobs/missing${after ? `?after=${after}` : ''}`,
        undefined,
        { signal },
      );
      for (const missing of page.blobs) {
        const blob = storage.sync.blob(vault.vaultId, missing.blobId);
        if (
          !blob ||
          blob.cipherBytes !== missing.cipherBytes ||
          blob.cipherSha256 !== missing.cipherSha256 ||
          blob.keyEpoch !== missing.keyEpoch
        )
          continue;
        try {
          await cache.read(vault.vaultId, blob.blobId, blob.cipherBytes, blob.cipherSha256);
        } catch {
          continue;
        }
        await this.#upload(vault, blob.blobId, missing.purpose, signal, true);
      }
      after = page.next ?? undefined;
    } while (after);
  }

  async #upload(
    vault: SyncVaultRecord,
    blobId: string,
    purpose: string,
    signal: AbortSignal,
    force = false,
  ) {
    const { storage, client, cache } = this.#options;
    this.#guard(vault, signal);
    const blob = storage.sync.blob(vault.vaultId, blobId);
    if (!blob) throw new ZuvRequestError('INTEGRITY_FAILED');
    if (blob.state === 'ready' && !force) return;
    if (blob.state === 'quarantined') throw new ZuvRequestError('INTEGRITY_FAILED');
    if ((blob.retryAt ?? 0) > Date.now()) throw new ZuvRequestError('RATE_LIMITED');
    const bytes = await cache.read(vault.vaultId, blobId, blob.cipherBytes, blob.cipherSha256);
    if (bytes.length > this.#maximumTransferBytes()) throw new ZuvRequestError('QUOTA_EXCEEDED');
    storage.sync.putBlob({
      ...blob,
      uploadAttempts: blob.uploadAttempts + 1,
      retryAt: Date.now() + TRANSFER_RETRY_MS,
    });
    const reserved = await client.json(
      'blobReserved',
      'POST',
      '/api/wevir/sync/v1/blobs/reserve',
      {
        blobId,
        cipherBytes: bytes.length,
        cipherSha256: blob.cipherSha256,
        purpose,
      },
      { signal },
    );
    if (Date.parse(reserved.expiresAt) <= Date.now()) throw new ZuvRequestError('RATE_LIMITED');
    this.#guard(vault, signal);
    storage.sync.putBlob({
      ...blob,
      state: 'reserved',
      retryAt: Date.now() + TRANSFER_RETRY_MS,
      uploadAttempts: blob.uploadAttempts + 1,
      uploadId: reserved.uploadId,
      uploadExpiresAt: reserved.expiresAt,
    });
    const uploaded = await client.transfer({
      method: 'PUT',
      path: `/api/wevir/sync/v1/uploads/${reserved.uploadId}`,
      body: bytes,
      contentType: 'application/octet-stream',
      maxBytes: 8192,
      signal,
      transfer: this.#transferLimits(),
    });
    const result = schemas.uploaded.safeParse(JSON.parse(uploaded.bytes.toString('utf8')));
    if (!result.success || result.data.blobId !== blobId)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    this.#guard(vault, signal);
    storage.sync.putBlob({ ...blob, state: 'ready', uploadAttempts: 0, retryAt: 0 });
  }

  #commitResult(
    vault: SyncVaultRecord,
    commit: SyncCommitRecord,
    result: typeof schemas.commitResult._output,
    operations: SyncOperation[],
  ): void {
    if (result.commitId !== commit.commitId) throw new ZuvRequestError('INTEGRITY_FAILED');
    const { storage } = this.#options;
    storage.transaction(() => {
      storage.sync.putCommit({
        ...commit,
        outcome: result.state === 'committed' ? 'ready' : 'uncertain',
        errorCode: undefined,
        state: result.state,
        queries: 0,
        ...(result.state === 'committed' && { cursor: result.cursor }),
        retryAt: result.state === 'pending' ? Date.now() + 10000 : 0,
      });
      for (const op of operations)
        storage.sync.markOperation(
          vault.vaultId,
          op.opId,
          result.state === 'committed' ? 'committed' : 'pending',
        );
    });
  }

  async #pull(vault: SyncVaultRecord, signal: AbortSignal): Promise<void> {
    const { storage, client } = this.#options;
    for (const page of storage.sync.pages(vault.vaultId))
      await this.#applyPage(vault, page.pageId, page.opIds, signal);
    this.#guard(vault, signal);
    const cursor = storage.sync.getVault(vault.vaultId)?.appliedCursor as string;
    const query = new URLSearchParams({
      limit: String(this.#limit('operations', LIMITS.operations)),
      ...(cursor && { cursor }),
    });
    const changes = await client.json(
      'changes',
      'GET',
      `/api/wevir/sync/v1/changes?${query}`,
      undefined,
      { signal, maxBytes: this.#limit('changeBytes', LIMITS.changeBytes) },
    );
    const pageId = newId('spg');
    try {
      validateSyncPage(changes);
    } catch {
      throw new ZuvRequestError('INTEGRITY_FAILED');
    }
    this.#guard(vault, signal);
    storage.transaction(() => {
      for (const op of changes.operations) {
        if (op.vaultId !== vault.vaultId) throw new ZuvRequestError('INTEGRITY_FAILED');
        const manifest = changes.recordManifest.find(
          (entry) => entry.opId === op.opId,
        ) as RecordManifest;
        this.#scope(vault, op.entityType, manifest.projectId);
        storage.sync.putOperation({
          vaultId: vault.vaultId,
          opId: op.opId,
          deviceId: op.deviceId,
          deviceSeq: op.deviceSeq,
          entityId: op.entityId,
          entityType: op.entityType,
          ...(manifest.projectId && { projectId: manifest.projectId }),
          envelope: op,
          manifest,
          digest: sha256(jcs({ operation: op, recordManifest: manifest })),
          direction: 'inbox',
          state: 'received',
        });
      }
      storage.sync.putPage({
        vaultId: vault.vaultId,
        pageId,
        fromCursor: cursor,
        nextCursor: changes.nextCursor,
        opIds: changes.operations.map((op) => op.opId),
      });
    });
    await this.#applyPage(
      vault,
      pageId,
      changes.operations.map((op) => op.opId),
      signal,
    );
    storage.transaction(() => {
      for (const commit of storage.sync.commits(vault.vaultId)) {
        const batch = validateSyncBatch(JSON.parse(commit.body));
        if (
          batch.operations.every(
            (op) => storage.sync.getOperation(vault.vaultId, op.opId)?.state === 'committed',
          )
        )
          storage.sync.putCommit({
            ...commit,
            state: 'committed',
            outcome: 'ready',
            cursor: changes.nextCursor,
            errorCode: undefined,
            retryAt: 0,
          });
      }
    });
    this.#guard(vault, signal);
    await client.json(
      'applied',
      'POST',
      '/api/wevir/sync/v1/devices/ack',
      { cursor: changes.nextCursor },
      { signal },
    );
    storage.transaction(() => {
      storage.db
        .prepare(
          "UPDATE sync_operations SET acknowledged=1 WHERE vault_id=? AND direction='outbox' AND op_id IN (SELECT value FROM json_each(?))",
        )
        .run(vault.vaultId, JSON.stringify(changes.operations.map((op) => op.opId)));
      storage.db
        .prepare(`UPDATE sync_commits SET body='' WHERE vault_id=? AND state='committed' AND body!=''
        AND EXISTS (SELECT 1 FROM sync_operations o WHERE o.vault_id=sync_commits.vault_id AND o.commit_id=sync_commits.commit_id)
        AND NOT EXISTS (SELECT 1 FROM sync_operations o WHERE o.vault_id=sync_commits.vault_id AND o.commit_id=sync_commits.commit_id AND o.acknowledged=0)`)
        .run(vault.vaultId);
      storage.db
        .prepare('DELETE FROM sync_pages WHERE vault_id=? AND applied=1')
        .run(vault.vaultId);
    });
  }

  async #applyPage(
    vault: SyncVaultRecord,
    pageId: string,
    opIds: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const { storage } = this.#options;
    const pending = opIds
      .map((id) => storage.sync.getOperation(vault.vaultId, id) as SyncOperationRecord)
      .filter((op) => !['applied', 'committed'].includes(op.state));
    const byBlob = new Map<string, SyncOperationRecord[]>();
    const verified = new Map<string, Record>();
    for (const stored of pending) {
      if (stored.direction === 'outbox') {
        storage.transaction(() => {
          storage.sync.confirmRecoveredOutbox(vault.vaultId, stored.opId);
          storage.sync.markOperation(vault.vaultId, stored.opId, 'committed');
        });
        continue;
      }
      if (
        stored.state === 'quarantined' &&
        stored.errorCode === 'UPGRADE_REQUIRED' &&
        stored.quarantineVersion !== PROTOCOL_VERSION
      )
        storage.sync.markOperation(vault.vaultId, stored.opId, 'received');
      else if (stored.state === 'quarantined')
        throw new ZuvRequestError(
          stored.errorCode === 'UPGRADE_REQUIRED' ? 'UPGRADE_REQUIRED' : 'INTEGRITY_FAILED',
        );
      const op = validateOperation(stored.envelope);
      const group = byBlob.get(op.payload?.blobId ?? '') ?? [];
      group.push(stored);
      byBlob.set(op.payload?.blobId ?? '', group);
    }
    for (const [blobId, group] of byBlob) {
      const operations = group.map((row) => validateOperation(row.envelope));
      const manifests = group.map((row) => schemas.recordManifest.parse(row.manifest));
      let records: Record[];
      try {
        if (!blobId)
          records = operations.map((op) =>
            packRecord.parse({
              opId: op.opId,
              entityId: op.entityId,
              kind: op.kind,
              parents: op.parents,
              content: null,
              ...(manifests.find((m) => m.opId === op.opId)?.projectId && {
                projectId: manifests.find((m) => m.opId === op.opId)?.projectId,
              }),
            }),
          );
        else {
          const bytes = await this.#download(vault, blobId, signal);
          const header = parseEnvelope(bytes).header;
          if (
            BigInt(header.keyEpoch) > BigInt(storage.sync.vaultTransport(vault.vaultId).keyEpoch)
          ) {
            const refreshed = await this.#options.client.getEntitlements();
            if (
              refreshed.vault?.vaultId !== vault.vaultId ||
              BigInt(header.keyEpoch) > BigInt(refreshed.vault.keyEpoch)
            )
              throw new ZuvRequestError('RECOVERY_REQUIRED');
            storage.sync.setVaultTransport(vault.vaultId, {
              ...storage.sync.vaultTransport(vault.vaultId),
              keyEpoch: refreshed.vault.keyEpoch,
            });
          }
          if (
            header.vaultId !== vault.vaultId ||
            header.blobId !== blobId ||
            BigInt(header.keyEpoch) > BigInt(storage.sync.vaultTransport(vault.vaultId).keyEpoch)
          )
            throw new ZuvRequestError('INTEGRITY_FAILED');
          const key = await this.#options.key(vault.vaultId, header.keyEpoch, signal);
          records = (await decryptPack(bytes, key, operations, manifests)).records;
        }
      } catch (error) {
        if (error instanceof ZuvRequestError && error.code !== 'INTEGRITY_FAILED') throw error;
        if (
          ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE'].includes(
            (error as NodeJS.ErrnoException | undefined)?.code ?? '',
          )
        )
          throw error;
        storage.transaction(() => {
          for (const op of operations)
            storage.sync.markOperation(vault.vaultId, op.opId, 'quarantined', 'INTEGRITY_FAILED');
        });
        const blob = storage.sync.blob(vault.vaultId, blobId);
        if (blob)
          storage.sync.putBlob({ ...blob, state: 'quarantined', errorCode: 'INTEGRITY_FAILED' });
        throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      for (const record of records) verified.set(record.opId, record);
    }
    for (const stored of pending) {
      if (stored.direction === 'outbox') continue;
      const op = validateOperation(stored.envelope);
      this.#guard(vault, signal);
      const record = verified.get(op.opId);
      if (!record) throw new ZuvRequestError('INTEGRITY_FAILED');
      if (storage.sync.missingParents(vault.vaultId, op.entityId, op.parents).length)
        throw new ZuvRequestError('MISSING_PARENT');
      let apply: () => void;
      try {
        apply = await this.#options.prepareApply(op, record, signal);
      } catch (error) {
        if (
          error instanceof ZuvRequestError &&
          ['INTEGRITY_FAILED', 'UPGRADE_REQUIRED'].includes(error.code)
        )
          storage.sync.markOperation(
            vault.vaultId,
            op.opId,
            'quarantined',
            error.code,
            PROTOCOL_VERSION,
          );
        throw error;
      }
      this.#guard(vault, signal);
      storage.transaction(() => {
        apply();
        storage.sync.putVerifiedRecord(vault.vaultId, op.opId, record);
        storage.sync.applyHeads(vault.vaultId, op.entityId, op.opId, op.parents);
        storage.sync.markOperation(vault.vaultId, op.opId, 'applied');
      });
    }
    this.#guard(vault, signal);
    storage.transaction(() => storage.sync.applyPage(vault.vaultId, pageId));
  }

  async #download(vault: SyncVaultRecord, blobId: string, signal: AbortSignal): Promise<Buffer> {
    return new SyncDownloads({
      ...this.#options,
      guard: (current, token) => this.#guard(current, token),
    }).read(vault, blobId, signal);
  }

  #limit(name: string, baseline: number): number {
    const limit = Math.min(baseline, this.#options.client.entitlements?.limits[name] ?? baseline);
    if (limit < 1) throw new ZuvRequestError('QUOTA_EXCEEDED');
    return limit;
  }
  #transferLimits(): { bytesPerSecond: number; chunkBytes: number; timeoutMs: number } {
    return {
      bytesPerSecond: this.#limit('transferBytesPerSecond', LIMITS.transferBytesPerSecond),
      chunkBytes: this.#limit('transferChunkBytes', LIMITS.transferChunkBytes),
      timeoutMs: this.#limit('transferMs', LIMITS.transferMs),
    };
  }
  #maximumTransferBytes(): number {
    const limits = this.#transferLimits();
    return Math.min(
      this.#limit('blobBytes', LIMITS.blobBytes),
      Math.floor((limits.bytesPerSecond * limits.timeoutMs) / 1000),
    );
  }
}
