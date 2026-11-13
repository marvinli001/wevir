import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SyncBundleContentSchema } from '@wevir/protocol';
import { jcs } from '@wevir/protocol/sync';
import { openStorage, type Storage, type SyncBundleBinding } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { SyncBundleFiles } from './bundle-files.js';
import { snapshotBundle } from './bundle-snapshot.js';
import { sha256 } from './crypto.js';

const fault = vi.hoisted(() => ({
  afterPromotion: false,
  target: undefined as string | undefined,
  trace: false,
  opens: [] as string[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fault.trace) fault.opens.push(String(args[0]));
      return actual.open(...args);
    },
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      if (
        fault.afterPromotion &&
        from.includes('.wevir-sync-') &&
        !to.includes('.wevir-sync-') &&
        (!fault.target || basename(to) === fault.target)
      ) {
        fault.afterPromotion = false;
        throw new Error('synthetic interruption after file promotion');
      }
    },
  };
});
const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  fault.afterPromotion = false;
  fault.target = undefined;
  fault.trace = false;
  fault.opens = [];
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture(projectId?: string) {
  const base = tempDir(),
    home = join(base, 'home'),
    target = join(base, 'local'),
    source = join(base, 'source');
  await mkdir(target);
  await mkdir(source);
  await writeFile(join(target, 'kept.txt'), 'Previous kept text');
  await writeFile(join(target, 'removed.txt'), 'Previous removed text');
  await writeFile(join(target, '.env'), 'Synthetic excluded local value');
  await writeFile(join(source, 'kept.txt'), 'Incoming kept text');
  await writeFile(join(source, 'binary.bin'), Buffer.from([0, 255, 17, 128]));
  await writeFile(join(source, 'script.sh'), 'echo synthetic');
  await chmod(join(source, 'script.sh'), 0o700);
  let storage: Storage = openStorage({ dataDir: home });
  cleanups.push(() => storage.close());
  const snapshot = await snapshotBundle({ path: target });
  const binding: SyncBundleBinding = {
    vaultId: 'vault_synthetic',
    entityId: 'bundle_synthetic',
    targetKey: 'target_synthetic',
    targetAnchor: base,
    targetPath: target,
    targetKind: 'directory',
    revision: 'operation_base',
    fingerprint: snapshot.fingerprint,
    manifest: {
      files: snapshot.files.map((file) => ({ ...file, bytes: file.bytes.length })),
      exclusions: snapshot.exclusions,
    },
  };
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: binding.vaultId,
      accountId: 'user_synthetic',
      deviceId: 'device_synthetic',
      originHostId: 'host_synthetic',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes(binding.vaultId, {
      enabled: true,
      revision: '1',
      categories: ['artifact'],
      projectIds: projectId ? [projectId] : [],
    });
    storage.sync.claimResource('bundle:synthetic', binding.vaultId);
    storage.sync.putEntity({
      vaultId: binding.vaultId,
      entityId: binding.entityId,
      entityType: 'artifact',
      localKey: 'bundle:synthetic',
      ...(projectId && { projectId }),
      revision: 'operation_base',
      materialized: true,
    });
    storage.sync.putBundleBinding(binding);
  });
  const snapshotSource = await snapshotBundle({ path: source });
  const body: typeof SyncBundleContentSchema._output = {
    schema: 'wevir-bundle/1',
    category: 'artifact',
    name: 'Synthetic package',
    files: snapshotSource.files.map((file) => ({ ...file, bytes: file.bytes.length, parts: [] })),
    exclusions: [],
  };
  const operation = {
    vaultId: binding.vaultId,
    opId: 'operation_incoming',
    deviceId: 'device_other',
    entityId: binding.entityId,
    entityType: 'artifact' as const,
    kind: 'put' as const,
    parents: ['operation_base'],
    clientTime: '2026-11-14T00:00:00.000Z',
  };
  const files = () =>
    new SyncBundleFiles({ storage, home, eligible: () => storage.sync.activeVault() });
  return {
    home,
    target,
    source,
    binding,
    body,
    operation,
    files,
    get storage() {
      return storage;
    },
    reopen() {
      storage.close();
      storage = openStorage({ dataDir: home });
    },
  };
}
describe('recoverable package file application', () => {
  it('does not read or stage a package after its project scope is removed', async () => {
    const h = await fixture('project_synthetic');
    h.storage.sync.setScopes(h.binding.vaultId, {
      enabled: true,
      revision: '2',
      categories: ['artifact'],
      projectIds: [],
    });
    fault.trace = true;
    await expect(
      h.files().prepare(h.operation, h.body, h.source, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    expect(fault.opens).toEqual([]);
    expect(h.storage.sync.pendingBundleApplications(h.binding.vaultId)).toEqual([]);
  });
  it('preserves a case-only rename across a promotion interruption', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    await rename(join(h.source, 'kept.txt'), join(h.source, 'Kept.txt'));
    const source = await snapshotBundle({ path: h.source });
    const body = {
      ...h.body,
      files: source.files.map((file) => ({ ...file, bytes: file.bytes.length, parts: [] })),
    };
    const app = await h.files().prepare(h.operation, body, h.source, signal);
    fault.target = 'Kept.txt';
    fault.afterPromotion = true;
    await expect(h.files().apply(app.opId, signal)).rejects.toThrow(
      'synthetic interruption after file promotion',
    );
    h.reopen();
    const finish = await h.files().apply(app.opId, signal);
    h.storage.transaction(finish);
    expect(await readdir(h.target)).toContain('Kept.txt');
    expect(await readdir(h.target)).not.toContain('kept.txt');
    expect(await readFile(join(h.target, 'Kept.txt'), 'utf8')).toBe('Incoming kept text');
  });
  it('applies file and directory transitions while refusing to replace a directory containing excluded data', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    await unlink(join(h.source, 'kept.txt'));
    await mkdir(join(h.source, 'kept.txt'));
    await writeFile(join(h.source, 'kept.txt/child.md'), 'Incoming child');
    const snapshot = await snapshotBundle({ path: h.source });
    const body = {
      ...h.body,
      files: snapshot.files.map((file) => ({ ...file, bytes: file.bytes.length, parts: [] })),
    };
    const first = await h.files().prepare(h.operation, body, h.source, signal);
    h.storage.transaction(await h.files().apply(first.opId, signal));
    expect(await readFile(join(h.target, 'kept.txt/child.md'), 'utf8')).toBe('Incoming child');
    await rm(join(h.source, 'kept.txt'), { recursive: true });
    await writeFile(join(h.source, 'kept.txt'), 'File after directory');
    const next = await snapshotBundle({ path: h.source });
    const second = await h.files().prepare(
      { ...h.operation, opId: 'operation_second', parents: [first.opId] },
      {
        ...h.body,
        files: next.files.map((file) => ({ ...file, bytes: file.bytes.length, parts: [] })),
      },
      h.source,
      signal,
    );
    h.storage.transaction(await h.files().apply(second.opId, signal));
    expect(await readFile(join(h.target, 'kept.txt'), 'utf8')).toBe('File after directory');
    await mkdir(join(h.target, 'protected'));
    await writeFile(join(h.target, 'protected/.env'), 'Excluded nested value');
    await writeFile(join(h.target, 'protected/managed.txt'), 'Managed nested value');
    const current = await snapshotBundle({ path: h.target });
    const binding = h.storage.sync.bundleBinding(h.binding.vaultId, h.binding.entityId);
    if (!binding) throw new Error('missing package binding');
    h.storage.transaction(() =>
      h.storage.sync.putBundleBinding({
        ...binding,
        fingerprint: current.fingerprint,
        manifest: {
          files: current.files.map((file) => ({ ...file, bytes: file.bytes.length })),
          exclusions: current.exclusions,
        },
      }),
    );
    await writeFile(join(h.source, 'protected'), 'Replacement file');
    const protectedSource = await snapshotBundle({ path: h.source });
    await expect(
      h.files().prepare(
        { ...h.operation, opId: 'operation_protected', parents: [second.opId] },
        {
          ...h.body,
          files: protectedSource.files.map((file) => ({
            ...file,
            bytes: file.bytes.length,
            parts: [],
          })),
        },
        h.source,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await readFile(join(h.target, 'protected/.env'), 'utf8')).toBe('Excluded nested value');
    expect(await readFile(join(h.target, 'protected/managed.txt'), 'utf8')).toBe(
      'Managed nested value',
    );
  });
  it('verifies every staged file before deleting or replacing any local data', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    const app = await h.files().prepare(h.operation, h.body, h.source, signal);
    const index = app.files.findIndex((file) => file.path === 'kept.txt');
    await writeFile(
      join(h.home, 'sync/bundle-writes', app.vaultId, app.opId, `${index}.next`),
      'Corrupt staged bytes',
    );
    await expect(h.files().apply(app.opId, signal)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect(await readFile(join(h.target, 'removed.txt'), 'utf8')).toBe('Previous removed text');
    expect(await readFile(join(h.target, 'kept.txt'), 'utf8')).toBe('Previous kept text');
  });
  it('preserves excluded files, binary bytes and previous copies across a database rollback and reopen', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    const app = await h.files().prepare(h.operation, h.body, h.source, signal);
    const finish = await h.files().apply(app.opId, signal);
    expect(() =>
      h.storage.transaction(() => {
        finish();
        throw new Error('synthetic database rollback');
      }),
    ).toThrow('synthetic database rollback');
    expect(h.storage.sync.bundleBinding(app.vaultId, app.entityId)?.revision).toBe(
      'operation_base',
    );
    h.reopen();
    const resumed = await h.files().apply(app.opId, signal);
    h.storage.transaction(resumed);
    expect(await readFile(join(h.target, 'kept.txt'), 'utf8')).toBe('Incoming kept text');
    expect(await readFile(join(h.target, 'binary.bin'))).toEqual(Buffer.from([0, 255, 17, 128]));
    expect((await stat(join(h.target, 'script.sh'))).mode & 0o100).toBe(0o100);
    expect(await readFile(join(h.target, '.env'), 'utf8')).toBe('Synthetic excluded local value');
    await expect(stat(join(h.target, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const index = app.files.findIndex((file) => file.path === 'removed.txt');
    expect(
      await readFile(
        join(h.home, 'sync/bundle-writes', app.vaultId, app.opId, `${index}.previous`),
        'utf8',
      ),
    ).toBe('Previous removed text');
    expect(h.storage.sync.bundleApplication(app.vaultId, app.opId)?.state).toBe('applied');
    expect(h.storage.sync.drafts(app.vaultId)).toEqual([]);
    expect(h.storage.sync.activeVault()?.appliedCursor).toBe('initial');
  });
  it('resumes a partially promoted package and publishes one stable all-parent resolution', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    const operation = {
      ...h.operation,
      kind: 'resolve' as const,
      parents: ['operation_base', 'operation_remote'],
    };
    const app = await h.files().prepare(operation, h.body, h.source, signal, true);
    fault.afterPromotion = true;
    await expect(h.files().apply(app.opId, signal)).rejects.toThrow(
      'synthetic interruption after file promotion',
    );
    expect(h.storage.sync.counts(app.vaultId).conflicts).toBe(1);
    h.reopen();
    const finish = await h.files().apply(app.opId, signal);
    h.storage.transaction(finish);
    expect(h.storage.sync.drafts(app.vaultId)).toMatchObject([
      { opId: operation.opId, kind: 'resolve', parents: operation.parents },
    ]);
    expect(h.storage.sync.counts(app.vaultId).conflicts).toBe(0);
    expect(h.storage.sync.bundleBinding(app.vaultId, app.entityId)?.fingerprint).toBe(app.nextHash);
  });
  it('rejects a concurrent local edit before touching another managed file', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    const app = await h.files().prepare(h.operation, h.body, h.source, signal);
    await writeFile(join(h.target, 'kept.txt'), 'Unsubmitted local edit');
    await expect(h.files().apply(app.opId, signal)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(await readFile(join(h.target, 'removed.txt'), 'utf8')).toBe('Previous removed text');
    expect(await readFile(join(h.target, 'kept.txt'), 'utf8')).toBe('Unsubmitted local edit');
    expect(h.storage.sync.bundleBinding(app.vaultId, app.entityId)?.revision).toBe(
      'operation_base',
    );
  });
  it('propagates a package deletion without deleting excluded local data', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    const operation = { ...h.operation, kind: 'delete' as const };
    const app = await h.files().prepare(operation, { ...h.body, files: [] }, h.source, signal);
    const finish = await h.files().apply(app.opId, signal);
    h.storage.transaction(finish);
    expect(await readFile(join(h.target, '.env'), 'utf8')).toBe('Synthetic excluded local value');
    expect(h.storage.sync.bundleBinding(app.vaultId, app.entityId)?.manifest).toMatchObject({
      deleted: true,
      files: [],
    });
    await expect(stat(join(h.target, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects source corruption, reserved paths and symbolic targets before promotion', async () => {
    const h = await fixture(),
      signal = new AbortController().signal;
    await writeFile(join(h.source, 'kept.txt'), 'Corrupt source copy');
    await expect(h.files().prepare(h.operation, h.body, h.source, signal)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect(await readFile(join(h.target, 'kept.txt'), 'utf8')).toBe('Previous kept text');
    await expect(
      h.files().prepare(
        { ...h.operation, opId: 'operation_reserved' },
        {
          ...h.body,
          files: [{ path: '.git/config', bytes: 0, sha256: sha256(Buffer.alloc(0)), parts: [] }],
        },
        h.source,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    await writeFile(join(h.source, 'kept.txt'), 'Incoming kept text');
    const app = await h
      .files()
      .prepare({ ...h.operation, opId: 'operation_symlink' }, h.body, h.source, signal);
    const outside = join(h.home, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'data.txt'), 'Outside synthetic value');
    await symlink(outside, join(h.target, 'linked'));
    await expect(h.files().apply(app.opId, signal)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect(await readFile(join(outside, 'data.txt'), 'utf8')).toBe('Outside synthetic value');
    expect(sha256(jcs(app.content))).toBe(sha256(jcs(h.body)));
  });
});
