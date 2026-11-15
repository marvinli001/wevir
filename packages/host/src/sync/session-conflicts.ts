import {
  type MethodParams,
  type SessionId,
  SyncSessionConflictContentSchema,
  SyncSessionStateContentSchema,
} from '@wevir/protocol';
import { jcs, packRecord } from '@wevir/protocol/sync';
import type {
  Storage,
  SyncContentRefRecord,
  SyncEntityRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { syncAncestors, syncParents } from './ancestry.js';
import { sha256 } from './crypto.js';
import { type SyncDraftPayload, SyncQueue } from './queue.js';
import type { SyncSessionMaterials } from './session-materials.js';

type Content = typeof SyncSessionConflictContentSchema._output;
interface Options {
  storage: Storage;
  materials: SyncSessionMaterials;
  eligible: () => SyncVaultRecord | undefined;
}

export class SyncSessionConflicts {
  constructor(readonly options: Options) {}

  list(after?: string) {
    const vault = this.#vault();
    const entries = this.options.storage.sync.sessionConflictEntities(
      vault.vaultId,
      vault.projectIds,
      after,
    );
    const conflicts = entries.slice(0, 100).flatMap((entity) => {
      const ref = this.#ref(vault, entity);
      const heads = this.#heads(vault, entity);
      if (heads.length < 2) return [];
      if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
      const sessionId = this.#session(vault, ref);
      return [
        {
          entityId: entity.entityId,
          kind: ref.kind,
          sessionId,
          title: this.options.storage.sessions.get(sessionId)?.title ?? '',
          heads,
        },
      ];
    });
    return { conflicts, ...(entries.length > 100 && { next: entries[99]?.entityId }) };
  }

  preview(entityId: string, historical = false) {
    const vault = this.#vault();
    const snapshot = this.#snapshot(vault, entityId, historical);
    const baseId =
      snapshot.heads.length === 2 ? this.#base(vault, snapshot.entity, snapshot.heads) : undefined;
    const base = baseId ? this.#version(vault, snapshot.entity, snapshot.ref, baseId) : undefined;
    let merged: typeof SyncSessionStateContentSchema._output | undefined;
    if (snapshot.ref.kind === 'session' && base) {
      const before = this.#state(base.content);
      const left = this.#state(snapshot.versions[0]?.content as Content);
      const right = this.#state(snapshot.versions[1]?.content as Content);
      if (before && left && right) {
        const title = this.#field(
          [before.title, before.titleSource],
          [left.title, left.titleSource],
          [right.title, right.titleSource],
        );
        const archivedAt = this.#field(before.archivedAt, left.archivedAt, right.archivedAt);
        if (title && archivedAt !== undefined)
          merged = SyncSessionStateContentSchema.parse({
            ...before,
            title: title[0],
            titleSource: title[1],
            archivedAt,
          });
      }
    }
    return {
      vaultId: vault.vaultId,
      entityId,
      kind: snapshot.ref.kind,
      sessionId: this.#session(vault, snapshot.ref),
      expectedHeads: snapshot.heads,
      localRevision: snapshot.entity.revision as string,
      localFingerprint: this.#fingerprint(vault, snapshot.ref),
      versions: snapshot.versions,
      ...(base && { base }),
      ...(merged && { merged }),
      mergeState: merged
        ? ('clean' as const)
        : base
          ? ('conflict' as const)
          : ('unavailable' as const),
    };
  }

  async resolve(input: MethodParams<'sync.resolveSession'>, historical?: Content) {
    const vault = this.#vault();
    if (vault.vaultId !== input.vaultId) throw new ZuvRequestError('REVISION_CONFLICT');
    const snapshot = this.#snapshot(vault, input.entityId, historical !== undefined);
    const check = () => {
      const current = this.#vault();
      const entity = this.options.storage.sync.entity(vault.vaultId, input.entityId);
      const heads = entity && this.#heads(vault, entity);
      if (
        current.vaultId !== vault.vaultId ||
        current.deviceId !== vault.deviceId ||
        current.revision !== vault.revision ||
        entity?.revision !== input.localRevision ||
        !heads ||
        heads.length !== input.expectedHeads.length ||
        heads.some((head) => !input.expectedHeads.includes(head)) ||
        this.#fingerprint(vault, snapshot.ref) !== input.localFingerprint
      )
        throw new ZuvRequestError('REVISION_CONFLICT');
    };
    check();
    const body =
      historical ??
      (input.selection.kind === 'merged'
        ? this.preview(input.entityId).merged
        : snapshot.versions.find(
            (version) =>
              version.opId === (input.selection.kind === 'version' ? input.selection.opId : ''),
          )?.content);
    if (!body) throw new ZuvRequestError('INVALID_REQUEST');
    const opId = newId('sop');
    const op = {
      vaultId: vault.vaultId,
      opId,
      entityId: input.entityId,
      entityType: 'session' as const,
      deviceId: vault.deviceId,
      kind:
        input.expectedHeads.length > 1
          ? ('resolve' as const)
          : body.schema === 'wevir-session-deleted/1' ||
              (body.schema === 'wevir-episode/1' && body.deleted)
            ? ('delete' as const)
            : ('put' as const),
      parents: input.expectedHeads,
      clientTime: new Date().toISOString(),
    };
    const apply = await this.options.materials.prepare(
      op,
      packRecord.parse({
        opId,
        entityId: input.entityId,
        projectId: snapshot.entity.projectId,
        kind: op.kind,
        parents: input.expectedHeads,
        content: body,
      }),
      { replaceRevision: input.localRevision },
    );
    const { storage } = this.options;
    storage.transaction(() => {
      check();
      apply();
      if (storage.sync.entity(vault.vaultId, input.entityId)?.revision !== opId)
        throw new ZuvRequestError('REVISION_CONFLICT');
      const queued = new SyncQueue(storage).enqueue({
        ...op,
        localKey: snapshot.entity.localKey,
        projectId: snapshot.entity.projectId,
        content: body,
      });
      if (!queued) throw new ZuvRequestError('SCOPE_DISABLED');
      storage.sync.clearMaterialConflicts(vault.vaultId, input.entityId, input.expectedHeads);
      if (snapshot.ref.kind !== 'session')
        storage.sync.putFileBaseline({
          vaultId: vault.vaultId,
          entityId: input.entityId,
          entityType: 'session',
          projectId: snapshot.entity.projectId,
          path: `sqlite:${snapshot.entity.localKey}`,
          fingerprint: this.#fingerprint(vault, snapshot.ref),
        });
    });
    return { opId };
  }

  #vault() {
    const vault = this.options.eligible();
    if (!vault?.categories.includes('session')) throw new ZuvRequestError('SCOPE_DISABLED');
    return vault;
  }
  #snapshot(vault: SyncVaultRecord, entityId: string, historical = false) {
    const entity = this.options.storage.sync.entity(vault.vaultId, entityId);
    if (!entity) throw new ZuvRequestError('SCOPE_DISABLED');
    const ref = this.#ref(vault, entity);
    const heads = this.#heads(vault, entity);
    if (heads.length < (historical ? 1 : 2)) throw new ZuvRequestError('REVISION_CONFLICT');
    if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
    return {
      entity,
      ref,
      heads,
      versions: heads.map((head) => this.#version(vault, entity, ref, head)),
    };
  }
  #ref(vault: SyncVaultRecord, entity: SyncEntityRecord) {
    const ref = this.options.storage.sync
      .contentRefs(vault.vaultId)
      .find((value) => value.entityId === entity.entityId);
    if (
      entity.entityType !== 'session' ||
      !entity.materialized ||
      !entity.revision ||
      !entity.projectId ||
      !vault.projectIds.includes(entity.projectId) ||
      !ref?.localId ||
      (this.options.storage.sync.owner(entity.localKey) ?? vault.vaultId) !== vault.vaultId
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    this.#session(vault, ref);
    return ref;
  }
  #session(vault: SyncVaultRecord, ref: SyncContentRefRecord): SessionId {
    const source = this.options.storage.sync
      .sources(vault.vaultId)
      .find(
        (value) =>
          value.hostId === ref.source.hostId &&
          value.deviceId === ref.source.deviceId &&
          value.sessionId === ref.source.sessionId &&
          value.streamId === ref.source.streamId,
      );
    if (!source?.localSessionId || !this.options.storage.sessions.get(source.localSessionId))
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    return source.localSessionId as SessionId;
  }
  #fingerprint(vault: SyncVaultRecord, ref: SyncContentRefRecord): string {
    const storage = this.options.storage;
    const sessionId = this.#session(vault, ref);
    if (ref.kind === 'episode')
      return sha256(jcs(storage.episodes.get(ref.localId as string) ?? null));
    if (ref.kind === 'retro-summary')
      return sha256(jcs(storage.retros.getSummary(sessionId) ?? null));
    const session = storage.sessions.get(sessionId);
    return sha256(
      jcs({
        title: session?.title,
        titleSource: session?.titleSource,
        archivedAt: session?.archivedAt ?? null,
        deleted: storage.sync.sessionDeleted(sessionId),
      }),
    );
  }
  #version(
    vault: SyncVaultRecord,
    entity: SyncEntityRecord,
    ref: SyncContentRefRecord,
    opId: string,
  ) {
    const operation = this.options.storage.sync.getOperation(vault.vaultId, opId);
    const draft = operation ? undefined : this.options.storage.sync.draft(vault.vaultId, opId);
    if (
      (operation &&
        (operation.entityId !== entity.entityId ||
          operation.entityType !== 'session' ||
          operation.projectId !== entity.projectId ||
          operation.state === 'quarantined' ||
          !operation.record)) ||
      (draft && draft.entityId !== entity.entityId) ||
      (!operation && !draft)
    )
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const record = operation ? packRecord.parse(operation.record) : undefined;
    const content = SyncSessionConflictContentSchema.parse(
      record
        ? record.content
        : ((draft as NonNullable<typeof draft>).content as SyncDraftPayload).body,
    );
    const contentKind =
      content.schema === 'wevir-episode/1'
        ? 'episode'
        : content.schema === 'wevir-retro-summary/1'
          ? 'retro-summary'
          : 'session';
    if (contentKind !== ref.kind || !content.source || jcs(content.source) !== jcs(ref.source))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return {
      opId,
      parents: record?.parents ?? draft?.parents ?? [],
      content,
      deviceId: operation?.deviceId ?? this.options.storage.sync.getVault(vault.vaultId)?.deviceId,
      clientTime:
        (operation?.envelope as { clientTime?: string } | undefined)?.clientTime ??
        draft?.createdAt,
    };
  }
  #heads(vault: SyncVaultRecord, entity: SyncEntityRecord): string[] {
    const heads = this.options.storage.sync.heads(vault.vaultId, entity.entityId);
    if (entity.revision && !heads.includes(entity.revision)) {
      const operation = this.options.storage.sync.getOperation(vault.vaultId, entity.revision);
      if (
        this.options.storage.sync.draft(vault.vaultId, entity.revision) ||
        (operation?.direction === 'outbox' && ['queued', 'pending'].includes(operation.state))
      ) {
        const ancestors = this.#ancestors(vault, entity, entity.revision);
        return [...heads.filter((head) => !ancestors?.has(head)), entity.revision].sort();
      }
    }
    return heads;
  }
  #ancestors(vault: SyncVaultRecord, entity: SyncEntityRecord, start: string) {
    return syncAncestors(this.options.storage, vault.vaultId, entity.entityId, start);
  }

  #base(vault: SyncVaultRecord, entity: SyncEntityRecord, heads: string[]) {
    const left = this.#ancestors(vault, entity, heads[0] as string);
    const right = this.#ancestors(vault, entity, heads[1] as string);
    if (!left || !right) return;
    const common = [...left].filter((opId) => right.has(opId));
    const parents = new Set(
      common.flatMap(
        (opId) =>
          syncParents(this.options.storage, vault.vaultId, entity.entityId, opId) as string[],
      ),
    );
    const candidates = common.filter((opId) => !parents.has(opId));
    const base = candidates.length === 1 ? candidates[0] : undefined;
    return base &&
      (this.options.storage.sync.getOperation(vault.vaultId, base)?.record !== undefined ||
        this.options.storage.sync.draft(vault.vaultId, base))
      ? base
      : undefined;
  }
  #state(content: Content) {
    if (content.schema !== 'wevir-session/1' && content.schema !== 'wevir-session-state/1') return;
    return SyncSessionStateContentSchema.parse({
      ...content,
      schema: 'wevir-session-state/1',
      archivedAt: content.archivedAt ?? null,
    });
  }
  #field<T>(base: T, left: T, right: T): T | undefined {
    return jcs(left) === jcs(right) || jcs(right) === jcs(base)
      ? left
      : jcs(left) === jcs(base)
        ? right
        : undefined;
  }
}
