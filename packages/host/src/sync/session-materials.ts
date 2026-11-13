import {
  EpisodeSchema,
  type Session,
  type SessionId,
  SyncEpisodeContentSchema,
  SyncRetroSummaryContentSchema,
  SyncSessionContentSchema,
  SyncSessionStateContentSchema,
  SyncSessionTombstoneSchema,
  type SyncStreamRef,
  SyncStreamRefSchema,
} from '@wevir/protocol';
import { jcs, type packRecord } from '@wevir/protocol/sync';
import type {
  EpisodeRecord,
  RetroSummaryRecord,
  SessionRecord,
  Storage,
  SyncContentRefRecord,
  SyncSourceRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { episodeRevision } from '../episodes/build.js';
import type { EpisodeChange } from '../episodes/service.js';
import type { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import type { SyncApplyContext, SyncMaterialRevision } from './queue.js';
import { type SyncDraftPayload, SyncQueue } from './queue.js';

type Record = typeof packRecord._output;
type Body =
  | typeof SyncEpisodeContentSchema._output
  | typeof SyncRetroSummaryContentSchema._output
  | (typeof SyncSessionContentSchema._output & { source: SyncStreamRef })
  | typeof SyncSessionTombstoneSchema._output
  | typeof SyncSessionStateContentSchema._output;
interface CaptureScope {
  vault: SyncVaultRecord;
  projectId: string;
  source: SyncStreamRef;
  ref: SyncContentRefRecord | undefined;
  mirrored: boolean;
  localId: string;
}
export interface SyncSessionMaterialsOptions {
  storage: Storage;
  client: ZuvClient;
  eligible: () => SyncVaultRecord | undefined;
  nativeSource: (sessionId: string) => SyncSourceRecord | undefined;
  ensureSource: (vaultId: string, source: SyncStreamRef, projectId: string) => SyncSourceRecord;
  events: EventStore;
  onEpisodeChanged?: (change: EpisodeChange) => void;
}

export class SyncSessionMaterials {
  readonly #options: SyncSessionMaterialsOptions;
  readonly #queue: SyncQueue;
  #devices: Map<string, string> | undefined;
  readonly #touched = new Set<SessionId>();
  readonly #episodes = new Map<string, EpisodeChange>();
  constructor(options: SyncSessionMaterialsOptions) {
    this.#options = options;
    this.#queue = new SyncQueue(options.storage);
  }

  notify(): void {
    this.#options.events.touchProjection([...this.#touched]);
    this.#touched.clear();
    for (const change of this.#episodes.values()) this.#options.onEpisodeChanged?.(change);
    this.#episodes.clear();
  }

  episode = (row: EpisodeRecord): void => {
    const scope = this.#scope(row.sessionId, 'episode', row.id);
    if (!scope) return;
    const previous = scope.ref && this.#body(scope.vault.vaultId, scope.ref.entityId);
    const source = scope.source;
    const originalOverrides = scope.mirrored
      ? this.#originalOverrides(JSON.parse(row.overrides), scope, row.sessionId)
      : { value: JSON.parse(row.overrides), unmapped: [] };
    const unresolved = new Map<string, unknown>(
      (previous?.schema === 'wevir-episode/1' ? (previous.unmappedRefs ?? []) : []).map((value) => [
        jcs(value),
        value,
      ]),
    );
    for (const value of originalOverrides.unmapped) unresolved.set(jcs(value), value);
    const body = SyncEpisodeContentSchema.parse({
      schema: 'wevir-episode/1',
      source: SyncStreamRefSchema.parse(source),
      episodeId: previous?.schema === 'wevir-episode/1' ? previous.episodeId : row.id,
      ...(row.deletedAt === undefined && {
        episode:
          previous?.schema === 'wevir-episode/1' && previous.episode
            ? {
                ...previous.episode,
                overrides: originalOverrides.value,
                pinned: row.pinned,
                excluded: row.excluded,
              }
            : {
                ...JSON.parse(row.digest),
                overrides: originalOverrides.value,
                pinned: row.pinned,
                excluded: row.excluded,
              },
      }),
      deleted: row.deletedAt !== undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(unresolved.size && { unmappedRefs: [...unresolved.values()] }),
    });
    this.#capture(
      scope,
      scope.ref?.entityId ?? body.episodeId,
      `episode:${row.id}`,
      body,
      row.deletedAt ? 'delete' : 'put',
      row,
    );
  };

  metadataChanged(sessionIds: readonly string[]): void {
    const { storage } = this.#options;
    const persist = () => {
      for (const id of sessionIds) {
        const row = storage.sessions.get(id);
        if (row?.origin?.kind !== 'synced') continue;
        const scope = this.#scope(id, 'session', id);
        if (!scope) continue;
        const entityId = scope.source.sessionId;
        const previous = this.#body(scope.vault.vaultId, entityId);
        const body: typeof SyncSessionStateContentSchema._output = {
          schema: 'wevir-session-state/1',
          source: scope.source,
          title: row.title,
          titleSource: row.titleSource as Session['titleSource'],
          archivedAt: row.archivedAt ?? null,
        };
        if (
          (previous?.schema === 'wevir-session/1' ||
            previous?.schema === 'wevir-session-state/1') &&
          previous.title === body.title &&
          previous.titleSource === body.titleSource &&
          (previous.archivedAt ?? null) === body.archivedAt
        )
          continue;
        storage.sync.putContentRef({
          vaultId: scope.vault.vaultId,
          entityId,
          kind: 'session',
          source: scope.source,
          localId: id,
        });
        const material = storage.sync.entity(scope.vault.vaultId, entityId);
        this.#queue.enqueue({
          vaultId: scope.vault.vaultId,
          entityId,
          entityType: 'session',
          projectId: scope.projectId,
          localKey: material?.localKey ?? `session:${id}`,
          kind: 'put',
          content: body,
        });
      }
    };
    if (storage.db.isTransaction) persist();
    else storage.transaction(persist);
  }

  summary = (row: RetroSummaryRecord): void => {
    const scope = this.#scope(row.sessionId, 'retro-summary', row.sessionId);
    if (!scope || scope.mirrored) return;
    const body = SyncRetroSummaryContentSchema.parse({
      schema: 'wevir-retro-summary/1',
      source: scope.source,
      summary: JSON.parse(row.summary),
    });
    this.#capture(
      scope,
      scope.ref?.entityId ?? `retro_${row.sessionId}`,
      `retro-summary:${row.sessionId}`,
      body,
      'put',
      row,
    );
  };

  remove(sessionIds: readonly string[]): void {
    const { storage } = this.#options;
    const vault = this.#options.eligible();
    if (!vault?.categories.includes('session')) return;
    for (const id of sessionIds) {
      const session = storage.sessions.get(id);
      if (!session) continue;
      const project = storage.sync
        .projects(vault.vaultId)
        .find(
          (value) =>
            value.workspaceId === session.workspaceId && vault.projectIds.includes(value.projectId),
        );
      if (!project) continue;
      const ref = storage.sync.localContentRef('session', id);
      const source = ref?.source ?? this.#options.nativeSource(id);
      if (!source?.deviceId) continue;
      const stable = SyncStreamRefSchema.parse({
        hostId: source.hostId,
        deviceId: source.deviceId,
        sessionId: source.sessionId,
        streamId: source.streamId,
      });
      const episode = storage.episodes.forSession(id);
      const deletedAt = new Date().toISOString();
      if (episode && !episode.pinned && episode.deletedAt === undefined)
        this.episode({ ...episode, deletedAt, updatedAt: deletedAt });
      const old = storage.sync.entity(vault.vaultId, stable.sessionId);
      storage.sync.putContentRef({
        vaultId: vault.vaultId,
        entityId: stable.sessionId,
        kind: 'session',
        source: stable,
        localId: id,
      });
      this.#queue.enqueue({
        vaultId: vault.vaultId,
        entityId: stable.sessionId,
        entityType: 'session',
        projectId: project.projectId,
        localKey: old?.localKey ?? `session:${id}`,
        kind: 'delete',
        content: { schema: 'wevir-session-deleted/1', source: stable, deletedAt },
      });
    }
  }

  scan(initialize: boolean, includeHistory: boolean): void {
    const { storage } = this.#options;
    const vault = this.#options.eligible();
    if (!vault?.categories.includes('session')) return;
    storage.transaction(() => {
      for (const project of storage.sync.projects(vault.vaultId)) {
        if (!project.workspaceId || !vault.projectIds.includes(project.projectId)) continue;
        for (const row of storage.sessions.list({
          workspaceId: project.workspaceId,
          includeChildren: true,
          includeSide: true,
          archived: 'include',
        })) {
          if (storage.sync.foreignSource(vault.vaultId, row.id)) continue;
          const episode = storage.episodes.forSession(row.id);
          const summary = storage.retros.getSummary(row.id);
          for (const [kind, value] of [
            ['episode', episode],
            ['retro-summary', summary],
          ] as const) {
            if (!value) continue;
            const localId = kind === 'episode' ? (value as EpisodeRecord).id : row.id;
            const key = `${kind}:${localId}`;
            const baseline = storage.sync.localEntity(vault.vaultId, key);
            if (initialize && !includeHistory && !baseline) {
              storage.sync.claimResource(key, vault.vaultId);
              storage.sync.putEntity({
                vaultId: vault.vaultId,
                entityId: kind === 'episode' ? localId : `retro_${row.id}`,
                entityType: 'session',
                projectId: project.projectId,
                localKey: key,
                materialized: true,
              });
              storage.sync.putFileBaseline({
                vaultId: vault.vaultId,
                entityId: kind === 'episode' ? localId : `retro_${row.id}`,
                entityType: 'session',
                projectId: project.projectId,
                path: `sqlite:${key}`,
                fingerprint: sha256(jcs(value)),
              });
            } else {
              const seen = baseline && storage.sync.fileBaseline(vault.vaultId, baseline.entityId);
              if (
                seen?.fingerprint === sha256(jcs(value)) &&
                !(initialize && includeHistory && !baseline?.revision)
              )
                continue;
              if (kind === 'episode') this.episode(value as EpisodeRecord);
              else this.summary(value as RetroSummaryRecord);
            }
          }
        }
      }
    });
  }

  async prepare(
    op: SyncMaterialRevision,
    record: Record,
    context: SyncApplyContext = {},
  ): Promise<() => void> {
    const raw = record.content as { schema?: string };
    if (
      ![
        'wevir-episode/1',
        'wevir-retro-summary/1',
        'wevir-session/1',
        'wevir-session-deleted/1',
        'wevir-session-state/1',
      ].includes(raw.schema ?? '')
    )
      throw new ZuvRequestError('UPGRADE_REQUIRED');
    let body: Body;
    if (raw.schema === 'wevir-session-state/1')
      body = SyncSessionStateContentSchema.parse(record.content);
    else if (raw.schema === 'wevir-episode/1')
      body = SyncEpisodeContentSchema.parse(record.content);
    else if (raw.schema === 'wevir-retro-summary/1')
      body = SyncRetroSummaryContentSchema.parse(record.content);
    else if (raw.schema === 'wevir-session-deleted/1')
      body = SyncSessionTombstoneSchema.parse(record.content);
    else {
      const parsed = SyncSessionContentSchema.parse(record.content);
      if (!parsed.source) throw new ZuvRequestError('UPGRADE_REQUIRED');
      body = { ...parsed, source: parsed.source };
    }
    if (
      !record.projectId ||
      (body.schema === 'wevir-episode/1' &&
        (body.episodeId !== op.entityId ||
          body.episodeId !== `ep_${body.source.sessionId.slice(4)}` ||
          (body.deleted
            ? body.episode !== undefined || (op.kind !== 'delete' && op.kind !== 'resolve')
            : !body.episode ||
              body.episode.id !== body.episodeId ||
              body.episode.sessionId !== body.source.sessionId)))
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const { storage, client } = this.#options;
    const ref = storage.sync
      .contentRefs(op.vaultId)
      .find((value) => value.entityId === op.entityId);
    const kind =
      body.schema === 'wevir-episode/1'
        ? 'episode'
        : body.schema === 'wevir-retro-summary/1'
          ? 'retro-summary'
          : 'session';
    if (
      (ref && ref.kind !== kind) ||
      (body.schema === 'wevir-retro-summary/1' &&
        op.entityId !== `retro_${body.source.sessionId}`) ||
      (body.schema === 'wevir-session/1' &&
        (op.entityId !== body.sessionId || body.sessionId !== body.source.sessionId)) ||
      ((body.schema === 'wevir-session-deleted/1' || body.schema === 'wevir-session-state/1') &&
        op.entityId !== body.source.sessionId)
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (ref && jcs(ref.source) !== jcs(body.source)) throw new ZuvRequestError('INTEGRITY_FAILED');
    if (!ref) {
      const known = storage.sync
        .sources(op.vaultId)
        .some(
          (value) =>
            value.hostId === body.source.hostId &&
            value.deviceId === body.source.deviceId &&
            value.sessionId === body.source.sessionId &&
            value.streamId === body.source.streamId,
        );
      if (!known && body.source.deviceId !== op.deviceId)
        throw new ZuvRequestError(
          body.schema === 'wevir-session-state/1' ? 'RECOVERY_REQUIRED' : 'INTEGRITY_FAILED',
        );
      if (!known && !this.#devices?.has(body.source.deviceId))
        this.#devices = new Map(
          (await client.json('devices', 'GET', '/api/wevir/sync/v1/devices')).devices.map(
            (value) => [value.deviceId, value.originHostId],
          ),
        );
      if (!known && this.#devices?.get(body.source.deviceId) !== body.source.hostId)
        throw new ZuvRequestError('INTEGRITY_FAILED');
    }
    return () => {
      const source = this.#options.ensureSource(
        op.vaultId,
        body.source,
        record.projectId as string,
      );
      const localId =
        ref?.localId ?? (body.schema === 'wevir-episode/1' ? newId('ep') : source.localSessionId);
      const mapped: SyncContentRefRecord = {
        vaultId: op.vaultId,
        entityId: op.entityId,
        kind:
          body.schema === 'wevir-episode/1'
            ? 'episode'
            : body.schema === 'wevir-retro-summary/1'
              ? 'retro-summary'
              : 'session',
        source: body.source,
        ...(localId && { localId }),
      };
      storage.sync.putContentRef(mapped);
      if (
        mapped.kind !== 'session' &&
        !storage.sync
          .contentRefs(op.vaultId)
          .some((value) => value.entityId === body.source.sessionId)
      )
        storage.sync.putContentRef({
          vaultId: op.vaultId,
          entityId: body.source.sessionId,
          kind: 'session',
          source: body.source,
          localId: source.localSessionId,
        });
      this.#apply(op, body, mapped, record.projectId as string, context);
    };
  }

  reconcile(vaultId: string): void {
    const { storage } = this.#options;
    for (const ref of storage.sync.contentRefs(vaultId)) {
      if (ref.kind === 'session') continue;
      const entity = storage.sync.entity(vaultId, ref.entityId);
      if (!entity?.revision) continue;
      const stored = storage.sync.getOperation(vaultId, entity.revision);
      if (
        !stored?.record ||
        !['applied', 'committed'].includes(stored.state) ||
        stored.direction === 'outbox'
      )
        continue;
      const body = this.#body(vaultId, ref.entityId);
      if (!body || !stored.projectId) continue;
      this.#apply(stored.envelope as SyncMaterialRevision, body, ref, stored.projectId);
    }
  }

  #scope(
    sessionId: string,
    kind: SyncContentRefRecord['kind'],
    localId: string,
  ): CaptureScope | undefined {
    const { storage } = this.#options;
    const vault = this.#options.eligible();
    if (!vault?.categories.includes('session')) return;
    const session = storage.sessions.get(sessionId);
    if (!session) return;
    const project = storage.sync
      .projects(vault.vaultId)
      .find(
        (value) =>
          value.workspaceId === session.workspaceId && vault.projectIds.includes(value.projectId),
      );
    if (!project) return;
    const ref = storage.sync.localContentRef(kind, localId);
    if (ref && ref.vaultId !== vault.vaultId) return;
    const native = ref
      ? undefined
      : (this.#options.nativeSource(sessionId) ??
        (kind === 'session'
          ? storage.sync.sources(vault.vaultId).find((value) => value.localSessionId === sessionId)
          : undefined));
    if (!ref && (!native || (native.mirrored && kind !== 'session'))) return;
    const source = ref?.source ?? {
      hostId: native?.hostId as string,
      deviceId: native?.deviceId as string,
      sessionId: native?.sessionId as string,
      streamId: native?.streamId as string,
    };
    return {
      vault,
      projectId: project.projectId,
      source: SyncStreamRefSchema.parse(source),
      ref,
      mirrored: session.origin?.kind === 'synced',
      localId,
    };
  }

  #capture(
    scope: CaptureScope,
    entityId: string,
    key: string,
    body: Body,
    kind: 'put' | 'delete',
    row: EpisodeRecord | RetroSummaryRecord,
  ): void {
    const { storage } = this.#options;
    if (!storage.db.isTransaction)
      throw new Error('sync task capture requires the business transaction');
    storage.sync.putContentRef({
      vaultId: scope.vault.vaultId,
      entityId,
      kind: body.schema === 'wevir-episode/1' ? 'episode' : 'retro-summary',
      source: scope.source,
      localId: scope.localId,
    });
    const entity = storage.sync.entity(scope.vault.vaultId, entityId);
    this.#queue.enqueue({
      vaultId: scope.vault.vaultId,
      entityId,
      entityType: 'session',
      projectId: scope.projectId,
      localKey: entity?.localKey ?? key,
      content: body,
      kind,
    });
    storage.sync.putFileBaseline({
      vaultId: scope.vault.vaultId,
      entityId,
      entityType: 'session',
      projectId: scope.projectId,
      path: `sqlite:${key}`,
      fingerprint: sha256(jcs(row)),
    });
  }

  #body(vaultId: string, entityId: string): Body | undefined {
    const { storage } = this.#options;
    const entity = storage.sync.entity(vaultId, entityId);
    const opId = entity?.revision;
    if (!opId) return;
    const op = storage.sync.getOperation(vaultId, opId);
    if (op?.record) return (op.record as Record).content as Body;
    const draft = storage.sync.drafts(vaultId).find((value) => value.opId === opId);
    return draft && ((draft.content as SyncDraftPayload).body as Body);
  }

  #apply(
    op: SyncMaterialRevision,
    body: Body,
    ref: SyncContentRefRecord,
    projectId: string,
    context: SyncApplyContext = {},
  ): void {
    const { storage } = this.#options;
    const source = storage.sync
      .sources(op.vaultId)
      .find(
        (value) =>
          value.hostId === ref.source.hostId &&
          value.deviceId === ref.source.deviceId &&
          value.sessionId === ref.source.sessionId &&
          value.streamId === ref.source.streamId,
      );
    if (!source?.localSessionId || !ref.localId) return;
    const session = storage.sessions.get(source.localSessionId);
    if (!session) return;
    const previous = storage.sync.entity(op.vaultId, op.entityId);
    const key = previous?.localKey ?? `${ref.kind}:${ref.localId}`;
    const conflict =
      previous?.revision &&
      previous.revision !== op.opId &&
      !op.parents.includes(previous.revision) &&
      previous.revision !== context.replaceRevision;
    if (conflict) {
      storage.sync.putMaterialJournal({
        vaultId: op.vaultId,
        opId: op.opId,
        entityId: op.entityId,
        localKey: key,
        targetPath: `sqlite:${key}`,
        nextHash: sha256(jcs(body)),
        state: 'conflict',
      });
      return;
    }
    const mapper = this.#mapper(op.vaultId, ref.source, session);
    if (body.schema === 'wevir-episode/1') {
      const old = storage.episodes.get(ref.localId);
      if (body.deleted) {
        if (old)
          storage.episodes.put({
            ...old,
            deletedAt: body.updatedAt,
            updatedAt: body.updatedAt,
            revision: episodeRevision([op.opId, 'deleted']),
          });
      } else {
        const original = body.episode;
        if (!original) throw new ZuvRequestError('INTEGRITY_FAILED');
        if (source.mirrored && session.title === '')
          storage.sessions.update(session.id, {
            title: original.overrides.title ?? original.title,
            titleSource: 'first_prompt',
          });
        const projected = mapper.tree(original) as typeof original;
        const root = mapper.session(original.rootSessionId);
        const { syncOrigin: _, unavailableRefs: __, ...base } = projected;
        const digest = {
          ...base,
          id: ref.localId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          rootSessionId: root ?? session.id,
          throughSeq: mapper.through(original.throughSeq),
          source: storage.sync.sessionDeleted(session.id) ? 'deleted' : 'available',
          syncOrigin: { ...ref.source, vaultId: op.vaultId, seq: String(original.throughSeq) },
          ...(mapper.missing.size + (body.unmappedRefs?.length ?? 0) && {
            unavailableRefs: mapper.missing.size + (body.unmappedRefs?.length ?? 0),
          }),
        };
        const checked = EpisodeSchema.parse(digest);
        const row: EpisodeRecord = {
          id: ref.localId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          rootSessionId: checked.rootSessionId,
          schemaVersion: checked.schemaVersion,
          throughSeq: checked.throughSeq,
          digest: JSON.stringify(checked),
          overrides: JSON.stringify(checked.overrides),
          pinned: checked.pinned,
          excluded: checked.excluded,
          createdAt: body.createdAt,
          updatedAt: body.updatedAt,
          revision: '',
        };
        row.revision = episodeRevision([row.digest, row.overrides, row.pinned, row.excluded]);
        storage.episodes.put(row);
      }
      this.#episodes.set(ref.localId, {
        workspaceId: session.workspaceId as EpisodeChange['workspaceId'],
        id: ref.localId as EpisodeChange['id'],
      });
    } else if (body.schema === 'wevir-retro-summary/1') {
      const projected = mapper.tree(body.summary) as typeof body.summary;
      storage.retros.putSummary({
        sessionId: session.id,
        summary: JSON.stringify({
          ...projected,
          throughSeq: mapper.through(body.summary.throughSeq),
          syncOrigin: { ...ref.source, vaultId: op.vaultId, seq: String(body.summary.throughSeq) },
          ...(mapper.missing.size && { unavailableRefs: mapper.missing.size }),
        }),
        createdAt: body.summary.generatedAt,
      });
    } else if (body.schema === 'wevir-session/1' || body.schema === 'wevir-session-state/1') {
      if (
        op.entityId !== body.source.sessionId ||
        (body.schema === 'wevir-session/1' && body.sessionId !== body.source.sessionId)
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      if (body.schema === 'wevir-session/1' && body.side)
        storage.sessions.setSyncedSide(session.id);
      storage.sessions.update(session.id, {
        title: body.title,
        titleSource: body.titleSource,
        ...(source.mirrored &&
          body.schema === 'wevir-session/1' && {
            providerId: body.providerId,
            modelId: body.modelId,
          }),
        lastSeq: storage.events.lastSeq(session.id),
      });
      storage.sessions.setArchived(session.id, body.archivedAt ?? undefined);
      if (!body.archivedAt || op.kind === 'resolve')
        storage.sync.clearSessionDeleted(op.vaultId, op.entityId);
    } else {
      if (!source.mirrored && session.activeTurn) {
        storage.sync.putMaterialJournal({
          vaultId: op.vaultId,
          opId: op.opId,
          entityId: op.entityId,
          localKey: key,
          targetPath: `sqlite:${key}`,
          nextHash: sha256(jcs(body)),
          state: 'conflict',
        });
        return;
      }
      storage.sessions.setArchived(session.id, body.deletedAt);
      storage.sync.markSessionDeleted(op.vaultId, op.entityId, session.id, op.opId);
    }
    storage.sync.putEntity({
      vaultId: op.vaultId,
      entityId: op.entityId,
      entityType: 'session',
      projectId,
      localKey: key,
      revision: op.opId,
      fingerprint: sha256(jcs({ kind: op.kind, content: { schema: 'wevir-sync-draft/1', body } })),
      materialized: true,
    });
    if (op.kind === 'resolve')
      storage.sync.clearMaterialConflicts(op.vaultId, op.entityId, op.parents);
    this.#touched.add(session.id as SessionId);
  }

  #originalOverrides(value: unknown, scope: CaptureScope, sessionId: string) {
    const { storage } = this.#options;
    const unmapped: Array<{ deviceId: string; sessionId: string; ref: unknown }> = [];
    const originalSeq = (seq: number) => {
      const origin = storage.sync.sourceOrigin(sessionId, seq);
      return origin &&
        origin.vaultId === scope.vault.vaultId &&
        origin.hostId === scope.source.hostId &&
        origin.deviceId === scope.source.deviceId &&
        origin.sessionId === scope.source.sessionId &&
        origin.streamId === scope.source.streamId
        ? Number(origin.seq)
        : undefined;
    };
    const preserve = (ref: unknown) => {
      unmapped.push({ deviceId: scope.vault.deviceId, sessionId, ref });
    };
    const tree = (item: unknown, key = ''): unknown => {
      if (Array.isArray(item))
        return item.map((value) => tree(value, key)).filter((value) => value !== undefined);
      if (typeof item === 'string' && ['id', 'refs', 'sources'].includes(key)) {
        const match = /^e([0-9]+)(\.[0-9]+)?$/.exec(item);
        if (!match) return item;
        const seq = originalSeq(Number(match[1]));
        if (seq !== undefined) return `e${seq}${match[2] ?? ''}`;
        preserve(item);
        return key === 'id' ? `local:${scope.vault.deviceId}:${item}` : undefined;
      }
      if (!item || typeof item !== 'object') return item;
      const ref = item as { kind?: string; seq?: number };
      if (
        key === 'ref' &&
        (ref.kind === 'event' || ref.kind === 'verification') &&
        typeof ref.seq === 'number'
      ) {
        const seq = originalSeq(ref.seq);
        if (seq === undefined) {
          preserve(item);
          return undefined;
        }
        return { ...item, seq };
      }
      if (key === 'ref' && ref.kind === 'session') {
        const local = (item as { sessionId: string }).sessionId;
        const source = storage.sync
          .sources(scope.vault.vaultId)
          .find(
            (value) =>
              value.localSessionId === local &&
              value.hostId === scope.source.hostId &&
              value.deviceId === scope.source.deviceId,
          );
        if (source) return { ...item, sessionId: source.sessionId };
        preserve(item);
        return undefined;
      }
      return Object.fromEntries(
        Object.entries(item).flatMap(([name, child]) => {
          if ((name === 'sessionId' || name === 'owner') && typeof child === 'string') {
            const source = storage.sync
              .sources(scope.vault.vaultId)
              .find(
                (value) =>
                  value.localSessionId === child &&
                  value.hostId === scope.source.hostId &&
                  value.deviceId === scope.source.deviceId,
              );
            if (source) return [[name, source.sessionId]];
          }
          const next = tree(child, name);
          return next === undefined ? [] : [[name, next]];
        }),
      );
    };
    return { value: tree(value), unmapped };
  }

  #mapper(vaultId: string, source: SyncContentRefRecord['source'], local: SessionRecord) {
    const { storage } = this.#options;
    const native = storage.sync
      .sources(vaultId)
      .some(
        (value) =>
          !value.mirrored &&
          value.hostId === source.hostId &&
          value.deviceId === source.deviceId &&
          value.sessionId === source.sessionId &&
          value.streamId === source.streamId &&
          value.localSessionId === local.id,
      );
    const missing = new Set<string>();
    const session = (id: string) => {
      const found = storage.sync
        .sources(vaultId)
        .find(
          (value) =>
            value.hostId === source.hostId &&
            value.deviceId === source.deviceId &&
            value.sessionId === id,
        )?.localSessionId;
      if (!found) missing.add(`s:${id}`);
      return found;
    };
    const seq = (value: number) => {
      const mapped =
        native && value <= storage.events.lastSeq(local.id)
          ? value
          : storage.sync.sourceLocalSeq(vaultId, source, String(value));
      if (mapped === undefined) missing.add(`e${value}`);
      return mapped;
    };
    const through = (value: number) =>
      Math.max(
        1,
        native
          ? Math.min(value, storage.events.lastSeq(local.id))
          : storage.sync.sourceThroughSeq(vaultId, source, String(value)),
      );
    const id = (value: string): string =>
      value.replace(/^(e)([0-9]+)(\.[0-9]+)?$/, (_all, _prefix, number, suffix) => {
        const mapped = seq(Number(number));
        return mapped === undefined
          ? `source:${source.streamId}:e${number}${suffix ?? ''}`
          : `e${mapped}${suffix ?? ''}`;
      });
    const tree = (value: unknown, key = ''): unknown => {
      if (Array.isArray(value))
        return value.map((child) => tree(child, key)).filter((child) => child !== undefined);
      if (typeof value === 'string')
        if (['id', 'refs', 'sources'].includes(key)) {
          const mapped = id(value);
          return key !== 'id' && mapped.startsWith('source:') ? undefined : mapped;
        } else return value;
      if (!value || typeof value !== 'object') return value;
      const item = value as { kind?: string; seq?: number; sessionId?: string };
      if (key === 'engines' && typeof item.seq === 'number' && seq(item.seq) === undefined)
        return undefined;
      if (key === 'ref') {
        if (item.kind === 'event' || item.kind === 'verification') {
          const mapped = seq(item.seq as number);
          return mapped === undefined
            ? undefined
            : item.kind === 'event'
              ? { ...item, seq: mapped }
              : { kind: 'event', seq: mapped };
        }
        if (item.kind === 'session') {
          const mapped = session(item.sessionId as string);
          return mapped ? { kind: 'session', sessionId: mapped } : undefined;
        }
        missing.add(`ref:${jcs(value)}`);
        return undefined;
      }
      return Object.fromEntries(
        Object.entries(value).flatMap(([name, child]) => {
          if (name === 'syncOrigin' || name === 'unavailableRefs') return [];
          if (name === 'seq' && typeof child === 'number') {
            const mapped = seq(child);
            return mapped === undefined ? [] : [[name, mapped]];
          }
          if (name === 'throughSeq' && typeof child === 'number') return [[name, through(child)]];
          if (
            (name === 'sessionId' || name === 'rootSessionId' || name === 'owner') &&
            typeof child === 'string'
          ) {
            const mapped = session(child);
            return mapped ? [[name, mapped]] : [];
          }
          if (name === 'workspaceId') return [[name, local.workspaceId]];
          const mapped = tree(child, name);
          return mapped === undefined ? [] : [[name, mapped]];
        }),
      );
    };
    return { tree, missing, session, through };
  }
}
