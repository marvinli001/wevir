import type {
  Episode,
  EpisodeId,
  MethodParams,
  MethodResult,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { EpisodeSchema, EpisodeSummarySchema } from '@wevir/protocol';
import type { EpisodeRecord, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import type { EventStore } from '../event-store.js';
import type { RetroService } from '../retro/service.js';
import { buildEpisode, episodeRevision, redactEpisodeValue } from './build.js';

export const EPISODE_IDLE_MS = 10 * 60_000;
export interface EpisodeChange {
  workspaceId: WorkspaceId;
  id?: EpisodeId;
}

export interface EpisodeServiceOptions {
  storage: Storage;
  events: EventStore;
  retro: RetroService;
  enabled: () => boolean;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

export class EpisodeService {
  readonly #options: EpisodeServiceOptions;
  readonly #listeners = new Set<(change: EpisodeChange) => void>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #running = new Map<string, Promise<Episode | undefined>>();
  #disposed = false;

  constructor(options: EpisodeServiceOptions) {
    this.#options = options;
  }

  watch(listener: (change: EpisodeChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  list({
    workspaceId,
    cursor,
    limit = 30,
  }: MethodParams<'episode.list'>): MethodResult<'episode.list'> {
    const records = this.#options.storage.episodes.list(workspaceId);
    const start = cursor === undefined ? 0 : records.findIndex((row) => row.id === cursor) + 1;
    const page = records.slice(start, start + limit);
    return {
      episodes: page.map((row) => EpisodeSummarySchema.parse(this.#read(row))),
      ...(start + limit < records.length && { next: page.at(-1)?.id }),
    };
  }

  get(id: EpisodeId): Episode {
    return this.#read(this.#record(id));
  }

  update(params: MethodParams<'episode.update'>): MethodResult<'episode.update'> {
    const row = this.#record(params.id);
    if (row.revision !== params.revision) return { episode: this.#read(row), conflict: true };
    const redacted = redactEpisodeValue({ ...JSON.parse(row.overrides), ...params.patch });
    const next = {
      ...row,
      overrides: JSON.stringify(redacted.value),
      pinned: params.pinned ?? row.pinned,
      excluded: params.excluded ?? row.excluded,
      updatedAt: new Date().toISOString(),
    };
    next.revision = episodeRevision([next.digest, next.overrides, next.pinned, next.excluded]);
    this.#options.storage.episodes.put(next);
    this.#changed(next);
    return { episode: this.#read(next) };
  }

  delete({ id, revision }: MethodParams<'episode.delete'>): MethodResult<'episode.delete'> {
    const row = this.#record(id);
    if (revision !== undefined && revision !== row.revision) return { conflict: true };
    const now = new Date().toISOString();
    const next = {
      ...row,
      digest: '{}',
      overrides: '{}',
      pinned: false,
      excluded: false,
      deletedAt: now,
      updatedAt: now,
      revision: episodeRevision([id, now]),
    };
    this.#options.storage.episodes.put(next);
    this.#changed(next);
    return {};
  }

  refresh(sessionId: SessionId, regenerate = false): Promise<Episode | undefined> {
    const pending = this.#running.get(sessionId);
    if (pending !== undefined) return pending.then(() => this.refresh(sessionId, regenerate));
    const work = this.#refresh(sessionId, regenerate).finally(() =>
      this.#running.delete(sessionId),
    );
    this.#running.set(sessionId, work);
    return work;
  }

  async #refresh(sessionId: SessionId, regenerate: boolean): Promise<Episode | undefined> {
    const { storage, retro, events } = this.#options;
    if (!this.#eligible(sessionId)) return undefined;
    const before = storage.episodes.forSession(sessionId);
    if (before?.deletedAt !== undefined && !regenerate) return undefined;
    const input = await retro.episodeInput(sessionId);
    const session = storage.sessions.get(sessionId);
    if (session === undefined || !this.#eligible(sessionId)) return undefined;
    const latest = storage.episodes.forSession(sessionId);
    if (latest?.deletedAt !== undefined && (!regenerate || latest.deletedAt !== before?.deletedAt))
      return undefined;
    let root = session;
    const seen = new Set<string>();
    while (!seen.has(root.id)) {
      seen.add(root.id);
      const parent = root.parentSessionId ?? root.origin?.sessionId;
      if (parent === undefined) break;
      const next = storage.sessions.get(parent);
      if (next === undefined) break;
      root = next;
    }
    const digest = buildEpisode({
      workspaceId: session.workspaceId as WorkspaceId,
      rootSessionId: root.id as SessionId,
      title: session.title,
      createdAt: session.createdAt,
      state: input.state,
      retro: input.retro,
      events: events.readSince(sessionId, 0).filter((event) => event.seq <= input.state.throughSeq),
      ...(input.live.startHead !== undefined && { startHead: input.live.startHead }),
    });
    if (latest !== undefined && latest.deletedAt === undefined) {
      const previous = JSON.parse(latest.digest) as Episode;
      digest.outcome.checkedAt = previous.outcome.checkedAt;
      digest.updatedAt = previous.updatedAt;
      digest.revision = previous.revision;
      if (JSON.stringify(digest) === latest.digest) return this.#read(latest);
      digest.outcome.checkedAt = input.retro.checkedAt;
      digest.updatedAt = input.retro.checkedAt;
    }
    digest.revision = episodeRevision({ ...digest, revision: '' });
    const row: EpisodeRecord = {
      id: digest.id,
      workspaceId: digest.workspaceId,
      sessionId,
      rootSessionId: digest.rootSessionId,
      schemaVersion: digest.schemaVersion,
      throughSeq: digest.throughSeq,
      digest: JSON.stringify(digest),
      overrides: latest?.overrides ?? '{}',
      pinned: latest?.pinned ?? false,
      excluded: latest?.excluded ?? false,
      revision: '',
      createdAt: latest?.createdAt ?? digest.updatedAt,
      updatedAt: digest.updatedAt,
    };
    row.revision = episodeRevision([row.digest, row.overrides, row.pinned, row.excluded]);
    storage.episodes.put(row);
    this.#changed(row);
    return this.#read(row);
  }

  onTurnFinished(sessionId: SessionId): void {
    this.#cancel(sessionId);
    if (!this.#eligible(sessionId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(sessionId);
      if (this.#options.storage.sessions.get(sessionId)?.activeTurn !== undefined) return;
      void this.refresh(sessionId).catch((error: unknown) =>
        this.#options.onWarning?.('failed to record episode', { sessionId, error }),
      );
    }, EPISODE_IDLE_MS);
    timer.unref();
    this.#timers.set(sessionId, timer);
  }

  async beforeClose(sessionId: SessionId): Promise<void> {
    this.#cancel(sessionId);
    await this.refresh(sessionId);
  }

  async catchUp(workspaceId: string): Promise<void> {
    const { storage } = this.#options;
    const sessions = storage.sessions
      .list({ workspaceId, archived: 'include', includeChildren: true })
      .filter(
        (session) =>
          session.activeTurn === undefined &&
          this.#eligible(session.id as SessionId) &&
          (storage.episodes.forSession(session.id)?.throughSeq ?? -1) <
            storage.events.lastSeq(session.id),
      )
      .slice(0, 5);
    for (const session of sessions) await this.refresh(session.id as SessionId);
  }

  removeWorkspace(workspaceId: WorkspaceId): void {
    this.#options.storage.episodes.removeWorkspace(workspaceId);
    for (const [id] of this.#timers)
      if (this.#options.storage.sessions.get(id)?.workspaceId === workspaceId) this.#cancel(id);
    for (const listener of this.#listeners) listener({ workspaceId });
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.#cancel(id);
  }
  dispose(): void {
    this.#disposed = true;
    this.forget([...this.#timers.keys()]);
  }

  #eligible(sessionId: SessionId): boolean {
    if (this.#disposed || !this.#options.enabled()) return false;
    const { storage } = this.#options;
    const session = storage.sessions.get(sessionId);
    return (
      session !== undefined &&
      session.origin?.kind !== 'second_opinion' &&
      session.origin?.kind !== 'automation' &&
      session.side !== true &&
      storage.workspaces.get(session.workspaceId) !== undefined &&
      storage.workspaces.get(session.workspaceId)?.removedAt === undefined
    );
  }

  #record(id: EpisodeId): EpisodeRecord {
    const row = this.#options.storage.episodes.get(id);
    if (row === undefined || row.deletedAt !== undefined)
      throw new HostError('EPISODE_NOT_FOUND', `episode ${id} not found`, { id });
    return row;
  }

  #read(row: EpisodeRecord): Episode {
    return EpisodeSchema.parse({
      ...JSON.parse(row.digest),
      ...JSON.parse(row.overrides),
      overrides: JSON.parse(row.overrides),
      pinned: row.pinned,
      excluded: row.excluded,
      revision: row.revision,
      updatedAt: row.updatedAt,
      source:
        this.#options.storage.sessions.get(row.sessionId) === undefined ? 'deleted' : 'available',
    });
  }
  #changed(row: EpisodeRecord): void {
    for (const listener of this.#listeners)
      listener({ workspaceId: row.workspaceId as WorkspaceId, id: row.id as EpisodeId });
  }
  #cancel(id: string): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(id);
  }
}
