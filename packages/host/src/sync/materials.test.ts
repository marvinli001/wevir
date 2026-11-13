import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jcs, packRecord, type SyncOperation } from '@wevir/protocol/sync';
import { openStorage, type SyncDraftRecord, type SyncVaultRecord } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import { ImageStore } from '../images.js';
import { MemoryStore } from '../memory.js';
import { HostSettingsStore } from '../settings.js';
import { useTempDir } from '../test-utils.js';
import { sha256 } from './crypto.js';
import { SyncFilesCapture } from './files-capture.js';
import { SyncMaterials } from './materials.js';
import type { SyncDraftPayload } from './queue.js';
import { SyncSettings } from './settings.js';

const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = tempDir();
  const storage = openStorage({ dataDir: home });
  const events = new EventStore({ storage });
  cleanups.push(() => {
    events.close();
    storage.close();
  });
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_synthetic',
      accountId: 'user_synthetic',
      deviceId: 'device_synthetic',
      originHostId: 'device_synthetic',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes('vault_synthetic', {
      enabled: true,
      revision: '1',
      categories: ['artifact', 'skill-bundle', 'rule'],
      projectIds: [],
    });
  });
  const memoryDir = join(home, 'memory');
  const materials = new SyncMaterials({
    storage,
    events,
    home,
    memoryDir,
    images: new ImageStore({ dir: join(home, 'images') }),
    settingsSync: new SyncSettings({ storage, home, settings: new HostSettingsStore() }),
  });
  const capture = new SyncFilesCapture({ storage, memoryDir });
  let deviceSeq = 0;
  async function apply(draft: SyncDraftRecord, entityType: SyncOperation['entityType']) {
    const record = packRecord.parse({
      opId: draft.opId,
      entityId: draft.entityId,
      kind: draft.kind,
      parents: draft.parents,
      content: (draft.content as SyncDraftPayload).body,
    });
    const op: SyncOperation = {
      protocol: 'wevir-sync/1',
      vaultId: 'vault_synthetic',
      opId: record.opId,
      deviceId: 'device_source',
      deviceSeq: String(++deviceSeq),
      entityId: record.entityId,
      entityType,
      kind: record.kind,
      parents: record.parents,
      clientTime: '2026-11-13T00:00:00.000Z',
    };
    const materialize = await materials.prepareApply(op, record);
    storage.transaction(() => {
      storage.sync.putOperation({
        ...op,
        envelope: op,
        manifest: {},
        digest: sha256(jcs(record)),
        record,
        direction: 'inbox',
        state: 'applied',
      });
      materialize();
      storage.sync.applyHeads(op.vaultId, op.entityId, op.opId, op.parents);
    });
    return op;
  }
  return {
    home,
    storage,
    capture,
    materials,
    apply,
    vault: storage.sync.activeVault() as SyncVaultRecord,
  };
}
function draft(entityId: string, content: unknown): SyncDraftRecord {
  return {
    vaultId: 'vault_synthetic',
    opId: newId('sop'),
    entityId,
    kind: 'put',
    parents: [],
    content: { schema: 'wevir-sync-draft/1', body: content },
    createdAt: '2026-11-13T00:00:00.000Z',
  };
}

describe('untrusted synchronized packages', () => {
  it('rejects malformed memory content before replacing a readable local note', async () => {
    const h = fixture();
    const memory = new MemoryStore({ dir: join(h.home, 'memory') });
    await memory.save('global', undefined, {
      name: 'synthetic-note',
      type: 'project',
      description: 'Synthetic',
      content: 'Preserved local note',
    });
    await expect(
      h.apply(
        draft('memory_synthetic', {
          schema: 'wevir-memory/1',
          scope: 'global',
          name: 'synthetic-note',
          markdown: 'Malformed remote frontmatter',
        }),
        'memory',
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect((await memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'Preserved local note',
    );
  });
  it('restores complete skill files and binary chunks without trusting scripts or selecting a concurrent chunk head', async () => {
    const first = fixture();
    const second = fixture();
    const path = join(first.home, 'synthetic-skill');
    await mkdir(join(path, 'scripts'), { recursive: true });
    await writeFile(join(path, 'SKILL.md'), '# Synthetic Skill\n');
    await writeFile(join(path, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(join(path, 'asset.bin'), Buffer.from([0, 255, 1, 128]));
    await writeFile(join(path, '.env'), 'SYNTHETIC_EXCLUDED=value');
    await first.capture.bundle(
      first.vault,
      { category: 'skill-bundle', localKey: 'skill:synthetic', name: 'Synthetic', path },
      false,
      true,
    );
    const drafts = first.storage.sync.drafts(first.vault.vaultId);
    const bundle = drafts.find(
      (value) =>
        first.storage.sync.entity(first.vault.vaultId, value.entityId)?.entityType ===
        'skill-bundle',
    );
    if (!bundle) throw new Error('missing captured bundle');
    for (const value of drafts.filter((value) => value !== bundle))
      await second.apply(value, 'artifact');
    const part = drafts.find((value) => value !== bundle);
    if (!part) throw new Error('missing captured chunk');
    const changed = {
      ...((part.content as SyncDraftPayload).body as object),
      data: Buffer.from('Concurrent').toString('base64url'),
      sha256: sha256(Buffer.from('Concurrent')),
    };
    await second.apply(draft(part.entityId, changed), 'artifact');
    await second.apply(bundle, 'skill-bundle');
    const restored = join(
      second.home,
      'sync/materials',
      second.vault.vaultId,
      bundle.entityId,
      bundle.opId,
    );
    expect(await readFile(join(restored, 'SKILL.md'), 'utf8')).toBe('# Synthetic Skill\n');
    expect(await readFile(join(restored, 'asset.bin'))).toEqual(Buffer.from([0, 255, 1, 128]));
    expect((await stat(join(restored, 'scripts/check.sh'))).mode & 0o111).toBe(0);
    expect((bundle.content as SyncDraftPayload).body).toMatchObject({ exclusions: ['.env'] });
    await expect(stat(join(restored, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, case collisions and symlink targets before publishing a materialized package', async () => {
    const h = fixture();
    const file = { path: 'safe', bytes: 0, sha256: sha256(Buffer.alloc(0)), parts: [] };
    const body = {
      schema: 'wevir-bundle/1',
      category: 'rule',
      name: 'Synthetic',
      files: [file],
      exclusions: [],
    };
    await expect(
      h.apply(
        draft('bundle_traversal', { ...body, files: [{ ...file, path: '../escape' }] }),
        'rule',
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    await expect(
      h.apply(
        draft('bundle_collision', { ...body, files: [file, { ...file, path: 'SAFE' }] }),
        'rule',
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    const value = draft('bundle_symlink', body);
    const outside = join(h.home, 'protected');
    await writeFile(outside, 'Synthetic protected');
    const root = join(h.home, 'sync/materials', h.vault.vaultId, value.entityId, value.opId);
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, 'safe'));
    await expect(h.apply(value, 'rule')).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect(await readFile(outside, 'utf8')).toBe('Synthetic protected');
    expect(h.storage.sync.entity(h.vault.vaultId, value.entityId)).toBeUndefined();
  });
});
