import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MethodResult, SessionId, WorkspaceId } from '@wevir/protocol';
import type { AgentInput, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { startMockZuv } from '../zuv/mock.test-utils.js';
import { workspaceGit } from './workspace-git.js';

const temp = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
class TrackedEcho extends EchoAdapter {
  created = 0;
  inputs: AgentInput[] = [];
  override createSession(config: SessionConfig) {
    this.created++;
    return super.createSession(config);
  }
  override async send(id: string, input: AgentInput) {
    this.inputs.push(input);
    await super.send(id, input);
  }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const mock = await startMockZuv();
  cleanups.push(() => mock.close());
  const boot = async () => {
    const root = await mkdtemp(join(temp(), 'peer-')),
      home = join(root, 'home'),
      userHome = join(root, 'user'),
      project = join(root, 'repo');
    await mkdir(userHome);
    await mkdir(project);
    const adapter = new TrackedEcho({ stepDelayMs: 0 });
    const options = {
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      adapter,
      engine: 'echo',
      zuv: { origin: mock.origin, allowLoopback: true, syncIntervalMs: 30 },
      logger: createLogger({ mirror: () => {} }),
    };
    let host = await startHost(options);
    const connect = async () => {
      const token = JSON.parse(await readFile(join(home, 'run/host.json'), 'utf8')).token;
      const connection = await TestRpcClient.connect(host.url);
      await connection.hello(token, undefined, {
        subscription_kinds: true,
        provider_kind_chatgpt: true,
      });
      return connection;
    };
    let rpc = await connect();
    cleanups.push(async () => {
      rpc.ws.terminate();
      await host.shutdown();
    });
    const workspaceId = (await rpc.request('workspace.add', { rootPath: project })).workspace
      .id as WorkspaceId;
    await rpc.request('provider.upsert', {
      id: 'synthetic-api',
      kind: 'openai-compatible',
      displayName: 'Synthetic API',
      api: 'openai-responses',
      baseURL: 'https://synthetic.invalid/v1',
      models: [{ id: 'echo-model' }],
      defaultModelId: 'echo-model',
    });
    const login = (await rpc.request('account.login', { kind: 'zuv', method: 'browser' })).account;
    mock.approve(login.login.authUrl);
    await rpc.until(
      () =>
        rpc
          .notifications('account.updated')
          .find((value) => (value.account as { status: string }).status === 'signed_in'),
      'synthetic login',
    );
    return {
      get rpc() {
        return rpc;
      },
      home,
      project,
      workspaceId,
      adapter,
      restart: async () => {
        rpc.ws.terminate();
        await host.shutdown();
        host = await startHost({ ...options, adapter: new TrackedEcho() });
        rpc = await connect();
      },
    };
  };
  return { mock, first: await boot(), second: await boot() };
}

async function seed(cwd: string, base = 'base\n') {
  await workspaceGit(cwd, ['init', '--template=', '--initial-branch=main']);
  await writeFile(join(cwd, 'mixed.txt'), base);
  await writeFile(join(cwd, 'old.txt'), 'renamed\n');
  await writeFile(join(cwd, 'remove.txt'), 'deleted\n');
  await workspaceGit(cwd, ['add', '.']);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@localhost',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'Synthetic base',
    ],
    { cwd, stdio: 'ignore' },
  );
  await writeFile(join(cwd, 'mixed.txt'), 'index\n');
  await rename(join(cwd, 'old.txt'), join(cwd, 'new.txt'));
  await rm(join(cwd, 'remove.txt'));
  await writeFile(join(cwd, 'binary.bin'), Buffer.alloc(192 * 1024, 137));
  await workspaceGit(cwd, ['add', '-A']);
  await writeFile(join(cwd, 'mixed.txt'), 'worktree\n');
  await writeFile(join(cwd, 'selected.txt'), 'selected\n');
  await writeFile(join(cwd, 'omitted.txt'), 'omitted\n');
}

