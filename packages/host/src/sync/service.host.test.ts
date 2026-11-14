import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { schemas } from '@wevir/protocol/sync';
import type { AppToolsEndpoint, SessionConfig, TitleRequest } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { MemoryStore } from '../memory.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';
import { SyncPortable } from './portable.js';

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
    execFileSync('git', ['init', '--quiet', '--template=', project], {
      env: {
        PATH: process.env.PATH,
        HOME: userHome,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(userHome, 'gitconfig'),
      },
    });
    const adapter = new SummaryEcho(withTools);
    const host = await startHost({
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      adapter,
      engine: 'echo',
      testConnectionGrant: (client) =>
        client.clientId === 'remote_preview'
          ? {
              principal: { kind: 'device', deviceId: 'device_preview' },
              permissions: ['workspace.read'],
            }
          : undefined,
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
async function confirmNative(peer: Peer, vaultId: string, entityId: string, name: string) {
  const preview = await peer.rpc.request('sync.bundlePreview', { vaultId, entityId });
  const target = (await peer.rpc.request('sync.bundleTargets', { vaultId, entityId })).targets.find(
    (item: { managed: boolean; name: string }) => !item.managed && item.name === name,
  );
  if (!target) throw new Error('missing native target');
  await peer.rpc.request('sync.applyBundle', {
    vaultId,
    entityId,
    expectedHeads: preview.heads,
    selectedOpId: preview.heads[0],
    targetId: target.targetId,
    fingerprint: target.fingerprint,
    localRevision: preview.binding?.revision,
  });
}

async function waitForBundleText(
  peer: Peer,
  vaultId: string,
  entityId: string,
  path: string,
  text: string,
) {
  await expect
    .poll(
      async () => {
        const preview = await peer.rpc.request('sync.bundlePreview', { vaultId, entityId });
        return (
          await peer.rpc.request('sync.bundleFile', {
            vaultId,
            entityId,
            path,
            opId: preview.heads[0],
          })
        ).text;
      },
      { timeout: 10000 },
    )
    .toBe(text);
}
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
  it('restores an imported rule through its explicit native target with new chunks and retained newer files', async () => {
    const { mock, first, second } = await fixture();
    await writeFile(join(first.project, 'AGENTS.md'), 'Archived rule body');
    const scope = {
      enabled: true,
      categories: ['project', 'artifact', 'rule'],
      includeHistory: true,
    };
    const opened = await first.rpc.request('sync.configure', {
      ...scope,
      projects: [{ workspaceId: first.workspaceId }],
    });
    const target = {
      ...scope,
      projects: [{ workspaceId: second.workspaceId, projectId: opened.binding.projectIds[0] }],
    };
    await second.rpc.call('sync.configure', target);
    await first.rpc.request('sync.approveDevice', {
      deviceId: (await second.rpc.request('sync.status')).binding.deviceId,
    });
    await second.rpc.request('sync.configure', target);
    await first.rpc.request('sync.retry');
    await expect
      .poll(async () => (await first.rpc.request('sync.status')).pending, { timeout: 8000 })
      .toBe(0);
    const exported = await first.rpc.request('sync.exportLocal', {
      directory: join(first.home, 'rule-history'),
    });
    const prepared = await first.rpc.request('sync.importPrepare', { path: exported.path });
    const imported = await first.rpc.request('sync.importApply', { importId: prepared.importId });
    const entries = (await first.rpc.request('sync.importRead', { importId: imported.importId }))
      .entries;
    let selected: { id: string; opId: string; entityId: string } | undefined;
    let oldParts: string[] = [];
    for (const entry of entries.filter((entry: { kind: string }) => entry.kind === 'version')) {
      const data = await first.rpc.request('sync.importEntry', {
        importId: imported.importId,
        entryId: entry.id,
      });
      const version = JSON.parse(Buffer.from(data.base64, 'base64').toString());
      if (version.entityType === 'rule') {
        selected = entry;
        oldParts = version.record.content.files.flatMap(
          (file: { parts: Array<{ opId: string }> }) => file.parts.map((part) => part.opId),
        );
      }
    }
    if (!selected) throw new Error('missing archived rule');
    await writeFile(join(first.project, 'AGENTS.md'), 'Newer native rule');
    await first.rpc.request('sync.retry');
    const initial = await first.rpc.request('sync.importRestorePreview', {
      importId: imported.importId,
      entryId: selected.id,
    });
    const native = initial.targets.find(
      (value: { managed: boolean; name: string }) => !value.managed && value.name === 'AGENTS.md',
    );
    const preview = await first.rpc.request('sync.importRestorePreview', {
      importId: imported.importId,
      entryId: selected.id,
      targetId: native.targetId,
    });
    expect(preview.currentText).toContain('Newer native rule');
    expect(preview.selectedText).toContain('Archived rule body');
    const newer = preview.expectedHeads[0];
    const restored = await first.rpc.request('sync.importRestore', preview);
    expect(restored.opId).not.toBe(selected.opId);
    expect(await readFile(join(first.project, 'AGENTS.md'), 'utf8')).toBe('Archived rule body');
    const local = openStorage({ dataDir: first.home });
    try {
      const draft = local.sync.draft(preview.vaultId, restored.opId);
      const value = (draft?.content ??
        local.sync.getOperation(preview.vaultId, restored.opId)?.record) as
        | { body?: unknown; content?: unknown }
        | undefined;
      if (!value) throw new Error('missing restored version');
      const body = (value.body ?? value.content) as {
        files: Array<{ parts: Array<{ opId: string }> }>;
      };
      expect(
        body.files
          .flatMap((file) => file.parts.map((part) => part.opId))
          .every((op) => !oldParts.includes(op)),
      ).toBe(true);
    } finally {
      local.close();
    }
    await first.rpc.request('sync.retry');
    await second.rpc.request('sync.retry');
    await expect
      .poll(
        async () => {
          const result = await second.rpc.call('sync.bundleFile', {
            vaultId: preview.vaultId,
            entityId: selected?.entityId,
            opId: restored.opId,
            path: 'AGENTS.md',
          });
          return (result.result as { text?: string } | undefined)?.text;
        },
        { timeout: 8000 },
      )
      .toBe('Archived rule body');
    expect(
      (
        await first.rpc.request('sync.bundleFile', {
          vaultId: preview.vaultId,
          entityId: selected.entityId,
          opId: newer,
          path: 'AGENTS.md',
        })
      ).text,
    ).toBe('Newer native rule');
    expect(mock.errors).toEqual([]);
  }, 20000);
  it.each(['memory', 'settings'] as const)(
    'restores an archived non-head %s version as a fresh revision while preserving intervening work',
    async (kind) => {
      const { mock, first, second } = await fixture();
      const scope = {
        enabled: true,
        categories: ['memory', 'settings'],
        projects: [],
        includeHistory: true,
      };
      await first.rpc.request('sync.configure', scope);
      await second.rpc.call('sync.configure', scope);
      await first.rpc.request('sync.approveDevice', {
        deviceId: (await second.rpc.request('sync.status')).binding.deviceId,
      });
      await second.rpc.request('sync.configure', scope);
      await first.memory.save('global', undefined, {
        name: 'historical-note',
        type: 'project',
        description: 'Synthetic archive',
        content: 'Archived body',
      });
      await first.rpc.request('settings.update', {
        settings: { agentInstructions: 'Archived instructions' },
      });
      await first.rpc.request('sync.retry');
      await expect
        .poll(async () => (await first.rpc.request('sync.status')).pending, { timeout: 8000 })
        .toBe(0);
      const exported = await first.rpc.request('sync.exportLocal', {
        directory: join(first.home, 'history-export'),
      });
      const prepared = await first.rpc.request('sync.importPrepare', { path: exported.path });
      const imported = await first.rpc.request('sync.importApply', { importId: prepared.importId });
      const entries = (await first.rpc.request('sync.importRead', { importId: imported.importId }))
        .entries;
      let selected: { id: string; opId: string; entityId: string } | undefined;
      for (const entry of entries.filter((value: { kind: string }) => value.kind === 'version')) {
        const data = await first.rpc.request('sync.importEntry', {
          importId: imported.importId,
          entryId: entry.id,
        });
        const record = JSON.parse(Buffer.from(data.base64, 'base64').toString());
        if (
          (kind === 'memory' && record.record.content?.name === 'historical-note') ||
          (kind === 'settings' && record.entityId === 'settings_agentInstructions')
        )
          selected = entry;
      }
      if (!selected) throw new Error('missing historical entry');
      const old = await first.rpc.request('sync.importEntry', {
        importId: imported.importId,
        entryId: selected.id,
      });
      const real = mock.sync.entitlements.bind(mock.sync);
      const expired = vi
        .spyOn(mock.sync, 'entitlements')
        .mockImplementation((userId, deviceId) => ({
          ...real(userId, deviceId),
          subscriptionState: 'expired',
        }));
      await first.rpc.request('account.get', { kind: 'zuv', refresh: true });
      const edit = async (content: string) => {
        if (kind === 'memory') {
          const note = await first.memory.read('global', undefined, 'historical-note');
          await first.memory.update('global', undefined, 'historical-note', note.revision, {
            content,
          });
        } else
          await first.rpc.request('settings.update', { settings: { agentInstructions: content } });
      };
      await edit('Intervening local work');
      const preview = await first.rpc.request('sync.importRestorePreview', {
        importId: imported.importId,
        entryId: selected.id,
      });
      expect(preview).toMatchObject({ canRestore: true, kind, entityId: selected.entityId });
      expect(preview.selectedText).toContain(
        kind === 'memory' ? 'Archived body' : 'Archived instructions',
      );
      expect(preview.currentText).toContain('Intervening local work');
      expect(preview.expectedHeads).not.toContain(selected.opId);
      await edit('Newer unsubmitted work');
      expect((await first.rpc.call('sync.importRestore', preview)).error).toMatchObject({
        data: { code: 'REVISION_CONFLICT' },
      });
      const fresh = await first.rpc.request('sync.importRestorePreview', {
        importId: imported.importId,
        entryId: selected.id,
      });
      expect(fresh.currentText).toContain('Newer unsubmitted work');
      const attempts = { ...mock.sync.attempts };
      const restored = await first.rpc.request('sync.importRestore', fresh);
      expect(restored.opId).not.toBe(selected.opId);
      expect(mock.sync.attempts).toEqual(attempts);
      expect(
        (
          await first.rpc.request('sync.importEntry', {
            importId: imported.importId,
            entryId: selected.id,
          })
        ).base64,
      ).toBe(old.base64);
      const verify = openStorage({ dataDir: first.home });
      try {
        const drafts = verify.sync.drafts(fresh.vaultId);
        expect(drafts.find((value) => value.opId === restored.opId)).toMatchObject({
          kind: fresh.expectedHeads.length > 1 ? 'resolve' : 'put',
          parents: fresh.expectedHeads,
        });
        expect(JSON.stringify(drafts)).toContain('Newer unsubmitted work');
      } finally {
        verify.close();
      }
      expired.mockRestore();
      await first.rpc.request('account.get', { kind: 'zuv', refresh: true });
      await first.rpc.request('sync.retry');
      await second.rpc.request('sync.retry');
      const expected = kind === 'memory' ? 'Archived body' : 'Archived instructions';
      await expect
        .poll(
          async () =>
            kind === 'memory'
              ? (await second.memory.read('global', undefined, 'historical-note')).content
              : (await second.rpc.request('settings.get')).settings.agentInstructions,
          { timeout: 8000 },
        )
        .toBe(expected);
      expect(
        mock.sync
          .acceptedOperations(selected.entityId)
          .some((value) => value.opId === restored.opId),
      ).toBe(true);
      if (kind === 'memory') {
        await edit('Keep while the identity changes');
        const chosen = await first.rpc.request('sync.importRestorePreview', {
          importId: imported.importId,
          entryId: selected.id,
        });
        let release: () => void = () => {},
          entered = false,
          logoutStarted = false;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const read = SyncPortable.prototype.version,
          logout = ZuvClient.prototype.logout;
        const reader = vi
          .spyOn(SyncPortable.prototype, 'version')
          .mockImplementationOnce(async function (this: SyncPortable, ...args) {
            const value = await read.apply(this, args);
            entered = true;
            await held;
            return value;
          });
        const leaving = vi.spyOn(ZuvClient.prototype, 'logout').mockImplementationOnce(function (
          this: ZuvClient,
        ) {
          logoutStarted = true;
          return logout.call(this);
        });
        cleanups.push(() => {
          release();
          reader.mockRestore();
          leaving.mockRestore();
        });
        const restoring = first.rpc.call('sync.importRestore', chosen);
        await expect.poll(() => entered).toBe(true);
        const signedOut = first.rpc.request('account.logout', { kind: 'zuv' });
        await expect.poll(() => logoutStarted).toBe(true);
        release();
        expect((await restoring).error).toMatchObject({ data: { code: 'SCOPE_DISABLED' } });
        await signedOut;
        expect((await first.memory.read('global', undefined, 'historical-note')).content).toBe(
          'Keep while the identity changes',
        );
      }
    },
    25000,
  );

  it('restores project and session metadata from an archive without replacing their source history', async () => {
    const { first, second, mock } = await fixture();
    await linkSessions(first, second);
    const session = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.rename', {
      sessionId: session.id,
      title: 'Archived session title',
    });
    await first.rpc.request('sync.retry');
    await expect
      .poll(async () => (await first.rpc.request('sync.status')).pending, { timeout: 8000 })
      .toBe(0);
    const exported = await first.rpc.request('sync.exportLocal', {
      directory: join(first.home, 'metadata-export'),
    });
    const prepared = await first.rpc.request('sync.importPrepare', { path: exported.path });
    const imported = await first.rpc.request('sync.importApply', { importId: prepared.importId });
    const entries = (await first.rpc.request('sync.importRead', { importId: imported.importId }))
      .entries;
    const candidates = [];
    for (const entry of entries.filter((value: { kind: string }) => value.kind === 'version')) {
      const data = await first.rpc.request('sync.importEntry', {
        importId: imported.importId,
        entryId: entry.id,
      });
      const value = JSON.parse(Buffer.from(data.base64, 'base64').toString());
      if (
        value.entityType === 'project' ||
        (value.entityId === session.id && value.record.content?.title === 'Archived session title')
      )
        candidates.push({ entry, value });
    }
    await first.rpc.request('session.rename', {
      sessionId: session.id,
      title: 'New session progress',
    });
    await first.rpc.request('workspace.update', {
      workspaceId: first.workspaceId,
      displayName: 'New project progress',
    });
    await first.rpc.request('sync.retry');
    for (const { entry, value } of candidates) {
      const view = await first.rpc.request('sync.importRestorePreview', {
        importId: imported.importId,
        entryId: entry.id,
      });
      expect(view.canRestore).toBe(true);
      const result = await first.rpc.request('sync.importRestore', view);
      expect(result.opId).not.toBe(entry.opId);
      if (value.entityType === 'session')
        expect(
          (await first.rpc.request('session.get', { sessionId: session.id })).session.title,
        ).toBe('Archived session title');
      else
        expect((await first.rpc.request('sync.status')).projects[0].displayName).toBe(
          value.record.content.displayName,
        );
    }
    const { subscriptionId } = await first.rpc.request('events.subscribe', {
      sessionId: session.id,
      sinceSeq: 0,
    });
    await first.rpc.untilTrue(
      () =>
        first.rpc
          .events(subscriptionId)
          .some(
            (event) =>
              event.type === 'session.title_changed' &&
              event.payload.title === 'New session progress',
          ),
      'keeps the intervening title event',
    );
    expect(
      (await first.rpc.request('workspace.list')).workspaces.find(
        (value: { id: string }) => value.id === first.workspaceId,
      ).displayName,
    ).toBe('New project progress');
    await expect
      .poll(
        async () => {
          await first.rpc.request('sync.retry');
          await second.rpc.request('sync.retry');
          return (await first.rpc.request('sync.status')).pending;
        },
        { timeout: 8000 },
      )
      .toBe(0);
    await expect
      .poll(
        async () => {
          const sessions = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions;
          return sessions.find(
            (value: { origin?: { sessionId?: string } }) => value.origin?.sessionId === session.id,
          )?.title;
        },
        { timeout: 8000 },
      )
      .toBe('Archived session title');
    expect(mock.errors).toEqual([]);
  }, 20000);
  it.each(['expired', 'signed_out'] as const)(
    'exports local data with a pending RESET journal while the account is %s',
    async (accountState) => {
      const { mock, first } = await fixture();
      await first.rpc.request('sync.configure', {
        enabled: true,
        categories: ['memory'],
        projects: [],
        includeHistory: true,
      });
      await first.memory.save('global', undefined, {
        name: 'reset-export-note',
        type: 'project',
        description: 'Synthetic recovery',
        content: 'Local content remains exportable.',
      });
      await first.rpc.request('sync.retry');
      const storage = openStorage({ dataDir: first.home });
      try {
        const vault = storage.sync.activeVault();
        if (!vault) throw new Error('missing synthetic vault');
        storage.transaction(() =>
          storage.sync.putBootstrapJob({
            vaultId: vault.vaultId,
            jobId: 'job_synthetic_interrupted',
            accountId: vault.accountId,
            deviceId: vault.deviceId,
            hostId: vault.originHostId,
            origin: mock.origin,
            scopeRevision: vault.revision,
            categories: vault.categories,
            projectIds: vault.projectIds,
            fromCursor: vault.appliedCursor,
            pendingBefore: 0,
            state: 'failed',
            errorCode: 'RESET_REQUIRED',
          }),
        );
      } finally {
        storage.close();
      }
      if (accountState === 'signed_out') await first.rpc.request('account.logout', { kind: 'zuv' });
      else {
        const entitlements = mock.sync.entitlements.bind(mock.sync);
        vi.spyOn(mock.sync, 'entitlements').mockImplementation((userId, deviceId) => ({
          ...entitlements(userId, deviceId),
          subscriptionState: 'expired',
        }));
        expect(
          (await first.rpc.request('account.get', { kind: 'zuv', refresh: true })).account,
        ).toMatchObject({ zuv: { subscriptionState: 'expired' } });
      }
      const attempts = { ...mock.sync.attempts };
      const status = await first.rpc.request('sync.status');
      const exported = await first.rpc.request('sync.exportLocal', {
        directory: join(first.home, 'synthetic-exports'),
      });
      expect(exported).toMatchObject({ state: 'exported', protection: 'plaintext' });
      expect(exported.entries).toBeGreaterThan(0);
      expect(mock.sync.attempts).toEqual(attempts);
      expect((await first.rpc.request('sync.status')).reset).toEqual(status.reset);
      if (accountState === 'expired') {
        const acknowledgements = mock.sync.acknowledgements.length;
        const plan = await first.rpc.request('sync.recoverySnapshot', {
          vaultId: status.binding.vaultId,
        });
        const recovered = await first.rpc.request('sync.recoveryDownload', {
          vaultId: status.binding.vaultId,
          jobId: plan.jobId,
          categories: ['memory'],
          projectIds: [],
        });
        const imported = await first.rpc.request('sync.importApply', {
          importId: recovered.importId,
        });
        const entries = (
          await first.rpc.request('sync.importRead', { importId: imported.importId })
        ).entries;
        const version = entries.find((entry: { kind: string }) => entry.kind === 'version');
        expect(version).toBeDefined();
        const data = await first.rpc.request('sync.importEntry', {
          importId: imported.importId,
          entryId: version.id,
        });
        expect(Buffer.from(data.base64, 'base64').toString()).toContain(
          'Local content remains exportable.',
        );
        expect(mock.sync.attempts.commits).toBe(attempts.commits);
        expect(mock.sync.acknowledgements).toHaveLength(acknowledgements);
        expect((await first.rpc.request('sync.status')).reset).toEqual(status.reset);
      }
      expect(
        (
          await first.rpc.call('sync.configure', {
            enabled: true,
            categories: ['memory'],
            projects: [],
            includeHistory: true,
          })
        ).error,
      ).toBeDefined();
      expect((await first.memory.read('global', undefined, 'reset-export-note')).content).toBe(
        'Local content remains exportable.',
      );
    },
    15000,
  );
  it('keeps skill activation local while resolving binary package conflicts on two bound Hosts', async () => {
    const { first, second, mock } = await fixture();
    const packagePath = (peer: Peer) => join(peer.userHome, '.agents/skills/synthetic-package');
    const initial =
      '---\nname: synthetic-package\ndescription: Synthetic package\n---\n\nInitial instructions';
    const binary = randomBytes(256 * 1024);
    for (const peer of [first, second]) {
      await mkdir(packagePath(peer), { recursive: true });
      await writeFile(join(packagePath(peer), 'SKILL.md'), initial);
      await writeFile(join(packagePath(peer), 'binary.bin'), binary);
    }
    const skills = (await first.rpc.request('plugins.list')).skills;
    const skill = skills.find((item: { name: string }) => item.name === 'synthetic-package');
    if (!skill) throw new Error('missing synthetic skill');
    await first.rpc.request('skill.setEnabled', { id: skill.id, enabled: true });
    const scope = {
      enabled: true,
      categories: ['skill-bundle', 'artifact'],
      projects: [],
      includeHistory: true,
    };
    const state = await first.rpc.request('sync.configure', scope);
    await second.rpc.call('sync.configure', scope);
    const pending = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: pending.binding.deviceId });
    await second.rpc.request('sync.configure', scope);
    const vaultId = state.binding.vaultId;
    await expect
      .poll(
        async () =>
          (await first.rpc.request('sync.bundles', { vaultId })).bundles.filter(
            (b: { category: string }) => b.category === 'skill-bundle',
          ).length,
        { timeout: 8000 },
      )
      .toBeGreaterThan(0);
    const source = (await first.rpc.request('sync.bundles', { vaultId })).bundles.find(
      (b: { category: string }) => b.category === 'skill-bundle',
    );
    await expect
      .poll(
        async () =>
          (await second.rpc.request('sync.bundles', { vaultId })).bundles.some(
            (b: { entityId: string }) => b.entityId === source.entityId,
          ),
        { timeout: 8000 },
      )
      .toBe(true);
    for (const peer of [first, second]) {
      const preview = await peer.rpc.request('sync.bundlePreview', {
        vaultId,
        entityId: source.entityId,
      });
      const native = (
        await peer.rpc.request('sync.bundleTargets', { vaultId, entityId: source.entityId })
      ).targets.find(
        (target: { managed: boolean; name: string }) =>
          !target.managed && target.name === 'synthetic-package',
      );
      if (!native) throw new Error('missing external skill target');
      await peer.rpc.request('sync.applyBundle', {
        vaultId,
        entityId: source.entityId,
        expectedHeads: preview.heads,
        selectedOpId: preview.heads[0],
        targetId: native.targetId,
        fingerprint: native.fingerprint,
      });
    }
    const baseline = mock.sync
      .acceptedOperations(source.entityId)
      .map((operation) => operation.opId);
    mock.sync.pendingEntities.add(source.entityId);
    const changed = randomBytes(256 * 1024);
    await writeFile(join(packagePath(first), 'binary.bin'), changed);
    const local = await second.rpc.request('sync.bundleFile', {
      vaultId,
      entityId: source.entityId,
      path: 'SKILL.md',
    });
    await second.rpc.request('sync.editBundleFile', {
      vaultId,
      entityId: source.entityId,
      path: 'SKILL.md',
      text: `${initial}\n\nSecond Host edit`,
      fingerprint: local.fingerprint,
      localRevision: local.localRevision,
    });
    await expect
      .poll(
        () =>
          mock.sync
            .acceptedOperations(source.entityId)
            .filter((operation) => !baseline.includes(operation.opId)).length,
        { timeout: 8000 },
      )
      .toBe(1);
    mock.sync.pendingEntities.delete(source.entityId);
    mock.sync.finalize();
    await expect
      .poll(
        () =>
          mock.sync
            .acceptedOperations(source.entityId)
            .filter((operation) => !baseline.includes(operation.opId)).length,
        { timeout: 8000 },
      )
      .toBe(2);
    const branches = mock.sync
      .acceptedOperations(source.entityId)
      .filter((operation) => !baseline.includes(operation.opId));
    expect(new Set(branches.map((operation) => operation.deviceId)).size).toBe(2);
    expect(branches[0]?.parents).toEqual(branches[1]?.parents);
    mock.sync.pendingEntities.delete(source.entityId);
    mock.sync.finalize();
    await expect
      .poll(
        async () =>
          (await second.rpc.request('sync.bundlePreview', { vaultId, entityId: source.entityId }))
            .heads.length,
        { timeout: 15000 },
      )
      .toBe(2);
    const preview = await second.rpc.request('sync.bundlePreview', {
      vaultId,
      entityId: source.entityId,
    });
    let binaryVersion: string | undefined, textVersion: string | undefined;
    for (const version of preview.versions) {
      const md = await second.rpc.request('sync.bundleFile', {
        vaultId,
        entityId: source.entityId,
        opId: version.opId,
        path: 'SKILL.md',
      });
      if (md.text?.includes('Second Host edit')) textVersion = version.opId;
      const file = version.files.find((file: { path: string }) => file.path === 'binary.bin');
      if (file?.sha256 === createHash('sha256').update(changed).digest('base64url'))
        binaryVersion = version.opId;
    }
    if (!binaryVersion || !textVersion) throw new Error('missing preserved binary/text revisions');
    const target = (
      await second.rpc.request('sync.bundleTargets', { vaultId, entityId: source.entityId })
    ).targets.find((target: { targetId: string }) => target.targetId === preview.binding.targetId);
    if (!target) throw new Error('missing bound target');
    await second.rpc.request('sync.applyBundle', {
      vaultId,
      entityId: source.entityId,
      selectedOpId: binaryVersion,
      expectedHeads: preview.heads,
      targetId: target.targetId,
      fingerprint: target.fingerprint,
      localRevision: preview.binding.revision,
    });
    for (const peer of [first, second]) {
      await expect
        .poll(
          async () =>
            (await peer.rpc.request('sync.bundlePreview', { vaultId, entityId: source.entityId }))
              .heads.length,
          { timeout: 10000 },
        )
        .toBe(1);
      if (peer === first) await confirmNative(peer, vaultId, source.entityId, 'synthetic-package');
      await expect
        .poll(() => readFile(join(packagePath(peer), 'binary.bin')), { timeout: 10000 })
        .toEqual(changed);
      await expect
        .poll(
          async () =>
            (await peer.rpc.request('sync.bundlePreview', { vaultId, entityId: source.entityId }))
              .heads.length,
          { timeout: 10000 },
        )
        .toBe(1);
    }
    expect(
      (
        await second.rpc.request('sync.bundleFile', {
          vaultId,
          entityId: source.entityId,
          opId: textVersion,
          path: 'SKILL.md',
        })
      ).text,
    ).toContain('Second Host edit');
    expect(
      (await first.rpc.request('plugins.list')).skills.find(
        (s: { name: string }) => s.name === 'synthetic-package',
      ).enabled,
    ).toBe(true);
    expect(
      (await second.rpc.request('plugins.list')).skills.find(
        (s: { name: string }) => s.name === 'synthetic-package',
      ).enabled,
    ).toBe(false);
    expect(first.adapter.endpoints.size).toBe(0);
    expect(second.adapter.endpoints.size).toBe(0);
    expect(mock.errors).toEqual([]);
  }, 40000);
  it('binds one rule package on two Hosts, returns native edits and retains the replaced local resource', async () => {
    const { first, second, mock } = await fixture();
    await writeFile(join(first.project, 'AGENTS.md'), 'Initial first rule');
    await writeFile(join(second.project, 'AGENTS.md'), 'Original second rule');
    const scope = {
      enabled: true,
      categories: ['project', 'rule', 'artifact'],
      includeHistory: true,
    };
    const configured = await first.rpc.request('sync.configure', {
      ...scope,
      projects: [{ workspaceId: first.workspaceId }],
    });
    const target = {
      ...scope,
      projects: [{ workspaceId: second.workspaceId, projectId: configured.binding.projectIds[0] }],
    };
    await second.rpc.call('sync.configure', target);
    const pending = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: pending.binding.deviceId });
    await second.rpc.request('sync.configure', target);
    const vaultId = configured.binding.vaultId;
    await expect
      .poll(
        async () =>
          (await first.rpc.request('sync.bundles', { vaultId })).bundles.filter(
            (b: { category: string }) => b.category === 'rule',
          ).length,
        { timeout: 8000 },
      )
      .toBeGreaterThan(0);
    const original = (await first.rpc.request('sync.bundles', { vaultId })).bundles.find(
      (b: { category: string }) => b.category === 'rule',
    );
    await expect
      .poll(
        async () =>
          (await second.rpc.request('sync.bundles', { vaultId })).bundles.some(
            (b: { entityId: string }) => b.entityId === original.entityId,
          ),
        { timeout: 8000 },
      )
      .toBe(true);
    for (const peer of [first, second]) {
      const preview = await peer.rpc.request('sync.bundlePreview', {
        vaultId,
        entityId: original.entityId,
      });
      const targets = (
        await peer.rpc.request('sync.bundleTargets', { vaultId, entityId: original.entityId })
      ).targets;
      const native = targets.find(
        (item: { managed: boolean; name: string }) => !item.managed && item.name === 'AGENTS.md',
      );
      if (!native) throw new Error('missing native rule target');
      await peer.rpc.request('sync.applyBundle', {
        vaultId,
        entityId: original.entityId,
        expectedHeads: preview.heads,
        selectedOpId: preview.heads[0],
        targetId: native.targetId,
        fingerprint: native.fingerprint,
      });
    }
    expect(await readFile(join(second.project, 'AGENTS.md'), 'utf8')).toBe('Initial first rule');
    const local = await second.rpc.request('sync.bundleFile', {
      vaultId,
      entityId: original.entityId,
      path: 'AGENTS.md',
    });
    await second.rpc.request('sync.editBundleFile', {
      vaultId,
      entityId: original.entityId,
      path: 'AGENTS.md',
      text: 'Edited on second Host',
      fingerprint: local.fingerprint,
      localRevision: local.localRevision,
    });
    await waitForBundleText(
      first,
      vaultId,
      original.entityId,
      'AGENTS.md',
      'Edited on second Host',
    );
    expect(await readFile(join(first.project, 'AGENTS.md'), 'utf8')).toBe('Initial first rule');
    await confirmNative(first, vaultId, original.entityId, 'AGENTS.md');
    await writeFile(join(first.project, 'AGENTS.md'), 'Returned from first Host');
    await waitForBundleText(
      second,
      vaultId,
      original.entityId,
      'AGENTS.md',
      'Returned from first Host',
    );
    expect(await readFile(join(second.project, 'AGENTS.md'), 'utf8')).toBe('Edited on second Host');
    await confirmNative(second, vaultId, original.entityId, 'AGENTS.md');
    await expect
      .poll(
        async () => {
          const packages = (await second.rpc.request('sync.bundles', { vaultId })).bundles;
          for (const item of packages) {
            if (item.entityId === original.entityId) continue;
            const preview = await second.rpc.request('sync.bundlePreview', {
              vaultId,
              entityId: item.entityId,
            });
            const file = await second.rpc.request('sync.bundleFile', {
              vaultId,
              entityId: item.entityId,
              opId: preview.heads[0],
              path: 'AGENTS.md',
            });
            if (file.text === 'Original second rule') return true;
          }
          return false;
        },
        { timeout: 8000 },
      )
      .toBe(true);
    await first.rpc.request('sync.retry', {});
    await second.rpc.request('sync.retry', {});
    const bound = await second.rpc.request('sync.bundlePreview', {
      vaultId,
      entityId: original.entityId,
    });
    const separate = (
      await second.rpc.request('sync.bundleTargets', { vaultId, entityId: original.entityId })
    ).targets.find((target: { managed: boolean }) => target.managed);
    const rebind = await second.rpc.request('sync.applyBundle', {
      vaultId,
      entityId: original.entityId,
      expectedHeads: bound.heads,
      selectedOpId: bound.heads[0],
      targetId: separate.targetId,
      fingerprint: separate.fingerprint,
      localRevision: bound.binding.revision,
      expectedTargetId: bound.binding.targetId,
    });
    expect(await readFile(join(second.project, 'AGENTS.md'), 'utf8')).toBe(
      'Returned from first Host',
    );
    const copy = await second.rpc.request('sync.bundleFile', {
      vaultId,
      entityId: original.entityId,
      path: 'AGENTS.md',
    });
    const saved = await second.rpc.request('sync.editBundleFile', {
      vaultId,
      entityId: original.entityId,
      path: 'AGENTS.md',
      text: 'Edited independent copy',
      fingerprint: copy.fingerprint,
      localRevision: copy.localRevision,
    });
    await waitForBundleText(
      first,
      vaultId,
      original.entityId,
      'AGENTS.md',
      'Edited independent copy',
    );
    expect(await readFile(join(first.project, 'AGENTS.md'), 'utf8')).toBe(
      'Returned from first Host',
    );
    await confirmNative(first, vaultId, original.entityId, 'AGENTS.md');
    expect(await readFile(join(second.project, 'AGENTS.md'), 'utf8')).toBe(
      'Returned from first Host',
    );
    expect(
      (
        await second.rpc.request('sync.bundleVersions', { vaultId, entityId: original.entityId })
      ).versions.some((version: { opId: string }) => version.opId === rebind.opId),
    ).toBe(true);
    await second.rpc.request('account.logout', { kind: 'zuv' });
    expect(
      (
        await second.rpc.request('sync.bundleFile', {
          vaultId,
          entityId: original.entityId,
          opId: saved.opId,
          path: 'AGENTS.md',
        })
      ).text,
    ).toBe('Edited independent copy');
    expect(
      (await second.rpc.call('sync.bundleTargets', { vaultId, entityId: original.entityId })).error,
    ).toMatchObject({ data: { code: 'SCOPE_DISABLED' } });
    expect(first.adapter.endpoints.size).toBe(0);
    expect(second.adapter.endpoints.size).toBe(0);
    expect(mock.errors).toEqual([]);
  }, 30000);
  it('merges a conflicting preference field explicitly without replacing unrelated or excluded settings', async () => {
    const { mock, first, second } = await fixture();
    const scope = { enabled: true, categories: ['settings'], projects: [], includeHistory: false };
    await first.rpc.request('sync.configure', scope);
    await second.rpc.call('sync.configure', scope);
    const pending = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: pending.binding.deviceId });
    await second.rpc.request('sync.configure', scope);
    await first.rpc.request('settings.update', {
      settings: {
        agentInstructions: 'Alpha\n\nMiddle\n\nOmega',
        notifications: { completed: true, failed: true },
      },
    });
    await expect
      .poll(
        async () => {
          await first.rpc.request('sync.retry');
          await second.rpc.request('sync.retry');
          return (await second.rpc.request('settings.get')).settings;
        },
        {
          timeout: 8000,
        },
      )
      .toMatchObject({
        agentInstructions: 'Alpha\n\nMiddle\n\nOmega',
        notifications: { completed: true, failed: true },
      });
    const commits = mock.sync.attempts.commits;
    mock.sync.pendingCommits = true;
    await Promise.all([
      first.rpc.request('settings.update', {
        settings: {
          agentInstructions: 'Local alpha\n\nMiddle\n\nOmega',
          promptSuggestions: false,
          notifications: { completed: false, failed: true },
        },
      }),
      second.rpc.request('settings.update', {
        settings: {
          agentInstructions: 'Alpha\n\nMiddle\n\nRemote omega',
          notifications: { completed: true, failed: false },
        },
      }),
    ]);
    await expect
      .poll(() => mock.sync.attempts.commits, { timeout: 8000 })
      .toBeGreaterThanOrEqual(commits + 2);
    mock.sync.pendingCommits = false;
    mock.sync.finalize();
    await expect
      .poll(async () => (await first.rpc.request('sync.settingsConflicts')).conflicts.length, {
        timeout: 8000,
      })
      .toBe(2);
    const preview = await first.rpc.request('sync.previewSettingsMerge', {
      entityId: 'settings_agentInstructions',
    });
    expect(preview).toMatchObject({
      key: 'agentInstructions',
      mergeState: 'clean',
      merged: { agentInstructions: 'Local alpha\n\nMiddle\n\nRemote omega' },
    });
    expect(
      (await first.rpc.call('sync.resolveSettings', { ...preview, values: { autoMemory: false } }))
        .error,
    ).toMatchObject({ data: { code: 'INVALID_REQUEST' } });
    const resolved = await first.rpc.request('sync.resolveSettings', {
      ...preview,
      values: preview.merged,
    });
    expect(resolved.opId).toMatch(/^sop_/);
    expect(
      (await first.rpc.call('sync.resolveSettings', { ...preview, values: preview.merged })).error,
    ).toMatchObject({ data: { code: 'REVISION_CONFLICT' } });
    const notifications = await first.rpc.request('sync.previewSettingsMerge', {
      entityId: 'settings_notifications',
    });
    expect(notifications).toMatchObject({
      mergeState: 'clean',
      merged: { notifications: { completed: false, failed: false } },
    });
    await first.rpc.request('sync.resolveSettings', {
      ...notifications,
      values: notifications.merged,
    });
    for (const peer of [first, second]) {
      await expect
        .poll(async () => (await peer.rpc.request('settings.get')).settings.agentInstructions, {
          timeout: 8000,
        })
        .toBe('Local alpha\n\nMiddle\n\nRemote omega');
      await expect
        .poll(async () => (await peer.rpc.request('sync.settingsConflicts')).conflicts, {
          timeout: 8000,
        })
        .toEqual([]);
      await expect
        .poll(async () => (await peer.rpc.request('sync.status')).conflicts, { timeout: 8000 })
        .toBe(0);
      expect(peer.adapter.endpoints.size).toBe(0);
      expect((await peer.rpc.request('settings.get')).settings.notifications).toMatchObject({
        completed: false,
        failed: false,
      });
    }
    expect((await second.rpc.request('settings.get')).settings.promptSuggestions).toBe(true);
    expect((await first.rpc.request('settings.get')).settings.promptSuggestions).toBe(false);
    expect(mock.errors).toEqual([]);
  }, 30000);
  it.each([
    [false, 'normal'],
    [true, 'normal'],
    [false, 'retry'],
    [false, 'cancel'],
  ] as const)(
    'rebuilds a reset device explicitly while preserving offline edits against remote deletion=%s using %s',
    async (deleted, recovery) => {
      const { mock, first, second } = await fixture();
      const scope = { enabled: true, categories: ['memory'], projects: [], includeHistory: true };
      await first.rpc.request('sync.configure', scope);
      expect((await second.rpc.call('sync.configure', scope)).error).toMatchObject({
        data: { code: 'RECOVERY_REQUIRED' },
      });
      const before = await second.rpc.request('sync.status');
      await first.rpc.request('sync.approveDevice', { deviceId: before.binding.deviceId });
      await second.rpc.request('sync.configure', scope);
      await first.memory.save('global', undefined, {
        name: 'reset-synthetic',
        type: 'project',
        description: 'Synthetic reset',
        content: 'Original shared body',
      });
      await expect
        .poll(
          () =>
            second.memory.read('global', undefined, 'reset-synthetic').then(
              (note) => note.content,
              () => '',
            ),
          { timeout: 8000 },
        )
        .toBe('Original shared body');
      mock.sync.forceReset(before.binding.deviceId);
      const local = await second.memory.read('global', undefined, 'reset-synthetic');
      await second.memory.update('global', undefined, 'reset-synthetic', local.revision, {
        content: 'Offline edit remains local',
      });
      const remote = await first.memory.read('global', undefined, 'reset-synthetic');
      if (deleted)
        await first.memory.delete('global', undefined, 'reset-synthetic', {
          revision: remote.revision,
        });
      else
        await first.memory.update('global', undefined, 'reset-synthetic', remote.revision, {
          content: 'New server revision',
        });
      await first.rpc.request('sync.retry');
      await expect
        .poll(async () => (await first.rpc.request('sync.status')).pending, { timeout: 8000 })
        .toBe(0);
      const exports = mock.sync.exports;
      await second.rpc.request('sync.retry');
      expect(mock.sync.exports).toBe(exports);
      await second.rpc.request('sync.resetPrepare');
      await expect
        .poll(
          async () => {
            const reset = (await second.rpc.request('sync.status')).reset;
            return reset?.busy ? 'busy' : reset?.phase;
          },
          { timeout: 8000 },
        )
        .toBe('staged');
      const staged = await second.rpc.request('sync.status');
      expect(staged.reset).toMatchObject({ selected: 2, staged: 2, applied: 0 });
      expect(mock.sync.resettingDevices.has(before.binding.deviceId)).toBe(true);
      expect((await second.memory.read('global', undefined, 'reset-synthetic')).content).toBe(
        'Offline edit remains local',
      );
      expect((await second.rpc.call('sync.configure', scope)).error).toMatchObject({
        data: { code: 'RECOVERY_REQUIRED' },
      });
      await second.rpc.call('sync.configure', { enabled: false, categories: [], projects: [] });
      expect((await second.rpc.request('sync.status')).binding.enabled).toBe(false);
      expect(
        (await second.rpc.call('sync.resetApply', { jobId: staged.reset.jobId })).error,
      ).toMatchObject({ data: { code: 'SCOPE_DISABLED' } });
      await second.rpc.request('sync.configure', {
        ...scope,
        expectedRevision: staged.binding.revision,
      });
      if (recovery !== 'normal') mock.sync.refusedResetAcks.add(before.binding.deviceId);
      await second.rpc.request('sync.resetApply', { jobId: staged.reset.jobId });
      if (recovery !== 'normal') {
        await expect
          .poll(
            async () => {
              const status = await second.rpc.request('sync.status');
              return status.reset?.busy ? undefined : status.errorCode;
            },
            { timeout: 8000 },
          )
          .toBe('SERVICE_UNAVAILABLE');
        mock.sync.refusedResetAcks.delete(before.binding.deviceId);
        if (recovery === 'retry') await second.rpc.request('sync.retry');
        else {
          await second.rpc.request('sync.resetCancel', { jobId: staged.reset.jobId });
          expect((await second.rpc.request('sync.status')).reset).toBeUndefined();
          await second.rpc.request('sync.resetPrepare');
          await expect
            .poll(
              async () => {
                const reset = (await second.rpc.request('sync.status')).reset;
                return reset?.busy ? undefined : reset?.phase;
              },
              { timeout: 8000 },
            )
            .toBe('staged');
          const next = (await second.rpc.request('sync.status')).reset;
          await second.rpc.request('sync.resetApply', { jobId: next.jobId });
        }
      }
      await expect
        .poll(async () => (await second.rpc.request('sync.status')).reset, { timeout: 8000 })
        .toBeUndefined();
      expect(mock.sync.resettingDevices.has(before.binding.deviceId)).toBe(false);
      expect(
        mock.sync.acknowledgements.filter(
          (ack) => ack.deviceId === before.binding.deviceId && ack.restoreId,
        ),
      ).toHaveLength(1);
      expect((await second.memory.read('global', undefined, 'reset-synthetic')).content).toBe(
        'Offline edit remains local',
      );
      await expect
        .poll(async () => (await second.rpc.request('sync.memoryConflicts')).conflicts.length, {
          timeout: 8000,
        })
        .toBe(1);
      expect(second.adapter.deleted).toEqual([]);
      if (deleted) {
        const conflict = (await second.rpc.request('sync.memoryConflicts')).conflicts[0];
        const preview = await second.rpc.request('sync.previewMemoryMerge', {
          entityId: conflict.entityId,
        });
        expect(preview.versions.some((version: { deleted?: boolean }) => version.deleted)).toBe(
          true,
        );
        expect(
          preview.versions.some((version: { markdown?: string }) =>
            version.markdown?.includes('Offline edit remains local'),
          ),
        ).toBe(true);
        await expect(
          first.memory.read('global', undefined, 'reset-synthetic'),
        ).rejects.toBeDefined();
      }
      expect(mock.errors).toEqual([]);
    },
    20000,
  );

  it('previews and explicitly merges concurrent memory edits through the Host while retaining both revisions', async () => {
    const { mock, first, second } = await fixture();
    const scope = { enabled: true, categories: ['memory'], projects: [], includeHistory: true };
    await first.rpc.request('sync.configure', scope);
    expect((await second.rpc.call('sync.configure', scope)).error).toMatchObject({
      data: { code: 'RECOVERY_REQUIRED' },
    });
    const status = await second.rpc.request('sync.status');
    await first.rpc.request('sync.approveDevice', { deviceId: status.binding.deviceId });
    await second.rpc.request('sync.configure', scope);
    await first.memory.save('global', undefined, {
      name: 'synthetic-merge',
      type: 'project',
      description: 'Synthetic merge',
      content: 'Alpha\n\nMiddle\n\nOmega',
    });
    await expect
      .poll(
        async () =>
          second.memory.read('global', undefined, 'synthetic-merge').then(
            (note) => note.content,
            (error) => error.code,
          ),
        { timeout: 8000 },
      )
      .toBe('Alpha\n\nMiddle\n\nOmega');
    await expect
      .poll(
        () =>
          Promise.all(
            [first, second].map(async (peer) => (await peer.rpc.request('sync.status')).state),
          ),
        { timeout: 8000 },
      )
      .toEqual(['idle', 'idle']);
    const commits = mock.sync.attempts.commits;
    mock.sync.pendingCommits = true;
    for (const [peer, content] of [
      [first, 'Local alpha\n\nMiddle\n\nOmega'],
      [second, 'Alpha\n\nMiddle\n\nRemote omega'],
    ] as const) {
      const note = await peer.memory.read('global', undefined, 'synthetic-merge');
      await peer.memory.update('global', undefined, 'synthetic-merge', note.revision, { content });
    }
    await expect
      .poll(() => mock.sync.attempts.commits, { timeout: 8000 })
      .toBeGreaterThanOrEqual(commits + 2);
    mock.sync.pendingCommits = false;
    mock.sync.finalize();
    await expect
      .poll(async () => (await first.rpc.request('sync.memoryConflicts')).conflicts.length, {
        timeout: 8000,
      })
      .toBe(1);
    const [entry] = (await first.rpc.request('sync.memoryConflicts')).conflicts;
    const preview = await first.rpc.request('sync.previewMemoryMerge', {
      entityId: entry.entityId,
    });
    expect(preview).toMatchObject({
      name: 'synthetic-merge',
      scope: 'global',
      mergeState: 'clean',
    });
    expect(preview.merged).toContain('Local alpha\n\nMiddle\n\nRemote omega');
    const resolved = await first.rpc.request('sync.resolveMemory', {
      ...preview,
      markdown: preview.merged,
    });
    expect(resolved.opId).toMatch(/^sop_/);
    expect((await first.memory.read('global', undefined, 'synthetic-merge')).content).toBe(
      'Local alpha\n\nMiddle\n\nRemote omega',
    );
    expect(
      (await first.rpc.call('sync.resolveMemory', { ...preview, markdown: preview.merged })).error,
    ).toMatchObject({ data: { code: 'REVISION_CONFLICT' } });
    await expect
      .poll(
        async () => (await second.memory.read('global', undefined, 'synthetic-merge')).content,
        { timeout: 8000 },
      )
      .toBe('Local alpha\n\nMiddle\n\nRemote omega');
    expect((await first.rpc.request('sync.memoryConflicts')).conflicts).toEqual([]);
    expect((await second.rpc.request('sync.memoryConflicts')).conflicts).toEqual([]);
    expect((await first.rpc.request('sync.status')).conflicts).toBe(0);
    expect((await second.rpc.request('sync.status')).conflicts).toBe(0);
    expect(mock.errors).toEqual([]);
  }, 25000);

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
    const remote = await TestRpcClient.connect(second.url);
    cleanups.push(() => remote.ws.terminate());
    await remote.hello(second.token, {
      deviceId: 'device_preview',
      clientId: 'remote_preview',
      clientKind: 'mobile',
    });
    expect(
      await remote.request('workspace.fileUrl', {
        ...scope,
        path: 'page.html',
        artifactSeq: firstShare.seq,
      }),
    ).not.toHaveProperty('localPath');
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
      data: { code: 'SCOPE_DISABLED' },
    });
    expect((await second.rpc.request('sync.status')).binding).toBeUndefined();
    expect(
      (
        await second.rpc.call('sync.configure', {
          enabled: true,
          categories: ['project'],
          projects: [],
        })
      ).error,
    ).toMatchObject({
      data: { code: 'RECOVERY_REQUIRED' },
    });
    const binding = (await second.rpc.request('sync.status')).binding;
    await first.rpc.request('sync.approveDevice', { deviceId: binding.deviceId });
    const nativeCreate = vi.spyOn(second.adapter, 'createSession');
    const unchanged = await second.rpc.request('sync.status');
    expect((await second.rpc.call('sync.projectCatalog', { enable: true })).error).toMatchObject({
      data: { code: 'SCOPE_DISABLED' },
    });
    expect((await second.rpc.request('sync.status')).binding).toEqual(unchanged.binding);
    await second.rpc.request('sync.configure', {
      enabled: true,
      categories: ['project'],
      projects: [],
    });
    const catalog = await second.rpc.request('sync.projectCatalog');
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
    await expect
      .poll(
        async () => (await first.rpc.request('sync.projectCatalog')).projects[0]?.versions.length,
        { timeout: 12000 },
      )
      .toBe(2);
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
      {
        opId: resolved.opId,
        displayName: 'Synthetic branch B',
        deleted: false,
        deviceId: (await second.rpc.request('sync.status')).binding.deviceId,
        clientTime: expect.any(String),
      },
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
    const mirroredRoot = (
      await second.rpc.request('session.list', { workspaceId: second.workspaceId })
    ).sessions.find(
      (row: { origin?: { sessionId?: string } }) => row.origin?.sessionId === root.id,
    );
    await expect
      .poll(
        async () => {
          const sides = (
            await second.rpc.request('session.list', {
              workspaceId: second.workspaceId,
              sideOf: mirroredRoot.id,
            })
          ).sessions;
          return sides.find(
            (row: { origin?: { sessionId?: string } }) => row.origin?.sessionId === side.id,
          )?.forkedFrom;
        },
        { timeout: 8000 },
      )
      .toMatchObject({ sessionId: mirroredRoot.id });
  }, 30000);
  it('reads handoff constraints, note revisions and task references on another Host without execution', async () => {
    const { first, second, mock } = await fixture();
    const create = vi.spyOn(second.adapter, 'createSession');
    await linkSessions(first, second);
    await first.rpc.request('provider.upsert', {
      id: 'synthetic-other',
      kind: 'openai-compatible',
      displayName: 'Synthetic other',
      api: 'openai-responses',
      baseURL: 'https://synthetic.invalid/v1',
      models: [{ id: 'synthetic-model' }],
      defaultModelId: 'synthetic-model',
    });
    await first.memory.save('global', undefined, {
      name: 'synthetic-handoff-note',
      type: 'reference',
      description: 'Synthetic handoff note',
      content: 'Synthetic retained note body',
    });
    const note = await first.memory.read('global', undefined, 'synthetic-handoff-note');
    const session = (
      await first.rpc.request('session.create', {
        workspaceId: first.workspaceId,
        providerId: 'synthetic-api',
        modelId: 'synthetic-model',
      })
    ).session;
    await first.rpc.request('session.send', {
      sessionId: session.id,
      clientMessageId: 'synthetic-handoff-message',
      content: [{ type: 'text', text: 'Synthetic handoff task' }],
    });
    await expect
      .poll(
        async () =>
          (await first.rpc.request('session.get', { sessionId: session.id })).session.state,
        { timeout: 8000 },
      )
      .toBe('idle');
    await first.rpc.request('session.configure', {
      sessionId: session.id,
      providerId: 'synthetic-other',
      handoff: {
        constraints: ['Synthetic must-carry constraint'],
        notes: [{ scope: 'global', name: 'synthetic-handoff-note' }],
        episode: true,
      },
    });
    let mirroredId: string | undefined;
    await expect
      .poll(
        async () => {
          const rows = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions;
          mirroredId = rows.find(
            (row: { origin?: { sessionId?: string } }) => row.origin?.sessionId === session.id,
          )?.id;
          return mirroredId;
        },
        { timeout: 8000 },
      )
      .toBeTruthy();
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: mirroredId,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () => second.rpc.events(subscriptionId).some((event) => event.type === 'session.handoff'),
      'synchronized handoff receipt',
    );
    const handoff = second.rpc
      .events(subscriptionId)
      .find((event) => event.type === 'session.handoff');
    if (handoff?.type !== 'session.handoff') throw new Error('missing synchronized handoff');
    expect(handoff.payload.context).toContain('Synthetic must-carry constraint');
    expect(handoff.payload.context).toContain('Synthetic retained note body');
    expect(handoff.payload.context).toContain('Synthetic handoff task');
    expect(handoff.payload.notes).toEqual([
      { scope: 'global', name: 'synthetic-handoff-note', revision: note.revision },
    ]);
    expect(handoff.payload.episode).toBeDefined();
    expect(handoff.syncOrigin).toMatchObject({ sessionId: session.id });
    const covered = handoff.payload.covered;
    expect(covered).toBeDefined();
    expect(
      second.rpc
        .events(subscriptionId)
        .some((event) => event.syncOrigin?.seq === String(covered?.toSeq)),
    ).toBe(true);
    const remote = (await second.rpc.request('session.get', { sessionId: mirroredId })).session;
    expect(remote).toMatchObject({ readOnly: { reason: 'synchronized' }, state: 'closed' });
    expect(create).not.toHaveBeenCalled();
    expect(mock.errors).toEqual([]);
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
    const receiver = openStorage({ dataDir: second.home });
    cleanups.push(() => receiver.close());
    const origin = remote.syncOrigin;
    // 资料先到时，事件补齐会重算投影修订。
    await expect
      .poll(
        () =>
          receiver.sync.sourceFingerprint(
            origin.vaultId,
            origin.hostId,
            origin.sessionId,
            origin.streamId,
            origin.seq,
          ),
        { timeout: 8000 },
      )
      .toBeDefined();
    const editable = (await second.rpc.request('episode.get', { id: remote.id })).episode;
    const updatedEpisode = await second.rpc.request('episode.update', {
      id: remote.id,
      revision: editable.revision,
      patch: {
        title: 'Edited on second Host',
        goal: { ...editable.goal, text: 'Updated synthetic goal' },
        open: [
          {
            id: 'user:follow-up',
            text: 'Synthetic follow-up',
            origin: 'todo',
            status: 'pending',
            ref: editable.goal.ref,
          },
        ],
      },
      pinned: true,
    });
    expect(updatedEpisode.conflict).toBeUndefined();
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

  it('resolves concurrent session metadata across two Hosts without rewriting either source history', async () => {
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
    await first.rpc.request('session.rename', { sessionId: created.id, title: 'Base title' });
    let remoteId: SessionId | undefined;
    await expect
      .poll(
        async () => {
          const sessions = (
            await second.rpc.request('session.list', { workspaceId: second.workspaceId })
          ).sessions as Array<{ id: SessionId; title: string; origin?: { kind: string } }>;
          const remote = sessions.find((session) => session.origin?.kind === 'synced');
          remoteId = remote?.id;
          return remote?.title;
        },
        { timeout: 10000 },
      )
      .toBe('Base title');
    for (const peer of [first, second])
      await expect
        .poll(async () => (await peer.rpc.request('sync.status')).pending, { timeout: 8000 })
        .toBe(0);
    const attempts = mock.sync.attempts.commits;
    mock.sync.pendingCommits = true;
    await Promise.all([
      first.rpc.request('session.rename', { sessionId: created.id, title: 'Local title' }),
      second.rpc.request('session.rename', { sessionId: remoteId, title: 'Remote title' }),
    ]);
    await expect
      .poll(() => mock.sync.attempts.commits, { timeout: 10000 })
      .toBeGreaterThanOrEqual(attempts + 2);
    mock.sync.pendingCommits = false;
    mock.sync.finalize();
    for (const peer of [first, second])
      await expect
        .poll(async () => (await peer.rpc.request('sync.sessionConflicts')).conflicts.length, {
          timeout: 10000,
        })
        .toBe(1);
    const preview = await first.rpc.request('sync.previewSessionMerge', { entityId: created.id });
    expect(preview.mergeState).toBe('conflict');
    const selected = preview.versions.find(
      (version: { content: { title?: string } }) => version.content.title === 'Remote title',
    );
    expect(selected).toBeDefined();
    const input = { ...preview, selection: { kind: 'version', opId: selected.opId } };
    await first.rpc.request('sync.resolveSession', input);
    expect((await first.rpc.call('sync.resolveSession', input)).error).toMatchObject({
      data: { code: 'REVISION_CONFLICT' },
    });
    for (const [peer, sessionId] of [
      [first, created.id],
      [second, remoteId],
    ] as const) {
      await expect
        .poll(async () => (await peer.rpc.request('session.get', { sessionId })).session.title, {
          timeout: 10000,
        })
        .toBe('Remote title');
      await expect
        .poll(async () => (await peer.rpc.request('sync.status')).conflicts, { timeout: 10000 })
        .toBe(0);
    }
    const { subscriptionId } = await first.rpc.request('events.subscribe', {
      sessionId: created.id,
      sinceSeq: 0,
    });
    await first.rpc.untilTrue(
      () =>
        first.rpc
          .events(subscriptionId)
          .some(
            (event) =>
              event.type === 'session.title_changed' && event.payload.title === 'Local title',
          ),
      'original local rename history',
    );
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mock.errors).toEqual([]);
  }, 35000);

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
