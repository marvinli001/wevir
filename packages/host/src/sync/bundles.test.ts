import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncVaultRecord } from '@wevir/storage';
import { openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { SyncBundles } from './bundles.js';
import { sha256 } from './crypto.js';
import { type SyncBundleRoot, SyncFilesCapture } from './files-capture.js';

const fault = vi.hoisted(() => ({ abort: undefined as AbortController | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      if (fault.abort && from.includes('.wevir-sync-') && !to.includes('.wevir-sync-')) {
        const abort = fault.abort;
        fault.abort = undefined;
        abort.abort();
      }
    },
  };
});
const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  fault.abort = undefined;
  for (const close of cleanups.splice(0).reverse()) close();
});
async function fixture(projectId?: string) {
  const base = tempDir(),
    home = join(base, 'host'),
    userHome = join(base, 'user');
  const native = join(userHome, '.agents/skills/synthetic');
  await mkdir(native, { recursive: true });
  await writeFile(join(native, 'SKILL.md'), 'Initial synthetic instructions');
  await writeFile(join(native, 'binary.bin'), Buffer.from([0, 255, 17]));
  let storage = openStorage({ dataDir: home });
  cleanups.push(() => storage.close());
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_test',
      accountId: 'account_test',
      deviceId: 'device_test',
      originHostId: 'device_test',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes('vault_test', {
      enabled: true,
      revision: '1',
      categories: ['skill-bundle', 'artifact'],
      projectIds: projectId ? [projectId] : [],
    });
    if (projectId) {
      storage.workspaces.insert({
        id: 'ws_synthetic',
        rootPath: userHome,
        displayName: 'Synthetic',
        createdAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      });
      storage.sync.bindProject('vault_test', projectId, 'ws_synthetic');
    }
  });
  let signedIn = true;
  const eligible = () =>
    signedIn && storage.sync.activeVault()?.enabled ? storage.sync.activeVault() : undefined;
  const root: SyncBundleRoot = {
    category: 'skill-bundle',
    localKey: `skill:${join(native, 'SKILL.md')}`,
    path: native,
    name: 'synthetic',
    metadata: { source: 'agents', enabled: false },
    ...(projectId && { projectId }),
  };
  const nativeRoots = vi.fn(async () => [root]);
  const service = () => {
    const files = new SyncFilesCapture({ storage, memoryDir: join(home, 'memory'), eligible });
    return new SyncBundles({ storage, home, userHome, files, eligible, nativeRoots });
  };
  await service().options.files.bundle(
    storage.sync.activeVault() as SyncVaultRecord,
    root,
    true,
    true,
  );
  const entity = storage.sync.localEntity('vault_test', root.localKey);
  if (!entity) throw new Error('missing synthetic bundle');
  const ref = { vaultId: entity.vaultId, entityId: entity.entityId };
  const bind = async () => {
    const preview = await service().preview(ref.vaultId, ref.entityId);
    const target = (await service().targets(ref.vaultId, ref.entityId)).targets.find(
      (target) => !target.managed,
    );
    if (!target) throw new Error('missing native target');
    await service().apply(
      {
        ...ref,
        expectedHeads: preview.heads,
        selectedOpId: preview.heads[0] as string,
        targetId: target.targetId,
        fingerprint: target.fingerprint,
      },
      new AbortController().signal,
    );
  };
  const edit = async (text: string, abort = new AbortController()) => {
    const file = await service().file({ ...ref, path: 'SKILL.md' });
    return service().edit(
      {
        ...ref,
        path: 'SKILL.md',
        text,
        fingerprint: file.fingerprint as string,
        localRevision: file.localRevision,
      },
      abort.signal,
    );
  };
  return {
    ref,
    root,
    native,
    home,
    userHome,
    service,
    bind,
    edit,
    nativeRoots,
    get storage() {
      return storage;
    },
    signOut() {
      signedIn = false;
    },
    reopen() {
      storage.close();
      storage = openStorage({ dataDir: home });
    },
  };
}

