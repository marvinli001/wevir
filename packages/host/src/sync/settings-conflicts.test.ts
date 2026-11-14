import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jcs } from '@wevir/protocol/sync';
import { openStorage, type Storage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSettingsStore } from '../settings.js';
import { useTempDir } from '../test-utils.js';
import { sha256 } from './crypto.js';
import { SyncSettings } from './settings.js';
import { SyncSettingsConflicts } from './settings-conflicts.js';

const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture(
  texts = {
    base: 'Alpha\n\nMiddle\n\nOmega',
    left: 'Local alpha\n\nMiddle\n\nOmega',
    right: 'Alpha\n\nMiddle\n\nRemote omega',
  },
) {
  const home = tempDir();
  let storage: Storage = openStorage({ dataDir: home });
  cleanups.push(() => storage.close());
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_synthetic',
      accountId: 'user_synthetic',
      deviceId: 'device_synthetic',
      originHostId: 'host_synthetic',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes('vault_synthetic', {
      enabled: true,
      revision: '1',
      categories: ['settings'],
      projectIds: [],
    });
  });
  const initialize = async () => {
    const settings = new HostSettingsStore({
      path: join(home, 'settings.json'),
      beforeWrite: (next) => {
        const vault = storage.sync.activeVault();
        return vault && sync.beforeWrite(vault, next);
      },
    });
    await settings.load();
    const sync = new SyncSettings({ storage, home, settings });
    const conflicts = new SyncSettingsConflicts({
      storage,
      home,
      settings,
      settingsSync: sync,
      eligible: () => storage.sync.activeVault(),
    });
    return { sync, settings, conflicts };
  };
  let services = await initialize();
  const vault = () => {
    const value = storage.sync.activeVault();
    if (!value) throw new Error('missing synthetic vault');
    return value;
  };
  services.sync.capture(vault(), true, false);
  let seq = 0;
  const apply = async (opId: string, parents: string[], text: string) => {
    const op = {
      vaultId: 'vault_synthetic',
      opId,
      entityId: 'settings_agentInstructions',
      entityType: 'settings' as const,
      deviceId: 'device_source',
      kind: 'put' as const,
      parents,
      clientTime: new Date().toISOString(),
    };
    const record = {
      opId,
      entityId: op.entityId,
      kind: 'put' as const,
      parents,
      content: {
        schema: 'wevir-settings/1' as const,
        values: { agentInstructions: text },
        exclusions: [],
      },
    };
    const materialize = await services.sync.prepare(op, record);
    storage.transaction(() => {
      storage.sync.putOperation({
        ...op,
        deviceSeq: String(++seq),
        envelope: op,
        manifest: {},
        digest: opId,
        record,
        direction: 'inbox',
        state: 'applied',
      });
      materialize();
      storage.sync.applyHeads(op.vaultId, op.entityId, opId, parents);
    });
  };
  await apply('operation_base', [], texts.base);
  await apply('operation_left', ['operation_base'], texts.left);
  await apply('operation_right', ['operation_base'], texts.right);
  return {
    home,
    apply,
    get storage() {
      return storage;
    },
    get sync() {
      return services.sync;
    },
    get settings() {
      return services.settings;
    },
    get conflicts() {
      return services.conflicts;
    },
    get vault() {
      return vault();
    },
    async reopen() {
      storage.close();
      storage = openStorage({ dataDir: home });
      services = await initialize();
    },
  };
}
describe('durable preference conflict resolution', () => {
  it('includes device and creation time for version presentation', async () => {
    const h = await fixture();
    const preview = await h.conflicts.preview('settings_agentInstructions');
    expect(preview.versions.find((version) => version.opId === 'operation_left')).toMatchObject({
      deviceId: 'device_source',
      clientTime: expect.any(String),
    });
  });
  it('keeps a single remote head and a local version selectable across truncated ancestry', async () => {
    const h = await fixture();
    await h.apply('operation_remote', ['operation_left', 'operation_right'], 'Remote');
    await h.settings.update({ agentInstructions: 'Local' });
    const revision = h.storage.sync.entity(h.vault.vaultId, 'settings_agentInstructions')?.revision;
    const draft = revision && h.storage.sync.draft(h.vault.vaultId, revision);
    if (!draft) throw new Error('missing synthetic draft');
    h.storage.transaction(() => {
      h.storage.sync.removeDraft(h.vault.vaultId, draft.opId);
      h.storage.sync.putDraft({ ...draft, parents: ['operation_pruned'] });
    });
    expect(h.conflicts.list().conflicts).toHaveLength(1);
    const preview = await h.conflicts.preview(draft.entityId);
    expect(preview.mergeState).toBe('unavailable');
    await h.conflicts.resolve({ ...preview, values: { agentInstructions: 'Remote' } });
    expect(h.settings.get().agentInstructions).toBe('Remote');
  });
  it('retains all revisions when the parent limit prevents a bounded conflict response', async () => {
    const h = await fixture();
    for (let index = 0; index < 31; index++)
      await h.apply(`operation_extra_${index}`, ['operation_base'], String(index));
    expect(h.storage.sync.heads('vault_synthetic', 'settings_agentInstructions')).toHaveLength(33);
    expect(() => h.conflicts.list()).toThrowError('QUOTA_EXCEEDED');
    expect(h.settings.get().agentInstructions).toBe('Local alpha\n\nMiddle\n\nOmega');
  });
  it('shows a retained local baseline without inventing another head and can explicitly keep it', async () => {
    const h = await fixture();
    const first = await h.conflicts.preview('settings_agentInstructions');
    if (!first.base) throw new Error('missing common preference baseline');
    await writeFile(
      join(h.home, 'settings.json'),
      JSON.stringify({ ...h.settings.get(), ...first.base.values }),
    );
    await h.settings.load();
    const entity = h.storage.sync.entity('vault_synthetic', 'settings_agentInstructions');
    if (!entity) throw new Error('missing preference entity');
    h.storage.transaction(() => {
      h.storage.sync.putEntity({ ...entity, revision: first.base?.opId });
      h.storage.sync.putFileBaseline({
        vaultId: entity.vaultId,
        entityId: entity.entityId,
        entityType: 'settings',
        path: join(h.home, 'settings.json'),
        fingerprint: sha256(jcs(first.base?.values.agentInstructions)),
        opId: first.base?.opId,
      });
    });
    const preview = await h.conflicts.preview(entity.entityId);
    expect(preview.expectedHeads).toEqual(['operation_left', 'operation_right']);
    expect(preview.localRevision).toBe('operation_base');
    expect(preview.localValues).toEqual(first.base.values);
    const result = await h.conflicts.resolve({ ...preview, values: preview.localValues });
    expect(h.storage.sync.draft(entity.vaultId, result.opId)).toMatchObject({
      kind: 'resolve',
      parents: preview.expectedHeads,
    });
    expect(h.settings.get().agentInstructions).toBe(first.base.values.agentInstructions);
  });
  it('keeps overlapping edits and rejects a stale choice when another head arrives', async () => {
    const h = await fixture({ base: 'Base', left: 'Left', right: 'Right' });
    const old = await h.conflicts.preview('settings_agentInstructions');
    expect(old.mergeState).toBe('conflict');
    expect(old.merged).toBeUndefined();
    await h.apply('operation_third', ['operation_base'], 'Third');
    await expect(
      h.conflicts.resolve({ ...old, values: { agentInstructions: 'Manual' } }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(h.settings.get().agentInstructions).toBe('Left');
    const fresh = await h.conflicts.preview('settings_agentInstructions');
    expect(fresh.expectedHeads).toHaveLength(3);
    const resolved = await h.conflicts.resolve({
      ...fresh,
      values: { agentInstructions: 'Manual' },
    });
    expect(h.storage.sync.draft('vault_synthetic', resolved.opId)?.parents).toEqual(
      fresh.expectedHeads,
    );
    expect(h.settings.get().agentInstructions).toBe('Manual');
    for (const [id, text] of [
      ['operation_left', 'Left'],
      ['operation_right', 'Right'],
      ['operation_third', 'Third'],
    ] as const)
      expect(h.storage.sync.getOperation('vault_synthetic', id)?.record).toMatchObject({
        content: { values: { agentInstructions: text } },
      });
  });
  it('recovers the same all-parent resolution after settings.json promotion and a database rollback', async () => {
    const h = await fixture();
    const preview = await h.conflicts.preview('settings_agentInstructions');
    expect(preview.merged).toEqual({ agentInstructions: 'Local alpha\n\nMiddle\n\nRemote omega' });
    if (!preview.merged) throw new Error('missing merged preference');
    vi.spyOn(h.storage.sync, 'putDraft').mockImplementationOnce(() => {
      throw new Error('synthetic database interruption');
    });
    await expect(h.conflicts.resolve({ ...preview, values: preview.merged })).rejects.toThrow(
      'synthetic database interruption',
    );
    const [intent] = h.storage.sync.localWrites('vault_synthetic');
    if (!intent) throw new Error('missing durable resolution intent');
    expect(intent).toMatchObject({
      resolution: true,
      state: 'pending',
      parents: preview.expectedHeads,
    });
    expect(h.settings.get().agentInstructions).toBe('Local alpha\n\nMiddle\n\nRemote omega');
    vi.restoreAllMocks();
    await h.reopen();
    h.sync.capture(h.vault, false, false);
    expect(h.storage.sync.drafts('vault_synthetic')).toMatchObject([
      { opId: intent.id, kind: 'resolve', parents: preview.expectedHeads },
    ]);
    expect(h.storage.sync.localWrites('vault_synthetic')).toEqual([]);
    expect(
      h.storage.sync
        .materialJournals('vault_synthetic')
        .some((journal) => journal.state === 'conflict'),
    ).toBe(false);
  });
  it('rejects a stale field value and accepts an explicit current version even when its value is unchanged', async () => {
    const h = await fixture();
    const old = await h.conflicts.preview('settings_agentInstructions');
    if (!old.merged) throw new Error('missing merged preference');
    await h.settings.update({ agentInstructions: 'New local edit' });
    await expect(h.conflicts.resolve({ ...old, values: old.merged })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    const current = await h.conflicts.preview('settings_agentInstructions');
    const chosen = current.versions.find((version) => version.opId === current.localRevision);
    if (!chosen) throw new Error('missing current preference revision');
    await h.settings.update({ autoMemory: false });
    const result = await h.conflicts.resolve({ ...current, values: chosen.values });
    expect(h.storage.sync.draft('vault_synthetic', result.opId)).toMatchObject({
      kind: 'resolve',
      parents: current.expectedHeads,
    });
    expect(h.settings.get().agentInstructions).toBe('New local edit');
    expect(h.settings.get().autoMemory).toBe(false);
  });
});
