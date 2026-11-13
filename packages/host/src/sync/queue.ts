import { type EntityType, jcs, type packRecord, type SyncOperation } from '@wevir/protocol/sync';

export interface SyncDraftPayload {
  schema: 'wevir-sync-draft/1';
  body: unknown;
  origin?: SyncOperation['origin'];
  events?: typeof packRecord._output.events;
}
export type SyncMaterialRevision = Omit<SyncOperation, 'protocol' | 'deviceSeq' | 'payload'>;
export interface SyncApplyContext {
  replaceRevision?: string;
  preserveRevision?: boolean;
}

import type { Storage, SyncEntityRecord } from '@wevir/storage';
import { newId } from '../ids.js';
import { sha256 } from './crypto.js';

export class SyncQueue {
  readonly #storage: Storage;
  constructor(storage: Storage) {
    this.#storage = storage;
  }

  enqueue(input: {
    opId?: string;
    vaultId: string;
    entityType: EntityType;
    localKey: string;
    content: unknown;
    projectId?: string;
    entityId?: string;
    kind?: 'put' | 'delete' | 'append' | 'resolve';
    parents?: string[];
    source?: Pick<SyncDraftPayload, 'origin' | 'events'>;
  }): string | undefined {
    if (!this.#storage.db.isTransaction)
      throw new Error('sync enqueue requires a business transaction');
    if (!this.#storage.sync.claimResource(input.localKey, input.vaultId)) return undefined;
    const existing =
      input.entityId === undefined
        ? this.#storage.sync.localEntity(input.vaultId, input.localKey)
        : this.#storage.sync.entity(input.vaultId, input.entityId);
    const kind = input.kind ?? 'put';
    const payload: SyncDraftPayload = {
      schema: 'wevir-sync-draft/1',
      body: input.content,
      ...input.source,
    };
    const fingerprint = sha256(jcs({ kind, content: payload }));
    if (existing?.fingerprint === fingerprint && kind !== 'resolve') return undefined;
    const opId = input.opId ?? newId('sop');
    const entity: SyncEntityRecord = {
      vaultId: input.vaultId,
      entityId: existing?.entityId ?? input.entityId ?? newId('sen'),
      entityType: input.entityType,
      ...(input.projectId && { projectId: input.projectId }),
      localKey: input.localKey,
      revision: opId,
      fingerprint,
      materialized: true,
    };
    const parents = input.parents ?? (existing?.revision ? [existing.revision] : []);
    this.#storage.sync.putEntity(entity);
    this.#storage.sync.putDraft({
      vaultId: input.vaultId,
      opId,
      entityId: entity.entityId,
      kind,
      parents,
      content: payload,
      createdAt: new Date().toISOString(),
    });
    return opId;
  }
}
