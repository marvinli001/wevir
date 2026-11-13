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
import { eventDigest } from './crypto.js';
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

  initialize(includeHistory: boolean): void {
    const vault = this.#eligible();
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
          if (mirrored.has(session.id)) continue;
          const source = this.#source(vault, session);
          if (includeHistory) this.#metadata(vault, session, project.projectId, 0);
          this.#storage.sync.capture({
            vaultId: vault.vaultId,
            localSessionId: session.id,
            streamId: source.streamId,
            projectId: project.projectId,
            throughSeq: session.lastSeq,
            preparedSeq: includeHistory ? 0 : session.lastSeq,
          });
        }
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
      if (!session || mirrored.has(session.id)) continue;
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

  prepare(): void {
    const vault = this.#eligible();
    if (!vault) return;
    for (const capture of this.#storage.sync.captures(vault.vaultId)) {
      if (
        !vault.projectIds.includes(capture.projectId) ||
        !vault.categories.includes('event-segment')
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
      this.#storage.transaction(() => {
        const session = this.#storage.sessions.get(capture.localSessionId);
        if (session) this.#metadata(vault, session, capture.projectId, Number(throughSeq));
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
      });
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
    };
    this.#storage.sync.putSource(source);
    return source;
  }

  #metadata(
    vault: SyncVaultRecord,
    session: SessionRecord,
    projectId: string,
    throughSeq: number,
  ): void {
    if (vault.categories.includes('project')) {
      const workspace = this.#storage.workspaces.get(session.workspaceId);
      if (workspace)
        this.#queue.enqueue({
          vaultId: vault.vaultId,
          entityId: projectId,
          entityType: 'project',
          projectId,
          localKey: `project:${projectId}`,
          content: { schema: 'wevir-project/1', projectId, displayName: workspace.displayName },
        });
    }
    if (vault.categories.includes('session'))
      this.#queue.enqueue({
        vaultId: vault.vaultId,
        entityId: session.id,
        entityType: 'session',
        projectId,
        localKey: `session:${session.id}`,
        content: {
          schema: 'wevir-session/1',
          sessionId: session.id,
          throughSeq: String(throughSeq),
          title: session.title,
          titleSource: session.titleSource,
          providerId: session.providerId,
          modelId: session.modelId,
          engine: session.engine,
          createdAt: session.createdAt,
          ...(session.origin && { origin: session.origin }),
        },
      });
  }
}
