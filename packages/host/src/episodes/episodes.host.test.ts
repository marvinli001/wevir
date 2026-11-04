import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode, SessionId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const dir = useTempDir();
const stops: (() => Promise<unknown> | undefined)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});
async function boot() {
  const home = join(dir(), 'home');
  const project = join(dir(), 'project');
  mkdirSync(project);
  const host = await startHost({
    home,
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
  stops.push(() => host.shutdown());
  const client = await TestRpcClient.connect(host.url);
  stops.push(() => {
    client.ws.close();
    return undefined;
  });
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const hello = await client.hello(token);
  expect(hello.result.features.episodes).toBe(true);
  const { workspace } = await client.request('workspace.add', { rootPath: project });
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'Mock',
    models: [],
    defaultModelId: 'mock',
  });
  const create = async (): Promise<SessionId> =>
    (
      await client.request('session.create', {
        workspaceId: workspace.id,
        providerId: 'deepseek-official',
      })
    ).session.id;
  return { client, workspaceId: workspace.id, create };
}

describe('episode Host integration', () => {
  it.each([false, true])(
    'deletes family records and retains pins (root pinned: %s)',
    async (rootPinned) => {
      const { client, workspaceId, create } = await boot();
      const sessionId = await create();
      await client.request('session.send', {
        sessionId,
        content: [{ type: 'text', text: 'subagent hello' }],
      });
      await vi.waitFor(async () => {
        expect((await client.request('session.get', { sessionId })).session.state).toBe('idle');
      });
      const { sessions: children } = await client.request('session.list', {
        parentSessionId: sessionId,
      });
      expect(children).toHaveLength(1);
      const childId = children[0].id as SessionId;
      const records: Episode[] = [];
      for (const id of [sessionId, childId]) {
        const { episode } = await client.request('episode.refresh', { sessionId: id });
        records.push(episode);
      }
      const pinned = records[rootPinned ? 0 : 1] as Episode;
      const ordinary = records[rootPinned ? 1 : 0] as Episode;
      await client.request('episode.update', {
        id: pinned.id,
        revision: pinned.revision,
        patch: {
          title: 'deletionMarker retained',
          open: [{ id: 'user:1', text: 'Keep this task', origin: 'todo', status: 'pending' }],
        },
        pinned: true,
      });
      await client.request('episode.update', {
        id: ordinary.id,
        revision: ordinary.revision,
        patch: { title: 'deletionMarker ordinary' },
      });
      const unrelatedId = await create();
      await client.request('episode.refresh', { sessionId: unrelatedId });
      await client.request('session.archive', { sessionId, archived: true });
      const { episode: before } = await client.request('episode.get', { id: pinned.id });
      expect(
        (await client.request('context.search', { workspaceId, query: 'deletionMarker' })).hits,
      ).toHaveLength(2);
      await client.request('episode.list', { workspaceId });
      const changeCount = client.notifications('episode.changed').length;
      const deleted = await client.request('session.delete', { sessionId });
      expect(new Set(deleted.sessionIds)).toEqual(new Set([sessionId, childId]));
      await client.until(
        () =>
          client
            .notifications('episode.changed')
            .slice(changeCount)
            .find((change) => change.workspaceId === workspaceId && change.id === undefined),
        'deleted episode family notification',
      );
      expect((await client.call('episode.get', { id: ordinary.id })).error?.code).toBe(-32081);
      expect((await client.request('episode.get', { id: pinned.id })).episode).toMatchObject({
        title: before.title,
        revision: before.revision,
        overrides: before.overrides,
        open: before.open,
        pinned: true,
        source: 'deleted',
      });
      const { episodes } = await client.request('episode.list', { workspaceId });
      expect(episodes.map((episode: Episode) => episode.sessionId).sort()).toEqual(
        [pinned.sessionId, unrelatedId].sort(),
      );
      expect(episodes.find((episode: Episode) => episode.id === pinned.id).source).toBe('deleted');
      const { hits } = await client.request('context.search', {
        workspaceId,
        query: 'deletionMarker',
      });
      expect(hits).toHaveLength(1);
      const retrieved = await client.request('context.search', {
        workspaceId,
        handle: `ep:${pinned.id}`,
      });
      expect(retrieved.body).toContain('source=deleted');
      expect(retrieved.body).toContain('Keep this task');
    },
  );

  it('records at retro reads, close, archive, and same-project creation; publishes scoped changes', async () => {
    const { client, workspaceId, create } = await boot();
    const sessionId = await create();
    await client.request('episode.list', { workspaceId });
    await client.request('retro.get', { sessionId });
    const first = (await client.request('episode.list', { workspaceId })).episodes[0] as Episode;
    expect(first.sessionId).toBe(sessionId);
    await client.until(() => client.notifications('episode.changed')[0], 'episode notification');
    const edited = await client.request('episode.update', {
      id: first.id,
      revision: first.revision,
      patch: { title: 'Manual title' },
    });
    await client.request('session.rename', { sessionId, title: 'Automatic title' });
    await client.request('session.close', { sessionId });
    expect((await client.request('episode.get', { id: first.id })).episode.title).toBe(
      'Manual title',
    );
    expect(edited.conflict).toBeUndefined();
    const nextId = await create();
    await client.request('session.archive', { sessionId: nextId, archived: true });
    expect((await client.request('episode.list', { workspaceId })).episodes).toHaveLength(2);
    const catchUp = await create();
    await client.request('session.rename', { sessionId: catchUp, title: 'Latest task' });
    await create();
    expect(
      (await client.request('episode.list', { workspaceId })).episodes.some(
        (row: Episode) => row.title === 'Latest task',
      ),
    ).toBe(true);
  });

  it('respects autoEpisodes independently and preserves tombstones across creation', async () => {
    const { client, workspaceId, create } = await boot();
    const id = await create();
    const { episode } = await client.request('episode.refresh', { sessionId: id });
    await client.request('episode.delete', { id: episode.id, revision: episode.revision });
    await create();
    expect((await client.request('episode.list', { workspaceId })).episodes).toHaveLength(0);
    await client.request('settings.update', { settings: { autoEpisodes: false } });
    const nextId = await create();
    await client.request('session.close', { sessionId: nextId });
    expect(await client.request('episode.refresh', { sessionId: nextId })).toEqual({});
    await client.request('settings.update', {
      settings: { autoEpisodes: true, autoMemory: false },
    });
    expect((await client.request('episode.refresh', { sessionId: id })).episode).toMatchObject({
      id: episode.id,
    });
  });
});
