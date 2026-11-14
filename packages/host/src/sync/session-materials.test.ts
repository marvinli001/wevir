import type { SyncOperation } from '@wevir/protocol/sync';
import { FileSecretStore, openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { EventStore } from '../event-store.js';
import { useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { SyncSessionMaterials } from './session-materials.js';

const tempDir = useTempDir();
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});
function fixture(consented = false) {
  const home = tempDir();
  const storage = openStorage({ dataDir: home });
  const events = new EventStore({ storage });
  stops.push(() => {
    events.close();
    storage.close();
  });
  const client = new ZuvClient({
    origin: 'https://synthetic.invalid',
    secrets: new FileSecretStore(home),
  });
  const directory = vi.spyOn(client, 'json').mockResolvedValue({
    devices: [
      {
        deviceId: 'device_source',
        name: 'Synthetic',
        thumbprint: 'a'.repeat(43),
        revokedAt: null,
        originHostId: 'host_bound',
        keyThroughEpoch: '1',
        enabled: true,
        revision: '1',
      },
    ],
  });
  const ensureSource = vi.fn();
  const materials = new SyncSessionMaterials({
    storage,
    events,
    client,
    eligible: () => (consented ? storage.sync.activeVault() : undefined),
    nativeSource: () => undefined,
    ensureSource,
  });
  const source = {
    hostId: 'host_forged',
    deviceId: 'device_source',
    sessionId: 'ses_synthetic' as const,
    streamId: 'stream_synthetic',
  };
  const op: SyncOperation = {
    protocol: 'wevir-sync/1',
    vaultId: 'vault_synthetic',
    opId: 'operation_synthetic',
    deviceId: 'device_source',
    deviceSeq: '1',
    entityType: 'session',
    entityId: 'ses_synthetic',
    kind: 'put',
    parents: [],
    payload: { blobId: 'blob_synthetic', recordIndex: 0 },
    clientTime: '2026-11-13T00:00:00.000Z',
  };
  const record = {
    opId: op.opId,
    entityId: op.entityId,
    kind: op.kind,
    parents: [],
    projectId: 'project_synthetic',
    content: {
      schema: 'wevir-session/1',
      source,
      sessionId: source.sessionId,
      throughSeq: '1',
      title: 'Synthetic',
      titleSource: 'user',
      providerId: 'synthetic-api',
      modelId: 'synthetic-model',
      engine: 'echo',
      createdAt: op.clientTime,
    },
  };
  return { storage, materials, directory, ensureSource, op, record, source };
}
describe('task source identity boundary', () => {
  it('hides a deleted replica locally without publishing a source tombstone', () => {
    const h = fixture(true);
    h.storage.workspaces.insert(workspace({ id: 'ws_synced' }));
    h.storage.sessions.insert(
      session({
        id: 'ses_replica',
        workspaceId: 'ws_synced',
        origin: {
          kind: 'synced',
          vaultId: 'vault_synthetic',
          hostId: 'host_bound',
          sessionId: 'ses_source',
          streamId: 'stream_source',
        },
      }),
    );
    h.storage.transaction(() => {
      h.storage.sync.bindVault({
        vaultId: 'vault_synthetic',
        accountId: 'account_synthetic',
        deviceId: 'device_local',
        originHostId: 'host_local',
        appliedCursor: 'cursor_synthetic',
      });
      h.storage.sync.setScopes('vault_synthetic', {
        revision: '1',
        enabled: true,
        categories: ['session'],
        projectIds: ['project_synced'],
      });
      h.storage.sync.bindProject('vault_synthetic', 'project_synced', 'ws_synced');
      h.storage.sync.putSource({
        vaultId: 'vault_synthetic',
        hostId: 'host_bound',
        deviceId: 'device_source',
        sessionId: 'ses_source',
        streamId: 'stream_source',
        localSessionId: 'ses_replica',
        mirrored: true,
      });
      h.storage.sync.putContentRef({
        vaultId: 'vault_synthetic',
        entityId: 'ses_source',
        kind: 'session',
        localId: 'ses_replica',
        source: {
          hostId: 'host_bound',
          deviceId: 'device_source',
          sessionId: 'ses_source',
          streamId: 'stream_source',
        },
      });
      h.materials.remove(['ses_replica']);
    });
    expect(h.storage.sync.drafts('vault_synthetic')).toEqual([]);
  });
  it('maps a delayed parent and fork through source identities without changing a native session', async () => {
    const h = fixture();
    h.storage.transaction(() => {
      h.storage.sync.bindVault({
        vaultId: h.op.vaultId,
        accountId: 'account_synthetic',
        deviceId: 'device_local',
        originHostId: 'device_local',
        appliedCursor: 'initial',
      });
      h.storage.workspaces.insert({
        id: 'ws_synthetic',
        rootPath: '/synthetic/project',
        displayName: 'Synthetic',
        createdAt: h.op.clientTime,
        updatedAt: h.op.clientTime,
      });
    });
    h.ensureSource.mockImplementation((vaultId, source) => {
      const found = h.storage.sync
        .sources(vaultId)
        .find((value) => value.streamId === source.streamId);
      if (found) return found;
      const localSessionId = `ses_local_${source.sessionId.slice(4)}`;
      h.storage.sessions.insert({
        id: localSessionId,
        workspaceId: 'ws_synthetic',
        cwd: '/synthetic/project',
        engine: 'sync',
        engineSessionId: `engine_${localSessionId}`,
        providerId: 'sync',
        modelId: 'sync',
        title: '',
        titleSource: 'first_prompt',
        state: 'closed',
        lastSeq: 0,
        createdAt: h.op.clientTime,
        updatedAt: h.op.clientTime,
        origin: {
          kind: 'synced',
          vaultId,
          hostId: source.hostId,
          sessionId: source.sessionId,
          streamId: source.streamId,
        },
      });
      const mapped = { vaultId, ...source, localSessionId, mirrored: true };
      h.storage.sync.putSource(mapped);
      return mapped;
    });
    let index = 0;
    const apply = async (sessionId: string, parentSessionId?: string) => {
      const op = {
        ...h.op,
        entityId: sessionId,
        opId: `operation_${++index}`,
        deviceSeq: String(index),
      };
      const source = {
        ...h.source,
        hostId: 'host_bound',
        sessionId,
        streamId: `stream_${sessionId}`,
      };
      const record = {
        ...h.record,
        entityId: sessionId,
        opId: op.opId,
        content: {
          ...h.record.content,
          source,
          sessionId,
          ...(parentSessionId && {
            parentSessionId,
            side: true,
            forkedFrom: { sessionId: parentSessionId },
          }),
        },
      };
      const finish = await h.materials.prepare(op, record);
      h.storage.transaction(() => {
        h.storage.sync.putOperation({
          ...op,
          projectId: record.projectId,
          envelope: op,
          manifest: {},
          digest: 'synthetic_digest',
          record,
          direction: 'inbox',
          state: 'applied',
        });
        finish();
      });
    };
    await apply('ses_child', 'ses_parent');
    expect(h.storage.sessions.get('ses_local_child')?.parentSessionId).toBeUndefined();
    await apply('ses_parent');
    expect(h.storage.sessions.get('ses_local_child')).toMatchObject({
      parentSessionId: 'ses_local_parent',
      forkedFrom: { sessionId: 'ses_local_parent' },
      side: true,
    });
    expect(h.storage.sessions.get('ses_parent')).toBeUndefined();
    expect(h.storage.sessions.get('ses_local_parent')?.parentSessionId).toBeUndefined();
  });
  it('does not accept a content header that claims a different Host from the registered device', async () => {
    const h = fixture();
    await expect(h.materials.prepare(h.op, h.record)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect(h.directory).toHaveBeenCalledWith('devices', 'GET', '/api/wevir/sync/v1/devices');
    expect(h.ensureSource).not.toHaveBeenCalled();
  });
  it('does not reassign an existing resource to another source stream', async () => {
    const h = fixture();
    h.storage.transaction(() => {
      h.storage.sync.bindVault({
        vaultId: h.op.vaultId,
        accountId: 'user_synthetic',
        deviceId: 'device_local',
        originHostId: 'device_local',
        appliedCursor: 'initial',
      });
      h.storage.sync.putContentRef({
        vaultId: h.op.vaultId,
        entityId: h.op.entityId,
        kind: 'session',
        source: { ...h.source, hostId: 'host_bound' },
        localId: 'ses_replica',
      });
    });
    await expect(h.materials.prepare(h.op, h.record)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    });
    expect(h.directory).not.toHaveBeenCalled();
    expect(h.ensureSource).not.toHaveBeenCalled();
  });
});
