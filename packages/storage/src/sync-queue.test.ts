import { describe, expect, it } from 'vitest';
import { openStorage } from './storage.js';
import { seedSession, useTempStorage } from './test-utils.js';

const vault = {
  vaultId: 'vault_fixture',
  accountId: 'account_fixture',
  deviceId: 'device_fixture',
  originHostId: 'device_fixture',
  appliedCursor: 'cursor_initial',
};
describe('sync durable preparation', () => {
  const { storage, dataDir } = useTempStorage();
  const bind = () => storage().transaction(() => storage().sync.bindVault(vault));
  it.each(['memory', 'settings'] as const)(
    'lists a single remote head conflicting with a local %s draft',
    (entityType) => {
      bind();
      storage().transaction(() => {
        storage().sync.putEntity({
          vaultId: vault.vaultId,
          entityId: 'entity_synthetic',
          entityType,
          localKey: entityType,
          revision: 'operation_local',
          materialized: true,
        });
        storage().sync.putDraft({
          vaultId: vault.vaultId,
          opId: 'operation_local',
          entityId: 'entity_synthetic',
          kind: 'put',
          parents: [],
          content: {},
          createdAt: '2026-11-13T00:00:00.000Z',
        });
        storage().sync.putOperation({
          vaultId: vault.vaultId,
          opId: 'operation_remote',
          deviceId: 'device_remote',
          deviceSeq: '1',
          entityType,
          entityId: 'entity_synthetic',
          envelope: {},
          manifest: {},
          digest: 'synthetic',
          direction: 'inbox',
          state: 'applied',
        });
        storage().sync.applyHeads(vault.vaultId, 'entity_synthetic', 'operation_remote', []);
      });
      const conflicts =
        entityType === 'memory'
          ? storage().sync.memoryConflictEntities(vault.vaultId, [])
          : storage().sync.settingsConflictEntities(vault.vaultId);
      expect(conflicts.map((value) => value.entityId)).toEqual(['entity_synthetic']);
    },
  );
  it('finds workspace rule-version references even without parent or file-part references', () => {
    bind();
    storage().transaction(() => {
      storage().sync.putEntity({
        vaultId: vault.vaultId,
        entityId: 'snapshot_fixture',
        entityType: 'workspace-snapshot',
        localKey: 'snapshot:fixture',
        materialized: true,
      });
      storage().sync.putDraft({
        vaultId: vault.vaultId,
        opId: 'snapshot_op_fixture',
        entityId: 'snapshot_fixture',
        kind: 'put',
        parents: [],
        content: {
          schema: 'wevir-sync-draft/1',
          body: {
            schema: 'wevir-bundle/1',
            files: [],
            metadata: { ruleVersions: [{ entityId: 'rule_fixture', opId: 'rule_op_fixture' }] },
          },
        },
        createdAt: '2026-11-13T00:00:00.000Z',
      });
    });
    expect(storage().sync.draftsReferencing(vault.vaultId, ['rule_op_fixture'])).toEqual([
      'snapshot_op_fixture',
    ]);
    expect(storage().sync.draftsReferencing(vault.vaultId, ['unrelated_fixture'])).toEqual([]);
  });

  it('keeps resource revisions, stable draft IDs and event capture in the business transaction', () => {
    bind();
    const session = seedSession(storage());
    const write = () => {
      storage().events.insert({
        sessionId: session.id,
        seq: 1,
        ts: '2026-11-13T00:00:00.000Z',
        type: 'user.message',
        source: 'host',
        payload: { text: 'synthetic' },
      });
      storage().sync.putEntity({
        vaultId: vault.vaultId,
        entityId: 'entity_fixture',
        entityType: 'memory',
        localKey: 'global/note.md',
        revision: 'op_fixture',
        materialized: true,
      });
      storage().sync.putDraft({
        vaultId: vault.vaultId,
        opId: 'op_fixture',
        entityId: 'entity_fixture',
        kind: 'put',
        parents: [],
        content: { text: 'synthetic' },
        createdAt: '2026-11-13T00:00:00.000Z',
      });
      storage().sync.capture({
        vaultId: vault.vaultId,
        localSessionId: session.id,
        streamId: 'stream_fixture',
        projectId: 'project_fixture',
        throughSeq: 1,
        preparedSeq: 0,
      });
    };
    expect(() =>
      storage().transaction(() => {
        write();
        throw new Error('interrupted');
      }),
    ).toThrow();
    expect(storage().sync.drafts(vault.vaultId)).toEqual([]);
    expect(storage().sync.captures(vault.vaultId)).toEqual([]);
    storage().transaction(write);
    storage().close();
    const reopened = openStorage({ dataDir: dataDir() });
    try {
      expect(reopened.sync.drafts(vault.vaultId)[0]?.opId).toBe('op_fixture');
      expect(reopened.sync.captures(vault.vaultId)[0]).toMatchObject({
        throughSeq: 1,
        preparedSeq: 0,
      });
      expect(reopened.sync.localEntity(vault.vaultId, 'global/note.md')?.revision).toBe(
        'op_fixture',
      );
    } finally {
      reopened.close();
    }
  });

  it('preserves later events while an earlier range is prepared', () => {
    bind();
    const session = seedSession(storage());
    const capture = {
      vaultId: vault.vaultId,
      localSessionId: session.id,
      streamId: 'stream_fixture',
      projectId: 'project_fixture',
      throughSeq: 10,
      preparedSeq: 0,
    };
    storage().transaction(() => storage().sync.capture(capture));
    storage().transaction(() => storage().sync.capture({ ...capture, throughSeq: 20 }));
    storage().transaction(() => storage().sync.prepareCapture(capture, 10));
    expect(storage().sync.captures(vault.vaultId)).toEqual([
      { ...capture, throughSeq: 20, preparedSeq: 10 },
    ]);
    expect(() => storage().transaction(() => storage().sync.prepareCapture(capture, 20))).toThrow(
      'sync capture changed',
    );
  });

  it('keeps same-name independent remote entities without replacing the local material', () => {
    bind();
    const entity = {
      vaultId: vault.vaultId,
      entityId: 'entity_local',
      entityType: 'memory',
      localKey: 'global/note.md',
      materialized: true,
    };
    storage().transaction(() => {
      storage().sync.putEntity(entity);
      storage().sync.putEntity({ ...entity, entityId: 'entity_remote', materialized: false });
    });
    expect(storage().sync.entities(vault.vaultId)).toHaveLength(2);
    expect(storage().sync.localEntity(vault.vaultId, 'global/note.md')?.entityId).toBe(
      'entity_local',
    );
    expect(() =>
      storage().transaction(() =>
        storage().sync.putEntity({ ...entity, projectId: 'project_other' }),
      ),
    ).toThrow('sync entity binding changed');
  });

  it('persists immutable commit bodies, upload tickets and attempt counts across restart', () => {
    bind();
    storage().sync.putBlob({
      vaultId: vault.vaultId,
      blobId: 'blob_fixture',
      cipherSha256: 'digest_fixture',
      cipherBytes: 123,
      keyEpoch: '1',
      cachePath: '/synthetic/cache',
      state: 'reserved',
      uploadId: 'upload_fixture',
      uploadExpiresAt: '2026-11-13T00:01:00.000Z',
      uploadAttempts: 1,
      downloadAttempts: 0,
    });
    const commit = {
      vaultId: vault.vaultId,
      commitId: 'commit_fixture',
      body: '{"commitId":"commit_fixture"}',
      state: 'pending' as const,
      attempts: 1,
      retryAt: 100,
    };
    storage().transaction(() => storage().sync.putCommit(commit));
    expect(() =>
      storage().transaction(() => storage().sync.putCommit({ ...commit, body: '{}' })),
    ).toThrow('sync commit identity changed');
    storage().close();
    const reopened = openStorage({ dataDir: dataDir() });
    try {
      expect(reopened.sync.commits(vault.vaultId)).toEqual([commit]);
      expect(reopened.sync.blob(vault.vaultId, 'blob_fixture')).toMatchObject({
        uploadAttempts: 1,
        uploadId: 'upload_fixture',
      });
    } finally {
      reopened.close();
    }
  });
});
