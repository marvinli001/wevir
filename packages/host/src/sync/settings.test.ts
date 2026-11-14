import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jcs } from '@wevir/protocol/sync';
import { describe, expect, it } from 'vitest';
import { HostSettingsStore } from '../settings.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import { SyncSettings } from './settings.js';

const temp = useTempDir(),
  stores = useStorages();
describe('received settings application', () => {
  async function local() {
    const home = temp(),
      storage = stores.open(home);
    storage.transaction(() => {
      storage.sync.bindVault({
        vaultId: 'vault_settings',
        accountId: 'account_settings',
        deviceId: 'device_settings',
        originHostId: 'host_settings',
        appliedCursor: 'cursor_settings',
      });
      storage.sync.setScopes('vault_settings', {
        revision: '1',
        enabled: true,
        categories: ['settings'],
        projectIds: [],
      });
    });
    const settings = new HostSettingsStore({ path: join(home, 'settings.json') });
    await settings.update({ agentInstructions: 'Local instructions' });
    const sync = new SyncSettings({ home, storage, settings });
    const vault = storage.sync.activeVault();
    if (!vault) throw new Error('missing synthetic vault');
    sync.capture(vault, true, true);
    const entity = storage.sync.entity(vault.vaultId, 'settings_agentInstructions');
    const revision = entity?.revision;
    if (!entity || !revision) throw new Error('missing synthetic revision');
    return { storage, settings, sync, vault, entity, revision };
  }
  it('abandons a refused resolution even when its selected value already matches disk', async () => {
    const h = await local();
    let checks = 0;
    await expect(
      h.sync.resolve(
        h.vault,
        {
          entityId: h.entity.entityId,
          localRevision: h.revision,
          expectedHeads: [h.revision],
          values: { agentInstructions: 'Local instructions' },
        },
        () => {
          if (++checks === 2) throw new ZuvRequestError('REVISION_CONFLICT');
        },
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(
      h.storage.sync.localWrites(h.vault.vaultId).filter((value) => value.state === 'pending'),
    ).toEqual([]);
    expect(h.settings.get().agentInstructions).toBe('Local instructions');
  });
  it('does not finish a stale resolution intent during capture', async () => {
    const h = await local();
    h.storage.transaction(() =>
      h.storage.sync.putLocalWrite({
        id: 'operation_resolution',
        vaultId: h.vault.vaultId,
        entityId: h.entity.entityId,
        entityType: 'settings',
        localKey: h.entity.localKey,
        path: '/synthetic/settings.json',
        kind: 'put',
        content: {
          schema: 'wevir-settings/1',
          values: { agentInstructions: 'Local instructions' },
          exclusions: [],
        },
        parents: ['operation_outdated'],
        nextHash: sha256(jcs('Local instructions')),
        state: 'pending',
        resolution: true,
      }),
    );
    h.sync.capture(h.vault, false, false);
    expect(h.storage.sync.draft(h.vault.vaultId, 'operation_resolution')).toBeUndefined();
    expect(
      h.storage.sync
        .localWrites(h.vault.vaultId)
        .find((value) => value.id === 'operation_resolution')?.state,
    ).toBe('abandoned');
  });
  it('prepares without changing settings and publishes only inside the apply transaction', async () => {
    const home = temp(),
      storage = stores.open(home);
    storage.transaction(() =>
      storage.sync.bindVault({
        vaultId: 'vault_settings',
        accountId: 'account_settings',
        deviceId: 'device_settings',
        originHostId: 'host_settings',
        appliedCursor: 'cursor_settings',
      }),
    );
    const settings = new HostSettingsStore({ path: join(home, 'settings.json') });
    await settings.update({ agentInstructions: 'Local instructions' });
    const sync = new SyncSettings({ home, storage, settings });
    const apply = await sync.prepare(
      {
        vaultId: 'vault_settings',
        opId: 'operation_settings',
        entityId: 'settings_agentInstructions',
        entityType: 'settings',
        deviceId: 'device_remote',
        kind: 'put',
        parents: [],
        clientTime: new Date().toISOString(),
      },
      {
        opId: 'operation_settings',
        entityId: 'settings_agentInstructions',
        kind: 'put',
        parents: [],
        content: {
          schema: 'wevir-settings/1',
          values: { agentInstructions: 'Remote instructions' },
          exclusions: [],
        },
      },
    );
    expect(settings.get().agentInstructions).toBe('Local instructions');
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')).agentInstructions).toBe(
      'Local instructions',
    );
    storage.transaction(apply);
    expect(settings.get().agentInstructions).toBe('Remote instructions');
  });
});
