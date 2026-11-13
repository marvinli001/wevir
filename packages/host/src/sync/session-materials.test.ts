import type { SyncOperation } from '@wevir/protocol/sync';
import { FileSecretStore, openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { SyncSessionMaterials } from './session-materials.js';

const tempDir = useTempDir();
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});
function fixture() {
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
    eligible: () => undefined,
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
