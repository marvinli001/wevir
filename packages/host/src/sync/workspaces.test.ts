import { lstat, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SyncBundleContentSchema } from '@wevir/protocol';
import { jcs, type SyncOperation } from '@wevir/protocol/sync';
import type { SyncVaultRecord } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { useStorages, useTempDir } from '../test-utils.js';
import type { BundleFile } from './bundle-snapshot.js';
import { sha256 } from './crypto.js';
import { type SyncDraftPayload, SyncQueue } from './queue.js';
import { workspaceGit, workspaceTreeFingerprint } from './workspace-git.js';
import { SyncWorkspaces } from './workspaces.js';

const race = vi.hoisted(() => ({ beforeTrees: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]).endsWith(join('sync', 'workspaces', 'trees')) && race.beforeTrees) {
        const build = race.beforeTrees;
        race.beforeTrees = undefined;
        await build();
      }
      return fs.readdir(...args);
    },
  };
});

const temp = useTempDir(),
  stores = useStorages();
async function fixture() {
  const home = join(temp(), 'home'),
    root = join(temp(), 'repo');
  await mkdir(root);
  await workspaceGit(root, ['init', '--template=', '--initial-branch=main']);
  await writeFile(join(root, 'selected.txt'), 'Synthetic workspace');
  const storage = stores.open(home);
  storage.workspaces.insert(workspace({ id: 'ws_workspace', rootPath: root }));
  storage.sessions.insert(session({ id: 'ses_workspace', workspaceId: 'ws_workspace', cwd: root }));
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_fixture',
      accountId: 'account_fixture',
      deviceId: 'device_fixture',
      originHostId: 'host_fixture',
      appliedCursor: '',
    });
    storage.sync.bindProject('vault_fixture', 'project_fixture', 'ws_workspace');
    storage.sync.setScopes('vault_fixture', {
      revision: '1',
      enabled: true,
      categories: ['artifact', 'workspace-snapshot'],
      projectIds: ['project_fixture'],
    });
    storage.sync.putSource({
      vaultId: 'vault_fixture',
      hostId: 'host_fixture',
      deviceId: 'device_fixture',
      sessionId: 'ses_workspace',
      localSessionId: 'ses_workspace',
      streamId: 'stream_fixture',
      mirrored: false,
    });
  });
  const vault = storage.sync.activeVault() as SyncVaultRecord;
  const source = () => ({
    hostId: vault.originHostId,
    deviceId: vault.deviceId,
    sessionId: 'ses_workspace',
    streamId: 'stream_fixture',
  });
  return { home, storage, vault, source };
}

