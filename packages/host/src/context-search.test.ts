import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode, WorkspaceId } from '@wevir/protocol';
import { APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import { createContextIndexRepository } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { AppTools } from './app-tools.js';
import { CONTEXT_READ_BYTES, CONTEXT_SEARCH_BYTES, ContextSearch } from './context-search.js';
import { EpisodeService } from './episodes/service.js';
import { MemoryStore } from './memory.js';
import { RetroService } from './retro/service.js';
import type { SessionManager } from './session-manager.js';
import { SessionSearch } from './session-search.js';
import { createStore, ev, SES, useStorages, useTempDir } from './test-utils.js';
import { toolTier } from './tool-presets.js';

const dir = useTempDir();
const storages = useStorages();
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
const workspaceId = 'ws_1' as WorkspaceId;
const note = {
  name: 'quota',
  type: 'feedback' as const,
  description: '额度与接力',
  content: '额度耗尽时接力，避免截断与死循环。invoiceTotal in package.json uses integer cents.',
  paths: ['package.json'],
};
function boot() {
  const storage = storages.open(dir());
  const events = createStore(storage);
  const memory = new MemoryStore({ dir: join(dir(), 'memory') });
  const retro = new RetroService({ storage, events });
  let memoryEnabled = true;
  let episodesEnabled = true;
  const episodes = new EpisodeService({ storage, events, retro, enabled: () => episodesEnabled });
  const sessions = new SessionSearch({ storage });
  const search = new ContextSearch({
    storage,
    events,
    memory,
    episodes,
    search: sessions,
    memoryEnabled: () => memoryEnabled,
    episodesEnabled: () => episodesEnabled,
  });
  stops.push(() => {
    episodes.dispose();
    sessions.close();
    events.close();
  });
  return {
    storage,
    events,
    memory,
    episodes,
    search,
    disableMemory: () => {
      memoryEnabled = false;
    },
    disableEpisodes: () => {
      episodesEnabled = false;
    },
  };
}

describe('context retrieval', () => {
  it('exposes one read-only on-demand tool and fixes its scope to the calling session', async () => {
    const { memory, search, storage, events } = boot();
    await memory.save('project', workspaceId, note);
    const app = new AppTools({
      hostId: 'hst_1',
      sendWhileBusy: () => 'steer',
      storage,
      events,
      sessions: {} as SessionManager,
      contextSearch: search,
    });
    const tool = app.tools.find((entry) => entry.name === 'wevir_context_search');
    expect(toolTier('wevir_context_search')).toBe('more');
    expect(APP_TOOLS_NO_APPROVAL).toContain('wevir_context_search');
    expect(tool?.annotations.readOnlyHint).toBe(true);
    const result = await tool?.call(
      { query: '额度', workspaceId: 'ws_other' },
      { sessionId: SES, signal: new AbortController().signal },
    );
    expect(result?.structuredContent).toBeUndefined();
    const block = result?.content[0];
    expect(block?.type === 'text' && JSON.parse(block.text).hits[0].source.workspaceId).toBe(
      workspaceId,
    );
  });
  it('finds two-character Chinese, trigram phrases, English, and paths; retrieves each handle in one call', async () => {
    const { memory, search } = boot();
    await memory.save('project', workspaceId, note);
    for (const query of ['额度', '接力', '截断', '死循环', 'invoiceTotal', 'package.json']) {
      const found = await search.query({ workspaceId, query });
      expect(found.hits[0]?.title, query).toBe(note.description);
      if (Array.from(query).length < 3) expect(found.scan?.reason).toBe('short_term');
      const read = await search.query({ workspaceId, handle: found.hits[0]?.handle as string });
      expect(read.body).toBe(note.content);
      expect(read.revision).toBeDefined();
    }
    expect(
      (await search.query({ workspaceId, query: '额度', path: 'package.json' })).hits,
    ).toHaveLength(1);
    expect((await search.query({ workspaceId, query: '额度', path: 'src' })).hits).toHaveLength(0);
  });

  it('never returns disabled notes; invalid notes need includeInvalid even with a handle', async () => {
    const { memory, search } = boot();
    const saved = await memory.save('project', workspaceId, note);
    await memory.update('project', workspaceId, note.name, saved.note.revision, {
      invalidate: { reason: 'Replaced' },
    });
    expect((await search.query({ workspaceId, query: '额度' })).hits).toEqual([]);
    const invalid = await search.query({ workspaceId, query: '额度', includeInvalid: true });
    expect(invalid.hits[0]?.validity?.reason).toBe('Replaced');
    await expect(
      search.query({ workspaceId, handle: invalid.hits[0]?.handle as string }),
    ).rejects.toThrow(/invalid/);
    expect(
      (
        await search.query({
          workspaceId,
          handle: invalid.hits[0]?.handle as string,
          includeInvalid: true,
        })
      ).body,
    ).toBe(note.content);
    await memory.setEnabled('project', workspaceId, note.name, false);
    expect((await search.query({ workspaceId, query: '额度', includeInvalid: true })).hits).toEqual(
      [],
    );
    await expect(
      search.query({
        workspaceId,
        handle: `mem:project/quota@${workspaceId}`,
        includeInvalid: true,
      }),
    ).rejects.toThrow();
  });

  it('reconciles hand-edited files and recovers a damaged FTS index', async () => {
    const { memory, search, storage } = boot();
    await memory.save('project', workspaceId, note);
    await search.query({ workspaceId, query: '额度' });
    const file = join(dir(), 'memory/projects/ws_1/quota.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(note.content, 'newly corrected command'),
    );
    expect((await search.query({ workspaceId, query: '额度' })).hits[0]?.snippet).not.toContain(
      'invoiceTotal',
    );
    expect((await search.query({ workspaceId, query: 'corrected' })).hits).toHaveLength(1);
    storage.db.exec('DROP TABLE context_fts');
    expect((await search.query({ workspaceId, query: 'corrected' })).hits).toHaveLength(1);
  });

  it('falls back to bounded scans without FTS and treats FTS operators as plain text', async () => {
    const { memory, search, storage } = boot();
    Object.defineProperty(storage, 'contextIndex', {
      value: createContextIndexRepository(storage.db, { fts: false }),
    });
    await memory.save('project', workspaceId, {
      ...note,
      content: 'A literal OR operator and "quoted" term',
    });
    const found = await search.query({ workspaceId, query: 'operator' });
    expect(found.scan).toMatchObject({ reason: 'fts_unavailable', limit: 5000 });
    expect(found.hits).toHaveLength(1);
    expect((await search.query({ workspaceId, query: 'operator OR absent' })).hits).toHaveLength(0);
  });

  it('isolates project handles and honors memory/episode switches', async () => {
    const { memory, search, storage, episodes, disableMemory, disableEpisodes } = boot();
    storage.workspaces.insert({
      id: 'ws_2',
      rootPath: '/another',
      displayName: 'Other',
      createdAt: '2026-11-04',
      updatedAt: '2026-11-04',
    });
    await memory.save('project', 'ws_2', note);
    expect((await search.query({ workspaceId, query: '额度' })).hits).toEqual([]);
    await expect(search.query({ workspaceId, handle: 'mem:project/quota@ws_2' })).rejects.toThrow(
      /workspace/,
    );
    await memory.save('global', undefined, note);
    disableMemory();
    expect((await search.query({ workspaceId, query: '额度' })).hits).toEqual([]);
    const episode = (await episodes.refresh(SES)) as Episode;
    disableEpisodes();
    await expect(search.query({ workspaceId, handle: `ep:${episode.id}` })).rejects.toThrow(
      /unavailable/,
    );
  });

  it('deduplicates episode sections and ranks pinned/open work above global notes', async () => {
    const { memory, search, episodes, events } = boot();
    await memory.save('global', undefined, note);
    await memory.save('project', workspaceId, note);
    events.appendMany(SES, [ev.user(), ev.turnStarted(), ev.turnFinished('completed')]);
    const initial = (await episodes.refresh(SES)) as Episode;
    const episode = episodes.update({
      id: initial.id,
      revision: initial.revision,
      pinned: true,
      patch: {
        title: '额度 task',
        open: [{ id: 'user:1', text: '额度恢复', origin: 'todo', status: 'pending' }],
        lessons: [{ kind: 'correction', text: '额度采用整数分', sources: ['e2'], verified: false }],
      },
    }).episode;
    const found = await search.query({ workspaceId, query: '额度' });
    expect(found.hits[0]?.kind).toBe('episode');
    expect(found.hits.filter((hit) => hit.kind === 'episode')).toHaveLength(1);
    expect(found.hits[0]?.sections?.length).toBeGreaterThan(0);
    expect((await search.query({ workspaceId, handle: `ep:${episode.id}#open` })).body).toContain(
      '额度恢复',
    );
    episodes.update({ id: episode.id, revision: episode.revision, patch: {}, excluded: true });
    expect(
      (await search.query({ workspaceId, query: '额度' })).hits.some(
        (hit) => hit.kind === 'episode',
      ),
    ).toBe(false);
  });

  it('keeps search and retrieval pages within byte budgets, including escaped text and provenance', async () => {
    const { memory, search, episodes } = boot();
    for (let index = 0; index < 12; index++)
      await memory.save('project', workspaceId, {
        ...note,
        name: `quota-${index}`,
        description: '额度'.repeat(90),
      });
    const found = await search.query({ workspaceId, query: '额度', limit: 10 });
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(CONTEXT_SEARCH_BYTES);
    const initial = (await episodes.refresh(SES)) as Episode;
    const text = '金额\\"🙂'.repeat(1000);
    const episode = episodes.update({
      id: initial.id,
      revision: initial.revision,
      patch: { lessons: [{ kind: 'correction', text, sources: [], verified: false }] },
    }).episode;
    let offset = 0;
    let joined = '';
    do {
      const page = await search.query({
        workspaceId,
        handle: `ep:${episode.id}#lessons`,
        textOffset: offset,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(CONTEXT_READ_BYTES);
      joined += page.body;
      offset = page.nextTextOffset ?? -1;
    } while (offset >= 0);
    expect(joined).toContain(text);
  });

  it('reuses session search and returns source items without widening scope', async () => {
    const { search, events } = boot();
    const user = ev.user();
    user.payload.content = [{ type: 'text', text: '额度恢复 and invoiceTotal' }];
    events.appendMany(SES, [user, ev.turnStarted(), ev.turnFinished('completed')]);
    const found = await search.query({ workspaceId, query: '额度', kinds: ['session'] });
    expect(found.hits[0]?.kind).toBe('session');
    expect(
      (await search.query({ workspaceId, handle: found.hits[0]?.handle as string })).body,
    ).toContain('invoiceTotal');
  });
});
