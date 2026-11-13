import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncVaultRecord } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { workspaceGit } from './workspace-git.js';
import { SyncWorkspaces } from './workspaces.js';

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
