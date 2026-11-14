import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, SessionId, WorkspaceId } from '@wevir/protocol';
import type { AgentInput } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';

class HeldEcho extends EchoAdapter {
  readonly inputs = new Map<string, AgentInput>();
  override async send(id: string, input: AgentInput) {
    this.inputs.set(id, input);
  }
  async complete(id: string) {
    await super.send(id, this.inputs.get(id) as AgentInput);
  }
}
const tempDir = useTempDir();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const mock = await startMockZuv();
  cleanup.push(() => mock.close());
  async function boot(name: string) {
    const root = join(tempDir(), name);
    const home = join(root, 'home');
    const userHome = join(root, 'synthetic-user');
    const project = join(root, 'project');
    await mkdir(userHome, { recursive: true });
    await mkdir(project, { recursive: true });
    const adapter = new HeldEcho();
    const host = await startHost({
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      adapter,
      engine: 'echo',
      logger: createLogger({ mirror: () => {} }),
      zuv: { origin: mock.origin, allowLoopback: true, syncIntervalMs: 20 },
    });
    cleanup.push(() => host.shutdown());
    const token = JSON.parse(await readFile(join(home, 'run/host.json'), 'utf8')).token as string;
    const rpc = await TestRpcClient.connect(host.url);
    cleanup.push(() => rpc.ws.terminate());
    await rpc.hello(token, undefined, { subscription_kinds: true, provider_kind_chatgpt: true });
    const workspaceId = (await rpc.request('workspace.add', { rootPath: project })).workspace
      .id as WorkspaceId;
    await rpc.request('provider.upsert', {
      id: 'synthetic-api',
      kind: 'openai-compatible',
      displayName: 'Synthetic',
      api: 'openai-responses',
      baseURL: 'https://synthetic.invalid/v1',
      models: [{ id: 'synthetic' }],
      defaultModelId: 'synthetic',
    });
    const login = (await rpc.request('account.login', { kind: 'zuv', method: 'browser' })).account;
    mock.approve(login.login.authUrl);
    await rpc.until(
      () =>
        rpc
          .notifications('account.updated')
          .find((event) => (event.account as { status: string }).status === 'signed_in'),
      'synthetic sign-in',
    );
    return { rpc, workspaceId, adapter, host };
  }
  const first = await boot('first');
  const second = await boot('second');
  const scope = {
    enabled: true,
    categories: ['project', 'session', 'event-segment'],
    includeHistory: false,
  };
  async function enable() {
    const selected = await first.rpc.request('sync.configure', {
      ...scope,
      projects: [{ workspaceId: first.workspaceId }],
    });
    const target = {
      ...scope,
      projects: [{ workspaceId: second.workspaceId, projectId: selected.binding.projectIds[0] }],
    };
    await second.rpc.call('sync.configure', target);
    const status = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: status.binding.deviceId });
    await second.rpc.request('sync.configure', target);
  }
  async function create(peer: typeof first) {
    return (
      await peer.rpc.request('session.create', {
        workspaceId: peer.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic',
      })
    ).session as Session;
  }
  async function send(peer: typeof first, sessionId: SessionId) {
    return peer.rpc.request('session.send', {
      sessionId,
      clientMessageId: `synthetic-${sessionId}`,
      content: [{ type: 'text', text: 'Synthetic offline task' }],
    });
  }
  async function current(peer: typeof first, id: SessionId): Promise<Session> {
    return (await peer.rpc.request('session.get', { sessionId: id })).session;
  }
  async function mirror(source: Session): Promise<Session> {
    let result: Session | undefined;
    await expect
      .poll(
        async () => {
          const sessions = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions as Session[];
          result = sessions.find(
            (session) =>
              session.origin?.kind === 'synced' &&
              session.origin.sessionId === source.id &&
              session.syncExecution?.epoch === '1',
          );
          return result?.id;
        },
        { timeout: 8000 },
      )
      .toBeDefined();
    return result as Session;
  }
  return { mock, first, second, enable, create, send, current, mirror };
}

