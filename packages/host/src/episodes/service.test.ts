import type { Episode, EpisodeId, WorkspaceId } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetroService } from '../retro/service.js';
import { createStore, ev, SES, SES2, useStorages, useTempDir } from '../test-utils.js';
import { EPISODE_IDLE_MS, EpisodeService } from './service.js';

const dir = useTempDir();
const storages = useStorages();
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});
function boot() {
  const storage = storages.open(dir());
  const events = createStore(storage);
  const retro = new RetroService({ storage, events });
  let enabled = true;
  const episodes = new EpisodeService({ storage, events, retro, enabled: () => enabled });
  stops.push(() => {
    episodes.dispose();
    events.close();
  });
  events.appendMany(SES, [ev.user(), ev.turnStarted(), ev.turnFinished('completed')]);
  return {
    storage,
    events,
    episodes,
    retro,
    disable: () => {
      enabled = false;
    },
  };
}

describe('episode lifecycle', () => {
  it('is idempotent, keeps user overrides, and rejects stale revisions', async () => {
    const { episodes, events } = boot();
    const first = (await episodes.refresh(SES)) as Episode;
    expect(await episodes.refresh(SES)).toEqual(first);
    const edited = episodes.update({
      id: first.id,
      revision: first.revision,
      patch: { title: 'User title' },
      pinned: true,
    });
    events.append(SES, ev.title('Automatic title'));
    const refreshed = (await episodes.refresh(SES)) as Episode;
    expect(refreshed.title).toBe('User title');
    expect(refreshed.pinned).toBe(true);
    expect(
      episodes.update({ id: first.id, revision: first.revision, patch: { title: 'Old editor' } })
        .conflict,
    ).toBe(true);
    expect(edited.conflict).toBeUndefined();
  });

  it('keeps tombstones until explicitly regenerated and redacts user edits', async () => {
    const { episodes, storage } = boot();
    const first = (await episodes.refresh(SES)) as Episode;
    episodes.update({
      id: first.id,
      revision: first.revision,
      patch: { title: 'sk-abcdefghijklmnopqrstuvwxyz123456' },
    });
    expect(storage.episodes.get(first.id)?.overrides).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz',
    );
    expect(episodes.delete({ id: first.id, revision: first.revision })).toEqual({ conflict: true });
    episodes.delete({ id: first.id });
    expect(await episodes.refresh(SES)).toBeUndefined();
    expect(storage.episodes.get(first.id)?.digest).toBe('{}');
    expect(() => episodes.get(first.id)).toThrow();
    expect(await episodes.refresh(SES, true)).toMatchObject({ id: first.id });
  });

  it('does not record when disabled, or for removed projects', async () => {
    const { episodes, disable, storage } = boot();
    disable();
    expect(await episodes.refresh(SES, true)).toBeUndefined();
    storage.workspaces.markRemoved('ws_1', '2026-11-04T00:00:00.000Z');
    expect(await episodes.refresh(SES)).toBeUndefined();
  });

  it('coalesces idle timers, waits ten minutes, and stops on disposal', async () => {
    const { episodes } = boot();
    vi.useFakeTimers();
    const refresh = vi.spyOn(episodes, 'refresh').mockResolvedValue(undefined);
    episodes.onTurnFinished(SES);
    await vi.advanceTimersByTimeAsync(EPISODE_IDLE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    episodes.onTurnFinished(SES);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EPISODE_IDLE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    episodes.onTurnFinished(SES);
    episodes.dispose();
    await vi.advanceTimersByTimeAsync(EPISODE_IDLE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes at close and catches up recent stale sessions only', async () => {
    const { episodes, events, storage } = boot();
    await episodes.beforeClose(SES);
    expect(storage.episodes.forSession(SES)).toBeDefined();
    events.append(SES, ev.title('New title'));
    await episodes.catchUp('ws_1');
    expect(episodes.list({ workspaceId: 'ws_1' as WorkspaceId }).episodes[0]?.title).toBe(
      'New title',
    );
    expect(storage.episodes.forSession(SES)?.throughSeq).toBe(storage.events.lastSeq(SES));
  });

  it('removes project records and emits changes', async () => {
    const { episodes, storage } = boot();
    const changed = vi.fn();
    episodes.watch(changed);
    const episode = (await episodes.refresh(SES)) as Episode;
    expect(changed).toHaveBeenCalledWith({ workspaceId: 'ws_1', id: episode.id });
    episodes.removeWorkspace('ws_1' as WorkspaceId);
    expect(storage.episodes.get(episode.id)).toBeUndefined();
    expect(changed).toHaveBeenLastCalledWith({ workspaceId: 'ws_1' });
    expect(() => episodes.get('ep_missing' as EpisodeId)).toThrow();
    expect(storage.episodes.forSession(SES2)).toBeUndefined();
  });
});