describe('local bundle choices and authority', () => {
  it('keeps complete cached versions readable after sign-out without inspecting native roots', async () => {
    const h = await fixture();
    await h.bind();
    const { opId } = await h.edit('Edited synthetic instructions');
    h.signOut();
    h.nativeRoots.mockClear();
    const versions = h.service().versions(h.ref.vaultId, h.ref.entityId).versions;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect((await h.service().file({ ...h.ref, opId, path: 'SKILL.md' })).text).toBe(
      'Edited synthetic instructions',
    );
    expect((await h.service().file({ ...h.ref, opId, path: 'binary.bin' })).sha256).toBe(
      sha256(Buffer.from([0, 255, 17])),
    );
    await h.service().preview(h.ref.vaultId, h.ref.entityId);
    await expect(h.service().targets(h.ref.vaultId, h.ref.entityId)).rejects.toMatchObject({
      code: 'SCOPE_DISABLED',
    });
    expect(h.nativeRoots).not.toHaveBeenCalled();
  });
  it('rebinds to a separate copy with CAS while preserving the old directory', async () => {
    const h = await fixture();
    await h.bind();
    const before = await h.service().preview(h.ref.vaultId, h.ref.entityId);
    const copy = (await h.service().targets(h.ref.vaultId, h.ref.entityId)).targets.find(
      (target) => target.managed,
    );
    if (!copy) throw new Error('missing separate target');
    const input = {
      ...h.ref,
      expectedHeads: before.heads,
      selectedOpId: before.heads[0] as string,
      targetId: copy.targetId,
      fingerprint: copy.fingerprint,
      localRevision: before.binding?.revision,
    };
    await expect(h.service().apply(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await h
      .service()
      .apply(
        { ...input, expectedTargetId: before.binding?.targetId },
        new AbortController().signal,
      );
    expect(await readFile(join(h.native, 'SKILL.md'), 'utf8')).toBe(
      'Initial synthetic instructions',
    );
    await h.edit('Separate editable copy');
    expect(await readFile(join(copy.path, 'SKILL.md'), 'utf8')).toBe('Separate editable copy');
    expect(await readFile(join(h.native, 'SKILL.md'), 'utf8')).toBe(
      'Initial synthetic instructions',
    );
    expect(h.storage.sync.bundleSource(h.ref.vaultId, h.root.localKey)).toBeUndefined();
    await expect(
      h
        .service()
        .apply(
          { ...input, expectedTargetId: before.binding?.targetId },
          new AbortController().signal,
        ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('resumes an interrupted promotion only after scope reauthorization and rejects a different account', async () => {
    const h = await fixture();
    await h.bind();
    const abort = new AbortController();
    fault.abort = abort;
    await expect(h.edit('Interrupted synthetic update', abort)).rejects.toThrow();
    const pending = h.storage.sync.pendingBundleApplication(h.ref.vaultId, h.ref.entityId);
    if (!pending) throw new Error('missing durable application');
    h.reopen();
    h.storage.sync.setScopes(h.ref.vaultId, {
      enabled: false,
      revision: '2',
      categories: ['skill-bundle', 'artifact'],
      projectIds: [],
    });
    await expect(
      h.service().retry(h.ref.vaultId, h.ref.entityId, pending.opId, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    h.storage.sync.setScopes(h.ref.vaultId, {
      enabled: true,
      revision: '3',
      categories: ['skill-bundle', 'artifact'],
      projectIds: [],
    });
    await h.service().recover(h.storage.sync.activeVault() as SyncVaultRecord);
    expect(h.storage.sync.pendingBundleApplication(h.ref.vaultId, h.ref.entityId)?.state).toBe(
      'conflict',
    );
    await h
      .service()
      .retry(h.ref.vaultId, h.ref.entityId, pending.opId, new AbortController().signal);
    expect(await readFile(join(h.native, 'SKILL.md'), 'utf8')).toBe('Interrupted synthetic update');
    expect(h.storage.sync.pendingBundleApplication(h.ref.vaultId, h.ref.entityId)).toBeUndefined();
    h.storage.transaction(() => {
      h.storage.sync.detachVault(h.ref.vaultId);
      h.storage.sync.bindVault({
        vaultId: 'vault_other',
        accountId: 'account_other',
        deviceId: 'device_other',
        originHostId: 'device_other',
        appliedCursor: 'initial',
      });
    });
    await expect(h.service().file({ ...h.ref, path: 'SKILL.md' })).rejects.toMatchObject({
      code: 'SCOPE_DISABLED',
    });
    expect((await h.service().file({ ...h.ref, opId: pending.opId, path: 'SKILL.md' })).text).toBe(
      'Interrupted synthetic update',
    );
  });
  it('keeps current files explicitly after an interruption and preserves the abandoned intended version', async () => {
    const h = await fixture();
    await h.bind();
    const abort = new AbortController();
    fault.abort = abort;
    await expect(h.edit('Intended interrupted version', abort)).rejects.toThrow();
    const pending = h.storage.sync.pendingBundleApplication(h.ref.vaultId, h.ref.entityId);
    if (!pending) throw new Error('missing durable application');
    await writeFile(join(h.native, 'SKILL.md'), 'Local correction after interruption');
    const preview = await h.service().preview(h.ref.vaultId, h.ref.entityId);
    const target = (await h.service().targets(h.ref.vaultId, h.ref.entityId)).targets.find(
      (target) => target.targetId === preview.binding?.targetId,
    );
    if (!target) throw new Error('missing current target');
    const result = await h.service().keepLocal(
      {
        ...h.ref,
        expectedHeads: preview.heads,
        targetId: target.targetId,
        fingerprint: target.fingerprint,
        localRevision: preview.binding?.revision,
      },
      new AbortController().signal,
    );
    expect(h.storage.sync.pendingBundleApplication(h.ref.vaultId, h.ref.entityId)).toBeUndefined();
    expect(h.storage.sync.bundleApplication(h.ref.vaultId, pending.opId)?.state).toBe('abandoned');
    expect((await h.service().file({ ...h.ref, opId: result.opId, path: 'SKILL.md' })).text).toBe(
      'Local correction after interruption',
    );
    expect((await h.service().file({ ...h.ref, opId: pending.opId, path: 'SKILL.md' })).text).toBe(
      'Intended interrupted version',
    );
  });
  it('rejects an old target after its project directory is remapped', async () => {
    const h = await fixture('project_synthetic');
    await h.bind();
    const before = await h.service().preview(h.ref.vaultId, h.ref.entityId);
    const other = join(h.userHome, 'another-project');
    await mkdir(other);
    h.storage.workspaces.insert({
      id: 'ws_other',
      rootPath: other,
      displayName: 'Other synthetic',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    });
    h.storage.transaction(() =>
      h.storage.sync.bindProject(h.ref.vaultId, 'project_synthetic', 'ws_other'),
    );
    await expect(h.service().file({ ...h.ref, path: 'SKILL.md' })).rejects.toMatchObject({
      code: 'SCOPE_DISABLED',
    });
    expect(
      (await h.service().file({ ...h.ref, opId: before.heads[0], path: 'SKILL.md' })).text,
    ).toBe('Initial synthetic instructions');
    const roots = [];
    for await (const root of h.service().roots(h.storage.sync.activeVault() as SyncVaultRecord))
      roots.push(root);
    expect(roots).toEqual([]);
    const copy = (await h.service().targets(h.ref.vaultId, h.ref.entityId)).targets.find(
      (target) => target.managed,
    );
    if (!copy) throw new Error('missing new authorized target');
    await h.service().apply(
      {
        ...h.ref,
        expectedHeads: before.heads,
        selectedOpId: before.heads[0] as string,
        targetId: copy.targetId,
        fingerprint: copy.fingerprint,
        localRevision: before.binding?.revision,
        expectedTargetId: before.binding?.targetId,
      },
      new AbortController().signal,
    );
    expect(await readFile(join(h.native, 'SKILL.md'), 'utf8')).toBe(
      'Initial synthetic instructions',
    );
  });
  it('captures a native deletion with its last applied revision and retains the prior cached files', async () => {
    const h = await fixture();
    await h.bind();
    const before = await h.service().preview(h.ref.vaultId, h.ref.entityId);
    await rm(h.native, { recursive: true });
    h.nativeRoots.mockResolvedValue([]);
    const roots = [];
    for await (const root of h.service().roots(h.storage.sync.activeVault() as SyncVaultRecord))
      roots.push(root);
    expect(roots).toHaveLength(1);
    await h
      .service()
      .options.files.bundle(
        h.storage.sync.activeVault() as SyncVaultRecord,
        roots[0] as SyncBundleRoot,
        false,
        false,
      );
    const after = await h.service().preview(h.ref.vaultId, h.ref.entityId);
    expect(after.versions[0]).toMatchObject({ deleted: true, parents: before.heads, fileCount: 0 });
    expect(
      (await h.service().file({ ...h.ref, opId: before.heads[0], path: 'SKILL.md' })).text,
    ).toBe('Initial synthetic instructions');
  });
});
