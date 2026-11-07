import type {
  ContextHit,
  ContextSearchParams,
  ContextSearchResult,
  ContextSourceRef,
  Episode,
  MemoryNote,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import type { ContextDocRecord, Storage } from '@wevir/storage';
import { episodeMarkdown, redactEpisodeValue } from './episodes/build.js';
import type { EpisodeService } from './episodes/service.js';
import { HostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { HISTORY_EVENT_TYPES, historyItems } from './handoff.js';
import { MemoryError, type MemoryStore } from './memory.js';
import { parseQuery, type SessionSearch, snippetOf } from './session-search.js';

export const CONTEXT_SEARCH_BYTES = 4000;
export const CONTEXT_READ_BYTES = 7000;
const SECTIONS = [
  'goal',
  'outcome',
  'done',
  'open',
  'lessons',
  'decisions',
  'files',
  'commits',
  'memories',
] as const;
interface Material {
  doc: ContextDocRecord;
  source: ContextSourceRef;
  handle: string;
  memory?: MemoryNote;
  episode?: Episode;
}

export interface ContextSearchOptions {
  storage: Storage;
  events: EventStore;
  memory: MemoryStore;
  episodes: EpisodeService;
  search: SessionSearch;
  memoryEnabled: () => boolean;
  episodesEnabled: () => boolean;
  isChats?: (workspace: { rootPath: string }) => boolean;
  now?: () => number;
}

export class ContextSearch {
  readonly #options: ContextSearchOptions;
  constructor(options: ContextSearchOptions) {
    this.#options = options;
  }

  async query(params: ContextSearchParams, cwd?: string): Promise<ContextSearchResult> {
    const scopes = this.#scopes(params.workspaceId);
    if (params.handle !== undefined) return this.#read(params, scopes, cwd);
    const materials = await this.#materials(scopes, cwd);
    const terms = parseQuery(params.query as string);
    if (terms.length === 0) throw this.#invalid('query has no words');
    const sync = () =>
      this.#options.storage.transaction(() => {
        for (const id of [undefined, ...scopes])
          this.#options.storage.contextIndex.sync(
            id,
            materials.filter((item) => item.doc.workspaceId === id).map((item) => item.doc),
          );
      });
    const find = () =>
      this.#options.storage.contextIndex.query({
        workspaceIds: scopes,
        kinds: params.kinds?.filter((kind) => kind !== 'session') ?? ['memory', 'episode'],
        includeInvalid: params.includeInvalid === true,
        ...(params.path !== undefined && { path: params.path }),
        terms,
      });
    let result: ReturnType<typeof find>;
    try {
      sync();
      result = find();
    } catch {
      this.#options.storage.contextIndex.reset();
      sync();
      result = find();
    }
    const byRef = new Map(materials.map((item) => [item.doc.ref, item]));
    const now = this.#options.now?.() ?? Date.now();
    const scored = result.docs
      .flatMap((doc) => {
        const item = byRef.get(doc.ref);
        if (item === undefined) return [];
        const age = Math.max(0, now - (Date.parse(doc.updatedAt) || now));
        let score = doc.score * 2 ** (-age / (30 * 86_400_000));
        if (doc.workspaceId !== undefined) score *= 1.2;
        if (item.episode?.pinned) score *= 1.5;
        if (
          ['feedback', 'user'].includes(item.memory?.type ?? '') ||
          ['open', 'lessons'].includes(
            item.source.kind === 'episode' ? (item.source.section ?? '') : '',
          )
        )
          score *= 1.2;
        if (['changed', 'moved', 'missing'].includes(item.memory?.freshness?.state ?? ''))
          score *= 0.8;
        return [{ item, score }];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.item.doc.updatedAt.localeCompare(a.item.doc.updatedAt) ||
          a.item.doc.ref.localeCompare(b.item.doc.ref),
      );
    const hits: ContextHit[] = [];
    const seen = new Map<string, ContextHit>();
    for (const { item } of scored) {
      const key = item.episode?.id ?? item.doc.ref;
      const previous = seen.get(key);
      if (previous !== undefined) {
        if (item.source.kind === 'episode' && item.source.section !== undefined)
          previous.sections = [...(previous.sections ?? []), item.source.section];
        continue;
      }
      const hit: ContextHit = {
        handle: item.handle,
        kind: item.doc.kind,
        title: item.doc.title,
        snippet: Array.from(snippetOf(item.doc.body, terms).snippet).slice(0, 200).join(''),
        updatedAt: item.doc.updatedAt,
        source: item.source,
        revision: item.doc.revision,
        ...(item.memory?.freshness !== undefined && { freshness: item.memory.freshness }),
        ...(item.memory?.validity !== undefined && { validity: item.memory.validity }),
      };
      hits.push(hit);
      seen.set(key, hit);
    }
    let scan = result.scan;
    if (params.kinds?.includes('session')) {
      const found = this.#options.search.query({
        query: params.query as string,
        scope: { workspaceIds: scopes as WorkspaceId[], includeArchived: true },
        limit: 10,
      });
      for (const hit of redactEpisodeValue(found.hits).value)
        hits.push({
          handle: `ses:${hit.sessionId}/e${hit.seq}`,
          kind: 'session',
          title: hit.sessionTitle,
          snippet: Array.from(hit.snippet).slice(0, 200).join(''),
          updatedAt: hit.ts,
          source: { kind: 'history', sessionId: hit.sessionId, itemId: `e${hit.seq}` },
        });
      if (found.scan !== undefined && scan === undefined)
        scan = { reason: 'short_term', examined: found.scan.examined, limit: found.scan.limit };
    }
    const page: ContextSearchResult = { hits: [], ...(scan !== undefined && { scan }) };
    for (const hit of hits.slice(0, params.limit ?? 5)) {
      page.hits.push(hit);
      if (Buffer.byteLength(JSON.stringify(page)) > CONTEXT_SEARCH_BYTES) {
        page.hits.pop();
        break;
      }
    }
    return page;
  }

  async #materials(scopes: string[], cwd?: string): Promise<Material[]> {
    const { memory, episodes, memoryEnabled, episodesEnabled } = this.#options;
    const result: Material[] = [];
    if (memoryEnabled()) {
      for (const note of await memory.readAll()) result.push(this.#memoryMaterial(note, undefined));
      for (const id of scopes) {
        for (const note of (await memory.readAll(id, scopes.length === 1 ? cwd : undefined)).filter(
          (note) => note.scope === 'project',
        ))
          result.push(this.#memoryMaterial(note, id));
      }
    }
    if (episodesEnabled())
      for (const id of scopes)
        for (const row of this.#options.storage.episodes.list(id)) {
          const episode = episodes.get(row.id as Episode['id']);
          for (const section of SECTIONS) {
            const body = episodeMarkdown(episode, section);
            if (!body.includes('\n')) continue;
            result.push({
              doc: {
                ref: `ep:${episode.id}#${section}`,
                kind: 'episode',
                workspaceId: id,
                title: `${episode.title} ${section}`,
                body,
                updatedAt: episode.updatedAt,
                revision: episode.revision,
                state: episode.excluded ? 'excluded' : 'active',
                paths: episode.files.map((file) => file.path),
              },
              source: {
                kind: 'episode',
                id: episode.id,
                revision: episode.revision,
                throughSeq: episode.throughSeq,
                section,
              },
              handle: `ep:${episode.id}#${section}`,
              episode,
            });
          }
        }
    return result;
  }

  #memoryMaterial(note: MemoryNote, workspaceId: string | undefined): Material {
    const handle = `mem:${note.scope}/${note.name}${workspaceId === undefined ? '' : `@${workspaceId}`}`;
    const redacted = redactEpisodeValue(note).value;
    return {
      doc: {
        ref: handle,
        kind: 'memory',
        ...(workspaceId !== undefined && { workspaceId }),
        title: redacted.description,
        body: redacted.content,
        updatedAt: note.updatedAt,
        revision: note.revision,
        state: !note.enabled
          ? 'disabled'
          : note.validity?.invalidAt !== undefined
            ? 'invalid'
            : 'active',
        paths: redacted.paths ?? [],
      },
      source: {
        kind: 'memory',
        scope: note.scope,
        name: note.name,
        revision: note.revision,
        ...(workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
        ...(note.freshness !== undefined && { freshness: note.freshness.state }),
      },
      handle,
      memory: redacted,
    };
  }

  async #read(
    params: ContextSearchParams,
    scopes: string[],
    cwd?: string,
  ): Promise<ContextSearchResult> {
    const handle = params.handle as string;
    let text: string;
    let source: ContextSourceRef;
    let revision: string | undefined;
    let memory: MemoryNote | undefined;
    if (handle.startsWith('mem:') && this.#options.memoryEnabled()) {
      const match = /^mem:(global|project)\/([a-z0-9-]+)(?:@(ws_[A-Za-z0-9]+))?$/.exec(handle);
      if (match === null) throw this.#invalid('invalid memory handle');
      const scope = match[1] as 'global' | 'project';
      const workspaceId = match[3] ?? (scopes.length === 1 ? scopes[0] : undefined);
      if (scope === 'project' && (workspaceId === undefined || !scopes.includes(workspaceId)))
        throw this.#invalid('project memory handle needs a workspace');
      memory = await this.#options.memory
        .read(scope, workspaceId, match[2] as string, { cwd })
        .catch((error: unknown) => {
          if (error instanceof MemoryError) throw this.#invalid(error.message);
          throw error;
        });
      if (memory.validity?.invalidAt !== undefined && params.includeInvalid !== true)
        throw this.#invalid('memory is invalid; use includeInvalid to inspect it');
      const material = this.#memoryMaterial(memory, scope === 'global' ? undefined : workspaceId);
      text = material.doc.body;
      source = material.source;
      revision = memory.revision;
      memory = material.memory;
    } else if (handle.startsWith('ep:') && this.#options.episodesEnabled()) {
      const match = /^ep:(ep_[A-Za-z0-9]+)(?:#([a-z]+))?$/.exec(handle);
      if (
        match === null ||
        (match[2] !== undefined && !SECTIONS.includes(match[2] as (typeof SECTIONS)[number]))
      )
        throw this.#invalid('invalid episode handle');
      const episode = this.#options.episodes.get(match[1] as Episode['id']);
      if (!scopes.includes(episode.workspaceId) || episode.excluded)
        throw this.#invalid('episode is outside the search scope');
      text = episodeMarkdown(episode, match[2]);
      revision = episode.revision;
      source = {
        kind: 'episode',
        id: episode.id,
        revision,
        throughSeq: episode.throughSeq,
        ...(match[2] !== undefined && { section: match[2] }),
      };
    } else if (handle.startsWith('ses:')) {
      const match = /^ses:(ses_[A-Za-z0-9]+)\/(e[0-9]+)$/.exec(handle);
      if (match === null) throw this.#invalid('invalid session handle');
      const record = this.#options.storage.sessions.get(match[1] as string);
      if (record === undefined || !scopes.includes(record.workspaceId) || record.side)
        throw this.#invalid('session is outside the search scope');
      const item = historyItems(
        this.#options.events.readTypes(record.id as SessionId, HISTORY_EVENT_TYPES, {
          omitToolOutput: true,
        }),
      ).find((item) => item.itemId === match[2]);
      if (item === undefined) throw this.#invalid('session item is no longer available');
      text = redactEpisodeValue(item.text).value;
      source = { kind: 'history', sessionId: record.id as SessionId, itemId: item.itemId };
    } else throw this.#invalid('context is unavailable');
    const chars = Array.from(text);
    const offset = Math.min(params.textOffset ?? 0, chars.length);
    const result: ContextSearchResult & { body: string } = {
      hits: [],
      body: '',
      source,
      ...(revision !== undefined && { revision }),
      ...(memory?.freshness !== undefined && { freshness: memory.freshness }),
      ...(memory?.validity !== undefined && { validity: memory.validity }),
      textOffset: offset,
      nextTextOffset: null,
    };
    let end = offset;
    while (end < chars.length) {
      result.body += chars[end] as string;
      end += 1;
      result.nextTextOffset = end < chars.length ? end : null;
      if (Buffer.byteLength(JSON.stringify(result)) > CONTEXT_READ_BYTES) {
        end -= 1;
        result.body = chars.slice(offset, end).join('');
        result.nextTextOffset = end;
        break;
      }
    }
    return result;
  }

  #scopes(workspaceId: WorkspaceId | undefined): string[] {
    const { storage } = this.#options;
    if (workspaceId === undefined)
      return storage.workspaces
        .list()
        .filter(
          (workspace) =>
            workspace.removedAt === undefined && this.#options.isChats?.(workspace) !== true,
        )
        .map((workspace) => workspace.id);
    const workspace = storage.workspaces.get(workspaceId);
    if (workspace === undefined || workspace.removedAt !== undefined)
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    return [workspaceId];
  }
  #invalid(message: string): HostError {
    return new HostError('INVALID_PARAMS', message, { issues: [{ path: [], message }] });
  }
}
