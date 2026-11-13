import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { schemas } from '@wevir/protocol/sync';
import type { AppToolsEndpoint, SessionConfig, TitleRequest } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { MemoryStore } from '../memory.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
class SummaryEcho extends EchoAdapter {
  constructor(readonly appTools = false) {
    super();
  }
  readonly endpoints = new Map<string, AppToolsEndpoint | undefined>();
  override async createSession(config: SessionConfig) {
    const session = await super.createSession(config);
    this.endpoints.set(session.engineSessionId, config.appTools);
    return session;
  }
  summary = '';
  readonly deleted: string[] = [];
  override async deleteSession(id: string): Promise<void> {
    this.deleted.push(id);
  }
  async generateTitle(_sessionId: string, _request: TitleRequest): Promise<string> {
    return this.summary;
  }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(withTools = false) {
  const mock = await startMockZuv();
  cleanups.push(() => mock.close());
  const boot = async (name: string) => {
    const base = join(tempDir(), name);
    const home = join(base, 'home');
    const userHome = join(base, 'user');
    const project = join(base, 'project');
    await mkdir(userHome, { recursive: true });
    await mkdir(project, { recursive: true });
    const adapter = new SummaryEcho(withTools);
    const host = await startHost({
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      adapter,
      engine: 'echo',
      zuv: {
        origin: mock.origin,
        allowLoopback: true,
        deviceName: `Synthetic ${name}`,
        syncIntervalMs: 20,
      },
      logger: createLogger({ mirror: () => {} }),
    });
    cleanups.push(() => host.shutdown());
    const token = JSON.parse(await readFile(join(home, 'run/host.json'), 'utf8')).token as string;
    const rpc = await TestRpcClient.connect(host.url);
    cleanups.push(() => rpc.ws.terminate());
    await rpc.hello(token, undefined, { subscription_kinds: true, provider_kind_chatgpt: true });
    const workspaceId = (await rpc.request('workspace.add', { rootPath: project })).workspace
      .id as WorkspaceId;
    const memory = new MemoryStore({ dir: join(home, 'memory') });
    const login = (await rpc.request('account.login', { kind: 'zuv', method: 'browser' })).account;
    mock.approve(login.login.authUrl);
    await rpc.until(
      () =>
        rpc
          .notifications('account.updated')
          .find(
            (value) =>
              (value.account as { kind: string; status: string }).kind === 'zuv' &&
              (value.account as { status: string }).status === 'signed_in',
          ),
      'synthetic ZUV sign-in',
    );
    return { home, userHome, project, workspaceId, rpc, memory, adapter, url: host.url, token };
  };
  return { mock, first: await boot('first'), second: await boot('second') };
}

type Peer = Awaited<ReturnType<typeof fixture>>['first'];
async function linkSessions(first: Peer, second: Peer, includeHistory = true, artifacts = false) {
  await first.rpc.request('provider.upsert', {
    id: 'synthetic-api',
    kind: 'openai-compatible',
    displayName: 'Synthetic API',
    api: 'openai-responses',
    baseURL: 'https://synthetic.invalid/v1',
    models: [{ id: 'synthetic-model' }],
    defaultModelId: 'synthetic-model',
  });
  const params = {
    enabled: true,
    categories: ['project', 'session', 'event-segment', ...(artifacts ? ['artifact'] : [])],
    includeHistory,
  };
  const selected = await first.rpc.request('sync.configure', {
    ...params,
    projects: [{ workspaceId: first.workspaceId }],
  });
  const target = {
    ...params,
    projects: [{ workspaceId: second.workspaceId, projectId: selected.binding.projectIds[0] }],
  };
  expect((await second.rpc.call('sync.configure', target)).error).toMatchObject({
    data: { code: 'RECOVERY_REQUIRED' },
  });
  const status = await second.rpc.request('sync.status');
  await first.rpc.request('sync.approveDevice', { deviceId: status.binding.deviceId });
  await second.rpc.request('sync.configure', target);
}

describe('full Host material synchronization with synthetic identities', () => {
  it('reads immutable text, binary and HTML artifacts by source event without falling back to local files', async () => {
    const { first, second } = await fixture(true);
    await linkSessions(first, second, true, true);
    const session = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    const binary = randomBytes(256 * 1024);
    await writeFile(join(first.project, 'report.md'), 'Synthetic version one');
    await writeFile(join(first.project, 'archive.bin'), binary);
    await writeFile(join(first.project, 'page.html'), '<h1>Synthetic artifact</h1>');
    await writeFile(join(first.project, '.env.test'), 'synthetic-not-a-real-secret');
    await writeFile(join(first.project, 'not-shared.txt'), 'Synthetic private sibling');
    await writeFile(join(second.project, 'report.md'), 'Synthetic unrelated local file');
    const endpoint = first.adapter.endpoints.get(session.engine.sessionId);
    if (!endpoint) throw new Error('missing synthetic tool endpoint');
    const share = async (paths: string[]) => {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: paths.length,
          method: 'tools/call',
          params: { name: 'wevir_share_file', arguments: { paths } },
        }),
      });
      expect(await response.json()).toMatchObject({
        result: { structuredContent: { shared: expect.any(Array) } },
      });
    };
    await share(['report.md', 'archive.bin', 'page.html', '.env.test']);
    await writeFile(join(first.project, 'report.md'), 'Synthetic version two');
    let remoteId: SessionId | undefined;
    await expect
      .poll(
        async () => {
          remoteId = (await second.rpc.request('session.list', { workspaceId: second.workspaceId }))
            .sessions[0]?.id;
          return remoteId;
        },
        { timeout: 8000 },
      )
      .toBeDefined();
    const scope = { workspaceId: second.workspaceId, sessionId: remoteId };
    await expect
      .poll(
        async () =>
          (await second.rpc.request('workspace.readFile', { ...scope, path: 'report.md' })).text,
        { timeout: 8000 },
      )
      .toBe('Synthetic version one');
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: remoteId,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () => second.rpc.events(subscriptionId).some((event) => event.type === 'file.shared'),
      'source file event',
    );
    const firstShare = second.rpc
      .events(subscriptionId)
      .find((event) => event.type === 'file.shared');
    if (!firstShare) throw new Error('missing synthetic file event');
    const raw = await second.rpc.request('files.read', {
      ...scope,
      path: 'archive.bin',
      artifactSeq: firstShare.seq,
    });
    expect(Buffer.from(raw.data, 'base64')).toEqual(binary);
    const preview = await second.rpc.request('workspace.fileUrl', {
      ...scope,
      path: 'page.html',
      artifactSeq: firstShare.seq,
    });
    expect(preview.url).toBeDefined();
    expect(await readFile(preview.localPath, 'utf8')).toBe('<h1>Synthetic artifact</h1>');
    const download = await second.rpc.request('workspace.fileUrl', {
      ...scope,
      path: 'archive.bin',
      artifactSeq: firstShare.seq,
    });
    expect(download).toMatchObject({ unavailable: 'unsupported', localPath: expect.any(String) });
    expect(await readFile(download.localPath)).toEqual(binary);
    expect(await (await fetch(preview.url)).text()).toContain('<h1>Synthetic artifact</h1>');
    for (const path of ['.env.test', 'not-shared.txt'])
      expect(await second.rpc.request('workspace.readFile', { ...scope, path })).toMatchObject({
        unavailable: 'not_found',
      });
    expect(
      (
        await second.rpc.call('workspace.writeFile', {
          ...scope,
          path: 'report.md',
          text: 'Overwrite',
        })
      ).error,
    ).toBeDefined();
    expect(
      (
        await second.rpc.call('workspace.readFile', {
          ...scope,
          path: 'report.md',
          folder: second.project,
        })
      ).error,
    ).toBeDefined();
    expect(
      (
        await second.rpc.request('workspace.readFile', {
          workspaceId: second.workspaceId,
          path: 'report.md',
        })
      ).text,
    ).toBe('Synthetic unrelated local file');
    await share(['report.md']);
    await expect
      .poll(
        async () =>
          (await second.rpc.request('workspace.readFile', { ...scope, path: 'report.md' })).text,
        { timeout: 8000 },
      )
      .toBe('Synthetic version two');
    expect(
      (
        await second.rpc.request('workspace.readFile', {
          ...scope,
          path: 'report.md',
          artifactSeq: firstShare.seq,
        })
      ).text,
    ).toBe('Synthetic version one');
    expect(await readFile(join(second.project, 'report.md'), 'utf8')).toBe(
      'Synthetic unrelated local file',
    );
    expect(second.adapter.endpoints.size).toBe(0);
  }, 20000);

  it('discovers encrypted project names explicitly before binding a different local directory', async () => {
    const { mock, first, second } = await fixture();
    await first.rpc.request('workspace.update', {
      workspaceId: first.workspaceId,
      displayName: 'Synthetic cloud project',
    });
    const initial = await first.rpc.request('sync.configure', {
      enabled: true,
      categories: ['project'],
      projects: [{ workspaceId: first.workspaceId }],
      includeHistory: false,
    });
    await first.rpc.request('sync.retry');
    await expect.poll(async () => (await first.rpc.request('sync.status')).pending).toBe(0);
    expect((await second.rpc.call('sync.projectCatalog')).error).toMatchObject({
      data: { code: 'SCOPE_DISABLED' },
    });
    expect(mock.sync.exports).toBe(0);
    expect((await second.rpc.call('sync.projectCatalog', { enable: true })).error).toMatchObject({
      data: { code: 'RECOVERY_REQUIRED' },
    });
    const binding = (await second.rpc.request('sync.status')).binding;
    await first.rpc.request('sync.approveDevice', { deviceId: binding.deviceId });
    const nativeCreate = vi.spyOn(second.adapter, 'createSession');
    const catalog = await second.rpc.request('sync.projectCatalog', { enable: true });
    expect(catalog.projects).toMatchObject([
      {
        projectId: initial.binding.projectIds[0],
        versions: [{ displayName: 'Synthetic cloud project', deleted: false }],
      },
    ]);
    expect(catalog.projects[0].versions).toHaveLength(1);
    expect((await second.rpc.request('sync.status')).binding.projectIds).toEqual([]);
    expect(nativeCreate).not.toHaveBeenCalled();
    await second.rpc.request('workspace.update', {
      workspaceId: second.workspaceId,
      displayName: 'Synthetic local label',
    });
    const state = await second.rpc.request('sync.status');
    await second.rpc.request('sync.configure', {
      enabled: true,
      categories: ['project'],
      projects: [{ workspaceId: second.workspaceId, projectId: catalog.projects[0].projectId }],
      expectedRevision: state.binding.revision,
      includeHistory: false,
    });
    await second.rpc.request('sync.retry');
    await first.rpc.request('sync.retry');
    const after = await first.rpc.request('sync.projectCatalog');
    expect(after.projects[0].versions).toHaveLength(1);
    expect(after.projects[0].versions[0].displayName).toBe('Synthetic cloud project');
    expect(mock.errors).toEqual([]);
  }, 20000);

  it('keeps concurrent project names and resolves them through a new operation referencing every head', async () => {
    const { mock, first, second } = await fixture();
    await linkSessions(first, second);
    await first.rpc.request('sync.retry');
    await second.rpc.request('sync.retry');
    const commits = mock.sync.attempts.commits;
    mock.sync.pendingCommits = true;
    await first.rpc.request('workspace.update', {
      workspaceId: first.workspaceId,
      displayName: 'Synthetic branch A',
    });
    await second.rpc.request('workspace.update', {
      workspaceId: second.workspaceId,
      displayName: 'Synthetic branch B',
    });
    await expect
      .poll(() => mock.sync.attempts.commits, { timeout: 8000 })
      .toBeGreaterThanOrEqual(commits + 2);
    mock.sync.pendingCommits = false;
    mock.sync.finalize();
    const catalog = await first.rpc.request('sync.projectCatalog');
    expect(catalog.projects[0].versions).toHaveLength(2);
    expect(
      new Set(
        catalog.projects[0].versions.map((value: { displayName: string }) => value.displayName),
      ),
    ).toEqual(new Set(['Synthetic branch A', 'Synthetic branch B']));
    await first.rpc.request('sync.retry');
    await second.rpc.request('sync.retry');
    expect((await first.rpc.request('sync.status')).projects[0].displayName).toBe(
      'Synthetic branch A',
    );
    expect((await second.rpc.request('sync.status')).projects[0].displayName).toBe(
      'Synthetic branch B',
    );
    const project = catalog.projects[0];
    const expectedHeads = project.versions.map((value: { opId: string }) => value.opId);
    const selectedOpId = project.versions.find(
      (value: { displayName: string }) => value.displayName === 'Synthetic branch B',
    ).opId;
    const selection = { projectId: project.projectId, expectedHeads, selectedOpId };
    expect(
      (
        await first.rpc.call('sync.resolveProject', {
          ...selection,
          expectedHeads: [selectedOpId, 'operation_stale'],
        })
      ).error,
    ).toMatchObject({ data: { code: 'REVISION_CONFLICT' } });
    expect(
      (
        await first.rpc.call('sync.resolveProject', {
          ...selection,
          selectedOpId: 'operation_other_project',
        })
      ).error,
    ).toMatchObject({ data: { code: 'INVALID_REQUEST' } });
    const resolved = await second.rpc.request('sync.resolveProject', selection);
    expect((await second.rpc.call('sync.resolveProject', selection)).error).toMatchObject({
      data: { code: 'REVISION_CONFLICT' },
    });
    await first.rpc.request('sync.retry');
    await second.rpc.request('sync.retry');
    await expect
      .poll(async () => (await first.rpc.request('sync.status')).conflicts, { timeout: 8000 })
      .toBe(0);
    const after = await second.rpc.request('sync.projectCatalog');
    expect(after.projects[0].versions).toEqual([
      { opId: resolved.opId, displayName: 'Synthetic branch B', deleted: false },
    ]);
    const status = await first.rpc.request('sync.status');
    const received = schemas.changes.parse(
      mock.sync.handle(
        'user_synthetic',
        status.binding.deviceId,
        new URL('/api/wevir/sync/v1/changes', mock.origin),
        'GET',
        undefined,
        Buffer.alloc(0),
      ).value,
    );
    const operation = received.operations.find((value) => value.opId === resolved.opId);
    expect(operation?.kind).toBe('resolve');
    expect(new Set(operation?.parents)).toEqual(new Set(expectedHeads));
    expect(
      (await first.rpc.request('workspace.list')).workspaces.find(
        (value: { id: WorkspaceId }) => value.id === first.workspaceId,
      )?.displayName,
    ).toBe('Synthetic branch A');
    expect((await second.rpc.request('sync.status')).projects[0].displayName).toBe(
      'Synthetic branch B',
    );
    expect(mock.errors).toEqual([]);
  }, 20000);

  it('replays newly enabled project ranges that earlier filtered pages had already skipped', async () => {
    const { first, second } = await fixture();
    await linkSessions(first, second);
    const initial = await second.rpc.request('sync.status');
    await second.rpc.request('sync.configure', {
      enabled: true,
      categories: initial.binding.categories,
      projects: [],
      includeHistory: true,
      expectedRevision: initial.binding.revision,
    });
    const created = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: created.id,
      title: 'Synthetic skipped project',
    });
    await first.rpc.request('session.send', {
      sessionId: created.id,
      clientMessageId: 'synthetic-hidden-range',
      content: [{ type: 'text', text: 'Synthetic hidden history' }],
    });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: created.id })).session.state,
      )
      .toBe('idle');
    await first.rpc.request('sync.retry');
    await expect.poll(async () => (await first.rpc.request('sync.status')).pending).toBe(0);
    await second.rpc.request('sync.retry');
    expect(
      (await second.rpc.request('session.list', { workspaceId: second.workspaceId })).sessions,
    ).toEqual([]);
    const current = await second.rpc.request('sync.status');
    await second.rpc.request('sync.configure', {
      enabled: true,
      categories: current.binding.categories,
      projects: [{ workspaceId: second.workspaceId, projectId: initial.binding.projectIds[0] }],
      includeHistory: true,
      expectedRevision: current.binding.revision,
    });
    await expect
      .poll(
        async () =>
          (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions.map((row: { title: string }) => row.title),
        { timeout: 8000 },
      )
      .toContain('Synthetic skipped project');
    const remote = (await second.rpc.request('session.list', { workspaceId: second.workspaceId }))
      .sessions[0];
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: remote.id,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () =>
        second.rpc
          .events(subscriptionId)
          .some(
            (event) =>
              event.type === 'user.message' &&
              event.payload.content.some(
                (value) => value.type === 'text' && value.text === 'Synthetic hidden history',
              ),
          ),
      'replayed selected history',
    );
  }, 20000);

  it('keeps synchronized side sessions out of the top-level session list', async () => {
    const { first, second } = await fixture();
    await linkSessions(first, second);
    const root = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.send', {
      sessionId: root.id,
      clientMessageId: 'synthetic-side-source',
      content: [{ type: 'text', text: 'Synthetic side setup' }],
    });
    await expect
      .poll(
        async () => (await first.rpc.request('session.get', { sessionId: root.id })).session.state,
        { timeout: 8000 },
      )
      .toBe('idle');
    const side = (await first.rpc.request('session.fork', { sessionId: root.id, side: true }))
      .session;
    await first.rpc.request('session.rename', {
      sessionId: side.id,
      title: 'Synthetic side session',
    });
    await expect
      .poll(async () => (await first.rpc.request('sync.status', {})).pending, { timeout: 8000 })
      .toBe(0);
    await second.rpc.request('sync.retry', {});
    expect(
      (await second.rpc.request('session.list', { workspaceId: second.workspaceId })).sessions.some(
        (row: { title: string }) => row.title === 'Synthetic side session',
      ),
    ).toBe(false);
  }, 30000);
  it('synchronizes replica names and archive changes without injecting received state into the native source stream', async () => {
    const { first, second } = await fixture();
    await linkSessions(first, second);
    const created = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: created.id,
      title: 'Original native title',
    });
    let id: SessionId | undefined;
    await expect
      .poll(
        async () => {
          const list = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions as Array<{ id: SessionId; title: string }>;
          id = list[0]?.id;
          return list[0]?.title;
        },
        { timeout: 8000 },
      )
      .toBe('Original native title');
    // The title event can arrive before its resource revision; this case edits after both peers catch up.
    await first.rpc.request('sync.retry', {});
    await second.rpc.request('sync.retry', {});
    const before = (await first.rpc.request('session.get', { sessionId: created.id })).session
      .lastSeq;
    await second.rpc.request('session.rename', { sessionId: id, title: 'Renamed on second Host' });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: created.id })).session.title,
        { timeout: 8000 },
      )
      .toBe('Renamed on second Host');
    expect(
      (await first.rpc.request('session.get', { sessionId: created.id })).session.lastSeq,
    ).toBe(before);
    await first.rpc.request('session.send', {
      sessionId: created.id,
      clientMessageId: 'synthetic-after-rename',
      content: [{ type: 'text', text: 'Synthetic further work' }],
    });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: created.id })).session.state,
        { timeout: 8000 },
      )
      .toBe('idle');
    expect((await first.rpc.request('session.get', { sessionId: created.id })).session.title).toBe(
      'Renamed on second Host',
    );
    await first.rpc.request('session.archive', { sessionId: created.id, archived: true });
    await expect
      .poll(
        async () =>
          (
            await second.rpc.request('session.list', {
              workspaceId: second.workspaceId,
              archived: true,
            })
          ).sessions.map((value: { id: string }) => value.id),
        { timeout: 8000 },
      )
      .toContain(id);
    await expect
      .poll(async () => (await first.rpc.request('sync.status', {})).pending, { timeout: 8000 })
      .toBe(0);
    await second.rpc.request('sync.retry', {});
    await second.rpc.request('session.archive', { sessionId: id, archived: false });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: created.id })).session.archivedAt,
        { timeout: 8000 },
      )
      .toBeUndefined();
    expect((await first.rpc.request('session.get', { sessionId: created.id })).session.state).toBe(
      'closed',
    );
  }, 30000);
  it('starts without existing history, backfills it only on explicit consent and gates source streams from older clients', async () => {
    const { first, second } = await fixture();
    await first.rpc.request('provider.upsert', {
      id: 'synthetic-api',
      kind: 'openai-compatible',
      displayName: 'Synthetic API',
      api: 'openai-responses',
      baseURL: 'https://synthetic.invalid/v1',
      models: [{ id: 'synthetic-model' }],
      defaultModelId: 'synthetic-model',
    });
    const native = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: native.id,
      title: 'Before sync consent',
    });
    await first.rpc.request('session.send', {
      sessionId: native.id,
      clientMessageId: 'synthetic-before-consent',
      content: [{ type: 'text', text: 'Synthetic earlier message' }],
    });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: native.id })).session.state,
        { timeout: 8000 },
      )
      .toBe('idle');
    await linkSessions(first, second, false);
    await first.rpc.request('sync.retry', {});
    await second.rpc.request('sync.retry', {});
    expect(
      (
        await second.rpc.request('session.list', {
          workspaceId: second.workspaceId,
          archived: false,
        })
      ).sessions,
    ).toEqual([]);
    const status = await first.rpc.request('sync.status', {});
    await first.rpc.request('sync.configure', {
      enabled: true,
      categories: status.binding.categories,
      projects: [{ workspaceId: first.workspaceId, projectId: status.binding.projectIds[0] }],
      includeHistory: true,
      expectedRevision: status.binding.revision,
    });
    let remoteId: SessionId | undefined;
    await expect
      .poll(
        async () => {
          const list = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions as Array<{ id: SessionId; title: string }>;
          remoteId = list[0]?.id;
          return list[0]?.title;
        },
        { timeout: 8000 },
      )
      .toBe('Before sync consent');
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: remoteId,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () =>
        second.rpc
          .events(subscriptionId)
          .some(
            (event) =>
              event.type === 'user.message' &&
              event.payload.content.some(
                (part) => part.type === 'text' && part.text === 'Synthetic earlier message',
              ),
          ),
      'consented history backfill',
    );
    const legacy = await TestRpcClient.connect(second.url);
    cleanups.push(() => legacy.ws.terminate());
    expect(
      (
        await legacy.call('host.hello', {
          token: second.token,
          protocolVersion: '0.171.0',
          deviceId: 'synthetic-legacy',
          clientId: 'synthetic-legacy',
          clientKind: 'cli',
          capabilities: {},
        })
      ).error,
    ).toBeUndefined();
    expect(
      (await legacy.request('session.list', { workspaceId: second.workspaceId })).sessions,
    ).toEqual([]);
    expect(
      (await legacy.call('events.subscribe', { sessionId: remoteId, sinceSeq: 0 })).error,
    ).toMatchObject({ code: -32020 });
  }, 30000);
  it('propagates a session tombstone while preserving pinned task history and avoiding native deletion on the receiving Host', async () => {
    const { mock, first, second } = await fixture();
    await linkSessions(first, second);
    const source = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: source.id,
      title: 'Synthetic retained task',
    });
    await first.rpc.request('session.send', {
      sessionId: source.id,
      clientMessageId: 'synthetic-deleted-source',
      content: [{ type: 'text', text: 'Synthetic retained history' }],
    });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: source.id })).session.state,
        { timeout: 8000 },
      )
      .toBe('idle');
    const task = (await first.rpc.request('episode.refresh', { sessionId: source.id })).episode;
    await first.rpc.request('episode.update', {
      id: task.id,
      revision: task.revision,
      patch: {},
      pinned: true,
    });
    let remoteId: string | undefined;
    await expect
      .poll(
        async () => {
          const rows = (
            await second.rpc.request('episode.list', { workspaceId: second.workspaceId })
          ).episodes as Array<{ id: string; pinned: boolean }>;
          remoteId = rows[0]?.id;
          return rows[0]?.pinned;
        },
        { timeout: 8000 },
      )
      .toBe(true);
    const remote = (await second.rpc.request('episode.get', { id: remoteId })).episode;
    await first.rpc.request('session.archive', { sessionId: source.id, archived: true });
    await first.rpc.request('session.delete', { sessionId: source.id });
    await expect
      .poll(
        async () =>
          (await second.rpc.request('session.list', { workspaceId: second.workspaceId })).sessions,
        { timeout: 8000 },
      )
      .toEqual([]);
    await expect
      .poll(async () => (await second.rpc.request('episode.get', { id: remote.id })).episode, {
        timeout: 8000,
      })
      .toMatchObject({
        pinned: true,
        source: 'deleted',
      });
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: remote.sessionId,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () => second.rpc.events(subscriptionId).some((event) => event.type === 'user.message'),
      'retained source history',
    );
    await second.rpc.request('session.delete', { sessionId: remote.sessionId });
    expect(second.adapter.deleted).toEqual([]);
    expect(first.adapter.deleted).toHaveLength(1);
    expect(mock.errors).toEqual([]);
  }, 30000);
  it('synchronizes task records and summaries with usable source references, then preserves edits and deletion', async () => {
    const { mock, first, second } = await fixture();
    await linkSessions(first, second);
    const generate = vi.spyOn(second.adapter, 'generateTitle');
    const created = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: created.id,
      title: 'Synthetic task record',
    });
    await first.rpc.request('session.send', {
      sessionId: created.id,
      clientMessageId: 'synthetic-record-message',
      content: [{ type: 'text', text: 'Synthetic recorded work' }],
    });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: created.id })).session.state,
        { timeout: 8000 },
      )
      .toBe('idle');
    const native = (await first.rpc.request('episode.refresh', { sessionId: created.id })).episode;
    let remoteId: string | undefined;
    await expect
      .poll(
        async () => {
          const rows = (
            await second.rpc.request('episode.list', { workspaceId: second.workspaceId })
          ).episodes as Array<{ id: string; title: string }>;
          remoteId = rows[0]?.id;
          return rows[0]?.title;
        },
        { timeout: 8000 },
      )
      .toBe('Synthetic task record');
    const remote = (await second.rpc.request('episode.get', { id: remoteId })).episode;
    expect(remote.id).not.toBe(native.id);
    expect(remote).toMatchObject({
      source: 'available',
      syncOrigin: { sessionId: created.id },
      workspaceId: second.workspaceId,
    });
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: remote.sessionId,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () =>
        second.rpc
          .events(subscriptionId)
          .some((event) => event.syncOrigin?.seq === String(native.goal.ref.seq)),
      'task source event',
    );
    const linked = second.rpc
      .events(subscriptionId)
      .find((event) => event.syncOrigin?.seq === String(native.goal.ref.seq));
    expect(remote.goal.ref.seq).toBe(linked?.seq);
    expect(linked?.type).toBe('user.message');
    const retro = await first.rpc.request('retro.get', { sessionId: created.id });
    const requestId = retro.retro.goal.request.id;
    first.adapter.summary = JSON.stringify({
      points: [{ text: 'Synthetic summary', refs: [requestId] }],
    });
    expect(
      (await first.rpc.request('retro.summarize', { sessionId: created.id })).summary,
    ).toBeDefined();
    await expect
      .poll(
        async () =>
          (await second.rpc.request('retro.get', { sessionId: remote.sessionId })).retro.summary
            ?.points[0],
        { timeout: 8000 },
      )
      .toMatchObject({ text: 'Synthetic summary', refs: [remote.goal.id] });
    expect(generate).not.toHaveBeenCalled();
    await second.rpc.request('episode.update', {
      id: remote.id,
      revision: remote.revision,
      patch: {
        title: 'Edited on second Host',
        goal: { ...remote.goal, text: 'Updated synthetic goal' },
        open: [
          {
            id: 'user:follow-up',
            text: 'Synthetic follow-up',
            origin: 'todo',
            status: 'pending',
            ref: remote.goal.ref,
          },
        ],
      },
      pinned: true,
    });
    await expect
      .poll(async () => (await first.rpc.request('episode.get', { id: native.id })).episode, {
        timeout: 8000,
      })
      .toMatchObject({ title: 'Edited on second Host', pinned: true });
    const current = (await first.rpc.request('episode.get', { id: native.id })).episode;
    expect(current.goal.ref.seq).toBe(native.goal.ref.seq);
    expect(current.open[0].ref.seq).toBe(native.goal.ref.seq);
    await first.rpc.request('episode.delete', { id: native.id, revision: current.revision });
    await expect
      .poll(
        async () =>
          (await second.rpc.request('episode.list', { workspaceId: second.workspaceId })).episodes,
        { timeout: 8000 },
      )
      .toEqual([]);
    expect(mock.errors).toEqual([]);
  }, 30000);
  it('keeps the prior account material local when a new identity opens another vault', async () => {
    const { mock, first } = await fixture();
    await first.memory.save('global', undefined, {
      name: 'account-owned-note',
      type: 'project',
      description: 'Synthetic',
      content: 'Prior account material',
    });
    const scope = { enabled: true, categories: ['memory'], projects: [], includeHistory: true };
    const previous = await first.rpc.request('sync.configure', scope);
    await expect
      .poll(async () => (await first.rpc.request('sync.status', {})).state, { timeout: 8000 })
      .toBe('idle');
    await first.rpc.request('account.logout', { kind: 'zuv' });
    const login = (await first.rpc.request('account.login', { kind: 'zuv', method: 'browser' }))
      .account;
    mock.approve(login.login.authUrl, 'user_second_synthetic');
    await expect
      .poll(async () => (await first.rpc.request('account.get', { kind: 'zuv' })).account, {
        timeout: 8000,
      })
      .toMatchObject({
        status: 'signed_in',
        zuv: { connection: 'online', subscriptionState: 'active' },
      });
    expect(mock.errors).toEqual([]);
    const commits = mock.sync.attempts.commits;
    const next = await first.rpc.request('sync.configure', scope);
    expect(next.binding.vaultId).not.toBe(previous.binding.vaultId);
    await first.rpc.request('sync.retry', {});
    expect(mock.sync.attempts.commits).toBe(commits);
    expect(
      (await first.rpc.request('memory.read', { scope: 'global', name: 'account-owned-note' })).note
        .content,
    ).toBe('Prior account material');
    expect(mock.errors).toEqual([]);
  }, 20000);
  it('merges separate preference fields without transferring execution, network or paid-feature settings', async () => {
    const { mock, first, second } = await fixture();
    const scope = { enabled: true, categories: ['settings'], projects: [], includeHistory: false };
    await first.rpc.request('sync.configure', scope);
    expect((await second.rpc.call('sync.configure', scope)).error).toMatchObject({
      data: { code: 'RECOVERY_REQUIRED' },
    });
    const pending = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: pending.binding.deviceId });
    await second.rpc.request('sync.configure', scope);
    await Promise.all([
      first.rpc.request('settings.update', {
        settings: { outputStyle: 'concise', promptSuggestions: false },
      }),
      second.rpc.request('settings.update', { settings: { autoMemory: false } }),
    ]);
    for (const side of [first, second])
      await expect
        .poll(async () => (await side.rpc.request('settings.get', {})).settings, { timeout: 8000 })
        .toMatchObject({ outputStyle: 'concise', autoMemory: false });
    const remote = (await second.rpc.request('settings.get', {})).settings;
    expect(remote.promptSuggestions).toBe(true);
    expect(remote.computerUse).toBeUndefined();
    expect(remote.remote?.enabled).not.toBe(true);
    expect(mock.errors).toEqual([]);
  }, 20000);
  it('requires scope consent, captures file changes without a watcher and keeps local files after sign-out', async () => {
    const { mock, first, second } = await fixture();
    await first.memory.save('global', undefined, {
      name: 'synthetic-note',
      type: 'project',
      description: 'Synthetic note',
      content: 'Before consent',
    });
    expect(mock.requests.some((path) => path.includes('/sync/'))).toBe(false);
    const enabled = await first.rpc.request('sync.configure', {
      enabled: true,
      categories: ['memory'],
      projects: [],
      includeHistory: true,
    });
    expect(enabled.binding.enabled).toBe(true);
    const pending = await second.rpc.call('sync.configure', {
      enabled: true,
      categories: ['memory'],
      projects: [],
      includeHistory: true,
    });
    expect(pending.error).toMatchObject({ data: { code: 'RECOVERY_REQUIRED' } });
    const secondStatus = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: secondStatus.binding.deviceId });
    await second.rpc.request('sync.configure', {
      enabled: true,
      categories: ['memory'],
      projects: [],
      includeHistory: true,
    });
    await expect
      .poll(
        async () => {
          try {
            return (
              await second.rpc.request('memory.read', { scope: 'global', name: 'synthetic-note' })
            ).note.content;
          } catch {
            return undefined;
          }
        },
        { timeout: 8000 },
      )
      .toBe('Before consent');
    const path = join(first.home, 'memory/global/synthetic-note.md');
    const before = await readFile(path, 'utf8');
    await writeFile(path, before.replace('Before consent', 'After direct filesystem edit'));
    await expect
      .poll(
        async () =>
          (await second.rpc.request('memory.read', { scope: 'global', name: 'synthetic-note' }))
            .note.content,
        { timeout: 8000 },
      )
      .toBe('After direct filesystem edit');
    await first.rpc.request('account.logout', { kind: 'zuv' });
    expect(
      (await first.rpc.request('memory.read', { scope: 'global', name: 'synthetic-note' })).note
        .content,
    ).toBe('After direct filesystem edit');
    expect(mock.errors).toEqual([]);
  }, 20000);

  it('synchronizes an API-backed task into an immutable source view without native execution or pending approvals', async () => {
    const { mock, first, second } = await fixture();
    const create = vi.spyOn(second.adapter, 'createSession');
    const resume = vi.spyOn(second.adapter, 'resumeSession');
    const execute = vi.spyOn(second.adapter, 'send');
    await linkSessions(first, second);
    const created = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: created.id,
      title: 'Synthetic synchronized task',
    });
    await first.rpc.request('session.send', {
      sessionId: created.id,
      clientMessageId: 'synthetic-native-message',
      content: [{ type: 'text', text: 'approve' }],
    });
    let remoteId: SessionId | undefined;
    await expect
      .poll(
        async () => {
          const sessions = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions as Array<{ id: SessionId; origin?: { kind: string }; title: string }>;
          const found = sessions.find((value) => value.origin?.kind === 'synced');
          remoteId = found?.id;
          return found?.title;
        },
        { timeout: 10000 },
      )
      .toBe('Synthetic synchronized task');
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: remoteId,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () => second.rpc.events(subscriptionId).some((event) => event.type === 'approval.requested'),
      'synced approval history',
    );
    const remote = await second.rpc.request('session.get', { sessionId: remoteId });
    expect(remote.session).toMatchObject({
      state: 'closed',
      readOnly: { reason: 'synchronized' },
      engine: { kind: 'sync' },
    });
    expect(remote.pendingApprovals).toEqual([]);
    const resumed = await second.rpc.call('session.resume', { sessionId: remoteId });
    expect(resumed.error).toMatchObject({ code: -32020 });
    const send = await second.rpc.call('session.send', {
      sessionId: remoteId,
      clientMessageId: 'synthetic-message',
      content: [{ type: 'text', text: 'Must remain a source view' }],
    });
    expect(send.error).toBeDefined();
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await first.rpc.request('session.get', { sessionId: created.id })).pendingApprovals,
    ).toHaveLength(1);
    expect(mock.errors).toEqual([]);
  }, 25000);
});