async function linked() {
  const env = await fixture(),
    { first, second } = env;
  await seed(first.project);
  const scopes = {
    enabled: true,
    categories: ['project', 'session', 'event-segment', 'artifact', 'workspace-snapshot'],
    includeHistory: true,
  };
  const selected = await first.rpc.request('sync.configure', {
    ...scopes,
    projects: [{ workspaceId: first.workspaceId }],
  });
  const target = {
    ...scopes,
    projects: [{ workspaceId: second.workspaceId, projectId: selected.binding.projectIds[0] }],
  };
  await second.rpc.call('sync.configure', target);
  const pending = await second.rpc.request('sync.status');
  await first.rpc.request('sync.approveDevice', { deviceId: pending.binding.deviceId });
  await second.rpc.request('sync.configure', target);
  const source = (
    await first.rpc.request('session.create', {
      workspaceId: first.workspaceId,
      providerId: 'synthetic-api',
    })
  ).session;
  await first.rpc.request('session.send', {
    sessionId: source.id,
    content: [
      { type: 'text', text: 'Continue the synthetic workspace task; retain staged changes.' },
    ],
  });
  await expect
    .poll(
      async () =>
        (await first.rpc.request('session.list', {})).sessions.find(
          (session: { id: string }) => session.id === source.id,
        )?.state,
    )
    .toBe('idle');
  const snapshot = (
    await first.rpc.request('sync.workspaceCapture', {
      sessionId: source.id,
      untracked: ['selected.txt'],
    })
  ).snapshot;
  let mirrored: { id: SessionId } | undefined;
  await expect
    .poll(
      async () => {
        await first.rpc.request('sync.retry');
        await second.rpc.request('sync.retry');
        mirrored = (await second.rpc.request('session.list', {})).sessions.find(
          (session: { origin?: { kind: string; sessionId: string } }) =>
            session.origin?.kind === 'synced' && session.origin.sessionId === source.id,
        );
        return (
          mirrored &&
          (await second.rpc.request('sync.workspaceSnapshots', { sessionId: mirrored.id }))
            .snapshots.length
        );
      },
      { timeout: 10000 },
    )
    .toBe(1);
  return { ...env, source, mirrored: mirrored as { id: SessionId }, snapshot };
}

