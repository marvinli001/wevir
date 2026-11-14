import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostSettingsStore } from '../settings.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { SyncSettings } from './settings.js';

const temp = useTempDir(),
  stores = useStorages();
describe('received settings application', () => {
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
