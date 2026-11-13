import { SyncBundleContentSchema, validateSyncBatch } from '@wevir/protocol';
import { jcs, matchRecord, packRecord } from '@wevir/protocol/sync';
import type { Storage, SyncCommitRecord, SyncDraftRecord, SyncVaultRecord } from '@wevir/storage';
import { newId } from '../ids.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import type { SyncDraftPayload } from './queue.js';

export function rebaseResetCommit(
  storage: Storage,
  vault: SyncVaultRecord,
  jobId: string,
  commit: SyncCommitRecord,
  verified: ReadonlyMap<string, typeof packRecord._output>,
): void {
  if (commit.attempts || commit.state !== 'queued' || commit.rebased)
    throw new ZuvRequestError('RECOVERY_REQUIRED');
  const batch = validateSyncBatch(JSON.parse(commit.body));
  const ids = new Map(batch.operations.map((op) => [op.opId, newId('sop')]));
  const remap = (draft: SyncDraftRecord): SyncDraftRecord => {
    const payload = draft.content as SyncDraftPayload;
    if (payload.schema !== 'wevir-sync-draft/1') throw new ZuvRequestError('UPGRADE_REQUIRED');
    let body = payload.body;
    if ((body as { schema?: string })?.schema === 'wevir-bundle/1') {
      const bundle = SyncBundleContentSchema.parse(body);
      body = {
        ...bundle,
        files: bundle.files.map((file) => ({
          ...file,
          parts: file.parts.map((part) => ({ ...part, opId: ids.get(part.opId) ?? part.opId })),
        })),
      };
    }
    return {
      ...draft,
      parents: draft.parents.map((id) => ids.get(id) ?? id),
      content: { ...payload, body },
    };
  };
  storage.transaction(() => {
    for (const operation of batch.operations) {
      const stored = storage.sync.getOperation(vault.vaultId, operation.opId);
      const manifest = batch.recordManifest.find((entry) => entry.opId === operation.opId);
      const record = packRecord.parse(stored?.record);
      if (
        !stored ||
        !manifest ||
        stored.direction !== 'outbox' ||
        stored.state !== 'queued' ||
        operation.deviceId !== vault.deviceId ||
        (operation.origin && operation.origin.hostId !== vault.originHostId) ||
        stored.digest !== sha256(jcs({ operation, recordManifest: manifest })) ||
        jcs(verified.get(operation.opId) ?? null) !== jcs(record)
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      matchRecord(operation, record, manifest);
      const opId = ids.get(operation.opId) as string;
      const draft = remap({
        vaultId: vault.vaultId,
        opId,
        entityId: operation.entityId,
        kind: operation.kind === 'resolve' ? 'put' : operation.kind,
        parents: operation.parents,
        content: {
          schema: 'wevir-sync-draft/1',
          body: record.content,
          ...(operation.origin && { origin: operation.origin }),
          ...(record.events && { events: record.events }),
        },
        createdAt: operation.clientTime ?? new Date().toISOString(),
      });
      storage.sync.putDraft(draft);
      storage.sync.rebaseOperation(vault.vaultId, operation.opId, opId);
      const entity = storage.sync.entity(vault.vaultId, operation.entityId);
      if (entity?.revision === operation.opId)
        storage.sync.putEntity({
          ...entity,
          revision: opId,
          fingerprint: sha256(jcs({ kind: draft.kind, content: draft.content })),
        });
    }
    for (const opId of storage.sync.draftsReferencing(vault.vaultId, [...ids.keys()])) {
      const original = storage.sync.draft(vault.vaultId, opId) as SyncDraftRecord;
      const draft = remap(original);
      storage.sync.saveResetDraft(jobId, original);
      storage.sync.removeDraft(vault.vaultId, opId);
      storage.sync.putDraft(draft);
      const entity = storage.sync.entity(vault.vaultId, draft.entityId);
      if (entity?.revision === opId)
        storage.sync.putEntity({
          ...entity,
          fingerprint: sha256(jcs({ kind: draft.kind, content: draft.content })),
        });
    }
    storage.sync.rebaseCommit(vault.vaultId, commit.commitId);
  });
}
