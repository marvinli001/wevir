import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { MemoryStore } from '../memory.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const mock = await startMockZuv();
  cleanups.push(() => mock.close());
  const boot = async (name: string) => {
    const base = join(tempDir(), name);
    const home = join(base, 'home');
    const userHome = join(base, 'user');
    const project = join(base, 'project');
    await mkdir(userHome, { recursive: true });
    await mkdir(project, { recursive: true });
    const adapter = new EchoAdapter();
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
    return { home, userHome, project, workspaceId, rpc, memory, adapter };
  };
  return { mock, first: await boot('first'), second: await boot('second') };
}

describe('full Host material synchronization with synthetic identities', () => {
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
    await first.rpc.request('provider.upsert', {
      id: 'synthetic-api',
      kind: 'openai-compatible',
      displayName: 'Synthetic API',
      api: 'openai-responses',
      baseURL: 'https://synthetic.invalid/v1',
      models: [{ id: 'synthetic-model' }],
      defaultModelId: 'synthetic-model',
    });
    const firstStatus = await first.rpc.request('sync.configure', {
      enabled: true,
      categories: ['project', 'session', 'event-segment'],
      projects: [{ workspaceId: first.workspaceId }],
      includeHistory: true,
    });
    const attempt = await second.rpc.call('sync.configure', {
      enabled: true,
      categories: ['project', 'session', 'event-segment'],
      projects: [{ workspaceId: second.workspaceId, projectId: firstStatus.binding.projectIds[0] }],
      includeHistory: true,
    });
    expect(attempt.error).toMatchObject({ data: { code: 'RECOVERY_REQUIRED' } });
    const secondStatus = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: secondStatus.binding.deviceId });
    await second.rpc.request('sync.configure', {
      enabled: true,
      categories: ['project', 'session', 'event-segment'],
      projects: [{ workspaceId: second.workspaceId, projectId: firstStatus.binding.projectIds[0] }],
      includeHistory: true,
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
    await second.rpc.until(
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
