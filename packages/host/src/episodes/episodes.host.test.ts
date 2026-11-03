import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode, SessionId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
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