describe('workspace identity fences', () => {
  it.each(['outbox', 'inbox'] as const)(
    'keeps a prepared local snapshot readable only from the %s',
    async (direction) => {
      const data = await fixture();
      const service = new SyncWorkspaces({
        ...data,
        eligible: () => data.storage.sync.activeVault(),
      });
      const { snapshot } = await service.capture({
        sessionId: 'ses_workspace',
        untracked: ['selected.txt'],
      });
      const draft = data.storage.sync.draft(data.vault.vaultId, snapshot.opId);
      if (!draft) throw new Error('missing captured synthetic snapshot');
      const operation: SyncOperation = {
        protocol: 'wevir-sync/1',
        vaultId: data.vault.vaultId,
        opId: draft.opId,
        entityId: draft.entityId,
        entityType: 'workspace-snapshot',
        kind: 'put',
        parents: draft.parents,
        deviceId: data.vault.deviceId,
        deviceSeq: '1',
        payload: { blobId: 'blob_synthetic', recordIndex: 0 },
        clientTime: draft.createdAt,
      };
      const manifest = {
        opId: draft.opId,
        blobId: 'blob_synthetic',
        recordIndex: 0,
        projectId: 'project_fixture',
      };
      data.storage.transaction(() => {
        data.storage.sync.putOperation({
          ...operation,
          projectId: 'project_fixture',
          envelope: operation,
          manifest,
          digest: sha256(jcs({ operation, recordManifest: manifest })),
          record: {
            opId: draft.opId,
            entityId: draft.entityId,
            kind: draft.kind,
            parents: draft.parents,
            projectId: 'project_fixture',
            content: (draft.content as SyncDraftPayload).body,
          },
          direction,
          state: 'queued',
        });
        data.storage.sync.removeDraft(data.vault.vaultId, draft.opId);
      });
      const restoring = service.restore({ sessionId: 'ses_workspace', snapshot });
      if (direction === 'outbox') await expect(restoring).resolves.toHaveProperty('cwd');
      else await expect(restoring).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    },
  );
  it('keeps a tree created after collecting the restore job list', async () => {
    const h = await fixture();
    const trees = join(h.home, 'sync/workspaces/trees');
    await mkdir(trees, { recursive: true });
    const tree = join(trees, 'restore_concurrent');
    race.beforeTrees = async () => {
      await mkdir(tree);
      const future = new Date(Date.now() + 1000);
      await utimes(tree, future, future);
    };
    await new SyncWorkspaces({ ...h, eligible: () => h.storage.sync.activeVault() }).collect();
    expect((await lstat(tree)).isDirectory()).toBe(true);
  });

  it('retains a restore while an installation is using it', async () => {
    const data = await fixture();
    let installing = true;
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
      inUse: () => installing,
    });
    const { snapshot } = await service.capture({
      sessionId: 'ses_workspace',
      untracked: ['selected.txt'],
    });
    const restored = await service.restore({ sessionId: 'ses_workspace', snapshot });
    expect(await service.discard(restored.restoreId)).toEqual({ discarded: false });
    installing = false;
    expect(await service.discard(restored.restoreId)).toEqual({ discarded: true });
  });
  it('reuses an unclaimed restore and discards it explicitly', async () => {
    const data = await fixture();
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    const { snapshot } = await service.capture({
      sessionId: 'ses_workspace',
      untracked: ['selected.txt'],
    });
    const first = await service.restore({ sessionId: 'ses_workspace', snapshot });
    const second = await service.restore({ sessionId: 'ses_workspace', snapshot });
    expect(second.restoreId).toBe(first.restoreId);
    await service.discard(first.restoreId);
    await expect(readFile(join(first.cwd, 'selected.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('counts identical Git layers once and reuses their chunks', async () => {
    const data = await fixture();
    const root = join(temp(), 'repo');
    await writeFile(join(root, 'selected.txt'), Buffer.alloc(24 * 1024 * 1024, 71));
    await workspaceGit(root, ['add', 'selected.txt']);
    await workspaceGit(root, [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Synthetic base',
    ]);
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    const { snapshot } = await service.capture({ sessionId: 'ses_workspace' });
    const body = SyncBundleContentSchema.parse(
      (
        data.storage.sync.draft(data.vault.vaultId, snapshot.opId)?.content as
          | SyncDraftPayload
          | undefined
      )?.body,
    );
    expect(new Set(body.files.flatMap((file) => file.parts.map((part) => part.opId))).size).toBe(
      384,
    );
    expect(snapshot.bytes).toBe(24 * 1024 * 1024);
    expect(service.read(snapshot).files).toHaveLength(3);
  }, 30000);
  it('reopens a restore with hundreds of agent paths without a large journal', async () => {
    const data = await fixture();
    const root = join(temp(), 'repo');
    await mkdir(join(root, '.claude/rules'), { recursive: true });
    const paths = Array.from(
      { length: 400 },
      (_, i) => `.claude/rules/${i}-${'long-name-'.repeat(6)}.md`,
    );
    for (const path of paths) await writeFile(join(root, path), 'Synthetic rule');
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    const { snapshot } = await service.capture({ sessionId: 'ses_workspace', untracked: paths });
    const restored = await service.restore({ sessionId: 'ses_workspace', snapshot });
    expect(restored.requiresTrust).toHaveLength(400);
    await expect(service.restoredRoot('ws_workspace', restored.restoreId)).resolves.toBe(
      restored.cwd,
    );
  }, 30000);

  it('reopens after dependency installation and reports local modifications', async () => {
    const data = await fixture();
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    const { snapshot } = await service.capture({
      sessionId: 'ses_workspace',
      untracked: ['selected.txt'],
    });
    const restored = await service.restore({ sessionId: 'ses_workspace', snapshot });
    await mkdir(join(restored.cwd, 'vendor/bin'), { recursive: true });
    await symlink('../../selected.txt', join(restored.cwd, 'vendor/bin/tool'));
    await expect(service.restoredRoot('ws_workspace', restored.restoreId)).resolves.toBe(
      restored.cwd,
    );
    const reopened = await service.restore({
      sessionId: 'ses_workspace',
      snapshot,
      restoreId: restored.restoreId,
    });
    expect(reopened.modified).toBe(true);
  });
  it.each(['deviceId', 'originHostId'] as const)(
    'rejects a late capture after %s changes within the same vault and revision',
    async (field) => {
      const fixtureData = await fixture();
      let reads = 0;
      const service = new SyncWorkspaces({
        ...fixtureData,
        eligible: () =>
          ++reads >= 5
            ? { ...fixtureData.vault, [field]: 'replacement_fixture' }
            : fixtureData.vault,
      });
      await expect(
        service.capture({ sessionId: 'ses_workspace', untracked: ['selected.txt'] }),
      ).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
      expect(fixtureData.storage.sync.drafts(fixtureData.vault.vaultId)).toEqual([]);
    },
  );

  it('fences a ready restore and its dependency setup after a local device rebind', async () => {
    const fixtureData = await fixture();
    const service = new SyncWorkspaces({
      ...fixtureData,
      eligible: () => fixtureData.storage.sync.activeVault(),
    });
    const { snapshot } = await service.capture({
      sessionId: 'ses_workspace',
      untracked: ['selected.txt'],
    });
    const restored = await service.restore({ sessionId: 'ses_workspace', snapshot });
    fixtureData.storage.db
      .prepare('UPDATE sync_vaults SET device_id = ?, origin_host_id = ? WHERE vault_id = ?')
      .run('replacement_device', 'replacement_host', fixtureData.vault.vaultId);
    await expect(
      service.restore({ sessionId: 'ses_workspace', snapshot, restoreId: restored.restoreId }),
    ).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    await expect(service.restoredRoot('ws_workspace', restored.restoreId)).rejects.toMatchObject({
      code: 'SCOPE_DISABLED',
    });
  });
});

function archivedWorkspace() {
  const files: BundleFile[] = [
    ['base/mixed.txt', Buffer.from('base\n')],
    ['index/mixed.txt', Buffer.from('staged\n')],
    ['worktree/mixed.txt', Buffer.from('working\n')],
    ['worktree/untracked.bin', Buffer.alloc(192 * 1024, 219)],
  ].map(([path, bytes]) => ({
    path: path as string,
    bytes: bytes as Buffer,
    sha256: sha256(bytes as Buffer),
    executable: false,
  }));
  const source = {
    hostId: 'archived_host',
    deviceId: 'archived_device',
    sessionId: 'ses_archived',
    streamId: 'archived_stream',
  };
  return {
    vaultId: 'vault_fixture',
    opId: 'archived_operation',
    deviceId: source.deviceId,
    sourceVerified: true,
    files,
    body: SyncBundleContentSchema.parse({
      schema: 'wevir-bundle/1',
      category: 'workspace-snapshot',
      name: 'Archived workspace',
      exclusions: ['.env'],
      files: files.map((file) => ({
        path: file.path,
        bytes: file.bytes.length,
        sha256: file.sha256,
        executable: file.executable,
        parts: [{ entityId: 'archived_chunk', opId: 'archived_chunk_operation' }],
      })),
      metadata: {
        schema: 'wevir-workspace-snapshot/1',
        projectId: 'project_fixture',
        source,
        throughSeq: 20,
        sourceHead: 'a'.repeat(40),
        base: 'bounded-tree',
        statusHash: 'A'.repeat(43),
        selectedUntracked: ['untracked.bin'],
        ruleVersions: [],
        capturedAt: '2026-11-12T00:00:00.000Z',
      },
    }),
  };
}

describe('restoring archived workspace versions as derived material', () => {
  it('omits unverified claimed device provenance from the derived workspace', async () => {
    const data = await fixture(),
      archived = archivedWorkspace();
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    const { snapshot } = service.restoreVersion(
      { sessionId: 'ses_workspace', expectedLocalSeq: 0 },
      { ...archived, sourceVerified: false },
    );
    const body = SyncBundleContentSchema.parse(
      (
        data.storage.sync.draft(data.vault.vaultId, snapshot.opId)?.content as
          | SyncDraftPayload
          | undefined
      )?.body,
    );
    expect(body.recoveredFrom).toBeUndefined();
  });
  it('derives fresh chunks for a mapped synced history and only writes Git on explicit isolated restore', async () => {
    const data = await fixture(),
      archived = archivedWorkspace();
    const source = (
      archived.body.metadata as {
        source: { hostId: string; deviceId: string; sessionId: string; streamId: string };
      }
    ).source;
    data.storage.sessions.insert(
      session({
        id: 'ses_synced',
        engine: 'sync',
        engineSessionId: 'synthetic_synced_history',
        workspaceId: 'ws_workspace',
        cwd: join(temp(), 'repo'),
        state: 'closed',
        lastSeq: 5,
        origin: {
          kind: 'synced',
          vaultId: data.vault.vaultId,
          hostId: source.hostId,
          sessionId: source.sessionId,
          streamId: source.streamId,
        },
      }),
    );
    data.storage.sync.putSource({
      ...source,
      vaultId: data.vault.vaultId,
      localSessionId: 'ses_synced',
      mirrored: true,
    });
    const ruleOp = data.storage.transaction(() =>
      new SyncQueue(data.storage).enqueue({
        vaultId: data.vault.vaultId,
        entityId: 'restored_rule',
        entityType: 'rule',
        projectId: 'project_fixture',
        localKey: 'archived-rule:restored_rule',
        content: {
          schema: 'wevir-bundle/1',
          category: 'rule',
          name: 'Archived rule',
          files: [],
          exclusions: [],
        },
      }),
    );
    archived.body.metadata = {
      ...(archived.body.metadata as object),
      ruleVersions: [{ entityId: 'restored_rule', opId: ruleOp as string }],
    };
    const original = structuredClone(archived.body),
      sourcesBefore = data.storage.sync.sources(data.vault.vaultId);
    const targetBefore = await workspaceTreeFingerprint(join(temp(), 'repo'));
    const service = new SyncWorkspaces({
      ...data,
      source: () => {
        throw new Error('must not capture a native execution source');
      },
      eligible: () => data.storage.sync.activeVault(),
    });
    const { snapshot } = service.restoreVersion(
      { sessionId: 'ses_synced', expectedLocalSeq: 5 },
      archived,
    );
    expect(snapshot).toMatchObject({
      vaultId: data.vault.vaultId,
      projectId: 'project_fixture',
      source: {
        hostId: data.vault.originHostId,
        deviceId: data.vault.deviceId,
        sessionId: 'ses_synced',
      },
    });
    expect(snapshot.source.streamId).not.toBe(source.streamId);
    expect(snapshot.opId).not.toBe(archived.opId);
    const body = SyncBundleContentSchema.parse(
      (
        data.storage.sync.draft(data.vault.vaultId, snapshot.opId)?.content as
          | SyncDraftPayload
          | undefined
      )?.body,
    );
    expect(body.recoveredFrom).toEqual({
      vaultId: archived.vaultId,
      deviceId: archived.deviceId,
      opId: archived.opId,
      source,
    });
    expect(body.files.find((file) => file.path.endsWith('untracked.bin'))?.parts).toHaveLength(3);
    expect(
      body.files
        .flatMap((file) => file.parts)
        .every(
          (part) => part.entityId !== 'archived_chunk' && part.opId !== 'archived_chunk_operation',
        ),
    ).toBe(true);
    expect(service.read(snapshot).files).toEqual(archived.files);
    expect(service.list('ses_synced').snapshots.map((value) => value.opId)).toContain(
      snapshot.opId,
    );
    expect(data.storage.sync.sources(data.vault.vaultId)).toEqual(sourcesBefore);
    expect(data.storage.sessions.get('ses_synced')).toMatchObject({ state: 'closed', lastSeq: 5 });
    expect(archived.body).toEqual(original);
    expect(await workspaceTreeFingerprint(join(temp(), 'repo'))).toBe(targetBefore);
    data.storage.db
      .prepare('UPDATE sync_vaults SET device_id = ?, origin_host_id = ? WHERE vault_id = ?')
      .run('receiving_device', 'receiving_host', data.vault.vaultId);
    expect(service.list('ses_synced').snapshots.map((value) => value.opId)).toContain(
      snapshot.opId,
    );
    const restored = await service.restore({ sessionId: 'ses_synced', snapshot });
    expect((await workspaceGit(restored.cwd, ['show', ':mixed.txt'])).toString()).toBe('staged\n');
    expect((await workspaceGit(restored.cwd, ['show', 'HEAD:mixed.txt'])).toString()).toBe(
      'base\n',
    );
    expect(await readFile(join(restored.cwd, 'mixed.txt'), 'utf8')).toBe('working\n');
    expect(await readFile(join(restored.cwd, 'untracked.bin'))).toEqual(archived.files[3]?.bytes);
    expect(restored.recoveredFrom).toEqual({
      deviceId: archived.deviceId,
      opId: archived.opId,
      source,
    });
  });

  it('rolls back with its caller transaction and rejects stale cursors, cross-vault and mismatched decoded files', async () => {
    const data = await fixture(),
      archived = archivedWorkspace();
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    expect(() =>
      service.restoreVersion({ sessionId: 'ses_workspace', expectedLocalSeq: 1 }, archived),
    ).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(() =>
      service.restoreVersion(
        { sessionId: 'ses_workspace', expectedLocalSeq: 0 },
        { ...archived, vaultId: 'another_vault' },
      ),
    ).toThrow(expect.objectContaining({ code: 'SCOPE_DISABLED' }));
    expect(() =>
      service.restoreVersion(
        { sessionId: 'ses_workspace', expectedLocalSeq: 0 },
        { ...archived, files: archived.files.slice(1) },
      ),
    ).toThrow(expect.objectContaining({ code: 'INTEGRITY_FAILED' }));
    expect(() =>
      data.storage.transaction(() => {
        service.restoreVersion({ sessionId: 'ses_workspace', expectedLocalSeq: 0 }, archived);
        throw new Error('synthetic caller rollback');
      }),
    ).toThrow('synthetic caller rollback');
    expect(data.storage.sync.drafts(data.vault.vaultId)).toEqual([]);
    expect(data.storage.sync.entities(data.vault.vaultId)).toEqual([]);
  });

  it('fences identity changes during chunk creation and rejects rule references from another project', async () => {
    const data = await fixture(),
      archived = archivedWorkspace();
    let reads = 0;
    const service = new SyncWorkspaces({
      ...data,
      eligible: () =>
        ++reads >= 5 ? { ...data.vault, deviceId: 'replacement_device' } : data.vault,
    });
    expect(() =>
      service.restoreVersion({ sessionId: 'ses_workspace', expectedLocalSeq: 0 }, archived),
    ).toThrow(expect.objectContaining({ code: 'SCOPE_DISABLED' }));
    expect(data.storage.sync.drafts(data.vault.vaultId)).toEqual([]);
    const opId = data.storage.transaction(() =>
      new SyncQueue(data.storage).enqueue({
        vaultId: data.vault.vaultId,
        entityId: 'foreign_rule',
        entityType: 'rule',
        projectId: 'another_project',
        localKey: 'archived-rule:foreign_rule',
        content: {},
      }),
    );
    archived.body.metadata = {
      ...(archived.body.metadata as object),
      ruleVersions: [{ entityId: 'foreign_rule', opId: opId as string }],
    };
    const stable = new SyncWorkspaces({ ...data, eligible: () => data.storage.sync.activeVault() });
    expect(() =>
      stable.restoreVersion({ sessionId: 'ses_workspace', expectedLocalSeq: 0 }, archived),
    ).toThrow(expect.objectContaining({ code: 'INTEGRITY_FAILED' }));
  });

  it('enqueues remapped rule references with the new workspace in one transaction', async () => {
    const data = await fixture(),
      archived = archivedWorkspace();
    data.storage.sync.setScopes(data.vault.vaultId, {
      revision: '2',
      enabled: true,
      categories: ['artifact', 'workspace-snapshot', 'rule'],
      projectIds: ['project_fixture'],
    });
    const ref = { entityId: 'cloned_rule', opId: 'cloned_rule_operation' };
    archived.body.metadata = { ...(archived.body.metadata as object), ruleVersions: [ref] };
    const service = new SyncWorkspaces({
      ...data,
      eligible: () => data.storage.sync.activeVault(),
    });
    const enqueue = () => {
      expect(data.storage.db.isTransaction).toBe(true);
      new SyncQueue(data.storage).enqueue({
        ...ref,
        vaultId: data.vault.vaultId,
        entityType: 'rule',
        projectId: 'project_fixture',
        localKey: 'archived-rule:cloned_rule',
        content: {
          schema: 'wevir-bundle/1',
          category: 'rule',
          name: 'Cloned rule',
          files: [],
          exclusions: [],
        },
      });
    };
    expect(() =>
      service.restoreVersion(
        { sessionId: 'ses_workspace', expectedLocalSeq: 0 },
        {
          ...archived,
          enqueueReferences: () => {
            enqueue();
            throw new Error('synthetic reference failure');
          },
        },
      ),
    ).toThrow('synthetic reference failure');
    expect(data.storage.sync.drafts(data.vault.vaultId)).toEqual([]);
    expect(data.storage.sync.entities(data.vault.vaultId)).toEqual([]);
    const { snapshot } = service.restoreVersion(
      { sessionId: 'ses_workspace', expectedLocalSeq: 0 },
      { ...archived, enqueueReferences: enqueue },
    );
    expect(service.read(snapshot).metadata.ruleVersions).toEqual([ref]);
    expect(data.storage.sync.draft(data.vault.vaultId, ref.opId)?.entityId).toBe(ref.entityId);
  });
});