describe('workspace handoff through two isolated Hosts', () => {
  it('restores an imported workspace and exact rule references as new scoped material without changing the target', async () => {
    const { mock, first, second, mirrored, source } = await linked();
    await writeFile(join(first.project, 'AGENTS.md'), 'Historical workspace rule');
    for (const peer of [first, second]) {
      const status = await peer.rpc.request('sync.status');
      await peer.rpc.request('sync.configure', {
        enabled: true,
        categories: [...status.binding.categories, 'rule'],
        includeHistory: true,
        expectedRevision: status.binding.revision,
        projects: [{ workspaceId: peer.workspaceId, projectId: status.binding.projectIds[0] }],
      });
    }
    await first.rpc.request('sync.retry');
    const snapshot = (
      await first.rpc.request('sync.workspaceCapture', {
        sessionId: source.id,
        untracked: ['selected.txt', 'AGENTS.md'],
      })
    ).snapshot;
    await expect
      .poll(
        async () => {
          await first.rpc.request('sync.retry');
          await second.rpc.request('sync.retry');
          return (
            await second.rpc.request('sync.workspaceSnapshots', { sessionId: mirrored.id })
          ).snapshots.some((item: { opId: string }) => item.opId === snapshot.opId);
        },
        { timeout: 10000 },
      )
      .toBe(true);
    const exported = await first.rpc.request('sync.exportLocal', {
      directory: join(first.home, 'workspace-archive'),
    });
    const prepared = await second.rpc.request('sync.importPrepare', { path: exported.path });
    const imported = await second.rpc.request('sync.importApply', { importId: prepared.importId });
    const entries = (await second.rpc.request('sync.importRead', { importId: imported.importId }))
      .entries;
    const entry = entries.find(
      (entry: { entityId?: string; opId?: string }) =>
        entry.entityId === snapshot.entityId && entry.opId === snapshot.opId,
    );
    expect(entry).toBeDefined();
    await seed(second.project, 'different archive target base\n');
    const index = await workspaceGit(second.project, ['ls-files', '--stage', '-z']);
    const created = second.adapter.created;
    const preview = await second.rpc.request('sync.importRestorePreview', {
      importId: imported.importId,
      entryId: entry.id,
    });
    expect(preview).toMatchObject({ canRestore: true, kind: 'workspace', sessionId: mirrored.id });
    const derived = await second.rpc.request('sync.importRestore', preview);
    expect(derived.entityId).not.toBe(snapshot.entityId);
    expect(derived.opId).not.toBe(snapshot.opId);
    const ref = { vaultId: snapshot.vaultId, entityId: derived.entityId, opId: derived.opId };
    const restored = await second.rpc.request('sync.workspaceRestore', {
      sessionId: mirrored.id,
      snapshot: ref,
    });
    expect(await readFile(join(restored.cwd, 'mixed.txt'), 'utf8')).toBe('worktree\n');
    expect(await readFile(join(restored.cwd, 'AGENTS.md'), 'utf8')).toBe(
      'Historical workspace rule',
    );
    expect(await workspaceGit(second.project, ['ls-files', '--stage', '-z'])).toEqual(index);
    expect(second.adapter.created).toBe(created);
    expect(restored.recoveredFrom).toMatchObject({ opId: snapshot.opId, source: snapshot.source });
    await expect
      .poll(
        async () => {
          await second.rpc.request('sync.retry');
          await first.rpc.request('sync.retry');
          return (
            await first.rpc.request('sync.workspaceSnapshots', { sessionId: source.id })
          ).snapshots.some((item: { opId: string }) => item.opId === derived.opId);
        },
        { timeout: 10000 },
      )
      .toBe(true);
    expect(mock.errors).toEqual([]);
  }, 30000);
  it('checks dependencies and requires explicit approval for restored agent configuration before creating an engine', async () => {
    const { second, mirrored, snapshot } = await linked();
    const restored = await second.rpc.request('sync.workspaceRestore', {
      sessionId: mirrored.id,
      snapshot,
    });
    const before = second.adapter.created;
    const marker = join(second.project, 'unexpected-install');
    await writeFile(
      join(restored.cwd, 'package.json'),
      JSON.stringify({
        name: 'synthetic-workspace',
        version: '1.0.0',
        dependencies: { 'synthetic-unused-dependency': '1.0.0' },
        scripts: { install: `node -e "require('fs').writeFileSync('${marker}', 'forbidden')"` },
      }),
    );
    const report = (
      await second.rpc.request('readiness.get', {
        workspaceId: second.workspaceId,
        workspaceRestoreId: restored.restoreId,
      })
    ).report;
    expect(report.status).toBe('not_ready');
    expect(report.plans.length).toBeGreaterThan(0);
    expect(
      (
        await second.rpc.call('session.createFromHistory', {
          sessionId: mirrored.id,
          workspaceSnapshot: snapshot,
          workspaceRestoreId: restored.restoreId,
        })
      ).error,
    ).toMatchObject({ code: -32020 });
    expect(second.adapter.created).toBe(before);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await second.rpc.call('readiness.install', {
          workspaceId: second.workspaceId,
          workspaceRestoreId: restored.restoreId,
          planId: report.plans[0].id,
        })
      ).error,
    ).toMatchObject({ code: -32602 });
    await rm(join(restored.cwd, 'package.json'));
    await mkdir(join(restored.cwd, '.claude'));
    await writeFile(
      join(restored.cwd, '.claude/settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: `touch '${marker}'` }] } }),
    );
    expect(
      (
        await second.rpc.call('session.createFromHistory', {
          sessionId: mirrored.id,
          workspaceSnapshot: snapshot,
          workspaceRestoreId: restored.restoreId,
        })
      ).error,
    ).toMatchObject({ code: -32020 });
    expect(second.adapter.created).toBe(before);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const allowed = await second.rpc.request('session.createFromHistory', {
      sessionId: mirrored.id,
      workspaceSnapshot: snapshot,
      workspaceRestoreId: restored.restoreId,
      trustWorkspace: true,
    });
    expect(allowed.session.cwd).toBe(restored.cwd);
  }, 30000);
  it('transfers bounded chunks, protects a dirty target and continues the logical task through the existing handoff', async () => {
    const { first, second, mirrored, snapshot } = await linked();
    await seed(second.project, 'different target base\n');
    await writeFile(join(second.project, 'mixed.txt'), 'target dirty\n');
    const targetIndex = await workspaceGit(second.project, ['ls-files', '--stage', '-z']);
    const createdBefore = second.adapter.created;
    const restored = await second.rpc.request('sync.workspaceRestore', {
      sessionId: mirrored.id,
      snapshot,
    });
    expect(second.adapter.created).toBe(createdBefore);
    expect(await readFile(join(second.project, 'mixed.txt'), 'utf8')).toBe('target dirty\n');
    expect(await workspaceGit(second.project, ['ls-files', '--stage', '-z'])).toEqual(targetIndex);
    await expect(
      workspaceGit(second.project, ['cat-file', '-e', `${restored.sourceHead}^{commit}`]),
    ).rejects.toBeDefined();
    expect((await workspaceGit(restored.cwd, ['show', ':mixed.txt'])).toString()).toBe('index\n');
    expect(await readFile(join(restored.cwd, 'mixed.txt'), 'utf8')).toBe('worktree\n');
    expect(await readFile(join(restored.cwd, 'binary.bin'))).toEqual(Buffer.alloc(192 * 1024, 137));
    await expect(readFile(join(restored.cwd, 'omitted.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const continuation = (
      await second.rpc.request('session.createFromHistory', {
        sessionId: mirrored.id,
        providerId: 'synthetic-api',
        workspaceSnapshot: snapshot,
        workspaceRestoreId: restored.restoreId,
        handoff: { constraints: ['Keep the index and worktree separate.'] },
      })
    ).session;
    expect(continuation.cwd).toBe(restored.cwd);
    expect(continuation.origin).toMatchObject({
      kind: 'history',
      sessionId: mirrored.id,
      via: 'handoff',
      syncContinuation: {
        vaultId: snapshot.vaultId,
        runId: snapshot.source.sessionId,
        source: snapshot.source,
      },
      workspaceSnapshot: { opId: snapshot.opId, sourceHead: restored.sourceHead },
    });
    await second.rpc.request('session.send', {
      sessionId: continuation.id,
      content: [{ type: 'text', text: 'Continue using the restored workspace.' }],
    });
    await expect
      .poll(
        async () =>
          (await second.rpc.request('session.list', {})).sessions.find(
            (session: { id: string }) => session.id === continuation.id,
          )?.state,
      )
      .toBe('idle');
    const continued = (await second.rpc.request('session.get', { sessionId: continuation.id }))
      .session;
    expect(continued.syncExecution.runId).toBe(snapshot.source.sessionId);
    expect(continued.syncExecution.streamId).not.toBe(snapshot.source.streamId);
    const { subscriptionId } = await second.rpc.request('events.subscribe', {
      sessionId: continuation.id,
      sinceSeq: 0,
    });
    await second.rpc.untilTrue(
      () =>
        second.rpc
          .events(subscriptionId)
          .some(
            (event) =>
              event.type === 'session.execution' &&
              event.payload.branchRequired === true &&
              event.payload.runId === snapshot.source.sessionId,
          ),
      'workspace handoff retains the independent execution branch',
    );
    expect(JSON.stringify(second.adapter.inputs)).toContain(
      'Keep the index and worktree separate.',
    );
    expect(JSON.stringify(second.adapter.inputs)).toContain('Workspace handoff:');
    expect(await readFile(join(first.project, 'mixed.txt'), 'utf8')).toBe('worktree\n');
  }, 30000);

  it('reopens a ready restore safely, preserves later local edits and refuses symlinks', async () => {
    const { second, mirrored, snapshot } = await linked();
    const restored: MethodResult<'sync.workspaceRestore'> = await second.rpc.request(
      'sync.workspaceRestore',
      { sessionId: mirrored.id, snapshot },
    );
    await second.restart();
    expect(
      await second.rpc.request('sync.workspaceRestore', {
        sessionId: mirrored.id,
        snapshot,
        restoreId: restored.restoreId,
      }),
    ).toEqual(restored);
    await writeFile(join(restored.cwd, 'mixed.txt'), 'local edits after restore\n');
    expect(
      await second.rpc.request('sync.workspaceRestore', {
        sessionId: mirrored.id,
        snapshot,
        restoreId: restored.restoreId,
      }),
    ).toMatchObject({ cwd: restored.cwd, modified: true });
    expect(await readFile(join(restored.cwd, 'mixed.txt'), 'utf8')).toBe(
      'local edits after restore\n',
    );
    await rm(join(restored.cwd, 'mixed.txt'));
    await symlink(join(second.project, 'outside'), join(restored.cwd, 'mixed.txt'));
    expect(
      (
        await second.rpc.call('sync.workspaceRestore', {
          sessionId: mirrored.id,
          snapshot,
          restoreId: restored.restoreId,
        })
      ).error,
    ).toMatchObject({ data: { code: 'INTEGRITY_FAILED' } });
  }, 30000);

  it('retries an interrupted restore in a new directory and preserves the previous attempt', async () => {
    const { second, mirrored, snapshot } = await linked();
    const restored = await second.rpc.request('sync.workspaceRestore', {
      sessionId: mirrored.id,
      snapshot,
    });
    const journalPath = join(second.home, 'sync/workspaces/jobs', `${restored.restoreId}.json`);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.state = 'building';
    await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(join(restored.cwd, 'interrupted-user-edit.txt'), 'keep this edit');
    await second.restart();
    const next = await second.rpc.request('sync.workspaceRestore', {
      sessionId: mirrored.id,
      snapshot,
      restoreId: restored.restoreId,
    });
    expect(next.cwd).not.toBe(restored.cwd);
    expect(await readFile(join(restored.cwd, 'interrupted-user-edit.txt'), 'utf8')).toBe(
      'keep this edit',
    );
    expect(await readFile(join(next.cwd, 'mixed.txt'), 'utf8')).toBe('worktree\n');
  }, 30000);
});
