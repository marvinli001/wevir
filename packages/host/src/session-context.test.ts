import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Episode, SessionId } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EpisodeService } from './episodes/service.js';
import { MemoryStore } from './memory.js';
import { RetroService } from './retro/service.js';
import { SessionContexts } from './session-context.js';
import { createStore, ev, SES, useStorages, useTempDir } from './test-utils.js';

const dir = useTempDir();
const storages = useStorages();
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function boot() {
  const storage = storages.open(dir());
  const events = createStore(storage);
  const memory = new MemoryStore({ dir: join(dir(), 'memory') });
  const retro = new RetroService({ storage, events });
  const episodes = new EpisodeService({ storage, events, retro, enabled: () => true });
  const options = {
    storage,
    memory,
    episodes,
    memoryEnabled: () => true,
    episodesEnabled: () => true,
    channel: () => 'instructions' as const,
  };
  const contexts = new SessionContexts(options);
  stops.push(() => {
    contexts.dispose();
    episodes.dispose();
    events.close();
  });
  const target = { providerId: 'mock', workspaceId: 'ws_1', cwd: '/not-a-repo' };
  return { storage, events, memory, episodes, options, contexts, target };
}
const note = {
  name: 'test-command',
  type: 'reference' as const,
  description: 'Old command',
  content: 'npm test',
};

describe('engine-session context freezing', () => {
  it('persists exactly the supplied text and restores it across a new service instance', async () => {
    const { memory, contexts, target, options, storage } = boot();
    await memory.save('project', 'ws_1', note);
    const first = await contexts.prepare(SES, target);
    const receipt = contexts.bind(SES, 'thread-1');
    expect(receipt?.hash).toBe(createHash('sha256').update(first.text).digest('hex'));
    expect(receipt?.included[0]).toMatchObject({ kind: 'memory', name: 'test-command' });
    expect(contexts.bind(SES, 'thread-1')).toBeUndefined();
    await memory.save('project', 'ws_1', { ...note, description: 'New command' });
    const restarted = new SessionContexts(options);
    const resumed = await restarted.prepare(SES, { ...target, engineSessionId: 'thread-1' });
    expect(resumed.text).toBe(first.text);
    expect(resumed.receipt.engineSession).toBe('resumed_frozen');
    restarted.bind(SES, 'thread-1');
    expect(storage.sessionContexts.get(SES, 'mock\0thread-1')?.text).toBe(first.text);
    const next = await restarted.prepare(SES, target);
    expect(next.text).toContain('New command');
    expect(next.receipt.hash).not.toBe(first.receipt.hash);
  });

  it('does not recompute a pre-upgrade engine session with no recorded body', async () => {
    const { memory, contexts, target } = boot();
    await memory.save('project', 'ws_1', note);
    const resumed = await contexts.prepare(SES, { ...target, engineSessionId: 'legacy-thread' });
    expect(resumed.text).toBe('');
    expect(resumed.receipt).toMatchObject({
      legacy: true,
      engineSession: 'resumed_frozen',
      bytes: 0,
    });
    contexts.bind(SES, 'legacy-thread');
    expect((await contexts.prepare(SES, target)).text).toContain('Old command');
  });

  it('isolates providers and handles same-source handoff versus restoring an old engine session', async () => {
    const { memory, contexts, target } = boot();
    await memory.save('project', 'ws_1', note);
    const old = await contexts.prepare(SES, target);
    contexts.bind(SES, 'thread');
    await memory.save('project', 'ws_1', { ...note, description: 'New command' });
    const other = await contexts.prepare(SES, { ...target, providerId: 'other' });
    contexts.bind(SES, 'thread');
    expect(other.text).toContain('New command');
    expect((await contexts.prepare(SES, { ...target, engineSessionId: 'thread' })).text).toBe(
      old.text,
    );
    expect(
      (await contexts.prepare(SES, { ...target, providerId: 'other', engineSessionId: 'thread' }))
        .text,
    ).toBe(other.text);
  });

  it('keeps startup material within 8000 bytes and supplies recent/pinned record handles', async () => {
    const { memory, episodes, contexts, target, events } = boot();
    for (let index = 0; index < 30; index++)
      await memory.save('project', 'ws_1', {
        ...note,
        name: `note-${index}`,
        description: '记忆'.repeat(90),
      });
    events.appendMany(SES, [ev.user(), ev.turnStarted(), ev.turnFinished('completed')]);
    const first = (await episodes.refresh(SES)) as Episode;
    episodes.update({
      id: first.id,
      revision: first.revision,
      pinned: true,
      patch: {
        open: [{ id: 'todo:1', text: 'applyDiscount rounding', origin: 'todo', status: 'pending' }],
      },
    });
    const pack = await contexts.prepare(SES, target);
    expect(Buffer.byteLength(pack.text)).toBeLessThanOrEqual(8000);
    expect(pack.receipt.memoryIndexBytes).toBeLessThanOrEqual(6000);
    expect(pack.receipt.omitted.length).toBeGreaterThan(0);
    expect(pack.text).toContain(`ep:${first.id}`);
    expect(pack.text).toContain('applyDiscount rounding');
    expect(pack.receipt.included.some((source) => source.kind === 'episode')).toBe(true);
  });

  it('deletes frozen bodies with the source session', async () => {
    const { storage, contexts, target, events } = boot();
    await contexts.prepare(SES, target);
    contexts.bind(SES, 'thread');
    events.close();
    storage.transaction(() => storage.sessions.remove([SES]));
    expect(storage.sessionContexts.get(SES, 'mock\0thread')).toBeUndefined();
    contexts.forget([SES as SessionId]);
    expect(contexts.active(SES)).toBeUndefined();
  });
});
