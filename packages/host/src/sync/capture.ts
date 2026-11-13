import type { WevirEvent } from '@wevir/protocol';
import { jcs, packRecord } from '@wevir/protocol/sync';
import type {
  EventRecord,
  SessionRecord,
  Storage,
  SyncSourceRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import { eventDigest, sha256 } from './crypto.js';
import { SyncQueue } from './queue.js';

export class SyncEventCapture {
  readonly #storage: Storage;
  readonly #eligible: () => SyncVaultRecord | undefined;
  readonly #queue: SyncQueue;
  constructor(options: { storage: Storage; eligible: () => SyncVaultRecord | undefined }) {
    this.#storage = options.storage;
    this.#eligible = options.eligible;
    this.#queue = new SyncQueue(options.storage);
  }

  initialize(includeHistory: boolean, backfill = false): void {
    const vault = this.#eligible();
    this.projects();
    if (!vault?.categories.includes('event-segment')) return;
    const projects = this.#storage.sync.projects(vault.vaultId);
    const mirrored = new Set(
      this.#storage.sync
        .sources(vault.vaultId)
        .filter((source) => source.mirrored)
        .map((source) => source.localSessionId),
    );
    this.#storage.transaction(() => {
      for (const project of projects) {
        if (!project.workspaceId || !vault.projectIds.includes(project.projectId)) continue;
        for (const session of this.#storage.sessions.list({
          workspaceId: project.workspaceId,
          includeChildren: true,
          includeSide: true,
          archived: 'include',
        })) {
          if (
            mirrored.has(session.id) ||
            this.#storage.sync.foreignSource(vault.vaultId, session.id)
          )
            continue;
          const source = this.#source(vault, session);
          this.#metadata(
            vault,
            session,
            project.projectId,
            this.#storage.sync.captureRange(vault.vaultId, session.id, source.streamId)
              ?.preparedSeq ?? (includeHistory ? 0 : session.lastSeq),
            { baselineOnly: !includeHistory, force: backfill },
          );
          this.#storage.sync.capture({
            vaultId: vault.vaultId,
            localSessionId: session.id,
            streamId: source.streamId,
            projectId: project.projectId,
            throughSeq: session.lastSeq,
            preparedSeq: includeHistory ? 0 : session.lastSeq,
          });
          if (backfill)
            this.#storage.sync.rewindCapture(vault.vaultId, session.id, source.streamId);
        }
      }
    });
  }

  projects(): void {
    const vault = this.#eligible();
    if (!vault?.categories.includes('project')) return;
    this.#storage.transaction(() => {
      for (const project of this.#storage.sync.projects(vault.vaultId)) {
        if (!project.workspaceId || !vault.projectIds.includes(project.projectId)) continue;
        this.#project(vault, project.projectId, project.workspaceId);
      }
    });
  }

  adoptProject(vaultId: string, projectId: string, workspaceId: string): void {
    if (
      this.#storage.sync.fileBaseline(vaultId, projectId) ||
      this.#storage.sync.entity(vaultId, projectId)
    )
      return;
    const workspace = this.#storage.workspaces.get(workspaceId);
    if (!workspace) return;
    this.#storage.sync.putFileBaseline({
      vaultId,
      entityId: projectId,
      entityType: 'project',
      projectId,
      path: `sqlite:workspace:${workspaceId}`,
      fingerprint: sha256(jcs({ displayName: workspace.displayName })),
    });
  }

  #project(vault: SyncVaultRecord, projectId: string, workspaceId: string): void {
    const workspace = this.#storage.workspaces.get(workspaceId);
    if (!workspace) return;
    const fingerprint = sha256(jcs({ displayName: workspace.displayName }));
    const baseline = this.#storage.sync.fileBaseline(vault.vaultId, projectId);
    if (baseline?.fingerprint === fingerprint) return;
    const local = this.#storage.sync.entity(vault.vaultId, projectId);
    const revision = local?.revision
      ? this.#storage.sync.getOperation(vault.vaultId, local.revision)
      : undefined;
    const opId =
      !baseline && revision?.direction === 'inbox'
        ? undefined
        : this.#queue.enqueue({
            vaultId: vault.vaultId,
            entityId: projectId,
            entityType: 'project',
            projectId,
            localKey: `project:${projectId}`,
            content: { schema: 'wevir-project/1', projectId, displayName: workspace.displayName },
          });
    if (opId) this.#storage.sync.setProjectName(vault.vaultId, projectId, workspace.displayName);
    this.#storage.sync.putFileBaseline({
      vaultId: vault.vaultId,
      entityId: projectId,
      entityType: 'project',
      projectId,
      path: `sqlite:workspace:${workspaceId}`,
      fingerprint,
      ...(opId && { opId }),
    });
  }

  source(sessionId: string): SyncSourceRecord | undefined {
    const vault = this.#eligible();
    const session = this.#storage.sessions.get(sessionId);
    if (!vault || !session || this.#storage.sync.foreignSource(vault.vaultId, sessionId)) return;
    if (
      !this.#storage.sync
        .projects(vault.vaultId)
        .some(
          (project) =>
            project.workspaceId === session.workspaceId &&
            vault.projectIds.includes(project.projectId),
        )
    )
      return;
    return this.#source(vault, session);
  }

  metadataChanged(sessionIds: readonly string[]): void {
    const vault = this.#eligible();
    if (!vault?.categories.includes('session')) return;
    this.#storage.transaction(() => {
      for (const id of sessionIds) {
        const session = this.#storage.sessions.get(id);
        const source = session && this.source(id);
        if (!session || !source) continue;
        const project = this.#storage.sync
          .projects(vault.vaultId)
          .find(
            (value) =>
              value.workspaceId === session.workspaceId &&
              vault.projectIds.includes(value.projectId),
          );
        if (project)
          this.#metadata(
            vault,
            session,
            project.projectId,
            this.#storage.sync.captureRange(vault.vaultId, id, source.streamId)?.preparedSeq ??
              session.lastSeq,
          );
      }
    });
  }

  record(events: readonly WevirEvent[]): void {
    const vault = this.#eligible();
    if (!vault?.categories.includes('event-segment') || !events.length) return;
    if (!this.#storage.db.isTransaction)
      throw new Error('sync event capture requires the business transaction');
    const projects = this.#storage.sync.projects(vault.vaultId);
    const mirrored = new Set(
      this.#storage.sync
        .sources(vault.vaultId)
        .filter((source) => source.mirrored)
        .map((source) => source.localSessionId),
    );
    for (const sessionId of new Set(events.map((event) => event.sessionId))) {
      const session = this.#storage.sessions.get(sessionId);
      if (
        !session ||
        mirrored.has(session.id) ||
        this.#storage.sync.foreignSource(vault.vaultId, session.id)
      )
        continue;
      const project = projects.find(
        (value) =>
          value.workspaceId === session.workspaceId && vault.projectIds.includes(value.projectId),
      );
      if (!project) continue;
      const source = this.#source(vault, session);
      const firstSeq = events.find((event) => event.sessionId === sessionId)?.seq as number;
      this.#metadata(
        vault,
        session,
        project.projectId,
        this.#storage.sync.captureRange(vault.vaultId, session.id, source.streamId)?.preparedSeq ??
          firstSeq - 1,
      );
      const throughSeq = Math.max(
        ...events.filter((event) => event.sessionId === sessionId).map((event) => event.seq),
      );
      this.#storage.sync.capture({
        vaultId: vault.vaultId,
        localSessionId: sessionId,
        streamId: source.streamId,
        projectId: project.projectId,
        throughSeq,
        preparedSeq: firstSeq - 1,
      });
    }
  }

  prepare(sessionIds?: readonly string[]): void {
    const vault = this.#eligible();
    if (!vault) return;
    this.#prepare(vault, sessionIds, false);
  }

  preserveForRemoval(sessionIds: readonly string[]): void {
    if (!this.#storage.db.isTransaction)
      throw new Error('outbox preservation requires the removal transaction');
    for (const vault of this.#storage.sync.vaults()) {
      while (true) {
        const pending = this.#storage.sync
          .captures(vault.vaultId)
          .filter((value) => sessionIds.includes(value.localSessionId));
        if (!pending.length) break;
        this.#prepare(vault, sessionIds, true);
        const next = this.#storage.sync
          .captures(vault.vaultId)
          .filter((value) => sessionIds.includes(value.localSessionId));
        if (
          next.length &&
          next.reduce((sum, value) => sum + value.preparedSeq, 0) <=
            pending.reduce((sum, value) => sum + value.preparedSeq, 0)
        )
          throw new Error('unprepared source events cannot be removed');
      }
    }
  }

  #prepare(
    vault: SyncVaultRecord,
    sessionIds: readonly string[] | undefined,
    preserve: boolean,
  ): void {
    for (const capture of this.#storage.sync.captures(vault.vaultId)) {
      if (sessionIds && !sessionIds.includes(capture.localSessionId)) continue;
      if (
        !preserve &&
        (!vault.projectIds.includes(capture.projectId) ||
          !vault.categories.includes('event-segment'))
      )
        continue;
      const source = this.#storage.sync
        .sources(vault.vaultId)
        .find(
          (value) =>
            value.streamId === capture.streamId &&
            value.localSessionId === capture.localSessionId &&
            !value.mirrored,
        );
      if (!source || source.hostId !== vault.originHostId) continue;
      const records = this.#storage.events.iterate(capture.localSessionId, {
        afterSeq: capture.preparedSeq,
      });
      const events: Array<{ seq: string; sha256: string; content: EventRecord }> = [];
      let bytes = 0;
      for (const event of records) {
        if (event.seq > capture.throughSeq || events.length >= 4096) break;
        const stable =
          event.type === 'engine.raw' ? { ...event, payload: { omitted: true } } : event;
        const size = Buffer.byteLength(jcs(stable));
        if (events.length && bytes + size > 192 * 1024) break;
        const seq = String(event.seq);
        const identity = {
          vaultId: vault.vaultId,
          hostId: source.hostId,
          sessionId: source.sessionId,
          streamId: source.streamId,
          seq,
        };
        events.push({ seq, sha256: eventDigest(identity, stable), content: stable });
        bytes += size;
      }
      if (!events.length) continue;
      const fromSeq = events[0]?.seq as string;
      const throughSeq = events.at(-1)?.seq as string;
      const persist = () => {
        const session = this.#storage.sessions.get(capture.localSessionId);
        if (session && !preserve)
          this.#metadata(vault, session, capture.projectId, Number(throughSeq));
        this.#queue.enqueue({
          vaultId: vault.vaultId,
          entityType: 'event-segment',
          projectId: capture.projectId,
          localKey: `event-segment:${source.streamId}:${fromSeq}:${throughSeq}`,
          kind: 'append',
          content: {
            schema: 'wevir-event-stream/1',
            sessionId: source.sessionId,
            streamId: source.streamId,
            exclusions: ['engine.raw'],
          },
          source: {
            origin: {
              hostId: source.hostId,
              sessionId: source.sessionId,
              streamId: source.streamId,
              fromSeq,
              throughSeq,
            },
            events: packRecord.shape.events.parse(events),
          },
        });
        this.#storage.sync.prepareCapture(capture, Number(throughSeq));
      };
      if (preserve) persist();
      else this.#storage.transaction(persist);
    }
  }

  #source(vault: SyncVaultRecord, session: SessionRecord): SyncSourceRecord {
    const existing = this.#storage.sync
      .sources(vault.vaultId)
      .find(
        (value) =>
          value.localSessionId === session.id &&
          value.hostId === vault.originHostId &&
          !value.mirrored,
      );
    if (existing) return existing;
    const source: SyncSourceRecord = {
      vaultId: vault.vaultId,
      hostId: vault.originHostId,
      sessionId: session.id,
      localSessionId: session.id,
      streamId: newId('sst'),
      mirrored: false,
      deviceId: vault.deviceId,
    };
    this.#storage.sync.putSource(source);
    return source;
  }

  #metadata(
    vault: SyncVaultRecord,
    session: SessionRecord,
    projectId: string,
    throughSeq: number,
    options: { baselineOnly?: boolean; force?: boolean } = {},
  ): void {
    if (vault.categories.includes('project')) this.#project(vault, projectId, session.workspaceId);
    if (!vault.categories.includes('session')) return;
    const native = this.#source(vault, session);
    const source = {
      hostId: native.hostId,
      deviceId: native.deviceId as string,
      sessionId: native.sessionId,
      streamId: native.streamId,
    };
    const body = {
      schema: 'wevir-session/1',
      source,
      sessionId: session.id,
      throughSeq: String(throughSeq),
      title: session.title,
      titleSource: session.titleSource,
      providerId: session.providerId,
      modelId: session.modelId,
      engine: session.engine,
      createdAt: session.createdAt,
      ...(session.side && { side: session.side }),
      ...(session.parentSessionId && { parentSessionId: session.parentSessionId }),
      ...(session.forkedFrom && { forkedFrom: session.forkedFrom }),
      ...(session.archivedAt && { archivedAt: session.archivedAt }),
      ...(session.origin && { origin: session.origin }),
    };
    const existing = this.#storage.sync.entity(vault.vaultId, session.id);
    const baseline = this.#storage.sync.fileBaseline(vault.vaultId, session.id);
    const fingerprint = sha256(jcs(body));
    this.#storage.sync.putContentRef({
      vaultId: vault.vaultId,
      entityId: session.id,
      kind: 'session',
      source,
      localId: session.id,
    });
    if (baseline?.fingerprint === fingerprint && !(options.force && !existing?.revision)) return;
    if (options.baselineOnly && !baseline && !existing?.revision) {
      if (!existing)
        this.#storage.sync.putEntity({
          vaultId: vault.vaultId,
          entityId: session.id,
          entityType: 'session',
          projectId,
          localKey: `session:${session.id}`,
          materialized: true,
        });
    } else
      this.#queue.enqueue({
        vaultId: vault.vaultId,
        entityId: session.id,
        entityType: 'session',
        projectId,
        localKey: existing?.localKey ?? `session:${session.id}`,
        content: body,
      });
    this.#storage.sync.putFileBaseline({
      vaultId: vault.vaultId,
      entityId: session.id,
      entityType: 'session',
      projectId,
      path: `sqlite:session:${session.id}`,
      fingerprint,
    });
  }
}