describe('execution ownership in two isolated Hosts', () => {
  it('releases an active execution before shutting down its account transport', async () => {
    const f = await fixture();
    await f.enable();
    const source = await f.create(f.first);
    await f.send(f.first, source.id);
    expect((await f.current(f.first, source.id)).syncExecution?.state).toBe('claimed');
    await f.first.host.shutdown();
    expect(
      f.mock.sync.executionRequests.filter((value) => value.action === 'release'),
    ).toHaveLength(1);
  }, 20000);
  it('keeps local execution independent when sync is disabled or the gateway is unavailable', async () => {
    const f = await fixture();
    const local = await f.create(f.first);
    await f.send(f.first, local.id);
    expect(f.mock.sync.executionRequests).toEqual([]);
    expect((await f.current(f.first, local.id)).state).toBe('running');
    await f.first.adapter.complete(local.engine.sessionId);
    await f.enable();
    f.mock.sync.failExecutions = true;
    const offline = await f.create(f.first);
    await f.send(f.first, offline.id);
    expect(await f.current(f.first, offline.id)).toMatchObject({
      state: 'running',
      syncExecution: {
        state: 'offline',
        branchRequired: true,
        runId: offline.id,
      },
    });
    expect(f.first.adapter.inputs.size).toBe(2);
    expect(f.second.adapter.inputs.size).toBe(0);
    await f.first.adapter.complete(offline.engine.sessionId);
    const requests = f.mock.sync.executionRequests.length;
    await f.first.rpc.request('account.logout', { kind: 'zuv' });
    const signedOut = await f.create(f.first);
    await f.send(f.first, signedOut.id);
    expect((await f.current(f.first, signedOut.id)).state).toBe('running');
    expect(f.mock.sync.executionRequests).toHaveLength(requests);
    await f.first.adapter.complete(signedOut.engine.sessionId);
  }, 20000);

  it('renews and fences a takeover without cancelling the old command or replaying either history', async () => {
    const f = await fixture();
    await f.enable();
    f.mock.sync.executionLeaseMs = 1800;
    const source = await f.create(f.first);
    const cancel = vi.spyOn(f.first.adapter, 'cancel');
    await f.send(f.first, source.id);
    expect((await f.current(f.first, source.id)).lastError).toBeUndefined();
    expect(await f.current(f.first, source.id)).toMatchObject({
      state: 'running',
      syncExecution: {
        state: 'claimed',
        epoch: '1',
      },
    });
    await expect
      .poll(
        () => f.mock.sync.executionRequests.filter((value) => value.action === 'renew').length,
        { timeout: 4000 },
      )
      .toBeGreaterThan(0);
    const mirrored = await f.mirror(source);
    expect(f.second.adapter.inputs.size).toBe(0);
    const continuation = (
      await f.second.rpc.request('session.createFromHistory', {
        sessionId: mirrored.id,
        providerId: 'synthetic-api',
        modelId: 'synthetic',
      })
    ).session as Session;
    expect(continuation.origin).toMatchObject({
      kind: 'history',
      syncContinuation: {
        runId: source.id,
        epoch: '1',
        source: { sessionId: source.id },
      },
    });
    f.mock.sync.expireExecution(source.id);
    await f.send(f.second, continuation.id);
    expect((await f.current(f.second, continuation.id)).syncExecution).toMatchObject({
      state: 'claimed',
      epoch: '2',
      branchRequired: true,
    });
    await expect
      .poll(async () => (await f.current(f.first, source.id)).syncExecution?.state, {
        timeout: 4000,
      })
      .toBe('lost');
    expect((await f.current(f.first, source.id)).state).toBe('running');
    expect(cancel).not.toHaveBeenCalled();
    expect(f.first.adapter.inputs.size).toBe(1);
    expect(f.second.adapter.inputs.size).toBe(1);
    const execution = (await f.current(f.second, continuation.id)).syncExecution as NonNullable<
      Session['syncExecution']
    >;
    const old = (await f.current(f.first, source.id)).syncExecution as NonNullable<
      Session['syncExecution']
    >;
    expect(execution.streamId).not.toBe(old.streamId);
    await f.second.adapter.complete(continuation.engine.sessionId);
    await expect
      .poll(
        () =>
          f.mock.sync.executionRequests.filter(
            (value) =>
              value.action === 'release' &&
              (value.input as { expectedEpoch: string }).expectedEpoch === '2',
          ).length,
        { timeout: 4000 },
      )
      .toBe(1);
    const before = f.first.adapter.inputs.size + f.second.adapter.inputs.size;
    await f.first.rpc.request('sync.retry');
    await f.second.rpc.request('sync.retry');
    expect(f.first.adapter.inputs.size + f.second.adapter.inputs.size).toBe(before);
    expect((await f.current(f.first, source.id)).state).toBe('running');
    await f.first.adapter.complete(source.engine.sessionId);
  }, 25000);

  it('keeps an active holder and a concurrent continuation as separate linked source streams', async () => {
    const f = await fixture();
    await f.enable();
    const source = await f.create(f.first);
    await f.send(f.first, source.id);
    const mirrored = await f.mirror(source);
    const continuation = (
      await f.second.rpc.request('session.createFromHistory', {
        sessionId: mirrored.id,
        providerId: 'synthetic-api',
        modelId: 'synthetic',
      })
    ).session as Session;
    await f.send(f.second, continuation.id);
    expect((await f.current(f.second, continuation.id)).syncExecution).toMatchObject({
      state: 'conflict',
      runId: source.id,
      epoch: '1',
      branchRequired: true,
    });
    expect((await f.current(f.first, source.id)).syncExecution?.state).toBe('claimed');
    await f.first.adapter.complete(source.engine.sessionId);
    await f.second.adapter.complete(continuation.engine.sessionId);
    await expect
      .poll(
        async () => {
          const sessions = (
            await f.first.rpc.request('session.list', { workspaceId: f.first.workspaceId })
          ).sessions as Session[];
          return {
            status: await f.second.rpc.request('sync.status'),
            mirrors: sessions.filter(
              (session) =>
                session.origin?.kind === 'synced' && session.origin.sessionId === continuation.id,
            ),
          };
        },
        { timeout: 8000 },
      )
      .toMatchObject({
        status: { pending: 0 },
        mirrors: expect.arrayContaining([
          expect.objectContaining({
            origin: expect.objectContaining({
              syncContinuation: expect.objectContaining({ runId: source.id }),
            }),
          }),
        ]),
      });
    expect(f.first.adapter.inputs.size).toBe(1);
    expect(f.second.adapter.inputs.size).toBe(1);
  }, 20000);
});
